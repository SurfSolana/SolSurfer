const { getQuote, getFeeAccountAndSwapTransaction, BASE_SWAP_URL } = require('./api');
const { getWallet, getConnection } = require('./globalState');
const { readSettings } = require('./pulseServer');
const { attemptRPCFailover } = require('./utils');
const { PublicKey, VersionedTransaction, TransactionMessage, SystemProgram, TransactionInstruction } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require("@solana/spl-token");
const bs58 = require('bs58');
const WebSocket = require('ws');
const fetch = require('cross-fetch');
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const borsh = require('@coral-xyz/borsh');

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
        const timestamp = now.toISOString().replace('T', ' ').slice(0, 19); // Format: YYYY-MM-DD HH:MM:SS

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
        console.log('Successfully logged trade data');

    } catch (error) {
        console.error('Error logging trade:', error);
        console.error('Error details:', {
            message: error.message,
            stack: error.stack,
            code: error.code
        });
    }
}

function cancelPendingBundle() {
    isBundleCancelled = true;
}

async function executeSwap(wallet, sentiment, USDC, SOL) {
    let tradeAmount;
    let isBuying;
    let inputMint;
    let outputMint;

    try {
        console.log("Initiating swap with sentiment:", sentiment);

        isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
        inputMint = isBuying ? USDC.ADDRESS : SOL.ADDRESS;
        outputMint = isBuying ? SOL.ADDRESS : USDC.ADDRESS;
        const balance = isBuying ? wallet.usdcBalance : wallet.solBalance;

        tradeAmount = calculateTradeAmount(balance, sentiment, isBuying ? USDC : SOL);

        if (!tradeAmount || tradeAmount <= 0) {
            console.log('Invalid trade amount calculated');
            return null;
        }

        console.log(`Calculated trade amount: ${tradeAmount}`);

        // Get initial quote
        let quoteResponse = await getQuote(inputMint, outputMint, tradeAmount);
        if (!quoteResponse) {
            console.log('Failed to get quote');
            return null;
        }

        let swapTransaction = await getFeeAccountAndSwapTransaction(
            new PublicKey("DGQRoyxV4Pi7yLnsVr1sT9YaRWN9WtwwcAiu3cKJsV9p"),
            new PublicKey(inputMint),
            quoteResponse,
            wallet
        );

        if (!swapTransaction) {
            console.log('Failed to create swap transaction');
            return null;
        }

        const jitoBundleResult = await handleJitoBundle(wallet, swapTransaction, tradeAmount, quoteResponse, isBuying);

        if (!jitoBundleResult) return null;

        // Calculate final amounts for successful trade
        const inputAmount = tradeAmount / (10 ** (isBuying ? USDC.DECIMALS : SOL.DECIMALS));
        const outputAmount = jitoBundleResult.finalQuote.outAmount / (10 ** (isBuying ? SOL.DECIMALS : USDC.DECIMALS));

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

        return {
            txId: jitoBundleResult.swapTxSignature,
            price,
            solChange,
            usdcChange,
            ...jitoBundleResult
        };

    } catch (error) {
        // Only log the essential information on failure
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

function calculateTradeAmount(balance, sentiment, tokenInfo) {
    try {
        const { SENTIMENT_MULTIPLIERS } = readSettings();
        if (!SENTIMENT_MULTIPLIERS || !SENTIMENT_MULTIPLIERS[sentiment]) {
            console.error(`Invalid sentiment multiplier for sentiment: ${sentiment}`);
            return 0;
        }

        const sentimentMultiplier = SENTIMENT_MULTIPLIERS[sentiment];
        if (!balance || balance <= 0) {
            console.error(`Invalid balance: ${balance}`);
            return 0;
        }

        const rawAmount = balance * sentimentMultiplier;
        return Math.floor(rawAmount * (10 ** tokenInfo.DECIMALS));
    } catch (error) {
        console.error('Error calculating trade amount:', error);
        return 0;
    }
}

async function updatePortfolioBalances(wallet, connection) {
    if (!wallet || !connection) {
        throw new Error("Wallet or connection is not initialized");
    }
    
    try {
        const solBalance = await getTokenBalance(connection, wallet.publicKey.toString(), SOL.ADDRESS);
        const usdcBalance = await getTokenBalance(connection, wallet.publicKey.toString(), USDC.ADDRESS);

        // Check if balances are suspiciously zero - might indicate RPC issue
        if (solBalance === 0 && usdcBalance === 0) {
            console.log("Warning: Both balances returned as 0, attempting RPC failover...");
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
        const failoverSuccess = await attemptRPCFailover(wallet);
        if (failoverSuccess) {
            // Retry the balance update with new connection
            return updatePortfolioBalances(wallet, wallet.connection);
        }
        
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

    const buffer = Buffer.alloc(1000)

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
    )

    const data = Buffer.concat([new Uint8Array(discrim), buffer]).slice(0, 8 + len)

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

async function handleJitoBundle(wallet, initialSwapTransaction, tradeAmount, initialQuote, isBuying) {
    isBundleCancelled = false;
    try {
        console.log(`\nAttempting to send Jito bundle...`);

        if (isBundleCancelled) {
            console.log('Bundle cancelled, abandoning transaction...');
            return null;
        }

        // Deserialize the transaction
        let transaction;
        try {
            const swapTransactionBuf = Buffer.from(initialSwapTransaction, 'base64');
            transaction = VersionedTransaction.deserialize(swapTransactionBuf);
        } catch (error) {
            console.log('Failed to deserialize transaction');
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

        console.log(`Jito Fee: ${limitedTipValueInLamports / Math.pow(10, 9)} SOL`);

        if (isBundleCancelled) return null;

        // Get fresh blockhash
        const { blockhash } = await wallet.connection.getLatestBlockhash("confirmed");
        console.log(`\nNew Blockhash: ${blockhash}`);

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

        const successful_trades = 1n; // Always increment by 1 for a successful trade (Bundles will only ever be successful, the tx doesnt land otherwise so we never have to account for fails)
        const sol_lamport_volume = BigInt(!isBuying ? tradeAmount : 0); // Only if selling SOL
        const usd_lamport_volume = BigInt(isBuying ? tradeAmount : 0); // Only if buying SOL
        const jup_lamport_volume = 0n;
        const wif_lamport_volume = 0n;
        const bonk_lamport_volume = 0n;

        console.log(successful_trades)
        console.log(sol_lamport_volume)
        console.log(usd_lamport_volume)
        console.log(jup_lamport_volume)
        console.log(wif_lamport_volume)
        console.log(bonk_lamport_volume)

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

        console.log(`Sending bundle with blockhash: ${blockhash}`);
        const jitoBundleResult = await sendJitoBundle(bundleToSend);

        const swapTxSignature = bs58.default.encode(transaction.signatures[0]);
        const tipTxSignature = bs58.default.encode(txSub.signatures[0]);

        if (isBundleCancelled) return null;

        console.log(`\nWaiting for bundle confirmation...`);
        const confirmationResult = await waitForBundleConfirmation(jitoBundleResult);

        if (confirmationResult.status === "Landed") {
            console.log(`Bundle landed successfully`);
            return {
                jitoBundleResult,
                swapTxSignature,
                tipTxSignature,
                finalQuote: initialQuote,
                ...confirmationResult,
                finalBlockhash: blockhash
            };
        } 
        
        console.log(`\nBundle failed. Blockhash: ${blockhash}`);
        return null;

    } catch (error) {
        console.log('Bundle execution failed:', error); // Add error details
        return null;
    }
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