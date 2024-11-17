const Position = require('./Position');
const { executeSwap, updatePortfolioBalances, USDC, SOL, updatePositionFromSwap, logPositionUpdate, cancelPendingBundle, calculateTradeAmount } = require('./trading');
const { fetchFearGreedIndex, getSentiment, fetchPrice, BASE_PRICE_URL } = require('./api');
const { getTimestamp, formatTime, getWaitTime, logTradingData, getVersion } = require('./utils');
const { server, paramUpdateEmitter, setInitialData, addRecentTrade, emitTradingData, readSettings, getMonitorMode, clearRecentTrades, saveState, loadState } = require('./pulseServer');
const { setWallet, setConnection, getWallet, getConnection } = require('./globalState');
const cliProgress = require('cli-progress');

let isCurrentExecutionCancelled = false;
let globalTimeoutId;
let position;
let MONITOR_MODE = getMonitorMode();
let currentPrice;
let SENTIMENT_BOUNDARIES;
let SENTIMENT_MULTIPLIERS;
let wallet = getWallet();
let connection = getConnection();

const MIN_USD_VALUE = 5; // Minimum USD value to keep in the wallet

// Create the progress bar
const progressBar = new cliProgress.SingleBar({
    format: 'Progress |{bar}| {percentage}% | {remainingTime}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    stopOnComplete: true,
    clearOnComplete: true
});

function cleanupProgressBar() {
    try {
        if (progressBar.isActive) {
            progressBar.stop();
        }
    } catch (error) {
        console.error('Error cleaning up progress bar:', error);
    }
}

function startProgressBar(totalSeconds) {
    // First cleanup any existing progress bar
    cleanupProgressBar();

    // Start new progress tracking
    progressBar.start(totalSeconds, 0, {
        remainingTime: formatTime(totalSeconds * 1000)
    });

    let elapsedSeconds = 0;
    const updateInterval = setInterval(() => {
        if (!progressBar.isActive || elapsedSeconds >= totalSeconds) {
            clearInterval(updateInterval);
            cleanupProgressBar();
            return;
        }

        elapsedSeconds++;
        const remainingSeconds = totalSeconds - elapsedSeconds;

        try {
            progressBar.update(elapsedSeconds, {
                remainingTime: formatTime(remainingSeconds * 1000)
            });
        } catch (error) {
            console.error('Error updating progress bar:', error);
            clearInterval(updateInterval);
            cleanupProgressBar();
        }
    }, 1000);

    // Store interval ID for cleanup
    return updateInterval;
}

async function minimumBalanceCheck(balance, amount, isSol, currentPrice) {
    const balanceInUSD = isSol ? balance * currentPrice : balance;
    const amountInUSD = isSol ? amount * currentPrice : amount;
    const remainingBalanceUSD = balanceInUSD - amountInUSD;
    
    if (remainingBalanceUSD < MIN_USD_VALUE) {
        console.log(`${getTimestamp()}: Trade blocked - Would leave ${isSol ? 'SOL' : 'USDC'} balance below $${MIN_USD_VALUE}`);
        return false;
    }
    return true;
}

