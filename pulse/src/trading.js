/**
 * PulseSurfer Trading Module
 * Handles swap execution, position management, and Jupiter ULTRA integration
 */

// Core dependencies
const { 
    getQuote, 
    getFeeAccountAndSwapTransaction, 
    BASE_SWAP_URL, 
    fetchFearGreedIndex, 
    fetchPrice,
    isFGIChangeSignificant 
} = require('./api');
const { getWallet, getConnection } = require('./globalState');
const { readSettings } = require('./pulseServer');
const { 
    attemptRPCFailover, 
    devLog, 
    formatTime, 
    checkTradingPeriod, 
    setNewTradingPeriod, 
    getCurrentPeriodInfo, 
    resetTradingPeriod,
    getBaseToken,
    getQuoteToken,
    formatTokenAmount,
    toTokenBaseUnits,
    fromTokenBaseUnits,
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
const { 
    PublicKey, 
    VersionedTransaction, 
    TransactionMessage, 
    SystemProgram, 
    TransactionInstruction 
} = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require("@solana/spl-token");
const bs58 = require('bs58');
const fetch = require('cross-fetch');
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const borsh = require('@coral-xyz/borsh');

// ===========================
// Constants and Configuration
// ===========================

// Token-agnostic definitions
const BASE_TOKEN = getBaseToken();
const QUOTE_TOKEN = getQuoteToken();

// Transaction-related constants
const TRANSACTION_TIMEOUT = 120000; // 2 minutes
const MAX_REQUEST_RETRIES = 3;
const REQUEST_RETRY_DELAY = 2000; // 2 seconds
const STATUS_CHECK_INTERVAL = 2000; // 2 seconds

// Jupiter ULTRA configuration
const JUPITER_ULTRA_ORDER_URL = 'https://lite-api.jup.ag/ultra/v1/order';
const JUPITER_ULTRA_EXECUTE_URL = 'https://lite-api.jup.ag/ultra/v1/execute';

// State tracking
const lastTradeTime = new Map();

// ===========================
// Jupiter ULTRA API Functions
// ===========================

/**
 * Gets a swap order from Jupiter ULTRA API
 * @param {string} inputMint - Input token mint address
 * @param {string} outputMint - Output token mint address
 * @param {string|number} amount - Amount to swap (in smallest units)
 * @param {string} takerAddress - Wallet address of the taker
 * @param {Object} options - Additional options (slippage, referral, etc.)
 * @returns {Promise<Object>} Order response
 */
async function getJupiterUltraOrder(inputMint, outputMint, amount, takerAddress, options = {}) {
    try {
        // Add fee settings
        const settings = readSettings();
        const developerTipPercentage = settings.DEVELOPER_TIP_PERCENTAGE || 0;
        const developerFeeBps = Math.round(developerTipPercentage * 100);
        
        // Default fee is 50 bps (0.5%) - minimum allowed by Jupiter
        const DEFAULT_FEE_BPS = 50;
        
        // Calculate final fee (capped between 50-255 bps as required by Jupiter)
        const referralFeeBps = Math.max(Math.min(DEFAULT_FEE_BPS + developerFeeBps, 255), 50);
        
        // Your fee wallet address
        const DEVELOPER_FEE_ADDRESS = "EVDjScHdbxkF2tX2msNqDweL1DnhrRr2vPyfFoSKDZUM";
        
        // Build base URL parameters
        const params = new URLSearchParams({
            inputMint,
            outputMint,
            amount: amount.toString(),
            taker: takerAddress,
            // Add fee parameters
            referralAccount: DEVELOPER_FEE_ADDRESS,
            referralFee: referralFeeBps.toString()
        });

        // Add optional parameters if provided
        if (options.slippageBps) {
            params.append('slippageBps', options.slippageBps.toString());
        }
        
        if (options.swapMode) {
            // Note: Even though we set swapMode, Jupiter ULTRA only supports ExactIn
            params.append('swapMode', 'ExactIn'); // Force ExactIn for ULTRA
        }
        
        // Only add custom referral parameters if provided (otherwise use our default)
        if (options.referralAccount) {
            // Override our default referral account if specified
            params.set('referralAccount', options.referralAccount);
        }
        
        if (options.referralFee) {
            // Override our default referral fee if specified
            params.set('referralFee', options.referralFee.toString());
        }

        // Add timeout to fetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TRANSACTION_TIMEOUT);
        
        devLog(`Getting Jupiter ULTRA order: ${JUPITER_ULTRA_ORDER_URL}?${params.toString()}`);
        devLog(`Referral fee being applied: ${referralFeeBps} bps (${referralFeeBps/100}%)`);
        
        const response = await fetch(`${JUPITER_ULTRA_ORDER_URL}?${params.toString()}`, {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`Failed to get Jupiter ULTRA order: ${response.status} ${response.statusText}`);
        }

        const orderResponse = await response.json();
        
        // Log fee information if present in response
        if (orderResponse.feeBps) {
            devLog(`Fee confirmed in response: ${orderResponse.feeBps} bps (${orderResponse.feeBps/100}%)`);
            if (orderResponse.feeMint) {
                devLog(`Fee being collected in token: ${orderResponse.feeMint}`);
            }
        }
        
        devLog('Jupiter ULTRA order response:', orderResponse);

        return orderResponse;
    } catch (error) {
        console.error(formatError(`Error getting Jupiter ULTRA order: ${error.message}`));
        throw error;
    }
}

/**
 * Executes a signed transaction through Jupiter ULTRA API with improved error handling
 * @param {string} signedTransaction - Base64 encoded signed transaction
 * @param {string} requestId - Request ID from the order response
 * @returns {Promise<Object>} Execution response
 */
async function executeJupiterUltraOrder(signedTransaction, requestId) {
    try {
        let retries = 0;
        let response;
        let lastError = null;

        // Implement retry logic
        while (retries < MAX_REQUEST_RETRIES) {
            try {
                // Add timeout to fetch
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), TRANSACTION_TIMEOUT);
                
                devLog(`Executing Jupiter ULTRA order: ${requestId} (Attempt ${retries + 1}/${MAX_REQUEST_RETRIES})`);
                console.log(formatInfo(`${icons.network} Sending request to Jupiter ULTRA API (Attempt ${retries + 1}/${MAX_REQUEST_RETRIES})...`));
                
                response = await fetch(JUPITER_ULTRA_EXECUTE_URL, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        signedTransaction,
                        requestId
                    }),
                    signal: controller.signal
                });
                
                clearTimeout(timeoutId);
                
                // Handle successful response
                if (response.ok) {
                    const responseData = await response.json();
                    
                    // Log the full response for debugging
                    devLog('Jupiter ULTRA execute response:', responseData);
                    
                    // Check the status field - Jupiter ULTRA returns a status field in the response
                    if (responseData.status === 'Failed') {
                        const errorMessage = responseData.error || 'Unknown error';
                        const errorCode = responseData.code || 'N/A';
                        
                        console.error(formatError(`${icons.error} Jupiter API returned failure status: ${errorMessage}`));
                        console.error(formatError(`Error code: ${errorCode}`));
                        
                        // Determine if this error is retryable
                        const nonRetryable = isNonRetryableError(errorCode, errorMessage);
                        
                        // If this is a known error that cannot be fixed by retrying, return the response
                        if (nonRetryable) {
                            console.log(formatWarning(`${icons.warning} This error cannot be fixed by retrying. Returning the error response.`));
                            return responseData;
                        }
                        
                        // For retryable errors, attempt retry if we haven't exhausted retries
                        retries++;
                        if (retries < MAX_REQUEST_RETRIES) {
                            const waitTime = calculateBackoffTime(retries);
                            console.log(formatWarning(`${icons.wait} Retrying in ${waitTime/1000} seconds (Attempt ${retries + 1}/${MAX_REQUEST_RETRIES})...`));
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        } else {
                            // We've exhausted retries
                            console.error(formatError(`${icons.error} Failed after ${MAX_REQUEST_RETRIES} attempts. Returning error response.`));
                            return responseData;
                        }
                    } else if (responseData.status === 'Success') {
                        // Success - return the data with full swap events
                        console.log(formatSuccess(`${icons.success} Jupiter ULTRA transaction successful`));
                        console.log(formatInfo(`${icons.info} Transaction signature: ${responseData.signature}`));
                        return responseData;
                    } else {
                        // Unexpected status value
                        console.error(formatError(`${icons.error} Unexpected status in Jupiter response: ${responseData.status}`));
                        
                        // Try to retry if we haven't exhausted retries
                        retries++;
                        if (retries < MAX_REQUEST_RETRIES) {
                            const waitTime = calculateBackoffTime(retries);
                            console.log(formatWarning(`${icons.wait} Retrying in ${waitTime/1000} seconds (Attempt ${retries + 1}/${MAX_REQUEST_RETRIES})...`));
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                            continue;
                        } else {
                            // We've exhausted retries
                            return responseData;
                        }
                    }
                }
                
                // Handle HTTP error responses
                const responseText = await response.text();
                devLog(`Response status: ${response.status}`);
                devLog("Response body:", responseText);
                
                // Parse the response text if possible
                let parsedError;
                try {
                    parsedError = JSON.parse(responseText);
                } catch (e) {
                    parsedError = { error: responseText };
                }
                
                lastError = new Error(`HTTP ${response.status}: ${parsedError.error || responseText}`);
                
                // Implement specific handling for different status codes
                if (response.status === 429) {
                    // Rate limiting - use exponential backoff
                    console.error(formatError(`${icons.error} Rate limit exceeded (429). Implementing backoff...`));
                    retries++;
                    if (retries < MAX_REQUEST_RETRIES) {
                        const waitTime = calculateBackoffTime(retries, true); // true for rate limiting
                        console.log(formatWarning(`${icons.wait} Rate limited. Retrying in ${waitTime/1000} seconds (Attempt ${retries + 1}/${MAX_REQUEST_RETRIES})...`));
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        throw new Error(`Maximum retries exceeded for rate limiting (429)`);
                    }
                } else if (response.status >= 500) {
                    // Server error - retry with backoff
                    console.error(formatError(`${icons.error} Server error (${response.status}). Retrying...`));
                    retries++;
                    if (retries < MAX_REQUEST_RETRIES) {
                        const waitTime = calculateBackoffTime(retries);
                        console.log(formatWarning(`${icons.wait} Server error. Retrying in ${waitTime/1000} seconds (Attempt ${retries + 1}/${MAX_REQUEST_RETRIES})...`));
                        await new Promise(resolve => setTimeout(resolve, waitTime));
                    } else {
                        throw new Error(`Maximum retries exceeded for server error (${response.status})`);
                    }
                } else if (response.status === 400) {
                    // Bad request - check the error type
                    console.error(formatError(`${icons.error} Bad request (400): ${parsedError.error || 'Unknown error'}`));
                    
                    // Some 400 errors might be retriable
                    if (isRetriableBadRequest(parsedError)) {
                        retries++;
                        if (retries < MAX_REQUEST_RETRIES) {
                            const waitTime = calculateBackoffTime(retries);
                            console.log(formatWarning(`${icons.wait} Retriable bad request. Retrying in ${waitTime/1000} seconds (Attempt ${retries + 1}/${MAX_REQUEST_RETRIES})...`));
                            await new Promise(resolve => setTimeout(resolve, waitTime));
                        } else {
                            throw new Error(`Maximum retries exceeded for bad request (400)`);
                        }
                    } else {
                        // Non-retriable bad request, throw error immediately
                        throw new Error(`Bad request (400): ${parsedError.error || 'Unknown error'}`);
                    }
                } else {
                    // Other status codes - probably not retriable
                    throw new Error(`Failed to execute Jupiter ULTRA order: ${response.status} ${responseText}`);
                }
            } catch (error) {
                // Handle network or timeout errors
                if (error.name === 'AbortError') {
                    lastError = new Error('Jupiter ULTRA execute request timed out');
                    console.error(formatError(`${icons.error} Request timed out after ${TRANSACTION_TIMEOUT/1000} seconds`));
                } else {
                    lastError = error;
                    console.error(formatError(`${icons.error} Error executing request: ${error.message}`));
                }
                
                retries++;
                if (retries >= MAX_REQUEST_RETRIES) {
                    throw lastError;
                }
                
                const waitTime = calculateBackoffTime(retries);
                console.log(formatWarning(`${icons.wait} Error during attempt ${retries}. Retrying in ${waitTime/1000} seconds...`));
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        // We should never reach here due to the retry logic, but just in case
        throw lastError || new Error(`Failed to execute Jupiter ULTRA order after ${MAX_REQUEST_RETRIES} attempts`);
    } catch (error) {
        console.error(formatError(`${icons.error} Error executing Jupiter ULTRA order: ${error.message}`));
        
        // Return a structured error response
        return {
            status: 'Failed',
            error: error.message,
            code: error.code || 'UNKNOWN_ERROR',
            requestId: requestId
        };
    }
}

