const { getQuote, getFeeAccountAndSwapTransaction, BASE_SWAP_URL } = require('./api');
const { getWallet, getConnection } = require('./globalState');
const { readSettings } = require('./waveServer');
const { PublicKey, VersionedTransaction, TransactionMessage, SystemProgram } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require("@solana/spl-token");
const bs58 = require('bs58');
const WebSocket = require('ws');
const fetch = require('cross-fetch');

let isBundleCancelled = false;

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

const maxJitoTip = 0.0004;

function logTradeToFile(tradeData) {
    const {
        inputToken,
        inputAmount,
        outputToken,
        outputAmount,
        jitoStatus,
        timestamp = new Date().toISOString(),
        additionalInfo = {}
    } = tradeData;

    // Format the log entry
    const logEntry = {
        timestamp,
        inputToken,
        inputAmount: parseFloat(inputAmount).toFixed(6),
        outputToken,
        outputAmount: parseFloat(outputAmount).toFixed(6),
        jitoStatus,
        ...additionalInfo
    };

    // Convert to CSV format
    const csvLine = `${logEntry.timestamp},${logEntry.inputToken},${logEntry.inputAmount},${logEntry.outputToken},${logEntry.outputAmount},${logEntry.jitoStatus}\n`;

    // Ensure logs directory exists
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir);
    }

    // Create filename based on current date
    const date = new Date();
    const fileName = `trades_${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}.csv`;
    const filePath = path.join(logsDir, fileName);

    // Create headers if file doesn't exist
    if (!fs.existsSync(filePath)) {
        const headers = 'Timestamp,Input Token,Input Amount,Output Token,Output Amount,Jito Status\n';
        fs.writeFileSync(filePath, headers);
    }

    // Append the log entry
    fs.appendFileSync(filePath, csvLine);

    // Also log to console
    console.log('Trade logged:', logEntry);
}

function cancelPendingBundle() {
    isBundleCancelled = true;
}

async function executeSwap(wallet, sentiment, USDC, SOL) {
    try {
        console.log("Initiating swap with sentiment:", sentiment);

        const isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
        const inputMint = isBuying ? USDC.ADDRESS : SOL.ADDRESS;
        const outputMint = isBuying ? SOL.ADDRESS : USDC.ADDRESS;
        const balance = isBuying ? wallet.usdcBalance : wallet.solBalance;

        const tradeAmount = calculateTradeAmount(balance, sentiment, isBuying ? USDC : SOL);

        // Log trade attempt
        const initialLogData = {
            inputToken: isBuying ? 'USDC' : 'SOL',
            inputAmount: tradeAmount / (10 ** (isBuying ? USDC.DECIMALS : SOL.DECIMALS)),
            outputToken: isBuying ? 'SOL' : 'USDC',
            outputAmount: 0, // Will be updated after quote
            jitoStatus: 'Attempted',
            timestamp: new Date().toISOString()
        };

        const quoteResponse = await getQuote(inputMint, outputMint, tradeAmount);

        if (quoteResponse) {
            initialLogData.outputAmount = quoteResponse.outAmount / (10 ** (isBuying ? SOL.DECIMALS : USDC.DECIMALS));
        }

        const swapTransaction = await getFeeAccountAndSwapTransaction(
            new PublicKey("DGQRoyxV4Pi7yLnsVr1sT9YaRWN9WtwwcAiu3cKJsV9p"),
            new PublicKey(inputMint),
            quoteResponse,
            wallet
        );

        if (!swapTransaction) {
            initialLogData.jitoStatus = 'Failed - No swap transaction';
            logTradeToFile(initialLogData);
            return null;
        }

        const jitoBundleResult = await handleJitoBundle(wallet, swapTransaction);

        // Update log data with final status
        initialLogData.jitoStatus = jitoBundleResult ? 'Success' : 'Failed';
        if (jitoBundleResult) {
            initialLogData.additionalInfo = {
                txId: jitoBundleResult.swapTxSignature,
                attempts: jitoBundleResult.attempts
            };
        }

        logTradeToFile(initialLogData);

        if (!jitoBundleResult) {
            return null;
        }

        const solChange = isBuying ? quoteResponse.outAmount / (10 ** SOL.DECIMALS) : -tradeAmount / (10 ** SOL.DECIMALS);
        const usdcChange = isBuying ? -tradeAmount / (10 ** USDC.DECIMALS) : quoteResponse.outAmount / (10 ** USDC.DECIMALS);
        const price = Math.abs(usdcChange / solChange);

        return {
            txId: jitoBundleResult.swapTxSignature,
            price,
            solChange,
            usdcChange,
            ...jitoBundleResult
        };

    } catch (error) {
        // Log error case
        logTradeToFile({
            inputToken: isBuying ? 'USDC' : 'SOL',
            inputAmount: tradeAmount / (10 ** (isBuying ? USDC.DECIMALS : SOL.DECIMALS)),
            outputToken: isBuying ? 'SOL' : 'USDC',
            outputAmount: 0,
            jitoStatus: `Failed - ${error.message}`,
            timestamp: new Date().toISOString()
        });

        console.error(`Error during swap:`, error);
        return null;
    }
}

