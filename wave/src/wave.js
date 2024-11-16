const Position = require('./Position');
const { executeSwap, updatePortfolioBalances, USDC, SOL, updatePositionFromSwap, logPositionUpdate, cancelPendingBundle } = require('./trading');
const { fetchFearGreedIndex, getSentiment, fetchPrice, BASE_PRICE_URL } = require('./api');
const { getTimestamp, formatTime, getWaitTime, logTradingData, getVersion } = require('./utils');
const { server, paramUpdateEmitter, setInitialData, addRecentTrade, emitTradingData, readSettings, getMonitorMode, clearRecentTrades, saveState, loadState } = require('./waveServer');
const { setWallet, setConnection, getWallet, getConnection } = require('./globalState');
const cliProgress = require('cli-progress');
const path = require('path');
const csv = require('csv-writer').createObjectCsvWriter;
const fs = require('fs')

// Global variables
let isCurrentExecutionCancelled = false;
let globalTimeoutId;
let position;
let MONITOR_MODE = getMonitorMode();
let currentPrice;
let SENTIMENT_BOUNDARIES;
let SENTIMENT_MULTIPLIERS;
let wallet = getWallet();
let connection = getConnection();

// Streak tracking globals
let sentimentStreak = [];
let totalStreaks = 0;
let totalStreakLength = 0;

const initialSettings = readSettings();

let STREAK_THRESHOLD = initialSettings.STREAK_THRESHOLD || 5; // Default to 5 if not found

const STREAK_LOG_PATH = path.join(__dirname, '..', '..', 'user', 'wave_streaks.csv');

const progressBar = new cliProgress.SingleBar({
    format: 'Progress |{bar}| {percentage}% | {remainingTime}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    stopOnComplete: true,
    clearOnComplete: true
});

const streakLogger = csv({
    path: STREAK_LOG_PATH,
    header: [
        { id: 'timestamp', title: 'Time of Streak' },
        { id: 'length', title: 'Streak Length' },
        { id: 'type', title: 'Streak Type' },
        { id: 'values', title: 'FGI Values' }
    ],
    append: true
});

async function loadHistoricalStreaks() {
    try {
        if (!fs.existsSync(STREAK_LOG_PATH)) {
            console.log("No streak history file found. Starting fresh.");
            return { totalStreaks: 0, totalLength: 0 };
        }

        const fileContent = await fs.promises.readFile(STREAK_LOG_PATH, 'utf-8');
        const lines = fileContent.split('\n');

        // Skip header row
        const dataLines = lines.slice(1).filter(line => line.trim().length > 0);

        let totalLength = 0;
        const count = dataLines.length;

        for (const line of dataLines) {
            const [timestamp, length] = line.split(',');
            totalLength += parseInt(length) || 0;
        }

        console.log(`Loaded ${count} historical streaks with total length ${totalLength}`);
        return { totalStreaks: count, totalLength };
    } catch (error) {
        console.error('Error loading streak history:', error);
        return { totalStreaks: 0, totalLength: 0 };
    }
}

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
    cleanupProgressBar();

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

    return updateInterval;
}

async function logStreak(streak) {
    if (!streak || streak.length < 2) return;

    const now = new Date();
    const timestamp = now.toISOString().replace('T', ' ').slice(0, 19);

    const fgiValues = streak.map(s => s.fgi).join(', ');
    const streakType = streak[0].sentiment.includes('FEAR') ? 'Fear' : 'Greed';

    // Update streak statistics after validating the streak
    totalStreaks++;
    totalStreakLength += streak.length;
    const averageStreakLength = (totalStreakLength / totalStreaks).toFixed(2);

    const data = [{
        timestamp: timestamp,
        length: streak.length,
        type: streakType,
        values: fgiValues
    }];

    try {
        await streakLogger.writeRecords(data);
        console.log(`Logged ${streakType} streak of ${streak.length} readings with values: ${fgiValues}`);
        console.log(`Average streak length: ${averageStreakLength} (Total streaks: ${totalStreaks})`);
    } catch (error) {
        console.error('Error logging streak:', error);
    }
}

