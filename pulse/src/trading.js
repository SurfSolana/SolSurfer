/**
 * PulseSurfer Trading Module
 * Handles swap execution, bundle creation, and position management
 */

// Core dependencies
const { 
    getQuote, 
    getFeeAccountAndSwapTransaction, 
    BASE_SWAP_URL, 
    fetchFearGreedIndex, 
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
const MAX_BUNDLE_RETRIES = 5;
const BUNDLE_RETRY_DELAY = 2000; // 2 seconds
const MAX_BUNDLE_CONFIRMATION_RETRIES = 60; // 2 minutes with 2s intervals
const STATUS_CHECK_INTERVAL = 2000; // 2 seconds
const DEFAULT_TIP = 0.0004; // 0.0004 SOL

// Jito MEV configuration
const JitoBlockEngine = "https://mainnet.block-engine.jito.wtf/api/v1/bundles";
const TIP_ACCOUNTS = [
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT"
];
const maxJitoTip = 0.0004; // Cap for Jito tip

// State tracking
const lastTradeTime = new Map();
let isBundleCancelled = false;

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
            jitoStatus = 'Unknown'
        } = tradeData || {};

        // Create timestamp
        const now = new Date();
        const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);

        // Create CSV line with timestamp
        const csvLine = `${timestamp},${inputToken},${outputToken},${inputAmount},${outputAmount},${jitoStatus}\n`;

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
            const headers = 'Timestamp,Input Token,Output Token,Input Amount,Output Amount,Jito Status\n';
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


/**
 * Gets a random tip account from the tip accounts list
 * @returns {string} Random tip account public key
 */
function getRandomTipAccount() {
    return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
}

// ===========================
// Jito Interactions
// ===========================

/**
 * Fetches the current Jito tip floor
 * @returns {Promise<number>} Current tip floor
 */
async function jitoTipCheck() {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 21000);
        
        const response = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const data = await response.json();

        if (!Array.isArray(data) || !data[0] || data[0].ema_landed_tips_50th_percentile === null) {
            throw new Error('Invalid tip floor data structure');
        }

        const emaPercentile50th = data[0].ema_landed_tips_50th_percentile;
        devLog('Current Jito tip floor (50th EMA):', emaPercentile50th);
        return emaPercentile50th;

    } catch (error) {
        console.error(formatError(`Error fetching Jito tip floor: ${error.message}`));
        return DEFAULT_TIP; // Return default tip on error
    }
}

/**
 * Cancels any pending Jito bundle
 */
function cancelPendingBundle() {
    isBundleCancelled = true;
    devLog('Jito bundle cancelled by user');
}

/**
 * Sends a bundle to Jito Block Engine
 * @param {Array<VersionedTransaction>} bundletoSend - Array of transactions
 * @returns {Promise<string>} Bundle ID
 */
async function sendJitoBundle(bundletoSend) {
    // Validate input
    if (!Array.isArray(bundletoSend) || bundletoSend.length === 0) {
        throw new Error('Invalid bundle input');
    }
    
    let encodedBundle;
    try {
        encodedBundle = bundletoSend.map((tx, index) => {
            if (!(tx instanceof VersionedTransaction)) {
                throw new Error(`Transaction at index ${index} is not a VersionedTransaction`);
            }
            const serialized = tx.serialize();
            const encoded = bs58.default.encode(serialized);
            return encoded;
        });
    } catch (error) {
        console.error(formatError(`Error encoding transactions: ${error.message}`));
        throw error;
    }

    const data = {
        jsonrpc: "2.0",
        id: 1,
        method: "sendBundle",
        params: [encodedBundle]
    };

    devLog("Sending bundle to Jito Block Engine...");

    let response;
    for (let i = 0; i <= MAX_BUNDLE_RETRIES; i++) {
        if (isBundleCancelled) {
            throw new Error('Bundle cancelled by user');
        }
        
        try {
            // Add timeout to fetch
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000);
            
            response = await fetch(JitoBlockEngine, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(data),
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            if (response.ok) {
                break;
            }

            const responseText = await response.text();
            devLog(`Response status: ${response.status}`);
            devLog("Response body:", responseText);

            if (response.status === 400) {
                console.error(formatError(`Bad Request Error: ${responseText}`));
                throw new Error(`Bad Request: ${responseText}`);
            }

            if (response.status === 429) {
                const waitTime = Math.min(500 * Math.pow(2, i), 5000);
                const jitter = Math.random() * 0.3 * waitTime;
                devLog(`Rate limited. Retrying in ${waitTime + jitter}ms...`);
                await new Promise((resolve) => setTimeout(resolve, waitTime + jitter));
            } else {
                throw new Error(`Unexpected response status: ${response.status}`);
            }
        } catch (error) {
            console.error(formatError(`Error on attempt ${i + 1}: ${error.message}`));
            if (i === MAX_BUNDLE_RETRIES) {
                console.error(formatError("Max retries exceeded"));
                throw error;
            }
        }
    }

    if (!response || !response.ok) {
        throw new Error(`Failed to send bundle after ${MAX_BUNDLE_RETRIES} attempts`);
    }

    const responseText = await response.text();

    let responseData;
    try {
        responseData = JSON.parse(responseText);
    } catch (error) {
        console.error(formatError(`Error parsing Jito response: ${error.message}`));
        throw new Error("Failed to parse Jito response");
    }

    if (responseData.error) {
        console.error(formatError(`Jito Block Engine returned an error: ${responseData.error.message}`));
        throw new Error(`Jito error: ${responseData.error.message}`);
    }

    const result = responseData.result;
    if (!result) {
        console.error(formatError("No result in Jito response"));
        throw new Error("No result in Jito response");
    }

    const url = `https://explorer.jito.wtf/bundle/${result}`;
    devLog(`\nJito Bundle Result: ${url}`);

    return result;
}