/**
 * No-op function that replaces cancelPendingBundle
 * Jupiter ULTRA doesn't need cancellation as transactions are handled by the API
 */
function cancelJupiterTransactions() {
    // Jupiter ULTRA doesn't need cancellation as transactions are handled by the API
    console.log(formatInfo(`${icons.info} Jupiter ULTRA transactions don't require cancellation`));
}

/**
 * Calculate backoff time with exponential increase
 * @param {number} retryCount - Current retry attempt (1-based)
 * @param {boolean} isRateLimited - Whether this is for rate limiting
 * @returns {number} - Delay in milliseconds
 */
function calculateBackoffTime(retryCount, isRateLimited = false) {
    // Base delay (3 seconds for regular errors, 5 seconds for rate limiting)
    const baseDelay = isRateLimited ? 5000 : 3000;
    
    // Add jitter to avoid thundering herd problem (±20%)
    const jitter = 0.8 + (Math.random() * 0.4);
    
    // Calculate exponential backoff: baseDelay * 2^(retryCount-1) * jitter
    return Math.min(
        baseDelay * Math.pow(2, retryCount - 1) * jitter,
        60000 // Cap at 60 seconds
    );
}

/**
 * Check if an error code or message indicates a non-retryable error
 * @param {string|number} errorCode - Error code
 * @param {string} errorMessage - Error message
 * @returns {boolean} - True if error should not be retried
 */