function updateSentimentStreak(sentiment, fearGreedIndex) {
    const currentReading = {
        sentiment: sentiment,
        fgi: fearGreedIndex
    };

    // If we're starting fresh
    if (sentimentStreak.length === 0) {
        if (sentiment !== "NEUTRAL") {
            sentimentStreak.push(currentReading);
        }
        return { display: 'No streak', wasCleared: false };
    }

    const lastSentiment = sentimentStreak[sentimentStreak.length - 1].sentiment;
    
    // Check if sentiment follows valid pattern
    const followsPattern = (
        (sentiment === "EXTREME_FEAR" && lastSentiment === "FEAR") ||
        (sentiment === "FEAR" && lastSentiment === "EXTREME_FEAR") ||
        (sentiment === "EXTREME_GREED" && lastSentiment === "GREED") ||
        (sentiment === "GREED" && lastSentiment === "EXTREME_GREED") ||
        sentiment === lastSentiment
    );

    // If pattern continues, add to streak
    if (followsPattern) {
        sentimentStreak.push(currentReading);
        const streakDisplay = sentimentStreak.map(s => s.fgi).join(', ');
        return { display: streakDisplay, wasCleared: false };
    }

    // Streak is ending
    const streakDisplay = sentimentStreak.map(s => s.fgi).join(', ');
    return { display: streakDisplay, wasCleared: true };
}

function shouldTrade(sentiment) {
    return sentimentStreak.length >= STREAK_THRESHOLD && sentiment === "NEUTRAL";
}

async function main() {
    console.log("Entering WaveSurfer main function");
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

        // Get streak display for UI
        const streakResult = updateSentimentStreak(sentiment, fearGreedIndex);
        let streakDisplay = streakResult.display;

        let swapResult = null;
        let recentTrade = null;
        let txId = null;

        // Wave trading logic
        if (!MONITOR_MODE && shouldTrade(sentiment)) {
            const tradeSentiment = sentimentStreak[0].sentiment;
            swapResult = await executeSwap(wallet, tradeSentiment, USDC, SOL);
        
            if (isCurrentExecutionCancelled) {
                console.log("Execution cancelled. Exiting main.");
                return;
            }
        
            if (swapResult) {
                txId = swapResult.txId;
                recentTrade = updatePositionFromSwap(position, swapResult, tradeSentiment, currentPrice);
                if (recentTrade) {
                    addRecentTrade(recentTrade);
                    console.log(`${getTimestamp()}: ${recentTrade.type} ${recentTrade.amount.toFixed(6)} SOL at $${recentTrade.price.toFixed(2)}`);
                }
            } else {
                console.log(`${getTimestamp()}: Trade execution failed - no swap performed`);
            }
        
            // Log and clear streak after trading
            if (sentimentStreak.length >= 2) {
                await logStreak(sentimentStreak);
            }
            console.log("Clearing sentiment streak after trade");
            sentimentStreak = [];
            streakDisplay = 'No streak - Recently Traded';
        } else if (streakResult.wasCleared) {
            // Pattern broke or hit neutral without threshold - log and clear
            if (sentimentStreak.length >= 2) {
                await logStreak(sentimentStreak);
            }
            sentimentStreak = [];
            streakDisplay = 'No streak';
        } else if (MONITOR_MODE) {
            console.log("Monitor Mode: Data collected without trading.");
            // If in monitor mode and we hit NEUTRAL, still log the streak
            if (sentiment === "NEUTRAL" && sentimentStreak.length >= 2) {
                await logStreak(sentimentStreak);
                streakDisplay = 'No streak - Recently Cleared';
                sentimentStreak = [];
            }
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
        console.log(`Current Sentiment Streak Values: ${streakDisplay}`);
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
            startTime: position.startTime,
            sentimentStreak: streakDisplay,
            streakThreshold: STREAK_THRESHOLD,
            streakStats: {
                averageLength: totalStreaks > 0 ? (totalStreakLength / totalStreaks).toFixed(2) : '0',
                totalStreaks: totalStreaks
            }
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
            settings: readSettings(),
            streakData: {
                sentimentStreak,
                totalStreaks,
                totalStreakLength,
                streakStats: {
                    averageLength: totalStreaks > 0 ? (totalStreakLength / totalStreaks).toFixed(2) : '0',
                    totalStreaks: totalStreaks
                }
            }
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

    // Load historical streaks first
    const historicalStreaks = await loadHistoricalStreaks();
    totalStreaks = historicalStreaks.totalStreaks;
    totalStreakLength = historicalStreaks.totalLength;
    console.log(`Initialized with ${totalStreaks} historical streaks, average length: ${totalStreaks > 0 ? (totalStreakLength / totalStreaks).toFixed(2) : '0'}`);

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

        // Update trading data with correct streak stats before setting initial data
        const updatedTradingData = {
            ...savedState.tradingData,
            streakStats: {
                averageLength: totalStreaks > 0 ? (totalStreakLength / totalStreaks).toFixed(2) : '0',
                totalStreaks: totalStreaks
            }
        };
        setInitialData(updatedTradingData);

        // Only restore current streak from saved state, keep historical totals
        if (savedState.streakData && savedState.streakData.sentimentStreak) {
            sentimentStreak = savedState.streakData.sentimentStreak || [];
            console.log("Restored current streak:", sentimentStreak);
        }

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

    // Reset streak tracking
    totalStreaks = 0;
    totalStreakLength = 0;
    sentimentStreak = [];
    try {
        if (fs.existsSync(STREAK_LOG_PATH)) {
            //Reset file with just headers (probably better)
            const headers = 'Time of Streak,Streak Length,Streak Type,FGI Values\n';
            fs.writeFileSync(STREAK_LOG_PATH, headers);
            console.log("Streak history file reset successfully");
        }
    } catch (error) {
        console.error('Error resetting streak history file:', error);
    }

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
        startTime: Date.now(),
        sentimentStreak: 'No Streak',
        streakThreshold: STREAK_THRESHOLD,
        streakStats: {
            averageLength: '0',  // Start with '0' instead of 'N/A'
            totalStreaks: 0
        }
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
        streakStats: {
            totalStreaks: 0,
            totalStreakLength: 0
        },
        sentimentStreak: []
    });
}