/**
 * Gets the status of an in-flight bundle
 * @param {string} bundleId - Bundle ID
 * @returns {Promise<Object|null>} Bundle status
 */
async function getInFlightBundleStatus(bundleId) {
    if (!bundleId) {
        throw new Error('Invalid bundle ID');
    }
    
    const data = {
        jsonrpc: "2.0",
        id: 1,
        method: "getInflightBundleStatuses",
        params: [[bundleId]]
    };

    try {
        // Add timeout to fetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 30000);
        
        const response = await fetch(JitoBlockEngine, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data),
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const responseData = await response.json();

        if (responseData.error) {
            throw new Error(`Jito API error: ${responseData.error.message}`);
        }

        const result = responseData.result.value[0];
        return result || null;
    } catch (error) {
        console.error(formatError(`Error fetching bundle status: ${error.message}`));
        throw error;
    }
}

/**
 * Waits for a bundle to confirm
 * @param {string} bundleId - Bundle ID
 * @returns {Promise<Object>} Bundle confirmation status
 */
async function waitForBundleConfirmation(bundleId) {
    const checkInterval = STATUS_CHECK_INTERVAL;
    let retries = 0;
    const maxRetries = MAX_BUNDLE_CONFIRMATION_RETRIES;

    while (retries < maxRetries && !isBundleCancelled) {
        try {
            const status = await getInFlightBundleStatus(bundleId);

            if (isBundleCancelled) {
                devLog('Bundle confirmation cancelled by user');
                return { status: "Failed", reason: "Bundle cancelled by user" };
            }

            if (status === null) {
                devLog("Bundle not found. Continuing to wait...");
            } else {
                devLog(`Bundle status: ${status.status}`);

                if (status.status === "Landed" || status.status === "Failed") {
                    return status;
                }
            }
        } catch (error) {
            console.error(formatError(`Error fetching bundle status: ${error.message}`));
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
        retries++;
    }

    if (isBundleCancelled) {
        return { status: "Failed", reason: "Bundle cancelled by user" };
    }

    return { status: "Failed", reason: "Bundle did not land or fail within expected time" };
}

/**
 * Handles Jito bundle creation and submission
 * @param {Object} wallet - Wallet object
 * @param {string} initialSwapTransaction - Encoded swap transaction
 * @param {number} tradeAmount - Trade amount
 * @param {Object} initialQuote - Quote from Jupiter
 * @param {boolean} isBuying - Whether this is a buy trade
 * @returns {Promise<Object|null>} Bundle result or null on failure
 */
async function handleJitoBundle(wallet, initialSwapTransaction, tradeAmount, initialQuote, isBuying) {
    isBundleCancelled = false;
    try {
        devLog(`\nAttempting to send Jito bundle...`);

        if (isBundleCancelled) {
            devLog('Bundle cancelled, abandoning transaction...');
            return null;
        }

        // Deserialize the transaction
        let transaction;
        try {
            const swapTransactionBuf = Buffer.from(initialSwapTransaction, 'base64');
            transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        } catch (error) {
            console.error(formatError(`Failed to deserialize transaction: ${error.message}`));
            return null;
        }

        // Get Jito tip amount
        let tipValueInSol;
        try {
            tipValueInSol = await jitoTipCheck();
        } catch (error) {
            tipValueInSol = maxJitoTip; // Fallback to max tip if check fails
        }

        const limitedTipValueInLamports = Math.floor(
            Math.min(tipValueInSol, maxJitoTip) * 1_000_000_000 * 1.1
        );

        devLog(`Jito Fee: ${limitedTipValueInLamports / Math.pow(10, 9)} SOL`);

        if (isBundleCancelled) return null;

        // Get fresh blockhash
        const { blockhash } = await wallet.connection.getLatestBlockhash("confirmed");
        devLog(`\nNew Blockhash: ${blockhash}`);

        // Create tip transaction with new blockhash
        const tipAccount = new PublicKey(getRandomTipAccount());
        const tipIxn = SystemProgram.transfer({
            fromPubkey: wallet.publicKey,
            toPubkey: tipAccount,
            lamports: limitedTipValueInLamports
        });

        const messageSub = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash: blockhash,
            instructions: [tipIxn]
        }).compileToV0Message();

        const txSub = new VersionedTransaction(messageSub);
        transaction.message.recentBlockhash = blockhash;

        //incrementTx.sign([wallet.payer]);
        txSub.sign([wallet.payer]);
        transaction.sign([wallet.payer]);

        //const bundleToSend = [transaction, txSub, incrementTx]; (Keep the old one spare)
        const bundleToSend = [transaction, txSub];

        devLog(`Sending bundle with blockhash: ${blockhash}`);
        const jitoBundleResult = await sendJitoBundle(bundleToSend);

        const swapTxSignature = bs58.default.encode(transaction.signatures[0]);
        const tipTxSignature = bs58.default.encode(txSub.signatures[0]);

        if (isBundleCancelled) return null;

        devLog(`\nWaiting for bundle confirmation...`);
        const confirmationResult = await waitForBundleConfirmation(jitoBundleResult);

        if (confirmationResult.status === "Landed") {
            devLog(`Bundle landed successfully`);
            return {
                jitoBundleResult,
                swapTxSignature,
                tipTxSignature,
                finalQuote: initialQuote,
                ...confirmationResult,
                finalBlockhash: blockhash
            };
        }

        devLog(`\nBundle failed. Blockhash: ${blockhash}`);
        return null;

    } catch (error) {
        console.error(formatError(`Bundle execution failed: ${error.message}`));
        return null;
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
// Swap Execution
// ===========================

/**
 * Executes a swap with exact output amount
 * @param {Object} wallet - Wallet object
 * @param {string} outputMint - Output token mint
 * @param {number} exactOutAmount - Exact output amount
 * @param {string} inputMint - Input token mint
 * @param {Object} trade - Trade object being closed (optional)
 * @param {number} currentPrice - Current token price (optional)
 * @returns {Promise<Object|null>} Swap result or null on failure
 */
async function executeExactOutSwap(wallet, outputMint, exactOutAmount, inputMint, trade = null, currentPrice = null) {
    try {
        devLog("Initiating exact out swap");
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();

        // Validate inputs
        if (!wallet || !outputMint || !exactOutAmount || !inputMint) {
            throw new Error('Missing required parameters for exact out swap');
        }

        // Determine token decimals based on the output mint
        const decimals = outputMint === baseToken.ADDRESS ? baseToken.DECIMALS : quoteToken.DECIMALS;
        const exactOutAmountFloor = Math.floor(exactOutAmount);

        devLog(`Exact Out Swap Details:`, {
            outputMint: outputMint === baseToken.ADDRESS ? baseToken.NAME : quoteToken.NAME,
            inputMint: inputMint === baseToken.ADDRESS ? baseToken.NAME : quoteToken.NAME,
            rawAmount: exactOutAmount,
            adjustedAmount: exactOutAmountFloor,
            decimals: decimals
        });

        // Calculate profit-based fee if this is closing a trade
        let profitFeeBps = 0;
        if (trade && trade.price && currentPrice !== null) {
            // Calculate profit based on trade direction
            const profit = trade.direction === 'buy' ? 
                (currentPrice - trade.price) * trade.baseTokenAmount :
                (trade.price - currentPrice) * trade.baseTokenAmount;
            
            devLog(`Trade direction: ${trade.direction}, Entry price: ${trade.price}, Current price: ${currentPrice}`);
            devLog(`Base token amount: ${trade.baseTokenAmount}, Calculated profit: ${profit}`);
            
            // Only apply profit fee if positive
            if (profit > 0) {
                // Calculate 10% of profit as the fee
                const profitFee = profit * 0.1;
                
                // Calculate the total swap value in quote token
                const isOutputBase = outputMint === baseToken.ADDRESS;
                const exactOutAmountDecimal = exactOutAmount / (10 ** (isOutputBase ? baseToken.DECIMALS : quoteToken.DECIMALS));
                const swapValueInQuote = isOutputBase ? exactOutAmountDecimal * currentPrice : exactOutAmountDecimal;
                
                // Calculate fee as basis points of swap value
                profitFeeBps = Math.round((profitFee / swapValueInQuote) * 10000);
                
                devLog(`Profit: ${profit}, Fee: ${profitFee}, Swap Value in Quote: ${swapValueInQuote}, Fee BPS: ${profitFeeBps}`);
                
                // Ensure fee doesn't exceed a reasonable limit
                if (profitFeeBps > 1000) {
                    devLog(`Profit fee BPS capped from ${profitFeeBps} to 1000`);
                    profitFeeBps = 1000;
                }
            }
        }

        // Combine fixed fee (1 bps) with profit-based fee
        const totalFeeBps = 1 + profitFeeBps; // 1 bps fixed fee + profit-based fee
        
        // Build params for Jupiter API
        const params = new URLSearchParams({
            inputMint: inputMint,
            outputMint: outputMint,
            amount: exactOutAmountFloor.toString(),
            slippageBps: '50',
            platformFeeBps: totalFeeBps.toString(), // Updated fee structure
            onlyDirectRoutes: 'false',
            asLegacyTransaction: 'false',
            swapMode: 'ExactOut'
        });

        const quoteUrl = `${BASE_SWAP_URL}/quote?${params.toString()}`;
        devLog(quoteUrl);
        
        // Add timeout to fetch
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TRANSACTION_TIMEOUT);
        
        const response = await fetch(quoteUrl, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const quoteResponse = await response.json();

        // Get fee account and transaction
        let swapTransaction = await getFeeAccountAndSwapTransaction(
            new PublicKey("DGQRoyxV4Pi7yLnsVr1sT9YaRWN9WtwwcAiu3cKJsV9p"),
            new PublicKey(inputMint),
            quoteResponse,
            wallet
        );

        if (!swapTransaction) {
            devLog('Failed to create swap transaction');
            return null;
        }

        console.log(formatInfo(`${icons.wait} Awaiting Confirmation...`));
        const jitoBundleResult = await handleJitoBundle(wallet, swapTransaction, quoteResponse.inAmount, quoteResponse, inputMint === baseToken.ADDRESS);

        if (!jitoBundleResult) return null;

        console.log(formatInfo(`${icons.info} Updating Trade Information...`));
        const inputAmount = quoteResponse.inAmount / (10 ** (inputMint === baseToken.ADDRESS ? baseToken.DECIMALS : quoteToken.DECIMALS));
        const outputAmount = exactOutAmount / (10 ** (outputMint === baseToken.ADDRESS ? baseToken.DECIMALS : quoteToken.DECIMALS));

        // Log the trade
        logTradeToFile({
            inputToken: inputMint === baseToken.ADDRESS ? baseToken.NAME : quoteToken.NAME,
            outputToken: outputMint === baseToken.ADDRESS ? baseToken.NAME : quoteToken.NAME,
            inputAmount: inputAmount.toFixed(6),
            outputAmount: outputAmount.toFixed(6),
            jitoStatus: 'Success',
            feeInBps: totalFeeBps // Log the fee rate applied
        });

        // Calculate changes in base and quote token amounts
        const baseTokenChange = outputMint === baseToken.ADDRESS ? outputAmount : -inputAmount;
        const quoteTokenChange = outputMint === quoteToken.ADDRESS ? outputAmount : -inputAmount;
        const price = Math.abs(quoteTokenChange / baseTokenChange);

        console.log(formatSuccess(`${icons.success} Trade Successful!`));
        if (profitFeeBps > 0) {
            console.log(formatInfo(`${icons.profit} Profit fee applied: ${profitFeeBps} bps (10% of profit)`));
        }
        
        return {
            txId: jitoBundleResult.swapTxSignature,
            price,
            baseTokenChange,
            quoteTokenChange,
            appliedFeeBps: totalFeeBps,
            ...jitoBundleResult
        };

    } catch (error) {
        console.error(formatError(`Error executing exact out swap: ${error.message}`));
        return null;
    }
}

/**
 * Executes a swap based on sentiment
 * @param {Object} wallet - Wallet object
 * @param {string} sentiment - Market sentiment
 * @returns {Promise<Object|string|null>} Swap result, failure reason, or null
 */
async function executeSwap(wallet, sentiment) {
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

    try {
        devLog("Initiating swap with sentiment:", sentiment);

        // Determine trade direction based on sentiment
        isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
        inputMint = isBuying ? quoteToken.ADDRESS : baseToken.ADDRESS;
        outputMint = isBuying ? baseToken.ADDRESS : quoteToken.ADDRESS;
        const balance = isBuying ? wallet.quoteBalance : wallet.baseBalance;

        // Calculate trade amount
        tradeAmount = calculateTradeAmount(balance, sentiment, isBuying ? quoteToken : baseToken);

        if (!tradeAmount || tradeAmount <= 0) {
            devLog('Invalid trade amount calculated');
            return null;
        }

        devLog(`Calculated trade amount: ${tradeAmount}`);

        // Get initial quote
        let quoteResponse = await getQuote(inputMint, outputMint, tradeAmount);
        if (!quoteResponse) {
            devLog('Failed to get quote');
            return null;
        }

        // Get transaction
        let swapTransaction = await getFeeAccountAndSwapTransaction(
            new PublicKey("DGQRoyxV4Pi7yLnsVr1sT9YaRWN9WtwwcAiu3cKJsV9p"),
            new PublicKey(inputMint),
            quoteResponse,
            wallet
        );

        if (!swapTransaction) {
            devLog('Failed to create swap transaction');
            return null;
        }

        console.log(formatInfo(`${icons.wait} Awaiting Confirmation...`));
        const jitoBundleResult = await handleJitoBundle(wallet, swapTransaction, tradeAmount, quoteResponse, isBuying);

        if (!jitoBundleResult) return null;

        console.log(formatInfo(`${icons.info} Updating Trade Information...`));
        // Calculate final amounts for successful trade
        const inputAmount = tradeAmount / (10 ** (isBuying ? quoteToken.DECIMALS : baseToken.DECIMALS));
        const outputAmount = jitoBundleResult.finalQuote.outAmount / (10 ** (isBuying ? baseToken.DECIMALS : quoteToken.DECIMALS));

        // Log the trade
        logTradeToFile({
            inputToken: isBuying ? quoteToken.NAME : baseToken.NAME,
            outputToken: isBuying ? baseToken.NAME : quoteToken.NAME,
            inputAmount: inputAmount.toFixed(6),
            outputAmount: outputAmount.toFixed(6),
            jitoStatus: 'Success'
        });

        // Calculate token changes using token-agnostic approach
        const baseTokenChange = isBuying ? jitoBundleResult.finalQuote.outAmount / (10 ** baseToken.DECIMALS) : -tradeAmount / (10 ** baseToken.DECIMALS);
        const quoteTokenChange = isBuying ? -tradeAmount / (10 ** quoteToken.DECIMALS) : jitoBundleResult.finalQuote.outAmount / (10 ** quoteToken.DECIMALS);
        const price = Math.abs(quoteTokenChange / baseTokenChange);

        console.log(formatSuccess(`${icons.success} Trade Successful!`));
        lastTradeTime.set(wallet.publicKey.toString(), Date.now());
        return {
            txId: jitoBundleResult.swapTxSignature,
            price,
            baseTokenChange,
            quoteTokenChange,
            ...jitoBundleResult
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
            jitoStatus: 'Failed'
        });

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
        wallet = getWallet();
        connection = getConnection();
        
        // Get token configurations
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();

        // Cancel any pending transactions
        cancelPendingBundle();

        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialised in resetPosition");
        }

        // Get current balances and price
        const { baseBalance, quoteBalance } = await updatePortfolioBalances(wallet, connection);
        const currentPrice = await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
        
        // Create new position
        const Position = require('./Position'); // Dynamically import to avoid circular dependencies
        position = new Position(baseBalance, quoteBalance, currentPrice);
        
        // Update orderBook storage path for current tokens then reset trades
        orderBook.updateStoragePathForTokens();
        orderBook.trades = [];
        orderBook.saveTrades();

        // Get current fear & greed index
        const fearGreedIndex = await fetchFearGreedIndex();
        const { getSentiment } = require('./api');
        const sentiment = getSentiment(fearGreedIndex);
        
        // Create initial data for UI
        const initialData = {
            timestamp: getTimestamp(),
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
        emitTradingData({ ...initialData, version: getVersion() });
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
            orderBook: orderBook.getState()
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
    executeExactOutSwap,
    logTradeToFile,
    calculateTradeAmount,
    updatePortfolioBalances,
    updatePositionFromSwap,
    logPositionUpdate,
    getTokenBalance,
    resetPosition,
    handleJitoBundle,
    cancelPendingBundle,
    // Token-agnostic exports
    BASE_TOKEN,
    QUOTE_TOKEN
};