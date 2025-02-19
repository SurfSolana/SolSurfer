const Position = require('./Position');
const OrderBook = require('./orderBook');
const { executeSwap, executeExactOutSwap, updatePortfolioBalances, USDC, SOL, updatePositionFromSwap, logPositionUpdate, cancelPendingBundle, calculateTradeAmount } = require('./trading');
const { fetchFearGreedIndex, getSentiment, fetchPrice, BASE_PRICE_URL } = require('./api');
const { getTimestamp, formatTime, getWaitTime, logTradingData, getVersion, loadEnvironment, devLog } = require('./utils');
const { startServer, server, paramUpdateEmitter, setInitialData, addRecentTrade, emitTradingData, readSettings, getMonitorMode, clearRecentTrades, saveState, loadState, orderBook } = require('./pulseServer');
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

async function checkAndCloseOpposingTrade(sentiment, currentPrice) {
    const isFearSentiment = ["FEAR", "EXTREME_FEAR"].includes(sentiment);
    const isGreedSentiment = ["GREED", "EXTREME_GREED"].includes(sentiment);
    
    if (!isFearSentiment && !isGreedSentiment) {
        console.log(`Current sentiment (${sentiment}) not appropriate for trading`);
        return null;
    }

    const oldestMatchingTrade = orderBook.findOldestMatchingTrade(
        isFearSentiment ? "sell" : "buy",
        currentPrice
    );
    
    if (oldestMatchingTrade) {
        devLog(`Found opposing trade to close:`, oldestMatchingTrade);
        
        try {
            const isClosingBuy = oldestMatchingTrade.direction === 'sell';
            
            const exactOutAmount = isClosingBuy ? 
                Math.floor(oldestMatchingTrade.solAmount * Math.pow(10, SOL.DECIMALS)) :
                Math.floor(oldestMatchingTrade.value * Math.pow(10, USDC.DECIMALS));
            
            devLog(`Closing trade details:`, {
                originalTrade: {
                    direction: oldestMatchingTrade.direction,
                    solAmount: oldestMatchingTrade.solAmount,
                    value: oldestMatchingTrade.value,
                },
                closingTrade: {
                    action: isClosingBuy ? 'buy' : 'sell',
                    exactOutAmount,
                    expectedUsdcAmount: oldestMatchingTrade.value
                }
            });
            
            const swapResult = await executeExactOutSwap(
                wallet,
                isClosingBuy ? SOL.ADDRESS : USDC.ADDRESS,
                exactOutAmount,
                isClosingBuy ? USDC.ADDRESS : SOL.ADDRESS
            );

            if (swapResult) {
                devLog('Closing trade swap successful:', swapResult);
                return {
                    swapResult,
                    closedTradeId: oldestMatchingTrade.id
                };
            }
        } catch (error) {
            console.error('Error closing opposing trade:', error);
        }
    } else {
        devLog(`No opposing trades found to close in ${sentiment} sentiment`);
    }
    return null;
}

async function hasOpposingTrades(sentiment) {
    const isFearSentiment = ["FEAR", "EXTREME_FEAR"].includes(sentiment);
    const isGreedSentiment = ["GREED", "EXTREME_GREED"].includes(sentiment);
    
    if (!isFearSentiment && !isGreedSentiment) {
        console.log(`Current sentiment (${sentiment}) not appropriate for trading`);
        return false;
    }

    // Look for opposing trades based on sentiment
    const oldestMatchingTrade = orderBook.findOldestMatchingTrade(
        isFearSentiment ? "sell" : "buy",
        currentPrice
    );
    
    return oldestMatchingTrade !== null;
}