function isNonRetryableError(errorCode, errorMessage) {
    // Define error codes and messages that should not be retried
    const nonRetryableCodes = [
        6000, // #6000 - custom program error, typically means contract logic rejection
        4001, // User rejected the transaction
        4100, // Unauthorized
        4200, // The request was denied
    ];
    
    // Check if error code is in non-retryable list
    if (nonRetryableCodes.includes(Number(errorCode))) {
        return true;
    }
    
    // Check for specific error messages that indicate non-retryable conditions
    const nonRetryableMessages = [
        'insufficient funds',
        'account has insufficient funds',
        'invalid signature',
        'invalid account',
        'unauthorized',
        'token account not found',
        'account not found',
        'instruction failed',
        'route unavailable'
    ];
    
    // Check if error message contains any non-retryable phrases
    if (errorMessage && typeof errorMessage === 'string') {
        return nonRetryableMessages.some(phrase => 
            errorMessage.toLowerCase().includes(phrase.toLowerCase())
        );
    }
    
    return false;
}

/**
 * Check if a bad request error is retriable
 * @param {Object} error - Error response object
 * @returns {boolean} - True if error should be retried
 */
function isRetriableBadRequest(error) {
    // Some bad requests might be temporary issues
    const retriableErrorMessages = [
        'timeout',
        'temporary',
        'try again',
        'busy',
        'overloaded',
        'maintenance'
    ];
    
    if (error && error.error && typeof error.error === 'string') {
        return retriableErrorMessages.some(phrase => 
            error.error.toLowerCase().includes(phrase.toLowerCase())
        );
    }
    
    return false;
}

// ===========================
// Swap Function
// ===========================

/**
 * Enhanced executeSwap function that handles both opening and closing positions
 * using only Jupiter ULTRA's ExactIn method with verification for position closing
 * 
 * @param {Object} wallet - Wallet object
 * @param {string} sentiment - Market sentiment
 * @param {number|null} manualTradeAmount - Optional direct trade amount in token units (not smallest units)
 * @param {Object|null} closingInfo - Information for position closing: {isClosingPosition, trade, currentPrice}
 * @returns {Promise<Object|string|null>} Swap result, failure reason, or null
 */
