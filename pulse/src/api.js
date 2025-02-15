const axios = require('axios');
const cheerio = require('cheerio');
const fetch = require('cross-fetch');
const { PublicKey } = require('@solana/web3.js');
const { readSettings } = require('./pulseServer');
const { devLog } = require('./utils');

const BASE_PRICE_URL = "https://api.jup.ag/price/v2?ids=";
const BASE_SWAP_URL = "https://quote-api.jup.ag/v6";

let lastFGIValue = null;
let lastTradeTime = new Map();

async function fetchFearGreedIndex() {
    try {
        const response = await axios.get('https://cfgi.io/solana-fear-greed-index/15m');
        const html = response.data;
        const $ = cheerio.load(html);
        const scriptContent = $('script:contains("series:")').html();
        const seriesMatch = scriptContent.match(/series:\s*\[(\d+)\]/);

        if (seriesMatch) {
            const seriesNumber = parseInt(seriesMatch[1]);
            if (!isNaN(seriesNumber) && seriesNumber >= 0 && seriesNumber <= 100) {
                const currentFGI = seriesNumber;
                
                // Store last value before updating
                const returnValue = currentFGI;
                lastFGIValue = currentFGI;
                console.log('Current Fear and Greed Index:', currentFGI);
                console.log('Last Fear and Greed Index:', lastFGIValue);
                console.log('Returning Fear and Greed Index:', returnValue);

                return returnValue;
            }
        }

        console.warn('Unable to parse Fear and Greed Index. Using default value.');
        return 50; // Default to neutral
    } catch (error) {
        console.error('Error fetching Fear and Greed Index:', error.message);
        return 50; // Default to neutral in case of error
    }
}

function isFGIChangeSignificant(currentFGI, settings) {
    console.log('lastFGIValue:', lastFGIValue);
    if (lastFGIValue === null) {
        return true; // First trade is always significant
    }

    const change = Math.abs(currentFGI - lastFGIValue);
    return change >= settings.MIN_SENTIMENT_CHANGE;
}

function getSentiment(data) {
    const { SENTIMENT_BOUNDARIES } = readSettings();
    if (typeof data !== 'number' || isNaN(data)) {
        console.error(`Invalid Fear and Greed Index value: ${data}. Defaulting to NEUTRAL.`);
        return "NEUTRAL";
    }

    const boundaries = Object.values(SENTIMENT_BOUNDARIES);
    if (!boundaries.every((value, index) => index === 0 || value > boundaries[index - 1])) {
        console.error("Sentiment boundaries are not properly defined. Defaulting to NEUTRAL.");
        return "NEUTRAL";
    }

    if (data < SENTIMENT_BOUNDARIES.EXTREME_FEAR) return "EXTREME_FEAR";
    if (data < SENTIMENT_BOUNDARIES.FEAR) return "FEAR";
    if (data < SENTIMENT_BOUNDARIES.GREED) return "NEUTRAL";
    if (data < SENTIMENT_BOUNDARIES.EXTREME_GREED) return "GREED";
    if (data <= 100) return "EXTREME_GREED";

    console.error(`Fear and Greed Index value out of range: ${data}. Defaulting to NEUTRAL.`);
    return "NEUTRAL";
}

async function fetchPrice(BASE_PRICE_URL, TOKEN, maxRetries = 5, retryDelay = 5000) {
	
	    if (!BASE_PRICE_URL || !TOKEN) {
        throw new Error('BASE_PRICE_URL and TOKEN are required');
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(`${BASE_PRICE_URL}${TOKEN}`);
			
			if (!response.data?.data?.[TOKEN]) {
                throw new Error('Invalid response structure');
            }
			
            const priceData = response.data.data[TOKEN];
			const price = parseFloat(priceData.price);
			
			if (!price || isNaN(price)) {
				throw new Error('Invalid price value received');
			}
			
			devLog(`Current ${TOKEN.slice(0, 8)}... Price: $${price.toFixed(2)}`);
			
            return parseFloat(price.toFixed(2));
			
			} catch (error) {
            console.error(`Error fetching price (attempt ${attempt}/${maxRetries}):`, error.message);

            if (attempt === maxRetries) {
                throw new Error(`Failed to fetch price after ${maxRetries} attempts`);
            }

            devLog(`Retrying in ${retryDelay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

async function getQuote(inputMint, outputMint, tradeAmountLamports) {
    const settings = readSettings();
    const slippageBps = 200; // 5% slippage
    const developerTipPercentage = settings.DEVELOPER_TIP_PERCENTAGE || 0;
    const totalFeePercentage = 0.05 + developerTipPercentage;
    const platformFeeBps = Math.round(totalFeePercentage * 100);

    const params = new URLSearchParams({
        inputMint: inputMint,
        outputMint: outputMint,
        amount: tradeAmountLamports.toString(),
        slippageBps: slippageBps.toString(),
        platformFeeBps: platformFeeBps.toString(),
        maxAutoSlippageBps: '500',
        autoSlippage: 'true',
    });

    const quoteUrl = `${BASE_SWAP_URL}/quote?${params.toString()}`;

    try {
        const response = await fetch(quoteUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const quoteResponse = await response.json();
        devLog('Quote response:', quoteResponse);  // Add this line for debugging
        return quoteResponse;
    } catch (error) {
        console.error('Error fetching quote:', error);
        throw error;
    }
}

async function getFeeAccountAndSwapTransaction(
    referralAccountPubkey,
    mint,
    quoteResponse,
    wallet
) {
    try {
        const [feeAccount] = await PublicKey.findProgramAddressSync(
            [
                Buffer.from("referral_ata"),
                referralAccountPubkey.toBuffer(),
                mint.toBuffer(),
            ],
            new PublicKey("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3")
        );

        const requestBody = {
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            feeAccount: feeAccount.toString(),
            dynamicComputeUnitLimit: true
        };

        const response = await fetch("https://quote-api.jup.ag/v6/swap", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            throw new Error(`Error performing swap: ${response.statusText}`);
        }

        const { swapTransaction } = await response.json();
        return swapTransaction;
    } catch (error) {
        console.error("Failed to get fee account and swap transaction:", error);
        return null;
    }
}

module.exports = {
    fetchFearGreedIndex,
    getSentiment,
    fetchPrice,
    getQuote,
    getFeeAccountAndSwapTransaction,
    BASE_PRICE_URL,
    BASE_SWAP_URL,
    isFGIChangeSignificant,
    lastFGIValue
};