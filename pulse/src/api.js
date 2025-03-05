const axios = require('axios');
const cheerio = require('cheerio');
const fetch = require('cross-fetch');
const { PublicKey } = require('@solana/web3.js');
const { readSettings } = require('./pulseServer');
const { devLog } = require('./utils');

// Constants
const BASE_PRICE_URL = "https://api.jup.ag/price/v2?ids=";
const BASE_SWAP_URL = "https://quote-api.jup.ag/v6";
const REFERRAL_PROGRAM_ID = new PublicKey("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3");
const DEFAULT_FGI_VALUE = 50;
const MAX_PRICE_RETRIES = 5;
const PRICE_RETRY_DELAY = 5000;
const DEFAULT_SLIPPAGE_BPS = 200; // 2%
const DEFAULT_MAX_AUTO_SLIPPAGE_BPS = 500;

/**
 * Fetches the current Fear and Greed Index for Solana
 * @returns {Promise<number>} The current FGI value (0-100)
 */
async function fetchFearGreedIndex() {
    try {
        const response = await axios.get('https://cfgi.io/solana-fear-greed-index/15m');
        const html = response.data;
        const $ = cheerio.load(html);
        const scriptContent = $('script:contains("series:")').html();
        
        if (!scriptContent) {
            throw new Error('Could not find script containing series data');
        }
        
        const seriesMatch = scriptContent.match(/series:\s*\[(\d+)\]/);

        if (!seriesMatch) {
            throw new Error('Could not parse series data from script');
        }
        
        const seriesNumber = parseInt(seriesMatch[1]);
        
        if (isNaN(seriesNumber) || seriesNumber < 0 || seriesNumber > 100) {
            throw new Error(`Invalid FGI value: ${seriesNumber}`);
        }
        
        // Update and log the value
        lastFGIValue = seriesNumber;
        devLog('Current Fear and Greed Index:', seriesNumber);
        
        return seriesNumber;
    } catch (error) {
        console.error('Error fetching Fear and Greed Index:', error.message);
        
        // If we had a previous value, return that instead of the default
        if (lastFGIValue !== null) {
            devLog('Using last known FGI value:', lastFGIValue);
            return lastFGIValue;
        }
        
        devLog(`Using default FGI value: ${DEFAULT_FGI_VALUE}`);
        return DEFAULT_FGI_VALUE;
    }
}

/**
 * Maps a numeric FGI value to a sentiment category
 * @param {number} data - The Fear and Greed Index value
 * @returns {string} The sentiment category
 */
function getSentiment(data) {
    const { SENTIMENT_BOUNDARIES } = readSettings();
    
    // Input validation
    if (typeof data !== 'number' || isNaN(data)) {
        console.error(`Invalid Fear and Greed Index value: ${data}. Defaulting to NEUTRAL.`);
        return "NEUTRAL";
    }
    
    // Validate boundaries are in ascending order
    const boundaries = Object.values(SENTIMENT_BOUNDARIES);
    const isBoundariesValid = boundaries.every((value, index) => 
        index === 0 || value > boundaries[index - 1]
    );
    
    if (!isBoundariesValid) {
        console.error("Sentiment boundaries are not properly defined. Defaulting to NEUTRAL.");
        return "NEUTRAL";
    }

    // Determine sentiment based on value
    if (data < SENTIMENT_BOUNDARIES.EXTREME_FEAR) return "EXTREME_FEAR";
    if (data < SENTIMENT_BOUNDARIES.FEAR) return "FEAR";
    if (data < SENTIMENT_BOUNDARIES.GREED) return "NEUTRAL";
    if (data < SENTIMENT_BOUNDARIES.EXTREME_GREED) return "GREED";
    if (data <= 100) return "EXTREME_GREED";

    console.error(`Fear and Greed Index value out of range: ${data}. Defaulting to NEUTRAL.`);
    return "NEUTRAL";
}

/**
 * Fetches the current price of a token with retry logic
 * @param {string} baseUrl - Base URL for the price API
 * @param {string} token - Token identifier
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} retryDelay - Delay between retries in milliseconds
 * @returns {Promise<number>} The token price
 */
