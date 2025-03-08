/**
 * PulseSurfer Trading Bot
 * Automated trading system that uses sentiment analysis to trade SOL/USDC
 */

// Core dependencies
const Position = require('./Position');
const OrderBook = require('./orderBook');
const { 
    executeSwap, 
    executeExactOutSwap, 
    updatePortfolioBalances, 
    USDC, 
    SOL, 
    updatePositionFromSwap, 
    logPositionUpdate, 
    cancelPendingBundle, 
    calculateTradeAmount 
} = require('./trading');
const { 
    fetchFearGreedIndex, 
    getSentiment, 
    fetchPrice, 
    BASE_PRICE_URL 
} = require('./api');
const { 
    getTimestamp, 
    formatTime, 
    getWaitTime, 
    logTradingData, 
    getVersion, 
    loadEnvironment, 
    devLog 
} = require('./utils');
const { 
    startServer, 
    server, 
    paramUpdateEmitter, 
    setInitialData, 
    addRecentTrade, 
    emitTradingData, 
    readSettings, 
    getMonitorMode, 
    clearRecentTrades, 
    saveState, 
    loadState, 
    orderBook 
} = require('./pulseServer');
const { 
    setWallet, 
    setConnection, 
    getWallet, 
    getConnection 
} = require('./globalState');
const cliProgress = require('cli-progress');

// Global state management
let isCurrentExecutionCancelled = false;
let globalTimeoutId = null;
let position = null;
let MONITOR_MODE = false;
let currentPrice = 0;
let SENTIMENT_BOUNDARIES = null;
let SENTIMENT_MULTIPLIERS = null;
let wallet = null;
let connection = null;
let progressInterval = null;

// Configuration
const MIN_USD_VALUE = 5; // Minimum USD value to keep in the wallet
const MAX_TRADE_ATTEMPTS = 10;
const RETRY_DELAY = 5000; // 5 seconds

/**
 * Progress bar for visualizing wait time between trading cycles
 */
const progressBar = new cliProgress.SingleBar({
    format: 'Progress |{bar}| {percentage}% | {remainingTime} remaining | {timeframe}',
    barCompleteChar: '\u2588',
    barIncompleteChar: '\u2591',
    hideCursor: true,
    stopOnComplete: true,
    clearOnComplete: true
});

/**
 * Safely cleans up the progress bar
 */
function cleanupProgressBar() {
    try {
        if (progressBar && progressBar.isActive) {
            progressBar.stop();
        }
    } catch (error) {
        console.error('Error cleaning up progress bar:', error);
    }
}

/**
 * Starts and manages a progress bar for the given duration
 * @param {number} totalSeconds - Total seconds to track
 * @param {string} timeframe - Current FGI timeframe
 * @returns {number} - Interval ID for cleanup
 */
function startProgressBar(totalSeconds, timeframe = '15m') {
    // First cleanup any existing progress bar
    cleanupProgressBar();
    
    if (totalSeconds <= 0) {
        devLog('Invalid progress bar duration');
        return null;
    }

    try {
        // Start new progress tracking with timeframe info
        progressBar.start(totalSeconds, 0, {
            remainingTime: formatTime(totalSeconds * 1000),
            timeframe: timeframe
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
                    remainingTime: formatTime(remainingSeconds * 1000),
                    timeframe: timeframe
                });
            } catch (error) {
                console.error('Error updating progress bar:', error);
                clearInterval(updateInterval);
                cleanupProgressBar();
            }
        }, 1000);

        return updateInterval;
    } catch (error) {
        console.error('Error starting progress bar:', error);
        return null;
    }
}

/**
 * Verifies if a trade will leave sufficient balance
 * @param {number} balance - Current balance
 * @param {number} amount - Trade amount
 * @param {boolean} isSol - Is SOL balance (vs USDC)
 * @param {number} currentPrice - Current SOL price
 * @returns {boolean} - True if balance will be sufficient
 */