function calculateTradeAmount(balance, sentiment, tokenInfo) {
    const { TRADE_MULTIPLIER } = readSettings();

    // Convert the multiplier from percentage to decimal (e.g., 15% -> 0.15)
    const positionSizeMultiplier = TRADE_MULTIPLIER / 100;

    // Calculate the raw amount based on the percentage of balance
    const rawAmount = balance * positionSizeMultiplier;

    // Convert to the appropriate number of decimals for the token
    return Math.floor(rawAmount * (10 ** tokenInfo.DECIMALS));
}

async function updatePortfolioBalances(wallet, connection) {
    if (!wallet || !connection) {
        throw new Error("Wallet or connection is not initialized");
    }
    try {
        const solBalance = await getTokenBalance(connection, wallet.publicKey.toString(), SOL.ADDRESS);
        const usdcBalance = await getTokenBalance(connection, wallet.publicKey.toString(), USDC.ADDRESS);

        wallet.solBalance = solBalance;
        wallet.usdcBalance = usdcBalance;

        return { solBalance, usdcBalance };
    } catch (error) {
        console.error("Error updating portfolio balances:", error);
        throw error;
    }
}

function updatePositionFromSwap(position, swapResult, sentiment, currentPrice) {
    if (!swapResult) {
        console.log("No swap executed or swap failed. Position remains unchanged.");
        return null;
    }

    console.log('Swap result:', swapResult);

    const { price, solChange, usdcChange, txId } = swapResult;

    if (price === undefined || solChange === undefined || usdcChange === undefined) {
        console.error('Swap result missing critical information:', swapResult);
        return null;
    }

    console.log('Updating position with:', { price, solChange, usdcChange, txId });

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
}

function logPositionUpdate(position, currentPrice) {
    const enhancedStats = position.getEnhancedStatistics(currentPrice);

    console.log("\n--- Current Position ---");
    console.log(`SOL Balance: ${position.solBalance.toFixed(SOL.DECIMALS)} SOL`);
    console.log(`USDC Balance: ${position.usdcBalance.toFixed(USDC.DECIMALS)} USDC`);
    console.log(`Average Entry Price: $${enhancedStats.averagePrices.entry}`);
    console.log(`Average Sell Price: $${enhancedStats.averagePrices.sell}`);
    console.log(`Current SOL Price: $${currentPrice.toFixed(2)}`);
    console.log(`Initial Portfolio Value: $${enhancedStats.portfolioValue.initial}`);
    console.log(`Current Portfolio Value: $${enhancedStats.portfolioValue.current}`);
    console.log(`Net Change: $${enhancedStats.netChange}`);
    console.log(`Portfolio Change: ${enhancedStats.portfolioValue.percentageChange}%`);
    console.log(`Total Volume: ${enhancedStats.totalVolume.sol} SOL / ${enhancedStats.totalVolume.usdc} USDC`);
    console.log("------------------------\n");
}

