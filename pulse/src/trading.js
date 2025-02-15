const { getQuote, getFeeAccountAndSwapTransaction, BASE_SWAP_URL, fetchFearGreedIndex, isFGIChangeSignificant } = require('./api');
const { getWallet, getConnection } = require('./globalState');
const { readSettings } = require('./pulseServer');
const { attemptRPCFailover, devLog, formatTime, checkTradingPeriod, setNewTradingPeriod, getCurrentPeriodInfo, resetTradingPeriod } = require('./utils');
const { PublicKey, VersionedTransaction, TransactionMessage, SystemProgram, TransactionInstruction } = require('@solana/web3.js');
const { getAssociatedTokenAddress } = require("@solana/spl-token");
const bs58 = require('bs58');
const fetch = require('cross-fetch');
const fs = require('fs');
const path = require('path');
const BN = require('bn.js');
const borsh = require('@coral-xyz/borsh');

const lastTradeTime = new Map();
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

function cancelPendingBundle() {
    isBundleCancelled = true;
}

function isTradeOnCooldown(wallet, settings) {
    const now = Date.now();
    const lastTrade = lastTradeTime.get(wallet.publicKey.toString());

    if (!lastTrade) return false;

    const cooldownMs = settings.TRADE_COOLDOWN_MINUTES * 60 * 1000;
    const timeSinceLastTrade = now - lastTrade;

    if (timeSinceLastTrade < cooldownMs) {
        const remaining = cooldownMs - timeSinceLastTrade;
        console.log(`Trade cooldown active. ${formatTime(remaining)} remaining`);
        return true;
    }

    return false;
}

function calculateTradeAmount(balance, sentiment, tokenInfo) {
    try {
        const {
            SENTIMENT_MULTIPLIERS,
            TRADE_SIZE_METHOD = 'STRATEGIC',
            STRATEGIC_PERCENTAGE = 2.5
        } = readSettings();

        if (!SENTIMENT_MULTIPLIERS || !SENTIMENT_MULTIPLIERS[sentiment]) {
            console.error(`Invalid sentiment multiplier for sentiment: ${sentiment}`);
            return 0;
        }

        const sentimentMultiplier = SENTIMENT_MULTIPLIERS[sentiment];
        if (!balance || balance <= 0) {
            console.error(`Invalid balance: ${balance}`);
            return 0;
        }

        if (TRADE_SIZE_METHOD === 'VARIABLE') {
            // Original trading size calculation logic
            const rawAmount = balance * sentimentMultiplier;
            return Math.floor(rawAmount * (10 ** tokenInfo.DECIMALS));
        } else if (TRADE_SIZE_METHOD === 'STRATEGIC') {
            // Get both current balances
            const wallet = getWallet();
            const { needsNewPeriod, currentBaseSizes } = checkTradingPeriod();

            if (needsNewPeriod) {
                // Calculate new base trade sizes for both tokens
                const baseSizes = setNewTradingPeriod(
                    wallet.solBalance,
                    wallet.usdcBalance,
                    STRATEGIC_PERCENTAGE
                );

                // Use the appropriate base size for the current token
                const baseAmount = baseSizes[tokenInfo.NAME];
                return Math.floor(baseAmount * (10 ** tokenInfo.DECIMALS));
            }

            // Use existing base trade size for the current token
            const baseAmount = currentBaseSizes[tokenInfo.NAME];
            return Math.floor(baseAmount * (10 ** tokenInfo.DECIMALS));
        }

        // Default to STRATEGIC if invalid method specified
        return calculateTradeAmount(balance, sentiment, tokenInfo);
    } catch (error) {
        console.error('Error calculating trade amount:', error);
        return 0;
    }
}

async function executeExactOutSwap(wallet, outputMint, exactOutAmount, inputMint) {
    try {
        devLog("Initiating exact out swap");

        const decimals = outputMint === SOL.ADDRESS ? SOL.DECIMALS : USDC.DECIMALS;
        const exactOutAmountFloor = Math.floor(exactOutAmount);

        devLog(`Exact Out Swap Details:`, {
            outputMint: outputMint === SOL.ADDRESS ? 'SOL' : 'USDC',
            inputMint: inputMint === SOL.ADDRESS ? 'SOL' : 'USDC',
            rawAmount: exactOutAmount,
            adjustedAmount: exactOutAmountFloor,
            decimals: decimals
        });

        const params = new URLSearchParams({
            inputMint: inputMint,
            outputMint: outputMint,
            amount: exactOutAmountFloor,
            slippageBps: '50',
            platformFeeBps: '0',
            onlyDirectRoutes: 'false',
            asLegacyTransaction: 'false',
            swapMode: 'ExactOut'
        });

        const quoteUrl = `${BASE_SWAP_URL}/quote?${params.toString()}`;
        devLog(quoteUrl);
        const response = await fetch(quoteUrl);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        const quoteResponse = await response.json();

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

async function executeSwap(wallet, sentiment, USDC, SOL) {
    const settings = readSettings();

    // Check cooldown
    if (isTradeOnCooldown(wallet, settings)) {
        return 'cooldownfail';
    }

    let tradeAmount;
    let isBuying;
    let inputMint;
    let outputMint;

    try {
        devLog("Initiating swap with sentiment:", sentiment);

        isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
        inputMint = isBuying ? USDC.ADDRESS : SOL.ADDRESS;
        outputMint = isBuying ? SOL.ADDRESS : USDC.ADDRESS;
        const balance = isBuying ? wallet.usdcBalance : wallet.solBalance;

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
        devLog("No swap executed or swap failed. Position remains unchanged.");
        return null;
    }

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
}

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
    devLog("Entering resetPosition function");
    const wallet = getWallet();
    const connection = getConnection();
    devLog("Wallet:", wallet);
    devLog("Connection:", connection);
    const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
    const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL);
    position = new Position(solBalance, usdcBalance, currentPrice);
    devLog("Position reset. New position:");
    devLog(`SOL Balance: ${solBalance.toFixed(SOL.DECIMALS)} SOL`);
    devLog(`USDC Balance: ${usdcBalance.toFixed(USDC.DECIMALS)} USDC`);
    devLog(`Current SOL Price: $${currentPrice.toFixed(2)}`);
    devLog(`Portfolio Value: $${position.getCurrentValue(currentPrice).toFixed(2)}`);

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

function getRandomTipAccount() {
    return TIP_ACCOUNTS[Math.floor(Math.random() * TIP_ACCOUNTS.length)];
}

async function jitoTipCheck() {
    try {
        const response = await fetch('https://bundles.jito.wtf/api/v1/bundles/tip_floor', {
            timeout: 21000
        });

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
        throw error;
    }
}

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
            devLog('Failed to deserialize transaction');
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

        const successful_trades = 1n;
        const sol_lamport_volume = BigInt(!isBuying ? tradeAmount : 0);
        const usd_lamport_volume = BigInt(isBuying ? tradeAmount : 0);
        const jup_lamport_volume = 0n;
        const wif_lamport_volume = 0n;
        const bonk_lamport_volume = 0n;

        devLog(successful_trades)
        devLog(sol_lamport_volume)
        devLog(usd_lamport_volume)
        devLog(jup_lamport_volume)
        devLog(wif_lamport_volume)
        devLog(bonk_lamport_volume)

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

async function waitForBundleConfirmation(bundleId) {
    const checkInterval = 2000; // Check every 2 seconds
    let retries = 0;
    const maxRetries = 60; // Will check for about 120 seconds total

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

    devLog("Sending bundle to Jito Block Engine...");

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
    devLog(`\nJito Bundle Result: ${url}`);

    return result;
}

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