async function minimumBalanceCheck(balance, amount, isSol, currentPrice) {
    try {
        if (typeof balance !== 'number' || isNaN(balance) ||
            typeof amount !== 'number' || isNaN(amount) ||
            typeof currentPrice !== 'number' || isNaN(currentPrice)) {
            console.error('Invalid inputs for minimum balance check');
            return false;
        }
        
        const balanceInUSD = isSol ? balance * currentPrice : balance;
        const amountInUSD = isSol ? amount * currentPrice : amount;
        const remainingBalanceUSD = balanceInUSD - amountInUSD;
        
        if (remainingBalanceUSD < MIN_USD_VALUE) {
            console.log(`${getTimestamp()}: Trade blocked - Would leave ${isSol ? 'SOL' : 'USDC'} balance below $${MIN_USD_VALUE}`);
            return false;
        }
        return true;
    } catch (error) {
        console.error('Error in minimum balance check:', error);
        return false;
    }
}

/**
 * Checks for and closes a profitable opposite-direction trade
 * @param {string} sentiment - Current market sentiment
 * @param {number} currentPrice - Current SOL price
 * @returns {Object|null} - Result of closing trade or null
 */
async function checkAndCloseOpposingTrade(sentiment, currentPrice) {
    try {
        const isFearSentiment = ["FEAR", "EXTREME_FEAR"].includes(sentiment);
        const isGreedSentiment = ["GREED", "EXTREME_GREED"].includes(sentiment);
        
        if (!isFearSentiment && !isGreedSentiment) {
            devLog(`Current sentiment (${sentiment}) not appropriate for trading`);
            return null;
        }

        // Find the oldest trade in the opposite direction
        const oldestMatchingTrade = orderBook.findOldestMatchingTrade(
            isFearSentiment ? "sell" : "buy",
            currentPrice
        );
        
        if (!oldestMatchingTrade) {
            devLog(`No opposing trades found to close in ${sentiment} sentiment`);
            return null;
        }
        
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
            
            // Execute the swap to close the position
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
            console.error('Error executing swap to close opposing trade:', error);
        }
        
        return null;
    } catch (error) {
        console.error('Error in checkAndCloseOpposingTrade:', error);
        return null;
    }
}

/**
 * Checks if there are any opposing trades that could be closed
 * @param {string} sentiment - Current market sentiment
 * @returns {boolean} - True if opposing trades exist
 */
async function hasOpposingTrades(sentiment) {
    try {
        const isFearSentiment = ["FEAR", "EXTREME_FEAR"].includes(sentiment);
        const isGreedSentiment = ["GREED", "EXTREME_GREED"].includes(sentiment);
        
        if (!isFearSentiment && !isGreedSentiment) {
            devLog(`Current sentiment (${sentiment}) not appropriate for trading`);
            return false;
        }

        // Look for opposing trades based on sentiment
        const oldestMatchingTrade = orderBook.findOldestMatchingTrade(
            isFearSentiment ? "sell" : "buy",
            currentPrice
        );
        
        return oldestMatchingTrade !== null;
    } catch (error) {
        console.error('Error checking for opposing trades:', error);
        return false;
    }
}

/**
 * Executes a trade to open a new position
 * @param {string} sentiment - Current market sentiment
 * @returns {Object|null} - Trade result or null
 */