async function main() {
    console.log("Entering PulseSurfer main function");
    isCurrentExecutionCancelled = false;
    let progressInterval = null;

    try {
        cleanupProgressBar();
        clearTimeout(globalTimeoutId);

        position.incrementCycle();

        const fearGreedIndex = await fetchFearGreedIndex();
        const sentiment = getSentiment(fearGreedIndex);
        currentPrice = await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
        const timestamp = getTimestamp();

        await logTradingData(timestamp, currentPrice, fearGreedIndex);
        console.log(`Data Logged: ${timestamp}, ${currentPrice}, ${fearGreedIndex}`);

        console.log(`\n--- Trading Cycle: ${timestamp} ---`);
        console.log(`Fear & Greed Index: ${fearGreedIndex} - Sentiment: ${sentiment}`);
        console.log(`Current SOL Price: $${currentPrice.toFixed(2)}`);

        console.log("Updating portfolio balances...");
        wallet = getWallet();
        connection = getConnection();
        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialized");
        }
        const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
        console.log(`Updated balances - SOL: ${solBalance}, USDC: ${usdcBalance}`);

        position.updateBalances(solBalance, usdcBalance);

        if (isCurrentExecutionCancelled) {
            console.log("Execution cancelled. Exiting main.");
            return;
        }

        let swapResult = null;
        let recentTrade = null;
        let txId = null;
        const MAX_ATTEMPTS = 5;

        // Pulse trading logic - trade on any non-neutral sentiment
        if (!MONITOR_MODE && sentiment !== "NEUTRAL") {
            let attempt = 1;
            let success = false;

            while (attempt <= MAX_ATTEMPTS && !success && !isCurrentExecutionCancelled) {
                console.log(`\nAttempt ${attempt}/${MAX_ATTEMPTS} to execute trade...`);
                
                try {
                    const isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
                    const balance = isBuying ? wallet.usdcBalance : wallet.solBalance;
                    
                    // Calculate trade amount in smallest units
                    const rawTradeAmount = calculateTradeAmount(balance, sentiment, isBuying ? USDC : SOL);
                    
                    // Convert to native units for minimumBalanceCheck
                    const tradeAmount = rawTradeAmount / Math.pow(10, isBuying ? USDC.DECIMALS : SOL.DECIMALS);
                    
                    if (!await minimumBalanceCheck(balance, tradeAmount, !isBuying, currentPrice)) {
                        console.log(`${getTimestamp()}: Trade skipped - minimum balance protection`);
                        break;
                    }

                    swapResult = await executeSwap(wallet, sentiment, USDC, SOL);
                    
                    if (swapResult) {
                        success = true;
                        txId = swapResult.txId;
                        recentTrade = updatePositionFromSwap(position, swapResult, sentiment, currentPrice);
                        if (recentTrade) {
                            addRecentTrade(recentTrade);
                            console.log(`${getTimestamp()}: ${recentTrade.type} ${recentTrade.amount.toFixed(6)} SOL at $${recentTrade.price.toFixed(2)}`);
                        }
                    } else {
                        console.log(`${getTimestamp()}: Trade attempt ${attempt} failed - retrying in 5 seconds...`);
                        if (attempt < MAX_ATTEMPTS) {
                            await new Promise(resolve => setTimeout(resolve, 5000));
                        }
                    }
                } catch (error) {
                    console.error(`Error during trade attempt ${attempt}:`, error);
                    if (attempt < MAX_ATTEMPTS) {
                        console.log('Waiting 5 seconds before retry...');
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                }

                attempt++;
            }

            if (!success) {
                console.log(`${getTimestamp()}: All ${MAX_ATTEMPTS} trade attempts failed`);
            }
        } else if (MONITOR_MODE) {
            console.log("Monitor Mode: Data collected without trading.");
        }

        const enhancedStats = position.getEnhancedStatistics(currentPrice);

        console.log("\n--- Enhanced Trading Statistics ---");
        console.log(`Total Script Runtime: ${enhancedStats.totalRuntime} hours`);
        console.log(`Total Cycles: ${enhancedStats.totalCycles}`);
        console.log(`Portfolio Value: $${enhancedStats.portfolioValue.initial} -> $${enhancedStats.portfolioValue.current} (${enhancedStats.portfolioValue.change >= 0 ? '+' : ''}${enhancedStats.portfolioValue.change}) (${enhancedStats.portfolioValue.percentageChange}%)`);
        console.log(`SOL Price: $${enhancedStats.solPrice.initial} -> $${enhancedStats.solPrice.current} (${enhancedStats.solPrice.percentageChange}%)`);
        console.log(`Net Change: $${enhancedStats.netChange}`);
        console.log(`Total Volume: ${enhancedStats.totalVolume.sol} SOL / ${enhancedStats.totalVolume.usdc} USDC ($${enhancedStats.totalVolume.usd})`);
        console.log(`Balances: SOL: ${enhancedStats.balances.sol.initial} -> ${enhancedStats.balances.sol.current}, USDC: ${enhancedStats.balances.usdc.initial} -> ${enhancedStats.balances.usdc.current}`);
        console.log(`Average Prices: Entry: $${enhancedStats.averagePrices.entry}, Sell: $${enhancedStats.averagePrices.sell}`);
        console.log("------------------------------------\n");

        console.log(`Jito Bundle ID: ${txId}`);

        let tradingData = {
            version: getVersion(),
            timestamp,
            price: currentPrice,
            fearGreedIndex,
            sentiment,
            usdcBalance: position.usdcBalance,
            solBalance: position.solBalance,
            portfolioValue: parseFloat(enhancedStats.portfolioValue.current),
            netChange: parseFloat(enhancedStats.netChange),
            averageEntryPrice: parseFloat(enhancedStats.averagePrices.entry) || 0,
            averageSellPrice: parseFloat(enhancedStats.averagePrices.sell) || 0,
            txId,
            initialSolPrice: position.initialPrice,
            initialPortfolioValue: position.initialValue,
            initialSolBalance: position.initialSolBalance,
            initialUsdcBalance: position.initialUsdcBalance,
            startTime: position.startTime
        };

        console.log('Emitting trading data with version:', getVersion());
        emitTradingData(tradingData);

        saveState({
            position: {
                solBalance: position.solBalance,
                usdcBalance: position.usdcBalance,
                initialSolBalance: position.initialSolBalance,
                initialUsdcBalance: position.initialUsdcBalance,
                initialPrice: position.initialPrice,
                initialValue: position.initialValue,
                totalSolBought: position.totalSolBought,
                totalUsdcSpent: position.totalUsdcSpent,
                totalSolSold: position.totalSolSold,
                totalUsdcReceived: position.totalUsdcReceived,
                netSolTraded: position.netSolTraded,
                startTime: position.startTime,
                totalCycles: position.totalCycles,
                totalVolumeSol: position.totalVolumeSol,
                totalVolumeUsdc: position.totalVolumeUsdc
            },
            tradingData,
            settings: readSettings()
        });

    } catch (error) {
        console.error('Error during main execution:', error);
        cleanupProgressBar();
    } finally {
        if (!isCurrentExecutionCancelled) {
            try {
                const waitTime = getWaitTime();
                const nextExecutionTime = new Date(Date.now() + waitTime);
                console.log(`\nNext trading update at ${nextExecutionTime.toLocaleTimeString()} (in ${formatTime(waitTime)})`);

                const totalSeconds = Math.ceil(waitTime / 1000);
                progressInterval = startProgressBar(totalSeconds);

                globalTimeoutId = setTimeout(async () => {
                    if (progressInterval) {
                        clearInterval(progressInterval);
                    }
                    cleanupProgressBar();

                    if (!isCurrentExecutionCancelled) {
                        await main();
                    }
                }, waitTime);

                console.log('Next execution scheduled successfully');
            } catch (scheduleError) {
                console.error('Error scheduling next execution:', scheduleError);
                cleanupProgressBar();
                // Attempt to recover by scheduling another run in 5 minutes
                setTimeout(async () => {
                    if (!isCurrentExecutionCancelled) {
                        await main();
                    }
                }, 300000);
            }
        } else {
            cleanupProgressBar();
        }
    }
}