async function executeSwap(wallet, sentiment, manualTradeAmount = null, closingInfo = null) {
    const settings = readSettings();
    if (!settings) {
        console.error(formatError('Failed to read settings'));
        return null;
    }

    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    
    let tradeAmount;
    let isBuying;
    let inputMint;
    let outputMint;
    let marketPrice = null;

    try {
        devLog("Initiating swap with sentiment:", sentiment);
        
        // Check if we need current price for calculations
        if (closingInfo && closingInfo.isClosingPosition) {
            if (closingInfo.currentPrice) {
                marketPrice = closingInfo.currentPrice;
                devLog(`Using provided currentPrice for closing position: ${marketPrice}`);
            } else {
                try {
                    marketPrice = await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
                    closingInfo.currentPrice = marketPrice;
                    console.log(formatInfo(`${icons.price} Fetched current price for closing position: ${formatPrice(marketPrice)}`));
                } catch (priceError) {
                    console.error(formatError(`Error fetching price for closing position: ${priceError.message}`));
                    return null;
                }
            }
        } else {
            // Always fetch the current market price for recording the trade accurately
            try {
                marketPrice = await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
                devLog(`Fetched current market price: ${marketPrice}`);
            } catch (priceError) {
                console.error(formatError(`Error fetching market price: ${priceError.message}`));
                // Continue with the trade - we'll try to fetch the price again later if needed
            }
        }

        // Determine trade direction based on sentiment
        isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
        
        // If closing position, override direction based on trade
        if (closingInfo && closingInfo.isClosingPosition && closingInfo.trade) {
            // Reverse the direction when closing a position
            isBuying = closingInfo.trade.direction === 'sell';
            console.log(formatInfo(`${icons.close} Closing ${closingInfo.trade.direction} position with ${isBuying ? 'buy' : 'sell'} operation`));
        }
        
        inputMint = isBuying ? quoteToken.ADDRESS : baseToken.ADDRESS;
        outputMint = isBuying ? baseToken.ADDRESS : quoteToken.ADDRESS;
        const tokenInfo = isBuying ? quoteToken : baseToken;
        const balance = isBuying ? wallet.quoteBalance : wallet.baseBalance;

        // Calculate trade amount based on different scenarios
        if (manualTradeAmount !== null) {
            // Manual amount provided (used by threshold mode)
            console.log(formatInfo(`${icons.trade} Using provided trade amount: ${manualTradeAmount} ${tokenInfo.NAME}`));
            tradeAmount = Math.floor(manualTradeAmount * Math.pow(10, tokenInfo.DECIMALS));
            console.log(formatInfo(`${icons.balance} Amount in smallest units: ${tradeAmount}`));
        } else if (closingInfo && closingInfo.isClosingPosition && closingInfo.trade) {
            // Calculate amount needed to close the position
            const trade = closingInfo.trade;
            const currentPrice = closingInfo.currentPrice;
            
            console.log(formatInfo(`${icons.trade} Calculating amount to close position with entry price: ${formatPrice(trade.price)}`));
            
            // When closing a position, we want to trade the position's base token amount
            // If we're buying, we need to calculate how much quote token is needed
            if (isBuying) {
                // Closing a sell position by buying base token
                // Calculate how much input (quote token) is needed based on current price
                const baseAmount = trade.baseTokenAmount;
                const quoteNeeded = baseAmount * currentPrice * 1.01; // Add 1% buffer for slippage
                
                console.log(formatInfo(`${icons.balance} Position size: ${formatBalance(baseAmount, baseToken.NAME)}`));
                console.log(formatInfo(`${icons.price} Estimated cost: ${formatPrice(quoteNeeded)}`));
                
                tradeAmount = Math.floor(quoteNeeded * Math.pow(10, quoteToken.DECIMALS));
            } else {
                // Closing a buy position by selling base token
                const baseAmount = trade.baseTokenAmount;
                console.log(formatInfo(`${icons.balance} Selling position size: ${formatBalance(baseAmount, baseToken.NAME)}`));
                
                tradeAmount = Math.floor(baseAmount * Math.pow(10, baseToken.DECIMALS));
            }
            
            console.log(formatInfo(`${icons.balance} Calculated closing amount: ${tradeAmount / Math.pow(10, tokenInfo.DECIMALS)} ${tokenInfo.NAME}`));
        } else {
            // Standard sentiment-based trade amount calculation
            tradeAmount = calculateTradeAmount(balance, sentiment, tokenInfo);
            console.log(formatInfo(`${icons.balance} Calculated amount: ${tradeAmount / Math.pow(10, tokenInfo.DECIMALS)} ${tokenInfo.NAME}`));
        }

        if (!tradeAmount || tradeAmount <= 0) {
            devLog('Invalid trade amount calculated');
            return null;
        }

        devLog(`Using trade amount: ${tradeAmount} smallest units (${tradeAmount / Math.pow(10, tokenInfo.DECIMALS)} ${tokenInfo.NAME})`);

        // Set options for Jupiter ULTRA with fixed 50bps fee
        const ultraOptions = {
            slippageBps: 50, // Default slippage of 0.5%
            swapMode: 'ExactIn' // Jupiter ULTRA only supports ExactIn
        };

        // Step 1: Get order from Jupiter ULTRA API
        console.log(formatInfo(`${icons.info} Preparing Jupiter ULTRA swap...`));
        const orderResponse = await getJupiterUltraOrder(
            inputMint,
            outputMint,
            tradeAmount,
            wallet.publicKey.toString(),
            ultraOptions
        );

        if (!orderResponse || !orderResponse.transaction) {
            console.error(formatError(`Invalid order response from Jupiter ULTRA`));
            
            // Log failed trade
            logTradeToFile({
                inputToken: isBuying ? quoteToken.NAME : baseToken.NAME,
                outputToken: isBuying ? baseToken.NAME : quoteToken.NAME,
                inputAmount: tradeAmount ? (tradeAmount / (10 ** (isBuying ? quoteToken.DECIMALS : baseToken.DECIMALS))).toFixed(6) : '0',
                outputAmount: '0',
                jupiterStatus: 'Failed'
            });
            
            return null;
        }

        // Step 2: Sign the transaction
        const transactionBuf = Buffer.from(orderResponse.transaction, 'base64');
        const transaction = VersionedTransaction.deserialize(transactionBuf);
        
        if (!transaction) {
            console.error(formatError(`Failed to deserialize transaction`));
            return null;
        }
        
        transaction.sign([wallet.payer]);
        const signedTransaction = Buffer.from(transaction.serialize()).toString('base64');

        // Step 3: Execute the order
        console.log(formatInfo(`${icons.wait} Executing swap through Jupiter ULTRA...`));
        const executeResponse = await executeJupiterUltraOrder(signedTransaction, orderResponse.requestId);

        if (executeResponse.status !== 'Success') {
            console.error(formatError(`${icons.error} Swap failed: ${executeResponse.error || 'Unknown error'}`));
            console.error(formatError(`Error code: ${executeResponse.code}`));
            
            // Log failed trade
            logTradeToFile({
                inputToken: isBuying ? quoteToken.NAME : baseToken.NAME,
                outputToken: isBuying ? baseToken.NAME : quoteToken.NAME,
                inputAmount: tradeAmount ? (tradeAmount / (10 ** (isBuying ? quoteToken.DECIMALS : baseToken.DECIMALS))).toFixed(6) : '0',
                outputAmount: '0',
                jupiterStatus: 'Failed'
            });
            
            return null;
        }

        console.log(formatInfo(`${icons.info} Updating Trade Information...`));
        
        // Parse amounts from the swap events - UPDATED to use total amounts
        let inputAmount = 0, outputAmount = 0;

        // Use totalInputAmount and totalOutputAmount fields directly
        if (executeResponse.totalInputAmount && executeResponse.totalOutputAmount) {
            // Use the total amounts, which include all swap events and fees
            inputAmount = parseFloat(executeResponse.totalInputAmount) / (10 ** (isBuying ? quoteToken.DECIMALS : baseToken.DECIMALS));
            outputAmount = parseFloat(executeResponse.totalOutputAmount) / (10 ** (isBuying ? baseToken.DECIMALS : quoteToken.DECIMALS));
            console.log(formatInfo(`${icons.trade} Total trade amounts: ${formatBalance(inputAmount, isBuying ? quoteToken.NAME : baseToken.NAME)} → ${formatBalance(outputAmount, isBuying ? baseToken.NAME : quoteToken.NAME)}`));
            
            // For visibility, also log the number of liquidity pools used
            if (executeResponse.swapEvents && executeResponse.swapEvents.length > 0) {
                console.log(formatInfo(`${icons.info} Trade routed through ${executeResponse.swapEvents.length} liquidity pools`));
            }
        } else if (executeResponse.swapEvents && executeResponse.swapEvents.length > 0) {
            // Fallback to summing up the individual swap events if total fields aren't available
            let totalInputAmount = 0;
            let totalOutputAmount = 0;
            
            console.log(formatInfo(`${icons.info} Trade routed through ${executeResponse.swapEvents.length} liquidity pools`));
            
            // Sum up all swap events
            executeResponse.swapEvents.forEach((swapEvent, index) => {
                const eventInputAmount = parseFloat(swapEvent.inputAmount) / (10 ** (swapEvent.inputMint === baseToken.ADDRESS ? baseToken.DECIMALS : quoteToken.DECIMALS));
                const eventOutputAmount = parseFloat(swapEvent.outputAmount) / (10 ** (swapEvent.outputMint === baseToken.ADDRESS ? baseToken.DECIMALS : quoteToken.DECIMALS));
                
                console.log(formatInfo(`${icons.trade} Pool ${index + 1}: ${formatBalance(eventInputAmount, swapEvent.inputMint === baseToken.ADDRESS ? baseToken.NAME : quoteToken.NAME)} → ${formatBalance(eventOutputAmount, swapEvent.outputMint === baseToken.ADDRESS ? baseToken.NAME : quoteToken.NAME)}`));
                
                // Only count events that match our expected direction
                if ((isBuying && swapEvent.outputMint === baseToken.ADDRESS) || 
                    (!isBuying && swapEvent.inputMint === baseToken.ADDRESS)) {
                    totalInputAmount += parseFloat(swapEvent.inputAmount);
                    totalOutputAmount += parseFloat(swapEvent.outputAmount);
                }
            });
            
            inputAmount = totalInputAmount / (10 ** (isBuying ? quoteToken.DECIMALS : baseToken.DECIMALS));
            outputAmount = totalOutputAmount / (10 ** (isBuying ? baseToken.DECIMALS : quoteToken.DECIMALS));
        } else {
            // Fallback to result amounts as last resort
            inputAmount = parseFloat(executeResponse.inputAmountResult) / (10 ** (isBuying ? quoteToken.DECIMALS : baseToken.DECIMALS));
            outputAmount = parseFloat(executeResponse.outputAmountResult) / (10 ** (isBuying ? baseToken.DECIMALS : quoteToken.DECIMALS));
            console.log(formatWarning(`${icons.warning} Using result amounts: ${formatBalance(inputAmount, isBuying ? quoteToken.NAME : baseToken.NAME)} → ${formatBalance(outputAmount, isBuying ? baseToken.NAME : quoteToken.NAME)}`));
        }

        // Log the trade
        logTradeToFile({
            inputToken: isBuying ? quoteToken.NAME : baseToken.NAME,
            outputToken: isBuying ? baseToken.NAME : quoteToken.NAME,
            inputAmount: inputAmount.toFixed(6),
            outputAmount: outputAmount.toFixed(6),
            jupiterStatus: 'Success'
        });

        // Calculate token changes using token-agnostic approach
        const baseTokenChange = isBuying ? outputAmount : -inputAmount;
        const quoteTokenChange = isBuying ? -inputAmount : outputAmount;
        
        // PRICE FIX: Use the market price we already fetched instead of calculating from the swap amounts
        let calculatedPrice;
        
        // If we have the market price from earlier, use it
        if (marketPrice) {
            calculatedPrice = marketPrice;
        } 
        // If we're closing a position and have currentPrice, use that
        else if (closingInfo && closingInfo.currentPrice) {
            calculatedPrice = closingInfo.currentPrice;
        } 
        // Otherwise, fetch it now
        else {
            try {
                calculatedPrice = await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
                console.log(formatInfo(`${icons.price} Fetched market price for trade: ${formatPrice(calculatedPrice)}`));
            } catch (priceError) {
                // As a last resort, calculate price from the trade amounts (not ideal)
                calculatedPrice = Math.abs(quoteTokenChange / baseTokenChange);
                console.log(formatWarning(`${icons.warning} Could not fetch market price, using calculated price: ${formatPrice(calculatedPrice)}`));
            }
        }

        console.log(formatSuccess(`${icons.success} Trade Successful!`));
        console.log(formatInfo(`${icons.info} Transaction ID: ${executeResponse.signature}`));
        console.log(formatInfo(`${icons.info} Explorer URL: https://solscan.io/tx/${executeResponse.signature}`));
        console.log(formatInfo(`${icons.price} Trade recorded at market price: ${formatPrice(calculatedPrice)}`));
        
        // If this was closing a position, verify if it was successful (closed at least 98.5%)
        let verificationResult = null;
        if (closingInfo && closingInfo.isClosingPosition && closingInfo.trade) {
            // Calculate how much of the position was actually closed
            const trade = closingInfo.trade;
            const wasOriginallyBuy = trade.direction === 'buy';
            
            // Get actual closed amount
            const actualBaseTokenClosed = Math.abs(baseTokenChange);
            const targetBaseTokenAmount = trade.baseTokenAmount;
            
            // Calculate close percentage
            const closePercentage = (actualBaseTokenClosed / targetBaseTokenAmount) * 100;
            
            console.log(formatInfo(`${icons.info} Position close verification:`));
            console.log(`  - Target amount: ${targetBaseTokenAmount} ${baseToken.NAME}`);
            console.log(`  - Actual closed: ${actualBaseTokenClosed} ${baseToken.NAME}`);
            console.log(`  - Close percentage: ${closePercentage.toFixed(2)}%`);
            
            // As required: >98.5% = success
            const isSuccessfulClose = closePercentage >= 98.5;
            verificationResult = {
                success: isSuccessfulClose,
                fullyClose: isSuccessfulClose,
                message: isSuccessfulClose
                    ? `Position successfully closed (${closePercentage.toFixed(2)}%)`
                    : `Position only partially closed (${closePercentage.toFixed(2)}%)`,
                remainingAmount: isSuccessfulClose ? 0 : targetBaseTokenAmount - actualBaseTokenClosed,
                closePercentage: closePercentage
            };
            
            console.log(formatInfo(`${icons.info} ${verificationResult.message}`));
        }
        
        lastTradeTime.set(wallet.publicKey.toString(), Date.now());
        
        // Return in a format compatible with existing code
        return {
            txId: executeResponse.signature,
            price: calculatedPrice,  // Use the correct market price here
            baseTokenChange,
            quoteTokenChange,
            appliedFeeBps: 0,  // No extra fees applied
            jupiterUltra: true,
            status: executeResponse.status,
            signature: executeResponse.signature,
            slot: executeResponse.slot,
            requestId: orderResponse.requestId,
            inAmount: orderResponse.inAmount,
            outAmount: orderResponse.outAmount,
            swapType: orderResponse.swapType,
            slippageBps: orderResponse.slippageBps,
            routePlan: orderResponse.routePlan,
            // Include verification result if this was a position close
            verificationResult
        };

    } catch (error) {
        console.error(formatError(`Error executing swap: ${error.message}`));
        
        // Log failed trade
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();
        
        logTradeToFile({
            inputToken: isBuying ? quoteToken.NAME : baseToken.NAME,
            outputToken: isBuying ? baseToken.NAME : quoteToken.NAME,
            inputAmount: tradeAmount ? (tradeAmount / (10 ** (isBuying ? quoteToken.DECIMALS : baseToken.DECIMALS))).toFixed(6) : '0',
            outputAmount: '0',
            jupiterStatus: 'Failed'
        });

        return null;
    }
}