async function executeOpeningTrade(sentiment) {
    let attempt = 1;
    
    while (attempt <= MAX_TRADE_ATTEMPTS && !isCurrentExecutionCancelled) {
        try {
            console.log(`Opening Trade (Attempt ${attempt}/${MAX_TRADE_ATTEMPTS})...`);
            const isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
            const balance = isBuying ? wallet.usdcBalance : wallet.solBalance;
            
            const rawTradeAmount = calculateTradeAmount(balance, sentiment, isBuying ? USDC : SOL);
            const tradeAmount = rawTradeAmount / Math.pow(10, isBuying ? USDC.DECIMALS : SOL.DECIMALS);
            
            // Check if trade would leave minimum balance
            if (!await minimumBalanceCheck(balance, tradeAmount, !isBuying, currentPrice)) {
                console.log(`${getTimestamp()}: Trade skipped - minimum balance protection`);
                return null;
            }
    
            console.log(`Placing ${isBuying ? 'Buy' : 'Sell'} Trade...`);
            const swapResult = await executeSwap(wallet, sentiment, USDC, SOL);
            
            if (swapResult === 'cooldownfail' || swapResult === 'fgichangefail') {
                // Don't retry for these conditions
                console.log(`${getTimestamp()}: Trade failed due to cooldown or FGI change - skipping retry`);
                return swapResult;
            } else if (swapResult) {
                return swapResult;
            }
        } catch (error) {
            console.error(`Error executing opening trade (attempt ${attempt}):`, error);
        }
        
        if (attempt < MAX_TRADE_ATTEMPTS && !isCurrentExecutionCancelled) {
            console.log(`${getTimestamp()}: Opening trade attempt ${attempt} failed - retrying in ${RETRY_DELAY/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
        
        attempt++;
    }
    
    return null;
}

/**
 * Executes a trade to close an existing position
 * @param {string} sentiment - Current market sentiment
 * @returns {Object|null} - Trade result or null
 */
async function executeClosingTrade(sentiment) {
    let attempt = 1;
    
    while (attempt <= MAX_TRADE_ATTEMPTS && !isCurrentExecutionCancelled) {
        try {
            console.log(`Closing Trade (Attempt ${attempt}/${MAX_TRADE_ATTEMPTS})...`);
            const closingResult = await checkAndCloseOpposingTrade(sentiment, currentPrice);
            
            if (closingResult) {
                return closingResult;
            }
        } catch (error) {
            console.error(`Error executing closing trade (attempt ${attempt}):`, error);
        }
        
        if (attempt < MAX_TRADE_ATTEMPTS && !isCurrentExecutionCancelled) {
            console.log(`${getTimestamp()}: Closing trade attempt ${attempt} failed - retrying in ${RETRY_DELAY/1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
        
        attempt++;
    }
    
    return null;
}

/**
 * Process and display enhanced trading statistics
 * @param {Object} stats - Trading statistics
 */
function displayEnhancedStatistics(stats) {
    console.log("\n--- Enhanced Trading Statistics ---");
    console.log(`Total Script Runtime: ${stats.totalRuntime} hours`);
    console.log(`Total Cycles: ${stats.totalCycles}`);
    console.log(`Portfolio Value: $${stats.portfolioValue.initial} -> $${stats.portfolioValue.current} (${stats.portfolioValue.change >= 0 ? '+' : ''}${stats.portfolioValue.change}) (${stats.portfolioValue.percentageChange}%)`);
    console.log(`SOL Price: $${stats.solPrice.initial} -> $${stats.solPrice.current} (${stats.solPrice.percentageChange}%)`);
    console.log(`Net Change: $${stats.netChange}`);
    console.log(`Total Volume: ${stats.totalVolume.sol} SOL / ${stats.totalVolume.usdc} USDC ($${stats.totalVolume.usd})`);
    console.log(`Balances: SOL: ${stats.balances.sol.initial} -> ${stats.balances.sol.current}, USDC: ${stats.balances.usdc.initial} -> ${stats.balances.usdc.current}`);
    console.log(`Average Prices: Entry: $${stats.averagePrices.entry}, Sell: $${stats.averagePrices.sell}`);
    console.log("------------------------------------\n");
}

/**
 * Prepare trading data for UI and state persistence
 * @param {string} timestamp - Current timestamp
 * @param {number} currentPrice - Current SOL price
 * @param {number} fearGreedIndex - Current Fear & Greed Index
 * @param {string} sentiment - Current market sentiment
 * @param {string} txId - Transaction ID (if any)
 * @param {Object} enhancedStats - Enhanced trading statistics
 * @returns {Object} - Trading data object
 */
function prepareTradingData(timestamp, currentPrice, fearGreedIndex, sentiment, txId, enhancedStats) {
    return {
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
}

/**
 * Save current position state for persistence
 * @param {Object} tradingData - Trading data object
 */
function savePositionState(tradingData) {
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
            totalVolumeUsdc: position.totalVolumeUsdc,
            trades: position.trades || []
        },
        tradingData,
        settings: readSettings(),
        orderBook: orderBook.getState()
    });
}

/**
 * Schedule the next trading cycle
 */
async function scheduleNextExecution() {
    try {
        const settings = readSettings();
        const timeframe = settings.FGI_TIMEFRAME || "15m";
        
        const waitTime = getWaitTime();
        const nextExecutionTime = new Date(Date.now() + waitTime);
        console.log(`\nNext trading update (${timeframe}) at ${nextExecutionTime.toLocaleTimeString()} (in ${formatTime(waitTime)})`);

        const totalSeconds = Math.ceil(waitTime / 1000);
        
        // Pass timeframe to progress bar
        progressInterval = startProgressBar(totalSeconds, timeframe);

        globalTimeoutId = setTimeout(async () => {
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
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
        
        // Align with the expected cycles rather than using a fixed delay
        const waitTime = getWaitTime();
        console.log(`Error occurred. Waiting until next expected cycle in ${formatTime(waitTime)}`);
        setTimeout(async () => {
            if (!isCurrentExecutionCancelled) {
                await main();
            }
        }, waitTime);
    }
}

/**
 * Main trading cycle function
 */
async function main() {
    devLog("Entering PulseSurfer main function");
    isCurrentExecutionCancelled = false;

    try {
        // Clean up any previous state
        cleanupProgressBar();
        clearTimeout(globalTimeoutId);

        // Increment cycle counter
        position.incrementCycle();

        // Get the current FGI timeframe
        const settings = readSettings();
        const timeframe = settings.FGI_TIMEFRAME || "15m";

        // Fetch current market data
        const fearGreedIndex = await fetchFearGreedIndex();
        const sentiment = getSentiment(fearGreedIndex);
        currentPrice = await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
        const timestamp = getTimestamp();

        // Log trading data
        await logTradingData(timestamp, currentPrice, fearGreedIndex);
        devLog(`Data Logged: ${timestamp}, ${currentPrice}, ${fearGreedIndex}`);

        // Display current cycle info with timeframe
        console.log(`\n--- Trading Cycle (${timeframe}): ${timestamp} ---`);
        console.log(`Fear & Greed Index: ${fearGreedIndex} - Sentiment: ${sentiment}`);
        console.log(`Current SOL Price: $${currentPrice.toFixed(2)}`);

        // Update portfolio balances
        devLog("Updating portfolio balances...");
        wallet = getWallet();
        connection = getConnection();
        
        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialized");
        }
        
        const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
        devLog(`Updated balances - SOL: ${solBalance}, USDC: ${usdcBalance}`);

        // Update position and orderbook
        position.updateBalances(solBalance, usdcBalance);
        orderBook.updateTradeUPNL(currentPrice);

        // Check if execution was cancelled during data fetch
        if (isCurrentExecutionCancelled) {
            devLog("Execution cancelled. Exiting main.");
            return;
        }

        // Initialize variables for trading
        let txId = null;
        let swapResult = null;
        let recentTrade = null;

        // Pulse trading logic - trade on any non-neutral sentiment
        if (!MONITOR_MODE && sentiment !== "NEUTRAL") {
            let success = false;
        
            // Check for closing trades first
            const hasPositionToClose = await hasOpposingTrades(sentiment);
        
            if (hasPositionToClose) {
                // Execute closing trade
                console.log("Found opposing position to close");
                const closingResult = await executeClosingTrade(sentiment);
                
                if (closingResult) {
                    swapResult = closingResult.swapResult;
                    orderBook.closeTrade(closingResult.closedTradeId, swapResult.price);
                    success = true;
                    console.log(`${getTimestamp()}: Successfully closed trade ID: ${closingResult.closedTradeId}`);
                } else {
                    console.log(`${getTimestamp()}: Failed to close opposing position after ${MAX_TRADE_ATTEMPTS} attempts`);
                }
            } else {
                // Execute opening trade
                console.log("Opening new position");
                swapResult = await executeOpeningTrade(sentiment);
                
                if (swapResult && swapResult !== 'cooldownfail' && swapResult !== 'fgichangefail') {
                    success = true;
                    console.log(`${getTimestamp()}: Successfully opened new position`);
                } else if (swapResult === 'cooldownfail' || swapResult === 'fgichangefail') {
                    console.log(`${getTimestamp()}: Trade skipped due to cooldown or FGI change`);
                } else {
                    console.log(`${getTimestamp()}: Failed to open position after ${MAX_TRADE_ATTEMPTS} attempts`);
                }
            }
        
            // Process successful trade
            if (swapResult && swapResult !== 'cooldownfail' && swapResult !== 'fgichangefail') {
                txId = swapResult.txId;

                // Update orderbook for new positions only
                if (!hasPositionToClose) {
                    devLog('New position trade successful, updating orderbook...', {
                        price: swapResult.price,
                        solChange: swapResult.solChange,
                        usdcChange: swapResult.usdcChange,
                        txId: swapResult.txId
                    });
                    
                    // Add trade to orderbook
                    orderBook.addTrade(
                        swapResult.price, 
                        swapResult.solChange, 
                        swapResult.usdcChange, 
                        swapResult.txId
                    );
                }
                
                // Update position from swap
                recentTrade = updatePositionFromSwap(position, swapResult, sentiment, currentPrice);
                if (recentTrade) {
                    addRecentTrade(recentTrade);
                    console.log(`${getTimestamp()}: ${recentTrade.type} ${recentTrade.amount.toFixed(6)} SOL at $${recentTrade.price.toFixed(2)}`);
                }
        
                // Update balances after trade
                const updatedBalances = await updatePortfolioBalances(wallet, connection);
                position.updateBalances(updatedBalances.solBalance, updatedBalances.usdcBalance);
            }
        } else if (MONITOR_MODE) {
            console.log("Monitor Mode: Data collected without trading.");
        }

        // Calculate and display enhanced statistics
        const enhancedStats = position.getEnhancedStatistics(currentPrice);
        displayEnhancedStatistics(enhancedStats);

        // Log transaction ID if available
        if (txId) {
            devLog(`Transaction ID: ${txId}`);
        }

        // Prepare trading data for UI and state persistence
        const tradingData = prepareTradingData(
            timestamp, currentPrice, fearGreedIndex, sentiment, txId, enhancedStats
        );
        
        // Emit trading data for UI
        devLog('Emitting trading data with version:', getVersion());
        emitTradingData(tradingData);

        // Save state for persistence
        savePositionState(tradingData);

    } catch (error) {
        console.error('Error during main execution:', error);
        cleanupProgressBar();
    } finally {
        // Schedule next execution if not cancelled
        if (!isCurrentExecutionCancelled) {
            await scheduleNextExecution();
        } else {
            cleanupProgressBar();
        }
    }
}

/**
 * Initializes the trading bot
 */
async function initialize() {
    try {
        // Load environment and set global wallet/connection
        const env = await loadEnvironment();
        setWallet(env.wallet);
        setConnection(env.connection);
        devLog(".env successfully applied");

        // Clear any pending timeouts
        clearTimeout(globalTimeoutId);

        // Start the web server
        await startServer();

        // Load saved state if available
        const savedState = loadState();
        devLog("SaveState:", savedState ? "Found" : "Not found");

        if (savedState && savedState.position) {
            devLog("Initializing from saved state...");
            
            // Initialize position from saved state
            position = new Position(
                savedState.position.initialSolBalance,
                savedState.position.initialUsdcBalance,
                savedState.position.initialPrice
            );
            
            // Restore position properties
            Object.assign(position, savedState.position);
            
            // Set initial data for UI
            setInitialData(savedState.tradingData);
            devLog("Position and initial data set from saved state");
        } else {
            devLog("No saved state found. Starting fresh.");
            await resetPosition();
            devLog("Position reset completed");
        }

        // Set monitor mode from settings
        MONITOR_MODE = getMonitorMode();
        console.log("Monitor mode:", MONITOR_MODE ? "Enabled" : "Disabled");

        // Fetch initial price data
        await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
        
        // Start first trading cycle
        await main();
    } catch (error) {
        console.error("Failed to initialize PulseSurfer:", error);
        process.exit(1);
    }
}

/**
 * Resets the position and order book to start fresh
 */
async function resetPosition() {
    devLog("Resetting position and orderBook...");
    
    try {
        // Get updated wallet and connection
        wallet = getWallet();
        connection = getConnection();

        // Cancel any pending transactions
        cancelPendingBundle();

        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialized in resetPosition");
        }

        // Get current balances and price
        const { solBalance, usdcBalance } = await updatePortfolioBalances(wallet, connection);
        const currentPrice = await fetchPrice(BASE_PRICE_URL, SOL.ADDRESS);
        
        // Create new position
        position = new Position(solBalance, usdcBalance, currentPrice);
        
        // Reset order book
        orderBook.trades = [];
        orderBook.saveTrades();

        // Get current fear & greed index
        const fearGreedIndex = await fetchFearGreedIndex();
        
        // Create initial data for UI
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

        // Set initial data and emit to UI
        setInitialData(initialData);
        emitTradingData({ ...initialData, version: getVersion() });
        clearRecentTrades();

        // Save initial state
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
                totalVolumeUsdc: position.totalVolumeUsdc,
                trades: []
            },
            tradingData: initialData,
            settings: readSettings(),
            orderBook: orderBook.getState()
        });
        
        return initialData;
    } catch (error) {
        console.error("Error resetting position:", error);
        throw error;
    }
}

