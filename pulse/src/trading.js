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
    resetTradingPeriod 
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

// Token definitions
const USDC = {
    ADDRESS: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    DECIMALS: 6,
    NAME: "USDC"
};

const SOL = {
    NAME: "SOL",
    ADDRESS: "So11111111111111111111111111111111111111112",
    DECIMALS: 9,
    FULL_NAME: "solana"
};

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
        console.error('Error logging trade:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        });
    }
}

/**
 * Logs position update details
 * @param {Object} position - Position object
 * @param {number} currentPrice - Current SOL price
 */
function logPositionUpdate(position, currentPrice) {
    const enhancedStats = position.getEnhancedStatistics(currentPrice);

    devLog("\n--- Current Position ---");
    devLog(`SOL Balance: ${position.solBalance.toFixed(SOL.DECIMALS)} SOL`);
    devLog(`USDC Balance: ${position.usdcBalance.toFixed(USDC.DECIMALS)} USDC`);
    devLog(`Average Entry Price: $${enhancedStats.averagePrices.entry}`);
    devLog(`Average Sell Price: $${enhancedStats.averagePrices.sell}`);
    devLog(`Current SOL Price: $${currentPrice.toFixed(2)}`);
    devLog(`Initial Portfolio Value: $${enhancedStats.portfolioValue.initial}`);
    devLog(`Current Portfolio Value: $${enhancedStats.portfolioValue.current}`);
    devLog(`Net Change: $${enhancedStats.netChange}`);
    devLog(`Portfolio Change: ${enhancedStats.portfolioValue.percentageChange}%`);
    devLog(`Total Volume: ${enhancedStats.totalVolume.sol} SOL / ${enhancedStats.totalVolume.usdc} USDC`);
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
            console.error(`Invalid balance: ${balance}`);
            return 0;
        }

        if (!sentiment || typeof sentiment !== 'string') {
            console.error(`Invalid sentiment: ${sentiment}`);
            return 0;
        }

        if (!tokenInfo || !tokenInfo.DECIMALS) {
            console.error('Invalid token info');
            return 0;
        }

        const settings = readSettings();
        if (!settings) {
            console.error('Failed to read settings');
            return 0;
        }

        const {
            SENTIMENT_MULTIPLIERS,
            TRADE_SIZE_METHOD,
            STRATEGIC_PERCENTAGE
        } = settings;

        if (!SENTIMENT_MULTIPLIERS || !SENTIMENT_MULTIPLIERS[sentiment]) {
            console.error(`Invalid sentiment multiplier for sentiment: ${sentiment}`);
            return 0;
        }

        const sentimentMultiplier = SENTIMENT_MULTIPLIERS[sentiment];
        
        // Handle invalid TRADE_SIZE_METHOD
        if (!['VARIABLE', 'STRATEGIC'].includes(TRADE_SIZE_METHOD)) {
            console.error(`Invalid trade size method: ${TRADE_SIZE_METHOD}, defaulting to STRATEGIC`);
        }

        if (TRADE_SIZE_METHOD === 'VARIABLE') {
            const rawAmount = balance * sentimentMultiplier;
            return Math.floor(rawAmount * (10 ** tokenInfo.DECIMALS));
        } else { // Default to STRATEGIC
            const wallet = getWallet();
            const { needsNewPeriod, currentBaseSizes } = checkTradingPeriod();

            if (needsNewPeriod) {
                const baseSizes = setNewTradingPeriod(
                    wallet.solBalance,
                    wallet.usdcBalance,
                    STRATEGIC_PERCENTAGE
                );
                const baseAmount = baseSizes[tokenInfo.NAME];
                return Math.floor(baseAmount * (10 ** tokenInfo.DECIMALS));
            }

            const baseAmount = currentBaseSizes[tokenInfo.NAME];
            return Math.floor(baseAmount * (10 ** tokenInfo.DECIMALS));
        }
    } catch (error) {
        console.error('Error calculating trade amount:', error);
        return 0;
    }
}

// ===========================
// Transaction Construction
// ===========================