function handleParameterUpdate(newParams) {
    console.log('\n--- Parameter Update Received ---');
    console.log('New parameters:');
    console.log(JSON.stringify(newParams, null, 2));

    const updatedSettings = readSettings();

    if (updatedSettings.SENTIMENT_BOUNDARIES) {
        SENTIMENT_BOUNDARIES = updatedSettings.SENTIMENT_BOUNDARIES;
        console.log('Sentiment boundaries updated. New boundaries:', SENTIMENT_BOUNDARIES);
    }
    if (updatedSettings.SENTIMENT_MULTIPLIERS) {
        SENTIMENT_MULTIPLIERS = updatedSettings.SENTIMENT_MULTIPLIERS;
        console.log('Sentiment multipliers updated. New multipliers:', SENTIMENT_MULTIPLIERS);
    }
    if (updatedSettings.STREAK_THRESHOLD) {
        STREAK_THRESHOLD = updatedSettings.STREAK_THRESHOLD;
        console.log('Streak threshold updated. New threshold:', STREAK_THRESHOLD);
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

    // Reset the cancellation flag and sentiment streak
    isCurrentExecutionCancelled = false;

    // Reset streak tracking
    totalStreaks = 0;
    totalStreakLength = 0;
    sentimentStreak = [];

    // Calculate the time until the next interval
    const waitTime = getWaitTime();
    const nextExecutionTime = new Date(Date.now() + waitTime);

    console.log(`Next trading cycle will start at ${nextExecutionTime.toLocaleTimeString()} (in ${formatTime(waitTime)})`);

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
        console.log("Starting WaveSurfer...");
        await initialize();
    } catch (error) {
        console.error("Failed to initialize WaveSurfer:", error);
        process.exit(1);
    }
})();

module.exports = { main, initialize, resetPosition };