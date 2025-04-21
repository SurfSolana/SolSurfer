const axios = require('axios');
const cheerio = require('cheerio');
const fetch = require('cross-fetch');
const { PublicKey } = require('@solana/web3.js');
const { readSettings } = require('./pulseServer');
const { 
    getBaseToken, 
    getQuoteToken, 
    devLog,
    // Import styling utilities
    formatHeading,
    formatSubheading,
    formatSuccess,
    formatError,
    formatWarning,
    formatInfo,
    formatPrice,
    formatSentiment,
    formatPercentage,
    horizontalLine,
    padRight,
    padLeft,
    formatTimestamp,
    formatBalance,
    formatTokenChange,
    icons,
    styles,
    colours
} = require('./utils');

// Constants
const BASE_PRICE_URL = "https://api.jup.ag/price/v2?ids=";
const BASE_SWAP_URL = "https://quote-api.jup.ag/v6";
const REFERRAL_PROGRAM_ID = new PublicKey("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3");
const DEFAULT_FGI_VALUE = 50;
const MAX_PRICE_RETRIES = 5;
const PRICE_RETRY_DELAY = 5000;
const DEFAULT_SLIPPAGE_BPS = 200; // 2%
const DEFAULT_MAX_AUTO_SLIPPAGE_BPS = 500;
let lastFGIValue = null;

/**
 * Fetches the current Fear and Greed Index for a token using the SolSurfer API
 * @returns {Promise<number>} The current FGI value (0-100)
 */
async function fetchFearGreedIndex() {
    try {
        // Get timeframe from settings
        const { readSettings } = require('./pulseServer');
        const settings = readSettings();
        
        // Use the configured timeframe or default to 15m
        const timeframe = settings.FGI_TIMEFRAME || "15m";
        
        // Convert timeframe format for API URL (15m → 15min)
        let apiTimeframe = timeframe;
        if (timeframe === "15m") {
            apiTimeframe = "15min";
        }
        
        // Get the base token from settings
        const targetToken = getBaseToken();
        
        // Construct the API URL with token ID and timeframe
        const apiUrl = `https://api.surfsolana.com/${targetToken.NAME}/${apiTimeframe}/latest.json`;
        devLog(`${icons.info} Fetching FGI from: ${apiUrl}`);
        
        // Make API request
        const response = await axios.get(apiUrl);
        
        // Validate response
        if (!response.data || typeof response.data.fgi !== 'number') {
            throw new Error('Invalid API response format');
        }
        
        const fgiValue = response.data.fgi;
        
        // Validate the FGI value
        if (isNaN(fgiValue) || fgiValue < 0 || fgiValue > 100) {
            throw new Error(`Invalid FGI value: ${fgiValue}`);
        }
        
        // Update and log the value
        lastFGIValue = fgiValue;
        devLog(`${icons.sentiment} Current Fear and Greed Index: ${styles.important}${fgiValue}${colours.reset}`);
        devLog(`${icons.settings} Using timeframe: ${styles.important}${timeframe}${colours.reset}`);
        
        return fgiValue;
    } catch (error) {
        console.error(formatError(`${icons.error} Error fetching Fear and Greed Index: ${error.message}`));
        
        // If we have a last known value, use that
        if (lastFGIValue !== null) {
            devLog(formatInfo(`${icons.info} Using last known FGI value: ${lastFGIValue}`));
            return lastFGIValue;
        }
        
        // Otherwise use the default value
        devLog(formatWarning(`${icons.warning} Using default FGI value: ${DEFAULT_FGI_VALUE}`));
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
        console.error(formatError(`${icons.error} Invalid Fear and Greed Index value: ${data}. Defaulting to NEUTRAL.`));
        return "NEUTRAL";
    }
    
    // Validate boundaries are in ascending order
    const boundaries = Object.values(SENTIMENT_BOUNDARIES);
    const isBoundariesValid = boundaries.every((value, index) => 
        index === 0 || value > boundaries[index - 1]
    );
    
    if (!isBoundariesValid) {
        console.error(formatError(`${icons.error} Sentiment boundaries are not properly defined. Defaulting to NEUTRAL.`));
        return "NEUTRAL";
    }

    // Determine sentiment based on value
    if (data < SENTIMENT_BOUNDARIES.EXTREME_FEAR) return "EXTREME_FEAR";
    if (data < SENTIMENT_BOUNDARIES.FEAR) return "FEAR";
    if (data < SENTIMENT_BOUNDARIES.GREED) return "NEUTRAL";
    if (data < SENTIMENT_BOUNDARIES.EXTREME_GREED) return "GREED";
    if (data <= 100) return "EXTREME_GREED";

    console.error(formatError(`${icons.error} Fear and Greed Index value out of range: ${data}. Defaulting to NEUTRAL.`));
    return "NEUTRAL";
}