/**
 * Creates transaction to increment trade stats
 * @param {Object} wallet - Wallet object
 * @param {string} recentBlockhash - Recent blockhash
 * @param {bigint} successful_trades - Number of successful trades
 * @param {bigint} sol_lamport_volume - SOL volume
 * @param {bigint} usd_lamport_volume - USDC volume
 * @param {bigint} jup_lamport_volume - JUP volume
 * @param {bigint} wif_lamport_volume - WIF volume
 * @param {bigint} bonk_lamport_volume - BONK volume
 * @returns {VersionedTransaction} Increment transaction
 */
function create_increment_tx(
    wallet,
    recentBlockhash,
    successful_trades,
    sol_lamport_volume,
    usd_lamport_volume,
    jup_lamport_volume,
    wif_lamport_volume,
    bonk_lamport_volume
) {
    try {
        // Check inputs
        if (!wallet || !wallet.publicKey || !recentBlockhash) {
            throw new Error('Invalid inputs for increment transaction');
        }
        
        const discrim = [
            171,
            200,
            174,
            106,
            229,
            34,
            80,
            175
        ];
        
        const layout = borsh.struct([
            borsh.u128('successful_trades'),
            borsh.u128('sol_lamport_volume'),
            borsh.u128('usd_lamport_volume'),
            borsh.u128('jup_lamport_volume'),
            borsh.u128('wif_lamport_volume'),
            borsh.u128('bonk_lamport_volume')
        ]);

        const buffer = Buffer.alloc(1000);

        const len = layout.encode(
            {
                successful_trades: new BN(successful_trades),
                sol_lamport_volume: new BN(sol_lamport_volume),
                usd_lamport_volume: new BN(usd_lamport_volume),
                jup_lamport_volume: new BN(jup_lamport_volume),
                wif_lamport_volume: new BN(wif_lamport_volume),
                bonk_lamport_volume: new BN(bonk_lamport_volume)
            },
            buffer
        );

        const data = Buffer.concat([new Uint8Array(discrim), buffer]).slice(0, 8 + len);

        const msg = new TransactionMessage({
            payerKey: wallet.publicKey,
            recentBlockhash,
            instructions: [
                new TransactionInstruction({
                    programId: new PublicKey("8GWdLKu8aA21f98pAA5oaqkQjt6NBUFdaVNkjyQAfpnD"),
                    keys: [
                        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
                        { pubkey: new PublicKey("GNZtRcvcik8UBtekeLDBY34K1yiuVv7mej8g5aPgZxhh"), isSigner: false, isWritable: true },
                        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }
                    ],
                    data
                })
            ]
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        tx.sign([wallet.payer]);
        return tx;
    } catch (error) {
        console.error('Error creating increment transaction:', error);
        throw error;
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
// Jito MEV Interactions
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
        console.error('Error fetching Jito tip floor:', error);
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
        console.error("Error encoding transactions:", error);
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
                console.error("Bad Request Error. Response details:", responseText);
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
            console.error(`Error on attempt ${i + 1}:`, error);
            if (i === MAX_BUNDLE_RETRIES) {
                console.error("Max retries exceeded");
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
        console.error("Error parsing Jito response:", error);
        throw new Error("Failed to parse Jito response");
    }

    if (responseData.error) {
        console.error("Jito Block Engine returned an error:", responseData.error);
        throw new Error(`Jito error: ${responseData.error.message}`);
    }

    const result = responseData.result;
    if (!result) {
        console.error("No result in Jito response");
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
        console.error("Error fetching bundle status:", error);
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
            console.error(`Error fetching bundle status:`, error.message);
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
            console.error('Failed to deserialize transaction:', error);
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

        // Create bundle transactions
        const successful_trades = 1n;
        const sol_lamport_volume = BigInt(!isBuying ? tradeAmount : 0);
        const usd_lamport_volume = BigInt(isBuying ? tradeAmount : 0);
        const jup_lamport_volume = 0n;
        const wif_lamport_volume = 0n;
        const bonk_lamport_volume = 0n;

        devLog(`Trade volumes - SOL: ${sol_lamport_volume}, USDC: ${usd_lamport_volume}`);

        const incrementTx = create_increment_tx(
            wallet,
            blockhash,
            successful_trades,
            sol_lamport_volume,
            usd_lamport_volume,
            jup_lamport_volume,
            wif_lamport_volume,
            bonk_lamport_volume
        );

        const txSub = new VersionedTransaction(messageSub);
        transaction.message.recentBlockhash = blockhash;

        incrementTx.sign([wallet.payer]);
        txSub.sign([wallet.payer]);
        transaction.sign([wallet.payer]);

        const bundleToSend = [transaction, txSub, incrementTx];

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
        console.error('Bundle execution failed:', error);
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
        console.error("Connection object is undefined");
        return 0;
    }

    if (!walletAddress || !mintAddress) {
        console.error("Invalid wallet or mint address");
        return 0;
    }

    try {
        if (mintAddress === SOL.ADDRESS) {
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
        console.error("Error fetching token balance:", error);
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
        throw new Error("Wallet or connection is not initialized");
    }

    try {
        const solBalance = await getTokenBalance(connection, wallet.publicKey.toString(), SOL.ADDRESS);
        const usdcBalance = await getTokenBalance(connection, wallet.publicKey.toString(), USDC.ADDRESS);

        // Check if balances are suspiciously zero - might indicate RPC issue
        if (solBalance === 0 && usdcBalance === 0) {
            devLog("Warning: Both balances returned as 0, attempting RPC failover...");
            const failoverSuccess = await attemptRPCFailover(wallet);

            if (failoverSuccess) {
                // Retry with new connection
                const newSolBalance = await getTokenBalance(wallet.connection, wallet.publicKey.toString(), SOL.ADDRESS);
                const newUsdcBalance = await getTokenBalance(wallet.connection, wallet.publicKey.toString(), USDC.ADDRESS);

                wallet.solBalance = newSolBalance;
                wallet.usdcBalance = newUsdcBalance;

                return { solBalance: newSolBalance, usdcBalance: newUsdcBalance };
            }
        }

        wallet.solBalance = solBalance;
        wallet.usdcBalance = usdcBalance;

        return { solBalance, usdcBalance };
    } catch (error) {
        console.error("Error updating portfolio balances:", error);

        // Attempt failover on error
        try {
            const failoverSuccess = await attemptRPCFailover(wallet);
            if (failoverSuccess) {
                // Retry the balance update with new connection
                return updatePortfolioBalances(wallet, wallet.connection);
            }
        } catch (failoverError) {
            console.error("Failover attempt failed:", failoverError);
        }

        throw error;
    }
}

/**
 * Updates position from swap result
 * @param {Object} position - Position object
 * @param {Object} swapResult - Swap result
 * @param {string} sentiment - Market sentiment
 * @param {number} currentPrice - Current SOL price
 * @returns {Object|null} Trade summary or null on failure
 */
function updatePositionFromSwap(position, swapResult, sentiment, currentPrice) {
    if (!swapResult) {
        devLog("No swap executed or swap failed. Position remains unchanged.");
        return null;
    }

    try {
        devLog('Swap result:', swapResult);

        const { price, solChange, usdcChange, txId } = swapResult;

        if (price === undefined || solChange === undefined || usdcChange === undefined) {
            console.error('Swap result missing critical information:', swapResult);
            return null;
        }

        devLog('Updating position with:', { price, solChange, usdcChange, txId });

        position.logTrade(sentiment, price, solChange, usdcChange);
        logPositionUpdate(position, currentPrice);

        const tradeType = solChange > 0 ? "Bought" : "Sold";
        const tradeAmount = Math.abs(solChange);

        return {
            type: tradeType,
            amount: tradeAmount,
            price: price,
            timestamp: new Date().toISOString(),
            txUrl: `https://solscan.io/tx/${txId}`
        };
    } catch (error) {
        console.error('Error updating position from swap:', error);
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
 * @returns {Promise<Object|null>} Swap result or null on failure
 */
async function executeExactOutSwap(wallet, outputMint, exactOutAmount, inputMint) {
    try {
        devLog("Initiating exact out swap");

        // Validate inputs
        if (!wallet || !outputMint || !exactOutAmount || !inputMint) {
            throw new Error('Missing required parameters for exact out swap');
        }

        const decimals = outputMint === SOL.ADDRESS ? SOL.DECIMALS : USDC.DECIMALS;
        const exactOutAmountFloor = Math.floor(exactOutAmount);

        devLog(`Exact Out Swap Details:`, {
            outputMint: outputMint === SOL.ADDRESS ? 'SOL' : 'USDC',
            inputMint: inputMint === SOL.ADDRESS ? 'SOL' : 'USDC',
            rawAmount: exactOutAmount,
            adjustedAmount: exactOutAmountFloor,
            decimals: decimals
        });

        // Build params for Jupiter API
        const params = new URLSearchParams({
            inputMint: inputMint,
            outputMint: outputMint,
            amount: exactOutAmountFloor.toString(),
            slippageBps: '50',
            platformFeeBps: '0',
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

        console.log("Awaiting Confirmation...");
        const jitoBundleResult = await handleJitoBundle(wallet, swapTransaction, quoteResponse.inAmount, quoteResponse, inputMint === SOL.ADDRESS);

        if (!jitoBundleResult) return null;

        console.log("Updating Trade Information...");
        const inputAmount = quoteResponse.inAmount / (10 ** (inputMint === SOL.ADDRESS ? SOL.DECIMALS : USDC.DECIMALS));
        const outputAmount = exactOutAmount / (10 ** (outputMint === SOL.ADDRESS ? SOL.DECIMALS : USDC.DECIMALS));

        // Log the trade
        logTradeToFile({
            inputToken: inputMint === SOL.ADDRESS ? 'SOL' : 'USDC',
            outputToken: outputMint === SOL.ADDRESS ? 'SOL' : 'USDC',
            inputAmount: inputAmount.toFixed(6),
            outputAmount: outputAmount.toFixed(6),
            jitoStatus: 'Success'
        });

        const solChange = outputMint === SOL.ADDRESS ? outputAmount : -inputAmount;
        const usdcChange = outputMint === USDC.ADDRESS ? outputAmount : -inputAmount;
        const price = Math.abs(usdcChange / solChange);

        console.log("Trade Successful!")
        return {
            txId: jitoBundleResult.swapTxSignature,
            price,
            solChange,
            usdcChange,
            ...jitoBundleResult
        };

    } catch (error) {
        console.error('Error executing exact out swap:', error);
        return null;
    }
}

/**
 * Executes a swap based on sentiment
 * @param {Object} wallet - Wallet object
 * @param {string} sentiment - Market sentiment
 * @param {Object} USDC - USDC token info
 * @param {Object} SOL - SOL token info
 * @returns {Promise<Object|string|null>} Swap result, failure reason, or null
 */
async function executeSwap(wallet, sentiment, USDC, SOL) {
    const settings = readSettings();
    if (!settings) {
        console.error('Failed to read settings');
        return null;
    }

    let tradeAmount;
    let isBuying;
    let inputMint;
    let outputMint;

    try {
        devLog("Initiating swap with sentiment:", sentiment);

        // Determine trade direction based on sentiment
        isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
        inputMint = isBuying ? USDC.ADDRESS : SOL.ADDRESS;
        outputMint = isBuying ? SOL.ADDRESS : USDC.ADDRESS;
        const balance = isBuying ? wallet.usdcBalance : wallet.solBalance;

        // Calculate trade amount
        tradeAmount = calculateTradeAmount(balance, sentiment, isBuying ? USDC : SOL);

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

        console.log("Awaiting Confirmation...");
        const jitoBundleResult = await handleJitoBundle(wallet, swapTransaction, tradeAmount, quoteResponse, isBuying);

        if (!jitoBundleResult) return null;

        console.log("Updating Trade Information...");
        // Calculate final amounts for successful trade
        const inputAmount = tradeAmount / (10 ** (isBuying ? USDC.DECIMALS : SOL.DECIMALS));
        const outputAmount = jitoBundleResult.finalQuote.outAmount / (10 ** (isBuying ? SOL.DECIMALS : USDC.DECIMALS));

        // Log the trade
        logTradeToFile({
            inputToken: isBuying ? 'USDC' : 'SOL',
            outputToken: isBuying ? 'SOL' : 'USDC',
            inputAmount: inputAmount.toFixed(6),
            outputAmount: outputAmount.toFixed(6),
            jitoStatus: 'Success'
        });

        const solChange = isBuying ? jitoBundleResult.finalQuote.outAmount / (10 ** SOL.DECIMALS) : -tradeAmount / (10 ** SOL.DECIMALS);
        const usdcChange = isBuying ? -tradeAmount / (10 ** USDC.DECIMALS) : jitoBundleResult.finalQuote.outAmount / (10 ** USDC.DECIMALS);
        const price = Math.abs(usdcChange / solChange);

        console.log("Trade Successful!")
        lastTradeTime.set(wallet.publicKey.toString(), Date.now());
        return {
            txId: jitoBundleResult.swapTxSignature,
            price,
            solChange,
            usdcChange,
            ...jitoBundleResult
        };

    } catch (error) {
        console.error('Error executing swap:', error);
        
        // Log failed trade
        logTradeToFile({
            inputToken: isBuying ? 'USDC' : 'SOL',
            outputToken: isBuying ? 'SOL' : 'USDC',
            inputAmount: tradeAmount ? (tradeAmount / (10 ** (isBuying ? USDC.DECIMALS : SOL.DECIMALS))).toFixed(6) : '0',
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
 * Resets trading position and initializes new state
 * @returns {Promise<void>}
 */
async function resetPosition() {
    devLog("Entering resetPosition function");
    
    try {
        // Get wallet and connection
        const wallet = getWallet();
        const connection = getConnection();
        
        if (!wallet || !connection) {
            throw new Error('Unable to get wallet or connection for reset');
        }
        
        devLog("Wallet:", wallet);
        devLog("Connection:", connection);
        
        // Get current balances
        const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
        
        // Get current price
        const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL);
        
        // Create new position object
        const Position = require('./Position'); // Dynamically import to avoid circular dependencies
        position = new Position(solBalance, usdcBalance, currentPrice);
        
        devLog("Position reset. New position:");
        devLog(`SOL Balance: ${solBalance.toFixed(SOL.DECIMALS)} SOL`);
        devLog(`USDC Balance: ${usdcBalance.toFixed(USDC.DECIMALS)} USDC`);
        devLog(`Current SOL Price: ${currentPrice.toFixed(2)}`);
        devLog(`Portfolio Value: ${position.getCurrentValue(currentPrice).toFixed(2)}`);

        // Get additional data
        const { getVersion, getTimestamp } = require('./utils');
        const { setInitialData, emitTradingData, clearRecentTrades, saveState } = require('./pulseServer');
        
        // Get current sentiment data
        const fearGreedIndex = await fetchFearGreedIndex();
        const { getSentiment } = require('./api');
        const sentiment = getSentiment(fearGreedIndex);
        
        // Create initial data package
        const initialData = {
            version: getVersion(),
            timestamp: getTimestamp(),
            price: currentPrice,
            fearGreedIndex,
            sentiment,
            usdcBalance: position.usdcBalance,
            solBalance: position.solBalance,
            portfolioValue: position.getCurrentValue(currentPrice),
            netChange: 0,
            averageEntryPrice: 0,
            averageSellPrice: 0,
            initialSolPrice: currentPrice,
            initialPortfolioValue: position.getCurrentValue(currentPrice),
            initialSolBalance: solBalance,
            initialUsdcBalance: usdcBalance,
            startTime: Date.now()
        };

        // Update UI and state
        setInitialData(initialData);
        emitTradingData(initialData);
        clearRecentTrades();

        // Save initial state (excluding recent trades)
        saveState({
            position: {
                solBalance: position.solBalance,
                usdcBalance: position.usdcBalance,
                initialSolBalance: position.initialSolBalance,
                initialUsdcBalance: position.initialUsdcBalance,
                initialPrice: position.initialPrice,
                initialValue: position.initialValue,
                totalSolBought: 0,
                totalUsdcSpent: 0,
                totalSolSold: 0,
                totalUsdcReceived: 0,
                netSolTraded: 0,
                startTime: position.startTime,
                totalCycles: 0,
                totalVolumeSol: 0,
                totalVolumeUsdc: 0
            },
            tradingData: initialData,
            settings: readSettings()
        });
        
        return initialData;
    } catch (error) {
        console.error('Error resetting position:', error);
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
    USDC,
    SOL
};