async function main() {
    devLog("Entering PulseSurfer main function");
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
        devLog(`Data Logged: ${timestamp}, ${currentPrice}, ${fearGreedIndex}`);

        console.log(`\n--- Trading Cycle: ${timestamp} ---`);
        console.log(`Fear & Greed Index: ${fearGreedIndex} - Sentiment: ${sentiment}`);
        console.log(`Current SOL Price: $${currentPrice.toFixed(2)}`);

        devLog("Updating portfolio balances...");
        wallet = getWallet();
        connection = getConnection();
        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialized");
        }
        const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
        devLog(`Updated balances - SOL: ${solBalance}, USDC: ${usdcBalance}`);

        position.updateBalances(solBalance, usdcBalance);

        orderBook.updateTradeUPNL(currentPrice);

        if (isCurrentExecutionCancelled) {
            devLog("Execution cancelled. Exiting main.");
            return;
        }

        let txId = null;
        const MAX_ATTEMPTS = 10;

        // Pulse trading logic - trade on any non-neutral sentiment
        if (!MONITOR_MODE && sentiment !== "NEUTRAL") {
            let swapResult = null;
            let recentTrade = null;
            let txId = null;
            let success = false;
        
            // Check for closing trades
            const hasPositionToClose = await hasOpposingTrades(sentiment, currentPrice);
        
            if (hasPositionToClose) {
                // Closing Trade Loop
                let attempt = 1;
                while (attempt <= MAX_ATTEMPTS && !success && !isCurrentExecutionCancelled) {
                    console.log("Closing Trade...");
                    const closingResult = await checkAndCloseOpposingTrade(sentiment, currentPrice);
                    if (closingResult) {
                        swapResult = closingResult.swapResult;
                        orderBook.closeTrade(closingResult.closedTradeId, swapResult.price);
                        success = true;
                        break;
                    } else if (attempt < MAX_ATTEMPTS) {
                        console.log(`${getTimestamp()}: Closing trade attempt ${attempt} failed - retrying in 5 seconds...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    attempt++;
                }
            } else if (!hasPositionToClose) {
                // Opening Trade Loop
                let attempt = 1;
                while (attempt <= MAX_ATTEMPTS && !success && !isCurrentExecutionCancelled) {
                    console.log("Opening Trade...");
                    const isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
                    const balance = isBuying ? wallet.usdcBalance : wallet.solBalance;
                    
                    const rawTradeAmount = calculateTradeAmount(balance, sentiment, isBuying ? USDC : SOL);
                    const tradeAmount = rawTradeAmount / Math.pow(10, isBuying ? USDC.DECIMALS : SOL.DECIMALS);
                    
                    if (!await minimumBalanceCheck(balance, tradeAmount, !isBuying, currentPrice)) {
                        console.log(`${getTimestamp()}: Trade skipped - minimum balance protection`);
                        break;
                    }
        
                    console.log("Placing Trade...");
                    swapResult = await executeSwap(wallet, sentiment, USDC, SOL);
                    if (swapResult === 'cooldownfail' || swapResult === 'fgichangefail') {
                        // Don't retry for these conditions
                        console.log(`${getTimestamp()}: Trade failed due to cooldown or FGI change - skipping retry`);
                        break;
                    } else if (swapResult) {
                        success = true;
                        break;
                    } else if (attempt < MAX_ATTEMPTS) {
                        console.log(`${getTimestamp()}: Opening trade attempt ${attempt} failed - retrying in 5 seconds...`);
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    attempt++;
                }
            }
        
            // Common success handling for both trade types
            if (swapResult && swapResult !== 'cooldownfail' && swapResult !== 'fgichangefail') {
                txId = swapResult.txId;

                devLog('New position trade successful, updating orderbook...', {
                    price: swapResult.price,
                    solChange: swapResult.solChange,
                    usdcChange: swapResult.usdcChange,
                    txId: swapResult.txId
                });
                
                if (!hasPositionToClose) {
                    // Only add to orderbook if it's a new position
                    orderBook.addTrade(
                        swapResult.price, 
                        swapResult.solChange, 
                        swapResult.usdcChange, 
                        swapResult.txId
                    );
                }
        
                recentTrade = updatePositionFromSwap(position, swapResult, sentiment, currentPrice);
                if (recentTrade) {
                    addRecentTrade(recentTrade);
                    console.log(`${getTimestamp()}: ${recentTrade.type} ${recentTrade.amount.toFixed(6)} SOL at $${recentTrade.price.toFixed(2)}`);
                }
        
                const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
                position.updateBalances(solBalance, usdcBalance);
            } else {
                console.log(`${getTimestamp()}: All trade attempts failed`);
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

        devLog(`Jito Bundle ID: ${txId}`);

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

        devLog('Emitting trading data with version:', getVersion());
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

                devLog('Next execution scheduled successfully');
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
    const env = await loadEnvironment();
    setWallet(env.wallet);
    setConnection(env.connection);
    devLog(".env successfully applied");

    clearTimeout(globalTimeoutId);

    // Use the startServer function that handles version checking
    await startServer();

    const savedState = loadState();
    devLog("SaveState:", savedState ? "Found" : "Not found");

    if (savedState) {
        devLog("Initializing from saved state...");
        
        // Initialize position
        if (savedState.position) {
            position = new Position(
                savedState.position.initialSolBalance,
                savedState.position.initialUsdcBalance,
                savedState.position.initialPrice
            );
            Object.assign(position, savedState.position);
        }

        setInitialData(savedState.tradingData);
        devLog("Position and initial data set from saved state");
    } else {
        devLog("No saved state found. Starting fresh.");
        await resetPosition();
        devLog("Position reset completed");
    }

    MONITOR_MODE = getMonitorMode();
    console.log("Monitor mode:", MONITOR_MODE ? "Enabled" : "Disabled");

    await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
    await main();
}

async function resetPosition(wallet, connection) {
    devLog("Resetting position and orderBook...");
    wallet = getWallet();
    connection = getConnection();

    cancelPendingBundle();

    if (!wallet || !connection) {
        throw new Error("Wallet or connection is not initialized in resetPosition");
    }

    const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
    const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
    position = new Position(solBalance, usdcBalance, currentPrice);
    orderBook.trades = [];
    orderBook.saveTrades();

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
        settings: readSettings(),
        orderBook: orderBook.getState()
    });
}

function handleParameterUpdate(newParams) {
    devLog('\n--- Parameter Update Received ---');
    devLog('New parameters:');
    devLog(JSON.stringify(newParams, null, 2));

    const updatedSettings = readSettings(); // Read the updated settings

    if (updatedSettings.SENTIMENT_BOUNDARIES) {
        SENTIMENT_BOUNDARIES = updatedSettings.SENTIMENT_BOUNDARIES;
        devLog('Sentiment boundaries updated. New boundaries:', SENTIMENT_BOUNDARIES);
    }
    if (updatedSettings.SENTIMENT_MULTIPLIERS) {
        SENTIMENT_MULTIPLIERS = updatedSettings.SENTIMENT_MULTIPLIERS;
        devLog('Sentiment multipliers updated. New multipliers:', SENTIMENT_MULTIPLIERS);
    }

    devLog('Trading strategy will adjust in the next cycle.');
    devLog('----------------------------------\n');
}

paramUpdateEmitter.on('paramsUpdated', handleParameterUpdate);

paramUpdateEmitter.on('restartTrading', async () => {
    devLog("Restarting trading...");
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
    devLog("Position reset. Waiting for next scheduled interval to start trading...");

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
        devLog("Starting new trading cycle.");
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