async function fetchPrice(baseUrl = BASE_PRICE_URL, token, maxRetries = MAX_PRICE_RETRIES, retryDelay = PRICE_RETRY_DELAY) {
    if (!baseUrl || !token) {
        throw new Error('BASE_PRICE_URL and TOKEN are required');
    }

    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(`${baseUrl}${token}`);
            
            // Validate response structure
            if (!response.data?.data?.[token]) {
                throw new Error('Invalid response structure');
            }
            
            const priceData = response.data.data[token];
            const price = parseFloat(priceData.price);
            
            // Validate price value
            if (!price || isNaN(price)) {
                throw new Error('Invalid price value received');
            }
            
            const formattedPrice = parseFloat(price.toFixed(2));
            devLog(`Current ${token.slice(0, 8)}... Price: $${formattedPrice}`);
            
            return formattedPrice;
        } catch (error) {
            lastError = error;
            console.error(`Error fetching price (attempt ${attempt}/${maxRetries}):`, error.message);

            if (attempt < maxRetries) {
                devLog(`Retrying in ${retryDelay / 1000} seconds...`);
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }
    
    throw new Error(`Failed to fetch price after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Gets a quote for swapping tokens
 * @param {string} inputMint - Input token mint address
 * @param {string} outputMint - Output token mint address
 * @param {number} tradeAmountLamports - Trade amount in lamports
 * @returns {Promise<Object>} The quote response
 */
async function getQuote(inputMint, outputMint, tradeAmountLamports) {
    const settings = readSettings();
    
    // Calculate fees
    const developerTipPercentage = settings.DEVELOPER_TIP_PERCENTAGE || 0;
    const totalFeePercentage = 0.05 + developerTipPercentage;
    const platformFeeBps = Math.round(totalFeePercentage * 100);
    
    // Build quote URL with parameters
    const params = new URLSearchParams({
        inputMint,
        outputMint,
        amount: tradeAmountLamports.toString(),
        slippageBps: settings.SLIPPAGE_BPS?.toString() || DEFAULT_SLIPPAGE_BPS.toString(),
        platformFeeBps: platformFeeBps.toString(),
        maxAutoSlippageBps: settings.MAX_AUTO_SLIPPAGE_BPS?.toString() || DEFAULT_MAX_AUTO_SLIPPAGE_BPS.toString(),
        autoSlippage: 'true',
    });

    const quoteUrl = `${BASE_SWAP_URL}/quote?${params.toString()}`;

    try {
        const response = await fetch(quoteUrl);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const quoteResponse = await response.json();
        devLog('Quote response received successfully');
        
        return quoteResponse;
    } catch (error) {
        console.error('Error fetching quote:', error);
        throw error;
    }
}

/**
 * Gets fee account and swap transaction for executing a trade
 * @param {PublicKey} referralAccountPubkey - Referral account public key
 * @param {PublicKey} mint - Token mint public key
 * @param {Object} quoteResponse - Quote response from getQuote
 * @param {Object} wallet - Wallet object
 * @returns {Promise<string|null>} Swap transaction or null on error
 */
async function getFeeAccountAndSwapTransaction(
    referralAccountPubkey,
    mint,
    quoteResponse,
    wallet
) {
    try {
        // Find fee account address
        const [feeAccount] = PublicKey.findProgramAddressSync(
            [
                Buffer.from("referral_ata"),
                referralAccountPubkey.toBuffer(),
                mint.toBuffer(),
            ],
            REFERRAL_PROGRAM_ID
        );

        // Prepare swap request
        const requestBody = {
            quoteResponse,
            userPublicKey: wallet.publicKey.toString(),
            wrapAndUnwrapSol: true,
            feeAccount: feeAccount.toString(),
            dynamicComputeUnitLimit: true
        };

        // Get swap transaction
        const response = await fetch(`${BASE_SWAP_URL}/swap`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            throw new Error(`Error performing swap: ${response.status} ${response.statusText}`);
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
    BASE_SWAP_URL
};