/**
 * Handles parameter updates from the UI
 * @param {Object} newParams - Updated parameters
 */
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

/**
 * Handles restart trading event
 */
async function handleRestartTrading() {
    devLog("Restarting trading...");
    
    try {
        // Get updated wallet and connection
        wallet = getWallet();
        connection = getConnection();

        // Cancel any pending transactions
        cancelPendingBundle();

        // Signal the current execution to stop
        isCurrentExecutionCancelled = true;

        // Clear any existing scheduled runs
        clearTimeout(globalTimeoutId);

        // Stop the progress bar if it's running
        cleanupProgressBar();

        // Wait for current operations to complete
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Reset position and get ready for new trading
        await resetPosition(wallet, connection);
        devLog("Position reset. Waiting for next scheduled interval to start trading...");

        // Reset the cancellation flag
        isCurrentExecutionCancelled = false;

        // Schedule the next trading cycle
        const waitTime = getWaitTime();
        const nextExecutionTime = new Date(Date.now() + waitTime);

        console.log(`Next trading cycle will start at ${nextExecutionTime.toLocaleTimeString()} (in ${formatTime(waitTime)})`);

        // Set up a progress bar for the wait time
        const totalSeconds = Math.ceil(waitTime / 1000);
        progressInterval = startProgressBar(totalSeconds);

        // Schedule the next trading cycle
        globalTimeoutId = setTimeout(() => {
            if (progressInterval) {
                clearInterval(progressInterval);
                progressInterval = null;
            }
            cleanupProgressBar();
            
            devLog("Starting new trading cycle.");
            main();
        }, waitTime);
    } catch (error) {
        console.error("Error handling restart trading:", error);
        
        // Wait until next expected cycle rather than using a fixed delay
        const waitTime = getWaitTime();
        console.log(`Error occurred. Waiting until next expected cycle in ${formatTime(waitTime)}`);
        setTimeout(() => {
            main();
        }, waitTime);
    }
}

// Set up event listeners
paramUpdateEmitter.on('paramsUpdated', handleParameterUpdate);
paramUpdateEmitter.on('restartTrading', handleRestartTrading);

// Self-executing initialization function
(async function () {
    try {
        console.log("Starting PulseSurfer...");
        await initialize();
    } catch (error) {
        console.error("Failed to initialize PulseSurfer:", error);
        process.exit(1);
    }
})();

// Export functions for external use
module.exports = { main, initialize, resetPosition };