/**
 * Fetches the current price of a token from the SurfSolana API
 * @param {string} baseUrl - Base URL for the price API (for backward compatibility, not used)
 * @param {string} tokenAddress - Token address (for backward compatibility, not used)
 * @param {number} maxRetries - Maximum number of retry attempts
 * @param {number} retryDelay - Delay between retries in milliseconds
 * @returns {Promise<number>} The token price
 */
async function fetchPrice(baseUrl = BASE_PRICE_URL, tokenAddress, maxRetries = MAX_PRICE_RETRIES, retryDelay = PRICE_RETRY_DELAY) {
    // Keep parameter signature for backward compatibility
    
    // Get base token information
    const baseToken = getBaseToken();
    let lastError = null;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            // Get timeframe from settings for consistency with fetchFearGreedIndex
            const { readSettings } = require('./pulseServer');
            const settings = readSettings();
            const timeframe = settings.FGI_TIMEFRAME || "15m";
            
            // Convert timeframe format for API URL (15m → 15min)
            let apiTimeframe = timeframe;
            if (timeframe === "15m") {
                apiTimeframe = "15min";
            }
            
            // Construct the API URL using the same pattern as fetchFearGreedIndex
            const apiUrl = `https://api.surfsolana.com/${baseToken.NAME}/${apiTimeframe}/latest.json`;
            devLog(`${icons.price} Fetching price from: ${apiUrl}`);
            
            const response = await axios.get(apiUrl);
            
            // Validate response structure
            if (!response.data?.price || typeof response.data.price !== 'number') {
                throw new Error('Invalid price data structure in API response');
            }
            
            const price = parseFloat(response.data.price);
            
            // Validate price value
            if (!price || isNaN(price)) {
                throw new Error('Invalid price value received');
            }
            
            const formattedPrice = parseFloat(price.toFixed(2));
            devLog(`${icons.price} Current ${baseToken.NAME} Price: ${formatPrice(formattedPrice)}`);
            
            return formattedPrice;
        } catch (error) {
            lastError = error;
            console.error(formatError(`${icons.error} Error fetching price for ${baseToken.NAME} (attempt ${attempt}/${maxRetries}): ${error.message}`));

            if (attempt < maxRetries) {
                devLog(formatInfo(`${icons.wait} Retrying in ${retryDelay / 1000} seconds...`));
                await new Promise(resolve => setTimeout(resolve, retryDelay));
            }
        }
    }
    
    throw new Error(`Failed to fetch price for ${baseToken.NAME} after ${maxRetries} attempts: ${lastError?.message || 'Unknown error'}`);
}

/**
 * Gets a quote for swapping tokens
 * @param {string} inputMint - Input token mint address
 * @param {string} outputMint - Output token mint address
 * @param {number} tradeAmountLamports - Trade amount in lamports or smallest token units
 * @returns {Promise<Object>} The quote response
 */
async function getQuote(inputMint, outputMint, tradeAmountLamports) {
    const settings = readSettings();
    
    // Calculate fees
    const developerTipPercentage = settings.DEVELOPER_TIP_PERCENTAGE || 0;
    const totalFeePercentage = 0.01 + developerTipPercentage; // Changed from 0.05 to 0.01
    const platformFeeBps = Math.round(totalFeePercentage * 100);
    
    // Get token info for logging
    const isBaseTokenInput = inputMint === getBaseToken().ADDRESS;
    const inputToken = isBaseTokenInput ? getBaseToken() : getQuoteToken();
    const outputToken = isBaseTokenInput ? getQuoteToken() : getBaseToken();
    
    // Log the trade details with proper token names
    devLog(`${icons.trade} Getting quote for ${inputToken.NAME} → ${outputToken.NAME} swap`);
    devLog(`${icons.balance} Amount: ${tradeAmountLamports} ${inputToken.NAME} units (${inputToken.DECIMALS} decimals)`);
    
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
        devLog(formatSuccess(`${icons.success} Quote response received successfully`));
        
        return quoteResponse;
    } catch (error) {
        console.error(formatError(`${icons.error} Error fetching quote: ${error.message}`));
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
        console.error(formatError(`${icons.error} Failed to get fee account and swap transaction: ${error.message}`));
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