// ===========================
// Trade Logging
// ===========================

/**
 * Logs trade execution to CSV file
 * @param {Object} tradeData - Data about the executed trade
 */
function logTradeToFile(tradeData) {
    try {
        // Get only the essential trade data with default values to prevent undefined
        const {
            inputToken = '',
            outputToken = '',
            inputAmount = 0,
            outputAmount = 0,
            jupiterStatus = 'Unknown'
        } = tradeData || {};

        // Create timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);

        // Create CSV line with timestamp
        const csvLine = `${timestamp},${inputToken},${outputToken},${inputAmount},${outputAmount},${jupiterStatus}\n`;

        // Get user folder path (two levels up from src directory)
        const userFolder = path.join(__dirname, '..', '..', 'user');

        // Create user folder if it doesn't exist
        if (!fs.existsSync(userFolder)) {
            fs.mkdirSync(userFolder, { recursive: true });
        }

        // Create filename with current date
        const fileName = `Pulse Log ${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}.csv`;
        const filePath = path.join(userFolder, fileName);

        // Create headers if file doesn't exist
        if (!fs.existsSync(filePath)) {
            const headers = 'Timestamp,Input Token,Output Token,Input Amount,Output Amount,Jupiter Status\n';
            fs.writeFileSync(filePath, headers);
        }

        // Append the trade data
        fs.appendFileSync(filePath, csvLine);
        devLog('Successfully logged trade data');

    } catch (error) {
        console.error(formatError(`Error logging trade: ${error.message}`));
        console.error(formatError('Error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        }));
    }
}

/**
 * Logs position update details
 * @param {Object} position - Position object
 * @param {number} currentPrice - Current token price
 */
function logPositionUpdate(position, currentPrice) {
    const enhancedStats = position.getEnhancedStatistics(currentPrice);
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();

    devLog("\n--- Current Position ---");
    devLog(`${baseToken.NAME} Balance: ${formatTokenAmount(position.baseBalance, baseToken)} ${baseToken.NAME}`);
    devLog(`${quoteToken.NAME} Balance: ${formatTokenAmount(position.quoteBalance, quoteToken)} ${quoteToken.NAME}`);
    devLog(`Average Entry Price: $${enhancedStats.averagePrices.entry}`);
    devLog(`Average Sell Price: $${enhancedStats.averagePrices.sell}`);
    devLog(`Current ${baseToken.NAME} Price: $${currentPrice.toFixed(2)}`);
    devLog(`Initial Portfolio Value: $${enhancedStats.portfolioValue.initial}`);
    devLog(`Current Portfolio Value: $${enhancedStats.portfolioValue.current}`);
    devLog(`Net Change: $${enhancedStats.netChange}`);
    devLog(`Portfolio Change: ${enhancedStats.portfolioValue.percentageChange}%`);
    devLog(`Total Volume: ${enhancedStats.totalVolume.baseToken} ${baseToken.NAME} / ${enhancedStats.totalVolume.quoteToken} ${quoteToken.NAME}`);
    devLog("------------------------\n");
}

// ===========================
// Trade Size Calculation
// ===========================

/**
 * Calculates appropriate trade amount based on sentiment and balance
 * @param {number} balance - Available balance
 * @param {string} sentiment - Market sentiment
 * @param {Object} tokenInfo - Token information
 * @returns {number} Trade amount in token decimal format
 */
function calculateTradeAmount(balance, sentiment, tokenInfo) {
    try {
        if (!balance || balance <= 0) {
            console.error(formatError(`Invalid balance: ${balance}`));
            return 0;
        }

        if (!sentiment || typeof sentiment !== 'string') {
            console.error(formatError(`Invalid sentiment: ${sentiment}`));
            return 0;
        }

        if (!tokenInfo || !tokenInfo.DECIMALS) {
            console.error(formatError('Invalid token information'));
            return 0;
        }

        const settings = readSettings();
        if (!settings) {
            console.error(formatError('Failed to read settings'));
            return 0;
        }

        const {
            SENTIMENT_MULTIPLIERS,
            TRADE_SIZE_METHOD,
            STRATEGIC_PERCENTAGE
        } = settings;

        if (!SENTIMENT_MULTIPLIERS || !SENTIMENT_MULTIPLIERS[sentiment]) {
            console.error(formatError(`Invalid sentiment multiplier for sentiment: ${sentiment}`));
            return 0;
        }

        const sentimentMultiplier = SENTIMENT_MULTIPLIERS[sentiment];
        
        // Handle invalid TRADE_SIZE_METHOD
        if (!['VARIABLE', 'STRATEGIC'].includes(TRADE_SIZE_METHOD)) {
            console.error(formatWarning(`Invalid trade size method: ${TRADE_SIZE_METHOD}, defaulting to STRATEGIC`));
        }

        if (TRADE_SIZE_METHOD === 'VARIABLE') {
            const rawAmount = balance * sentimentMultiplier;
            return Math.floor(rawAmount * (10 ** tokenInfo.DECIMALS));
        } else { // Default to STRATEGIC
            const wallet = getWallet();
            const { needsNewPeriod, currentBaseSizes } = checkTradingPeriod();
            if (needsNewPeriod) {
                const baseSizes = setNewTradingPeriod(
                    wallet.baseBalance,
                    wallet.quoteBalance,
                    STRATEGIC_PERCENTAGE
                );
                const isBaseToken = tokenInfo.NAME === getBaseToken().NAME;
                const baseAmount = isBaseToken ? baseSizes.BASE : baseSizes.QUOTE;
                return Math.floor(baseAmount * (10 ** tokenInfo.DECIMALS));
            }
        
            const isBaseToken = tokenInfo.NAME === getBaseToken().NAME;
            const baseAmount = isBaseToken ? currentBaseSizes.BASE : currentBaseSizes.QUOTE;
            return Math.floor(baseAmount * (10 ** tokenInfo.DECIMALS));
        }
    } catch (error) {
        console.error(formatError(`Error calculating trade amount: ${error.message}`));
        return 0;
    }
}

// ===========================
// Portfolio Management
// ===========================

/**
 * Gets token balance for a specific wallet and mint
 * @param {Object} connection - RPC connection
 * @param {string} walletAddress - Wallet address
 * @param {string} mintAddress - Token mint address
 * @returns {Promise<number>} Token balance
 */
async function getTokenBalance(connection, walletAddress, mintAddress) {
    if (!connection) {
        console.error(formatError("Connection object is undefined"));
        return 0;
    }

    if (!walletAddress || !mintAddress) {
        console.error(formatError("Invalid wallet or mint address"));
        return 0;
    }

    try {
        if (mintAddress === "So11111111111111111111111111111111111111112") {
            const balance = await connection.getBalance(new PublicKey(walletAddress));
            return balance / 1e9; // Convert lamports to SOL
        } else {
            const tokenMint = new PublicKey(mintAddress);
            const walletPublicKey = new PublicKey(walletAddress);
            const tokenAddress = await getAssociatedTokenAddress(tokenMint, walletPublicKey);

            const balance = await connection.getTokenAccountBalance(tokenAddress);

            return parseFloat(balance.value.uiAmount);
        }
    } catch (error) {
        console.error(formatError(`Error fetching token balance: ${error.message}`));
        return 0;
    }
}

/**
 * Updates portfolio balances
 * @param {Object} wallet - Wallet object
 * @param {Object} connection - RPC connection
 * @returns {Promise<Object>} Updated balances
 */
async function updatePortfolioBalances(wallet, connection) {
    if (!wallet || !connection) {
        throw new Error("Wallet or connection is not initialised");
    }

    try {
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();
        
        const baseBalance = await getTokenBalance(connection, wallet.publicKey.toString(), baseToken.ADDRESS);
        const quoteBalance = await getTokenBalance(connection, wallet.publicKey.toString(), quoteToken.ADDRESS);

        // Check if balances are suspiciously zero - might indicate RPC issue
        if (baseBalance === 0 && quoteBalance === 0) {
            devLog(formatWarning("Warning: Both balances returned as 0, attempting RPC failover..."));
            const failoverSuccess = await attemptRPCFailover(wallet);

            if (failoverSuccess) {
                // Retry with new connection
                const newBaseBalance = await getTokenBalance(wallet.connection, wallet.publicKey.toString(), baseToken.ADDRESS);
                const newQuoteBalance = await getTokenBalance(wallet.connection, wallet.publicKey.toString(), quoteToken.ADDRESS);

                // Update wallet properties
                wallet.baseBalance = newBaseBalance;
                wallet.quoteBalance = newQuoteBalance;

                return { 
                    baseBalance: newBaseBalance, 
                    quoteBalance: newQuoteBalance
                };
            }
        }

        // Update wallet properties
        wallet.baseBalance = baseBalance;
        wallet.quoteBalance = quoteBalance;

        return { 
            baseBalance, 
            quoteBalance
        };
    } catch (error) {
        console.error(formatError(`Error updating portfolio balances: ${error.message}`));

        // Attempt failover on error
        try {
            const failoverSuccess = await attemptRPCFailover(wallet);
            if (failoverSuccess) {
                // Retry the balance update with new connection
                return updatePortfolioBalances(wallet, wallet.connection);
            }
        } catch (failoverError) {
            console.error(formatError(`Failover attempt failed: ${failoverError.message}`));
        }

        throw error;
    }
}

/**
 * Updates position from swap result
 * @param {Object} position - Position object
 * @param {Object} swapResult - Swap result
 * @param {string} sentiment - Market sentiment
 * @param {number} currentPrice - Current token price
 * @returns {Object|null} Trade summary or null on failure
 */
function updatePositionFromSwap(position, swapResult, sentiment, currentPrice) {
    if (!swapResult) {
        devLog("No swap executed or swap failed. Position remains unchanged.");
        return null;
    }

    try {
        devLog('Swap result:', swapResult);
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();

        const { price, baseTokenChange, quoteTokenChange, txId } = swapResult;

        if (price === undefined || baseTokenChange === undefined || quoteTokenChange === undefined) {
            console.error(formatError('Swap result missing critical information'));
            return null;
        }

        devLog('Updating position with:', { price, baseTokenChange, quoteTokenChange, txId });

        position.logTrade(sentiment, price, baseTokenChange, quoteTokenChange);
        logPositionUpdate(position, currentPrice);

        const tradeType = baseTokenChange > 0 ? "Bought" : "Sold";
        const tradeAmount = Math.abs(baseTokenChange);

        return {
            type: tradeType,
            amount: tradeAmount,
            price: price,
            timestamp: new Date().toISOString(),
            txUrl: `https://solscan.io/tx/${txId}`,
            tokenInfo: {
                baseToken: baseToken.NAME,
                quoteToken: quoteToken.NAME,
                baseTokenDecimals: baseToken.DECIMALS,
                quoteTokenDecimals: quoteToken.DECIMALS
            }
        };
    } catch (error) {
        console.error(formatError(`Error updating position from swap: ${error.message}`));
        return null;
    }
}

// ===========================
// Position Management
// ===========================

/**
 * Resets trading position and initialises new state
 * @returns {Promise<Object>} Initial data
 */
async function resetPosition() {
    devLog("Resetting position and orderBook...");
    
    try {
        // Get updated wallet and connection
        const wallet = getWallet();
        const connection = getConnection();
        
        // Get token configurations
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();

        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialised in resetPosition");
        }

        // Get current balances and price
        const { baseBalance, quoteBalance } = await updatePortfolioBalances(wallet, connection);
        const currentPrice = await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
        
        // Create new position
        const Position = require('./Position'); // Dynamically import to avoid circular dependencies
        const position = new Position(baseBalance, quoteBalance, currentPrice);
        
        // Update orderBook storage path for current tokens then reset trades
        const orderBook = global.orderBook; // Assuming orderBook is globally available
        if (orderBook) {
            orderBook.updateStoragePathForTokens();
            orderBook.trades = [];
            orderBook.saveTrades();
        } else {
            devLog("Warning: orderBook not available, skipping orderBook reset");
        }

        // Get current fear & greed index
        const fearGreedIndex = await fetchFearGreedIndex();
        const { getSentiment } = require('./api');
        const sentiment = getSentiment(fearGreedIndex);
        
        // Create initial data for UI
        const initialData = {
            timestamp: formatTime(new Date()), // Assuming formatTime is available
            price: currentPrice,
            fearGreedIndex,
            sentiment,
            quoteBalance: position.quoteBalance,
            baseBalance: position.baseBalance,
            portfolioValue: position.getCurrentValue(currentPrice),
            netChange: 0,
            averageEntryPrice: 0,
            averageSellPrice: 0,
            initialPrice: currentPrice,
            initialPortfolioValue: position.getCurrentValue(currentPrice),
            initialBaseBalance: baseBalance,
            initialQuoteBalance: quoteBalance,
            startTime: Date.now(),
            tokenInfo: {
                baseToken: baseToken.NAME,
                quoteToken: quoteToken.NAME,
                baseTokenDecimals: baseToken.DECIMALS,
                quoteTokenDecimals: quoteToken.DECIMALS
            }
        };

        // Set initial data and emit to UI
        const { setInitialData, emitTradingData, clearRecentTrades, saveState } = require('./pulseServer');
        setInitialData(initialData);
        emitTradingData({ ...initialData, version: getVersion() }); // Assuming getVersion is available
        clearRecentTrades();

        // Save initial state
        saveState({
            position: {
                baseBalance: position.baseBalance,
                quoteBalance: position.quoteBalance,
                initialBaseBalance: position.initialBaseBalance,
                initialQuoteBalance: position.initialQuoteBalance,
                initialPrice: position.initialPrice,
                initialValue: position.initialValue,
                totalBaseBought: 0,
                totalQuoteSpent: 0,
                totalBaseSold: 0,
                totalQuoteReceived: 0,
                netBaseTraded: 0,
                startTime: position.startTime,
                totalCycles: 0,
                totalVolumeBase: 0,
                totalVolumeQuote: 0,
                trades: []
            },
            tradingData: initialData,
            settings: readSettings(),
            orderBook: orderBook ? orderBook.getState() : {}
        });
        
        devLog(`Position reset successfully. ${baseToken.NAME} Balance: ${formatTokenAmount(baseBalance, baseToken)}, ${quoteToken.NAME} Balance: ${formatTokenAmount(quoteBalance, quoteToken)}`);
        
        return initialData;
    } catch (error) {
        console.error(formatError(`Error resetting position: ${error.message}`));
        throw error;
    }
}

// ===========================
// Module Exports
// ===========================

module.exports = {
    executeSwap,
    logTradeToFile,
    calculateTradeAmount,
    updatePortfolioBalances,
    updatePositionFromSwap,
    logPositionUpdate,
    getTokenBalance,
    resetPosition,
    // Jupiter ULTRA exports
    getJupiterUltraOrder,
    executeJupiterUltraOrder,
    cancelJupiterTransactions,
    // Token-agnostic exports
    BASE_TOKEN,
    QUOTE_TOKEN
};