async function getTokenBalance(connection, walletAddress, mintAddress) {
    if (!connection) {
        console.error("Connection object is undefined");
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

async function resetPosition() {
    console.log("Entering resetPosition function");
    const wallet = getWallet();
    const connection = getConnection();
    console.log("Wallet:", wallet);
    console.log("Connection:", connection);
    const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
    const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL);
    position = new Position(solBalance, usdcBalance, currentPrice);
    console.log("Position reset. New position:");
    console.log(`SOL Balance: ${solBalance.toFixed(SOL.DECIMALS)} SOL`);
    console.log(`USDC Balance: ${usdcBalance.toFixed(USDC.DECIMALS)} USDC`);
    console.log(`Current SOL Price: $${currentPrice.toFixed(2)}`);
    console.log(`Portfolio Value: $${position.getCurrentValue(currentPrice).toFixed(2)}`);

    const initialData = {
        version: getVersion(),
        timestamp: getTimestamp(),
        price: currentPrice,
        fearGreedIndex: await fetchFearGreedIndex(),
        sentiment: getSentiment(await fetchFearGreedIndex()),
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
}

// Jito-related functions

function getRandomTipAccount() {
    return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
}

async function jitoTipCheck() {
    const JitoTipWS = 'ws://bundles-api-rest.jito.wtf/api/v1/bundles/tip_stream';
    return new Promise((resolve, reject) => {
        const tipws = new WebSocket(JitoTipWS);
        tipws.on('open', function open() { });
        tipws.on('message', function incoming(data) {
            const str = data.toString();
            try {
                const json = JSON.parse(str);
                const emaPercentile50th = json[0].ema_landed_tips_50th_percentile;
                if (emaPercentile50th !== null) {
                    tipws.close();
                    resolve(emaPercentile50th);
                } else {
                    reject(new Error('50th percentile is null'));
                }
            } catch (err) {
                reject(err);
            }
        });
        tipws.on('error', function error(err) {
            console.error('WebSocket error:', err);
            reject(err);
        });
        setTimeout(() => {
            tipws.close();
            reject(new Error('Timeout'));
        }, 21000);
    });
}

async function handleJitoBundle(wallet, swapTransaction, maxAttempts = 5) {
    let currentAttempt = 1;
    isBundleCancelled = false; // Reset at start of new bundle

    while (currentAttempt <= maxAttempts && !isBundleCancelled) {
        try {
            console.log(`\nAttempt ${currentAttempt}/${maxAttempts} to send Jito bundle...`);

            if (isBundleCancelled) {
                console.log('Bundle cancelled, abandoning transaction...');
                return null;
            }

            // Deserialize the base transaction
            const swapTransactionBuf = Buffer.from(swapTransaction, 'base64');
            const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

            // Get Jito tip amount
            const tipValueInSol = await jitoTipCheck();
            const limitedTipValueInLamports = Math.floor(
                Math.min(tipValueInSol, maxJitoTip) * 1_000_000_000 * 1.1
            );

            console.log(`Jito Fee: ${limitedTipValueInLamports / Math.pow(10, 9)} SOL`);

            if (isBundleCancelled) {
                console.log('Bundle cancelled after tip calculation, abandoning transaction...');
                return null;
            }

            // Always get a fresh blockhash for each attempt
            const { blockhash, lastValidBlockHeight } = await wallet.connection.getLatestBlockhash("confirmed");
            console.log(`\nNew Blockhash for attempt ${currentAttempt}: ${blockhash}`);

            // Create tip transaction with new blockhash
            const tipAccount = new PublicKey(getRandomTipAccount());
            const tipIxn = SystemProgram.transfer({
                fromPubkey: wallet.publicKey,
                toPubkey: tipAccount,
                lamports: limitedTipValueInLamports
            });

            // Create tip transaction message with new blockhash
            const messageSub = new TransactionMessage({
                payerKey: wallet.publicKey,
                recentBlockhash: blockhash,
                instructions: [tipIxn]
            }).compileToV0Message();

            const txSub = new VersionedTransaction(messageSub);

            // Update swap transaction with new blockhash
            transaction.message.recentBlockhash = blockhash;

            // Re-sign both transactions with the new blockhash
            txSub.sign([wallet.payer]);
            transaction.sign([wallet.payer]);

            const bundleToSend = [transaction, txSub];

            if (isBundleCancelled) {
                console.log('Bundle cancelled before sending, abandoning transaction...');
                return null;
            }

            console.log(`Sending bundle for attempt ${currentAttempt} with blockhash: ${blockhash}`);
            const jitoBundleResult = await sendJitoBundle(bundleToSend);

            const swapTxSignature = bs58.default.encode(transaction.signatures[0]);
            const tipTxSignature = bs58.default.encode(txSub.signatures[0]);

            if (isBundleCancelled) {
                console.log('Bundle cancelled before confirmation, abandoning transaction...');
                return null;
            }

            console.log(`\nWaiting for bundle confirmation on attempt ${currentAttempt}...`);
            const confirmationResult = await waitForBundleConfirmation(jitoBundleResult);

            if (confirmationResult.status === "Landed") {
                console.log(`Bundle landed successfully on attempt ${currentAttempt}`);
                return {
                    jitoBundleResult,
                    swapTxSignature,
                    tipTxSignature,
                    ...confirmationResult,
                    attempts: currentAttempt,
                    finalBlockhash: blockhash
                };
            } else if (confirmationResult.status === "Failed") {
                console.log(`\nBundle failed on attempt ${currentAttempt}. Reason: ${confirmationResult.reason}`);
                console.log(`Failed blockhash was: ${blockhash}`);

                if (currentAttempt === maxAttempts) {
                    console.log(`All ${maxAttempts} attempts exhausted. Giving up.`);
                    return null;
                }
            }
        } catch (error) {
            if (isBundleCancelled) {
                console.log('Bundle cancelled during error handling, abandoning retry attempts...');
                return null;
            }
            console.error(`\nError in bundle attempt ${currentAttempt}:`, error.message);
            if (currentAttempt === maxAttempts) {
                console.log(`All ${maxAttempts} attempts exhausted. Giving up.`);
                return null;
            }
        }

        if (isBundleCancelled) {
            console.log('Bundle cancelled before retry, abandoning transaction...');
            return null;
        }

        currentAttempt++;
        if (currentAttempt <= maxAttempts) {
            console.log(`\nWaiting 5 seconds before retry ${currentAttempt}...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }
    }

    return null;
}

async function waitForBundleConfirmation(bundleId) {
    const checkInterval = 2000; // Check every 2 seconds
    let retries = 0;
    const maxRetries = 45; // Will check for about 90 seconds total

    while (retries < maxRetries && !isBundleCancelled) {
        try {
            const status = await getInFlightBundleStatus(bundleId);

            if (isBundleCancelled) {
                console.log('Bundle confirmation cancelled by user');
                return { status: "Failed", reason: "Bundle cancelled by user" };
            }

            if (status === null) {
                console.log("Bundle not found. Continuing to wait...");
            } else {
                console.log(`Bundle status: ${status.status}`);

                if (status.status === "Landed" || status.status === "Failed") {
                    return status;
                }
            }
        } catch (error) {
            console.log(`Error fetching bundle status:`, error.message);
        }

        await new Promise(resolve => setTimeout(resolve, checkInterval));
        retries++;
    }

    if (isBundleCancelled) {
        return { status: "Failed", reason: "Bundle cancelled by user" };
    }

    return { status: "Failed", reason: "Bundle did not land or fail within expected time" };
}

async function getInFlightBundleStatus(bundleId) {
    const data = {
        jsonrpc: "2.0",
        id: 1,
        method: "getInflightBundleStatuses",
        params: [[bundleId]]
    };

    try {
        const response = await fetch(JitoBlockEngine, {
            method: "POST",
            headers: {
                "Content-Type": "application/json"
            },
            body: JSON.stringify(data)
        });

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

async function sendJitoBundle(bundletoSend) {
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

    console.log("Sending bundle to Jito Block Engine...");

    let response;
    const maxRetries = 5;
    for (let i = 0; i <= maxRetries; i++) {
        try {
            response = await fetch(JitoBlockEngine, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(data)
            });

            if (response.ok) {
                break;
            }

            const responseText = await response.text();
            console.log(`Response status: ${response.status}`);
            console.log("Response body:", responseText);

            if (response.status === 400) {
                console.error("Bad Request Error. Response details:", responseText);
                throw new Error(`Bad Request: ${responseText}`);
            }

            if (response.status === 429) {
                const waitTime = Math.min(500 * Math.pow(2, i), 5000);
                const jitter = Math.random() * 0.3 * waitTime;
                console.log(`Rate limited. Retrying in ${waitTime + jitter}ms...`);
                await new Promise((resolve) => setTimeout(resolve, waitTime + jitter));
            } else {
                throw new Error(`Unexpected response status: ${response.status}`);
            }
        } catch (error) {
            console.error(`Error on attempt ${i + 1}:`, error);
            if (i === maxRetries) {
                console.error("Max retries exceeded");
                throw error;
            }
        }
    }

    if (!response.ok) {
        throw new Error(`Failed to send bundle after ${maxRetries} attempts`);
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
    console.log(`\nJito Bundle Result: ${url}`);

    return result;
}

module.exports = {
    executeSwap,
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