async function initialize() {
    const { loadEnvironment } = require('./utils');

    const env = await loadEnvironment();
    setWallet(env.wallet);
    setConnection(env.connection);
    console.log(".env successfully applied");

    clearTimeout(globalTimeoutId);

    const savedState = loadState();
    console.log("SaveState :", savedState ? "Found" : "Not found");

    if (savedState && savedState.position) {
        console.log("Initializing from saved state...");
        position = new Position(
            savedState.position.initialSolBalance,
            savedState.position.initialUsdcBalance,
            savedState.position.initialPrice
        );
        Object.assign(position, savedState.position);
        setInitialData(savedState.tradingData);
        console.log("Position and initial data set from saved state");
    } else {
        console.log("No saved state found. Starting fresh.");
        await resetPosition();
        console.log("Position reset completed");
    }

    MONITOR_MODE = getMonitorMode();
    console.log("Monitor mode:", MONITOR_MODE ? "Enabled" : "Disabled");

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`\nLocal Server Running On: http://localhost:${PORT}`);
    });

    await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
    await main();
}

async function resetPosition(wallet, connection) {
    console.log("Resetting position...");
    wallet = getWallet();
    connection = getConnection();

    if (!wallet || !connection) {
        throw new Error("Wallet or connection is not initialized in resetPosition");
    }

    const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
    const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
    position = new Position(solBalance, usdcBalance, currentPrice);

    const fearGreedIndex = await fetchFearGreedIndex();
    const initialData = {
        timestamp: getTimestamp(),
        price: currentPrice,
        fearGreedIndex,
        sentiment: getSentiment(fearGreedIndex),
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
    emitTradingData({ ...initialData, version: getVersion() });
    clearRecentTrades();

    saveState({
        position: {
            solBalance: position.solBalance,
            usdcBalance: position.usdcBalance,
            initialSolBalance: position.initialSolBalance,
            initialUsdcBalance: position.initialUsdcBalance,
            initialPrice: position.initialPrice,
            initialValue: position.initialValue,
            totalSolBought: position.totalSolBought,
            totalUsdcSpent: position.totalUsdcSpent,
            totalSolSold: position.totalSolSold,
            totalUsdcReceived: position.totalUsdcReceived,
            netSolTraded: position.netSolTraded,
            startTime: position.startTime,
            totalCycles: position.totalCycles,
            totalVolumeSol: position.totalVolumeSol,
            totalVolumeUsdc: position.totalVolumeUsdc
        },
        tradingData: initialData,
        settings: readSettings()
    });
}

function handleParameterUpdate(newParams) {
    console.log('\n--- Parameter Update Received ---');
    console.log('New parameters:');
    console.log(JSON.stringify(newParams, null, 2));

    const updatedSettings = readSettings(); // Read the updated settings

    if (updatedSettings.SENTIMENT_BOUNDARIES) {
        SENTIMENT_BOUNDARIES = updatedSettings.SENTIMENT_BOUNDARIES;
        console.log('Sentiment boundaries updated. New boundaries:', SENTIMENT_BOUNDARIES);
    }
    if (updatedSettings.SENTIMENT_MULTIPLIERS) {
        SENTIMENT_MULTIPLIERS = updatedSettings.SENTIMENT_MULTIPLIERS;
        console.log('Sentiment multipliers updated. New multipliers:', SENTIMENT_MULTIPLIERS);
    }

    console.log('Trading strategy will adjust in the next cycle.');
    console.log('----------------------------------\n');
}

paramUpdateEmitter.on('paramsUpdated', handleParameterUpdate);

paramUpdateEmitter.on('restartTrading', async () => {
    console.log("Restarting trading...");
    wallet = getWallet();
    connection = getConnection();

    // Cancel any pending Jito bundles
    cancelPendingBundle();

    // Signal the current execution to stop
    isCurrentExecutionCancelled = true;

    // Clear any existing scheduled runs
    clearTimeout(globalTimeoutId);

    // Stop the progress bar if it's running
    if (progressBar.isActive) {
        progressBar.stop();
    }

    // Wait a bit to ensure the current execution and any pending bundles have a chance to exit
    await new Promise(resolve => setTimeout(resolve, 2000));

    await resetPosition(wallet, connection);
    console.log("Position reset. Waiting for next scheduled interval to start trading...");

    // Reset the cancellation flag
    isCurrentExecutionCancelled = false;

    // Calculate the time until the next interval
    const waitTime = getWaitTime();
    const nextExecutionTime = new Date(Date.now() + waitTime);

    console.log(`Next trading cycle will start at ${nextExecutionTime.toLocaleTimeString()} (in ${formatTime(waitTime)})`);

    // Set up a progress bar for the wait time
    const totalSeconds = Math.ceil(waitTime / 1000);
    progressBar.start(totalSeconds, 0, {
        remainingTime: formatTime(waitTime)
    });

    let elapsedSeconds = 0;
    const updateInterval = setInterval(() => {
        elapsedSeconds++;
        const remainingSeconds = totalSeconds - elapsedSeconds;
        progressBar.update(elapsedSeconds, {
            remainingTime: formatTime(remainingSeconds * 1000)
        });

        if (elapsedSeconds >= totalSeconds) {
            clearInterval(updateInterval);
            progressBar.stop();
        }
    }, 1000);

    // Schedule the next run at the correct interval
    globalTimeoutId = setTimeout(() => {
        console.log("Starting new trading cycle.");
        main();
    }, waitTime);
});

(async function () {
    try {
        console.log("Starting PulseSurfer...");
        await initialize();
    } catch (error) {
        console.error("Failed to initialize PulseSurfer:", error);
        process.exit(1);
    }
})();

module.exports = { main, initialize, resetPosition };
