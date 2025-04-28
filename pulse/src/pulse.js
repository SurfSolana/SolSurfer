/**
 * PulseSurfer Trading Bot
 * Automated trading system that uses sentiment analysis to trade Solana Tokens
 * Now with support for threshold-based strategy
 */

// Core dependencies
const Position = require('./Position');
const OrderBook = require('./orderBook');
const { 
    executeSwap, 
    updatePortfolioBalances,
    updatePositionFromSwap, 
    logPositionUpdate, 
    cancelJupiterTransactions,
    calculateTradeAmount,
    BASE_TOKEN,
    QUOTE_TOKEN
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
    devLog,
    getBaseToken,
    getQuoteToken,
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

// Import the threshold strategy module
const thresholdStrategy = require('./threshold');

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
const MIN_USD_VALUE = 1; // Minimum USD value to keep in the wallet
const MAX_TRADE_ATTEMPTS = 10;
const RETRY_DELAY = 5000; // 5 seconds

/**
 * Progress bar for visualising wait time between trading cycles
 */
const progressBar = new cliProgress.SingleBar({
    format: `${styles.info}${icons.wait} Progress ${colours.reset}|{bar}| {percentage}% | ${styles.time}{remainingTime}${colours.reset} remaining | ${styles.info}{timeframe}${colours.reset}`,
    barCompleteChar: '█',
    barIncompleteChar: '░',
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
        console.error(formatError(`Error cleaning up progress bar: ${error.message}`));
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
                console.error(formatError(`Error updating progress bar: ${error.message}`));
                clearInterval(updateInterval);
                cleanupProgressBar();
            }
        }, 1000);

        return updateInterval;
    } catch (error) {
        console.error(formatError(`Error starting progress bar: ${error.message}`));
        return null;
    }
}

/**
 * Verifies if a trade will leave sufficient balance
 * @param {number} balance - Current balance
 * @param {number} amount - Trade amount
 * @param {boolean} isBaseToken - Is base token balance (vs quote token)
 * @param {number} currentPrice - Current token price
 * @returns {boolean} - True if balance will be sufficient
 */
async function minimumBalanceCheck(balance, amount, isBaseToken, currentPrice) {
    try {
        if (typeof balance !== 'number' || isNaN(balance) ||
            typeof amount !== 'number' || isNaN(amount) ||
            typeof currentPrice !== 'number' || isNaN(currentPrice)) {
            console.error(formatError('Invalid inputs for minimum balance check'));
            return false;
        }
        
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();
        
        const balanceInUSD = isBaseToken ? balance * currentPrice : balance;
        const amountInUSD = isBaseToken ? amount * currentPrice : amount;
        const remainingBalanceUSD = balanceInUSD - amountInUSD;
        
        if (remainingBalanceUSD < MIN_USD_VALUE) {
            console.log(formatWarning(`${icons.warning} Trade blocked - Would leave ${isBaseToken ? baseToken.NAME : quoteToken.NAME} balance below $${MIN_USD_VALUE}`));
            return false;
        }
        return true;
    } catch (error) {
        console.error(formatError(`Error in minimum balance check: ${error.message}`));
        return false;
    }
}

/**
 * Checks for and closes a profitable opposite-direction trade
 * @param {string} sentiment - Current market sentiment
 * @param {number} currentPrice - Current token price
 * @returns {Object|null} - Result of closing trade or null
 */
async function checkAndCloseOpposingTrade(sentiment, currentPrice) {
    try {
        const isFearSentiment = ["FEAR", "EXTREME_FEAR"].includes(sentiment);
        const isGreedSentiment = ["GREED", "EXTREME_GREED"].includes(sentiment);
        
        if (!isFearSentiment && !isGreedSentiment) {
            console.log(formatWarning(`${icons.info} CLOSING: Current sentiment (${formatSentiment(sentiment)}) not appropriate for trading`));
            return null;
        }

        // Find the oldest trade in the opposite direction
        const oldestMatchingTrade = orderBook.findOldestMatchingTrade(
            isFearSentiment ? "sell" : "buy",
            currentPrice
        );
        
        if (!oldestMatchingTrade) {
            console.log(formatWarning(`${icons.info} CLOSING: No opposing trades found to close in ${formatSentiment(sentiment)} sentiment`));
            return null;
        }
        
        const shortId = oldestMatchingTrade.id.substring(0, 8) + '...';
        console.log(formatInfo(`${icons.trade} CLOSING: Found opposing trade to close: ID ${styles.important}${shortId}${colours.reset}`));
        
        try {
            const baseToken = getBaseToken();
            const quoteToken = getQuoteToken();
            
            console.log(formatInfo(
                `${icons.trade} CLOSING TRADE DETAILS:`
            ));
            console.log(`  ${oldestMatchingTrade.direction === 'buy' ? styles.positive + 'Direction: Buy' + colours.reset : styles.negative + 'Direction: Sell' + colours.reset}`);
            console.log(`  ${formatBalance(oldestMatchingTrade.baseTokenAmount, baseToken.NAME)} @ ${formatPrice(currentPrice)}`);
            console.log(`  Quote value: ${formatBalance(oldestMatchingTrade.quoteTokenValue, quoteToken.NAME)}`);
            
            // Calculate potential profit
            const potentialProfit = oldestMatchingTrade.direction === 'buy' ? 
                (currentPrice - oldestMatchingTrade.price) * oldestMatchingTrade.baseTokenAmount :
                (oldestMatchingTrade.price - currentPrice) * oldestMatchingTrade.baseTokenAmount;
                
            if (potentialProfit > 0) {
                console.log(`  ${styles.positive}Potential Profit: ${formatPrice(potentialProfit)}${colours.reset}`);
                console.log(`  ${styles.info}10% Fee: ${formatPrice(potentialProfit * 0.1)}${colours.reset}`);
            }
            
            // Execute the swap to close the position with the consolidated executeSwap
            const swapResult = await executeSwap(
                wallet,
                sentiment,
                null, // No manual trade amount
                {
                    isClosingPosition: true,
                    trade: oldestMatchingTrade,
                    currentPrice: currentPrice
                }
            );

            if (swapResult) {
                console.log(formatSuccess(`${icons.success} CLOSING: Swap executed successfully`));
                
                // Log fee information if it was applied
                if (swapResult.appliedFeeBps > 1) {
                    const profitFeeBps = swapResult.appliedFeeBps - 1; // Subtract the 1bps base fee
                    if (profitFeeBps > 0) {
                        console.log(formatInfo(`${icons.profit} Applied profit fee: ${profitFeeBps} bps (10% of realized profit)`));
                    }
                }
                
                return {
                    swapResult,
                    closedTradeId: oldestMatchingTrade.id
                };
            } else {
                console.log(formatError(`${icons.error} CLOSING: Swap failed`));
            }
        } catch (error) {
            console.error(formatError(`CLOSING: Error executing swap: ${error.message}`));
        }
        
        return null;
    } catch (error) {
        console.error(formatError(`CLOSING: Error in trade operation: ${error.message}`));
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
        console.error(formatError(`Error checking for opposing trades: ${error.message}`));
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
            const baseToken = getBaseToken();
            const quoteToken = getQuoteToken();
            
            console.log(formatInfo(`${icons.open} OPENING: Attempt ${attempt}/${MAX_TRADE_ATTEMPTS}`));
            const isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
            const balance = isBuying ? wallet.quoteBalance : wallet.baseBalance;
            
            // Using the configured tokens for the calculation
            const inputToken = isBuying ? quoteToken : baseToken;
            const rawTradeAmount = calculateTradeAmount(balance, sentiment, inputToken);
            const tradeAmount = rawTradeAmount / Math.pow(10, inputToken.DECIMALS);
            
            // Check if trade would leave minimum balance
            if (!await minimumBalanceCheck(balance, tradeAmount, !isBuying, currentPrice)) {
                console.log(formatWarning(`${icons.warning} OPENING: Trade skipped - minimum balance protection`));
                return null;
            }
    
            console.log(formatInfo(`${icons.trade} OPENING: Placing ${isBuying ? styles.positive + 'Buy' + colours.reset : styles.negative + 'Sell' + colours.reset} Trade...`));
            
            // Execute trade using the consolidated executeSwap function
            const swapResult = await executeSwap(
                wallet,
                sentiment,
                null // Use calculated trade amount
            );
            
            if (swapResult === 'cooldownfail' || swapResult === 'fgichangefail') {
                // Don't retry for these conditions
                console.log(formatWarning(`${icons.warning} OPENING: Trade failed due to cooldown or FGI change - skipping retry`));
                return swapResult;
            } else if (swapResult) {
                return swapResult;
            }
        } catch (error) {
            console.error(formatError(`OPENING: Error on attempt ${attempt}/${MAX_TRADE_ATTEMPTS}: ${error.message}`));
        }
        
        if (attempt < MAX_TRADE_ATTEMPTS && !isCurrentExecutionCancelled) {
            console.log(formatWarning(`${icons.wait} OPENING: Attempt ${attempt} failed - retrying in ${RETRY_DELAY/1000}s...`));
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
            // Fetch the latest price before each attempt
            const latestPrice = await fetchPrice(BASE_PRICE_URL, getBaseToken().ADDRESS);
            console.log(formatInfo(`${icons.close} CLOSING: Attempt ${attempt}/${MAX_TRADE_ATTEMPTS} with price ${formatPrice(latestPrice)}`));
            
            // Use the fresh price for trade evaluation and execution
            const closingResult = await checkAndCloseOpposingTrade(sentiment, latestPrice);
            
            if (closingResult) {
                // Update global price state with the latest value
                currentPrice = latestPrice;
                return closingResult;
            }
        } catch (error) {
            console.error(formatError(`CLOSING: Error on attempt ${attempt}/${MAX_TRADE_ATTEMPTS}: ${error.message}`));
        }
        
        if (attempt < MAX_TRADE_ATTEMPTS && !isCurrentExecutionCancelled) {
            console.log(formatWarning(`${icons.wait} CLOSING: Attempt ${attempt} failed - retrying in ${RETRY_DELAY/1000}s...`));
            await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
        }
        
        attempt++;
    }
    
    return null;
}

/**
 * Execute a trade using the threshold strategy
 * @param {number} fearGreedIndex - Current Fear & Greed Index value
 * @param {number} currentPrice - Current token price
 * @param {Object} wallet - Wallet object
 * @param {Object} thresholdSettings - Threshold strategy settings
 * @returns {Object|null} - Trade result or null if no trade needed
 */
async function executeThresholdStrategyTrade(fearGreedIndex, currentPrice, wallet, thresholdSettings) {
    try {
        console.log(formatHeading("=== THRESHOLD STRATEGY TRADING ==="));
        
        // Get token information
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();
        
        // Update threshold state with current FGI value
        const thresholdState = thresholdStrategy.updateThresholdState(fearGreedIndex, thresholdSettings);
        
        // Display threshold strategy state information
        console.log(formatInfo(`${icons.sentiment} FGI Value: ${fearGreedIndex} / Threshold: ${thresholdSettings.THRESHOLD}`));
        console.log(formatInfo(`${icons.stats} Consecutive readings: Above threshold: ${thresholdState.daysAboveThreshold}, Below threshold: ${thresholdState.daysBelowThreshold}`));
        console.log(formatInfo(`${icons.settings} Allocation state: ${thresholdState.inHighAllocation === true ? "High " + baseToken.NAME : (thresholdState.inHighAllocation === false ? "High " + quoteToken.NAME : "Not set")}`));
        
        // Check if we need to rebalance
        if (!thresholdState.needsRebalance) {
            console.log(formatInfo(`${icons.info} No portfolio rebalance needed based on threshold strategy`));
            return null;
        }
        
        // Get current allocations - IMPORTANT: Use full balances
        const currentAllocations = thresholdStrategy.getCurrentAllocations(
            wallet.baseBalance, 
            wallet.quoteBalance, 
            currentPrice
        );
        
        // Determine target allocations
        const shouldAllocateHighSOL = thresholdState.shouldSwitchToHighSOL;
        
        console.log(formatInfo(`${icons.trade} ${shouldAllocateHighSOL ? "FGI above threshold - allocating high " + baseToken.NAME : "FGI below threshold - allocating high " + quoteToken.NAME}`));
        
        const targetAllocations = thresholdStrategy.calculateTargetAllocations(
            shouldAllocateHighSOL,
            currentAllocations.totalValue,
            currentPrice,
            thresholdSettings.ALLOCATION_PERCENTAGE
        );
        
        // Log target allocation details for debugging
        console.log("Target Allocation Calculation:");
        console.log(`- Portfolio Value: ${currentAllocations.totalValue.toFixed(2)}`);
        console.log(`- Current Price: ${currentPrice.toFixed(2)}`);
        console.log(`- Target ${baseToken.NAME} %: ${targetAllocations.baseToken.percentage.toFixed(2)}%`);
        console.log(`- Target ${quoteToken.NAME} %: ${targetAllocations.quoteToken.percentage.toFixed(2)}%`);
        console.log(`- Target ${baseToken.NAME} Value: ${targetAllocations.baseToken.value.toFixed(2)}`);
        console.log(`- Target ${quoteToken.NAME} Value: ${targetAllocations.quoteToken.value.toFixed(2)}`);
        console.log(`- Target ${baseToken.NAME} Tokens: ${targetAllocations.baseToken.tokens.toFixed(6)}`);
        
        // Calculate trade needed for rebalance
        const tradeParams = thresholdStrategy.calculateRebalanceTrade(
            currentAllocations,
            targetAllocations,
            thresholdSettings
        );
        
        if (!tradeParams) {
            console.log(formatInfo(`${icons.info} No significant trade needed for rebalance`));
            return null;
        }
        
        // Execute the trade
        console.log(formatInfo(`${icons.trade} Executing ${tradeParams.type} trade: ${Math.abs(tradeParams.baseTokenChange).toFixed(6)} ${baseToken.NAME}`));
        
        let swapResult;
        
        // Calculate the appropriate trade amount
        const tradeAmount = tradeParams.isBuyingBase ? 
            Math.abs(tradeParams.quoteTokenChange) : // If buying SOL, spend this much USDC
            Math.abs(tradeParams.baseTokenChange);   // If selling SOL, spend this much SOL
        
        // Call executeSwap with the manual trade amount and sentiment
        swapResult = await executeSwap(
            wallet, 
            tradeParams.isBuyingBase ? "EXTREME_FEAR" : "EXTREME_GREED",
            tradeAmount // Pass the threshold-calculated amount directly
        );
        
        if (swapResult && typeof swapResult === 'object') {
            console.log(formatSuccess(`${icons.success} Rebalance trade executed successfully`));
            
            // Find and close open trades in the opposite direction
            if (thresholdState.inHighAllocation !== null) {
                const currentDirection = shouldAllocateHighSOL ? "buy" : "sell";
                const previousDirection = shouldAllocateHighSOL ? "sell" : "buy";
                
                console.log(formatInfo(`${icons.close} Looking for open trades in ${previousDirection} direction to close`));
                
                // Get all open trades in the opposite direction
                const openTrades = orderBook.getOpenTrades().filter(trade => trade.direction === previousDirection);
                
                if (openTrades.length > 0) {
                    console.log(formatInfo(`${icons.close} Found ${openTrades.length} open ${previousDirection} positions to close`));
                    
                    // Close all open trades in the opposite direction
                    for (const trade of openTrades) {
                        console.log(formatInfo(`${icons.close} Closing trade ${trade.id.substring(0, 10)}... at price ${formatPrice(swapResult.price)}`));
                        orderBook.closeTrade(trade.id, swapResult.price);
                    }
                } else {
                    console.log(formatInfo(`${icons.info} No open ${previousDirection} trades found to close`));
                }
            }
            
            // Update the allocation state after successful trade
            thresholdStrategy.updateAllocationState(shouldAllocateHighSOL);
            
            // Add the new trade to orderbook
            console.log(formatInfo(`${icons.open} Recording new ${shouldAllocateHighSOL ? "buy" : "sell"} position in orderbook`));
            orderBook.addTrade(
                swapResult.price,
                swapResult.baseTokenChange,
                swapResult.quoteTokenChange,
                swapResult.txId
            );
            
            return swapResult;
        } else {
            console.log(formatError(`${icons.error} Rebalance trade failed`));
            return null;
        }
    } catch (error) {
        console.error(formatError(`Error executing threshold strategy trade: ${error.message}`));
        return null;
    }
}

/**
 * Process and display enhanced trading statistics
 * @param {Object} stats - Trading statistics
 */
function displayEnhancedStatistics(stats) {
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    
    console.log(formatHeading("=== TRADING STATISTICS ==="));
    
    // Runtime and cycle information
    console.log(`${icons.time} Runtime: ${styles.info}${stats.totalRuntime}${colours.reset} hours | Cycles: ${styles.info}${stats.totalCycles}${colours.reset}`);
    
    // Portfolio value
    const portfolioChangeValue = parseFloat(stats.portfolioValue.change);
    const portfolioChangePercent = parseFloat(stats.portfolioValue.percentageChange);
    console.log(
        `${icons.chart} Portfolio: ${formatPrice(stats.portfolioValue.initial)} → ${formatPrice(stats.portfolioValue.current)} ` +
        `(${formatTokenChange(portfolioChangeValue, '$')}) (${formatPercentage(portfolioChangePercent)})`
    );
    
    // Token price information
    const priceChange = parseFloat(stats.tokenPrice.percentageChange);
    console.log(
        `${icons.price} ${baseToken.NAME} Price: ${formatPrice(stats.tokenPrice.initial)} → ${formatPrice(stats.tokenPrice.current)} ` +
        `(${formatPercentage(priceChange)})`
    );
    
    // Net change 
    const netChange = parseFloat(stats.netChange);
    console.log(`${icons.profit} Net Change: ${formatTokenChange(netChange, '$')}`);
    
    // Volume information
    console.log(
        `${icons.trade} Total Volume: ${styles.balance}${stats.totalVolume.baseToken || stats.totalVolume.sol}${colours.reset} ${baseToken.NAME} / ` +
        `${styles.balance}${stats.totalVolume.quoteToken}${colours.reset} ${quoteToken.NAME} (${formatPrice(stats.totalVolume.usd)})`
    );
    
    // Balance information
    const baseInitial = stats.balances.baseToken?.initial || stats.balances.sol.initial;
    const baseCurrent = stats.balances.baseToken?.current || stats.balances.sol.current;
    const quoteInitial = stats.balances.quoteToken?.initial;
    const quoteCurrent = stats.balances.quoteToken?.current;
    
    console.log(
        `${icons.balance} Balances: ${baseToken.NAME}: ${styles.balance}${baseInitial}${colours.reset} → ${styles.balance}${baseCurrent}${colours.reset}, ` +
        `${quoteToken.NAME}: ${styles.balance}${quoteInitial}${colours.reset} → ${styles.balance}${quoteCurrent}${colours.reset}`
    );
    
    // Average prices
    console.log(
        `${icons.stats} Average Prices: Entry: ${formatPrice(stats.averagePrices.entry)}, ` +
        `Sell: ${stats.averagePrices.sell === '0.00' ? styles.detail + 'N/A' + colours.reset : formatPrice(stats.averagePrices.sell)}`
    );
    
}

/**
 * Prepare trading data for UI and state persistence
 * @param {string} timestamp - Current timestamp
 * @param {number} currentPrice - Current token price
 * @param {number} fearGreedIndex - Current Fear & Greed Index
 * @param {string} sentiment - Current market sentiment
 * @param {string} txId - Transaction ID (if any)
 * @param {Object} enhancedStats - Enhanced trading statistics
 * @returns {Object} - Trading data object
 */
function prepareTradingData(timestamp, currentPrice, fearGreedIndex, sentiment, txId, enhancedStats) {
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    
    return {
        version: getVersion(),
        timestamp,
        price: currentPrice,
        fearGreedIndex,
        sentiment,
        quoteBalance: position.quoteBalance,
        baseBalance: position.baseBalance,
        portfolioValue: parseFloat(enhancedStats.portfolioValue.current),
        netChange: parseFloat(enhancedStats.netChange),
        averageEntryPrice: parseFloat(enhancedStats.averagePrices.entry) || 0,
        averageSellPrice: parseFloat(enhancedStats.averagePrices.sell) || 0,
        txId,
        initialPrice: position.initialPrice,
        initialPortfolioValue: position.initialValue,
        initialBaseBalance: position.initialBaseBalance,
        initialQuoteBalance: position.initialQuoteBalance,
        startTime: position.startTime,
        tokenInfo: {
            quoteToken: quoteToken.NAME,
            baseToken: baseToken.NAME,
            quoteTokenDecimals: quoteToken.DECIMALS,
            baseTokenDecimals: baseToken.DECIMALS
        }
    };
}

/**
 * Save current position state for persistence
 * @param {Object} tradingData - Trading data object
 */
function savePositionState(tradingData) {
    saveState({
        position: {
            quoteBalance: position.quoteBalance,
            baseBalance: position.baseBalance,
            initialQuoteBalance: position.initialQuoteBalance,
            initialBaseBalance: position.initialBaseBalance,
            initialPrice: position.initialPrice,
            initialValue: position.initialValue,
            totalQuoteBought: position.totalQuoteBought,
            totalBaseSpent: position.totalBaseSpent,
            totalQuoteSold: position.totalQuoteSold,
            totalBaseReceived: position.totalBaseReceived,
            netQuoteTraded: position.netQuoteTraded,
            startTime: position.startTime,
            totalCycles: position.totalCycles,
            totalVolumeQuote: position.totalVolumeQuote,
            totalVolumeBase: position.totalVolumeBase,
            trades: position.trades || []
        },
        tradingData,
        settings: readSettings(),
        orderBook: orderBook.getState(),
        thresholdState: thresholdStrategy.getThresholdState()
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
        
        console.log(formatHeading("=== NEXT CYCLE ==="));
        console.log(formatInfo(`${icons.wait} Next trading update (${timeframe}) at ${nextExecutionTime.toLocaleTimeString()}`));
        console.log(formatInfo(`${icons.time} Time until next cycle: ${formatTime(waitTime)}`));

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
        console.error(formatError(`Error scheduling next execution: ${scheduleError.message}`));
        cleanupProgressBar();
        
        // Align with the expected cycles rather than using a fixed delay
        const waitTime = getWaitTime();
        console.log(formatWarning(`${icons.wait} Error occurred. Waiting until next expected cycle in ${formatTime(waitTime)}`));
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
        
        // Get token configurations
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();

        // Fetch current market data
        const fearGreedIndex = await fetchFearGreedIndex();
        const sentiment = getSentiment(fearGreedIndex);
        currentPrice = await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
        const timestamp = getTimestamp();

        // Log trading data
        await logTradingData(timestamp, currentPrice, fearGreedIndex);
        devLog(`Data Logged: ${timestamp}, ${currentPrice}, ${fearGreedIndex}`);

        // Display current cycle info with timeframe
        console.log(horizontalLine());
        console.log(formatHeading(`=== TRADING CYCLE (${timeframe}): ${timestamp} ===`));
        console.log(`${icons.sentiment} Sentiment: ${formatSentiment(sentiment)} | Fear & Greed Index: ${padLeft(fearGreedIndex, 2)}`);
        console.log(`${icons.price} Current ${baseToken.NAME} Price: ${formatPrice(currentPrice)}`);

        // Update portfolio balances
        devLog("Updating portfolio balances...");
        wallet = getWallet();
        connection = getConnection();
        
        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialised");
        }
        
        const { baseBalance, quoteBalance } = await updatePortfolioBalances(wallet, connection);
        console.log(`${icons.balance} Balance: ${formatBalance(baseBalance, baseToken.NAME)} | ${formatBalance(quoteBalance, quoteToken.NAME)}`);

        // Update position and orderbook
        position.updateBalances(baseBalance, quoteBalance);
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

        // Check which trading mode to use
        const isThresholdMode = settings.THRESHOLD_MODE === true;
        const isMonitorMode = MONITOR_MODE || settings.MONITOR_MODE === true;

        if (!isMonitorMode) {
            if (isThresholdMode) {
                // Use threshold-based strategy
                const thresholdSettings = settings.THRESHOLD_SETTINGS || {
                    THRESHOLD: 50,
                    ALLOCATION_PERCENTAGE: 95,
                    SWITCH_DELAY: 1,
                    MIN_TRADE_AMOUNT: 0.00001
                };
                
                // Execute threshold strategy trade
                swapResult = await executeThresholdStrategyTrade(fearGreedIndex, currentPrice, wallet, thresholdSettings);
                
                if (swapResult) {
                    txId = swapResult.txId;
                    // Update position
                    const trade = updatePositionFromSwap(position, swapResult, sentiment, currentPrice);
                    if (trade) {
                        addRecentTrade(trade);
                        recentTrade = trade;
                    }
                }
            } else {
                // Use original sentiment-based strategy
                if (sentiment !== "NEUTRAL") {
                    // Check if we have any positions to close and if we can open new ones
                    const hasPositionToClose = await hasOpposingTrades(sentiment);
                    
                    // Set up parallel execution of close and open trades
                    const tradeOperations = [];
                    
                    console.log(formatHeading("=== PARALLEL TRADING OPERATIONS ==="));
                    
                    // Add closing trade operation if needed
                    if (hasPositionToClose) {
                        console.log(formatInfo(`${icons.close} CLOSING OPERATION: Found opposing position to close - starting operation`));
                        const closingOperation = executeClosingTrade(sentiment)
                            .then(result => ({ type: 'close', result }));
                        tradeOperations.push(closingOperation);
                    }
                    
                    // Always add opening trade operation
                    console.log(formatInfo(`${icons.open} OPENING OPERATION: Starting new position operation`));
                    const openingOperation = executeOpeningTrade(sentiment)
                        .then(result => ({ type: 'open', result }));
                    tradeOperations.push(openingOperation);
                    
                    console.log(formatInfo(`${icons.running} Both operations running in parallel - this may take a moment...`));
                    
                    // Wait for all operations to complete and process results
                    const results = await Promise.all(tradeOperations);
                    
                    console.log(formatHeading("=== TRADING RESULTS ==="));
                    
                    // Process each completed operation
                    for (const { type, result } of results) {
                        if (!result) {
                            console.log(formatWarning(`${type.toUpperCase()} OPERATION: No result returned`));
                            continue;
                        }
                        
                        if (type === 'close' && result.swapResult) {
                            // Process closing trade
                            swapResult = result.swapResult;
                            orderBook.closeTrade(result.closedTradeId, swapResult.price);
                            console.log(formatSuccess(`${icons.close} CLOSING OPERATION: Successfully closed trade ID: ${result.closedTradeId.substring(0, 12)}...`));
                            
                            // Update position from closing trade
                            const closedTrade = updatePositionFromSwap(position, swapResult, sentiment, currentPrice);
                            if (closedTrade) {
                                addRecentTrade(closedTrade);
                                console.log(`   ${formatTimestamp(getTimestamp(), false)}: ${closedTrade.type} ${formatBalance(closedTrade.amount, baseToken.NAME)} at ${formatPrice(closedTrade.price)}`);
                                recentTrade = closedTrade;
                            }
                            
                            txId = swapResult.txId;
                        }
                        else if (type === 'open') {
                            if (result !== 'cooldownfail' && result !== 'fgichangefail') {
                                // Process opening trade
                                swapResult = result;
                                txId = result.txId; // Prioritize the opening trade ID
                                
                                // Add to orderbook
                                orderBook.addTrade(
                                    swapResult.price, 
                                    swapResult.baseTokenChange, 
                                    swapResult.quoteTokenChange, 
                                    swapResult.txId
                                );
                                
                                // Update position
                                const openedTrade = updatePositionFromSwap(position, swapResult, sentiment, currentPrice);
                                if (openedTrade) {
                                    addRecentTrade(openedTrade);
                                    console.log(formatSuccess(`${icons.open} OPENING OPERATION: Successfully opened new position`));
                                    console.log(`   ${formatTimestamp(getTimestamp(), false)}: ${openedTrade.type} ${formatBalance(openedTrade.amount, baseToken.NAME)} at ${formatPrice(openedTrade.price)}`);
                                    recentTrade = openedTrade;
                                }
                            } 
                            else if (result === 'cooldownfail' || result === 'fgichangefail') {
                                console.log(formatWarning(`${icons.warning} OPENING OPERATION: Trade skipped due to cooldown or FGI change`));
                            }
                        }
                    }
                }
            }
        } else {
            console.log(formatInfo(`${icons.info} Monitor Mode: Data collected without trading.`));
        }

        // Update balances after all trading operations
        if (swapResult) {
            console.log(formatInfo(`\n${icons.balance} Updating portfolio balances after trades...`));
            const updatedBalances = await updatePortfolioBalances(wallet, connection);
            position.updateBalances(updatedBalances.baseBalance, updatedBalances.quoteBalance);
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
        devLog(tradingData);
        emitTradingData(tradingData);

        // Save state for persistence
        savePositionState(tradingData);

    } catch (error) {
        console.error(formatError(`Error during main execution: ${error.message}`));
        console.error(error);
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
        console.log(formatHeading("=== INITIALISING PULSESURFER ==="));
        
        // Load environment and set global wallet/connection
        console.log(formatInfo(`${icons.settings} Loading environment configuration...`));
        const env = await loadEnvironment();
        setWallet(env.wallet);
        setConnection(env.connection);
        console.log(formatSuccess(`${icons.success} Environment loaded successfully`));
        console.log(formatInfo(`${icons.network} Connected to ${env.connectionSource} RPC endpoint`));
        devLog(".env successfully applied");

        // Clear any pending timeouts
        clearTimeout(globalTimeoutId);

        // Start the web server
        console.log(formatInfo(`${icons.network} Starting web server...`));
        await startServer();
        console.log(formatSuccess(`${icons.success} Web server started successfully`));

        // Load saved state if available
        console.log(formatInfo(`${icons.settings} Checking for saved state...`));
        const savedState = loadState();
        devLog("SaveState:", savedState ? "Found" : "Not found");

        if (savedState && savedState.position) {
            console.log(formatSuccess(`${icons.success} Found saved state - resuming previous session`));
            devLog("Initializing from saved state...");
            
            // Initialize position from saved state
            position = new Position(
                savedState.position.initialBaseBalance,
                savedState.position.initialQuoteBalance,
                savedState.position.initialPrice
            );
            
            // Restore position properties
            Object.assign(position, savedState.position);
            
            // Set initial data for UI
            setInitialData(savedState.tradingData);
            
            // Restore threshold state if available
            if (savedState.thresholdState) {
                // Deep clone to avoid reference issues
                const thresholdStateData = JSON.parse(JSON.stringify(savedState.thresholdState));
                Object.keys(thresholdStrategy.getThresholdState()).forEach(key => {
                    if (thresholdStateData[key] !== undefined) {
                        thresholdStrategy.getThresholdState()[key] = thresholdStateData[key];
                    }
                });
                devLog("Threshold state restored from saved state");
            }
            
            devLog("Position and initial data set from saved state");
        } else {
            console.log(formatInfo(`${icons.info} No saved state found - starting fresh`));
            await resetPosition();
            devLog("Position reset completed");
        }

        // Set monitor mode from settings
        MONITOR_MODE = getMonitorMode();
        console.log(formatInfo(`${icons.settings} Monitor mode: ${MONITOR_MODE ? styles.warning + 'Enabled' + colours.reset : styles.success + 'Disabled' + colours.reset}`));

        // Get base token for initial price fetch
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();
        console.log(formatInfo(`${icons.trade} Trading pair: ${styles.important}${baseToken.NAME}/${quoteToken.NAME}${colours.reset}`));
        
        // Display threshold mode status
        const settings = readSettings();
        const isThresholdMode = settings.THRESHOLD_MODE === true;
        console.log(formatInfo(`${icons.settings} Trading strategy: ${isThresholdMode ? 
            styles.important + 'Threshold Strategy' + colours.reset : 
            styles.important + 'Sentiment Strategy' + colours.reset}`));
        
        if (isThresholdMode && settings.THRESHOLD_SETTINGS) {
            const ts = settings.THRESHOLD_SETTINGS;
            console.log(formatInfo(`${icons.settings} Threshold: ${styles.important}${ts.THRESHOLD}${colours.reset}, Allocation: ${styles.important}${ts.ALLOCATION_PERCENTAGE}%${colours.reset}, Delay: ${styles.important}${ts.SWITCH_DELAY}${colours.reset}`));
        }
        
        // Fetch initial price data
        console.log(formatInfo(`${icons.price} Fetching initial price data...`));
        await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
        
        // Start first trading cycle
        console.log(formatSuccess(`${icons.success} Initialisation complete - starting first trading cycle`));
        console.log(horizontalLine());
        await main();
    } catch (error) {
        console.error(formatError(`Failed to initialise PulseSurfer: ${error.message}`));
        console.error(error);
        process.exit(1);
    }
}

/**
 * Resets the position and order book to start fresh
 */
async function resetPosition() {
    console.log(formatHeading("=== RESETTING POSITION ==="));
    devLog("Resetting position and orderBook...");
    
    try {
        // Get updated wallet and connection
        wallet = getWallet();
        connection = getConnection();
        
        // Get token configurations
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();

        // Cancel any pending transactions
        console.log(formatInfo(`${icons.warning} Cancelling any pending transactions...`));
        cancelJupiterTransactions();

        if (!wallet || !connection) {
            throw new Error("Wallet or connection is not initialised in resetPosition");
        }

        // Get current balances and price
        console.log(formatInfo(`${icons.balance} Fetching current balances...`));
        const { baseBalance, quoteBalance } = await updatePortfolioBalances(wallet, connection);
        console.log(formatInfo(`${icons.price} Fetching current price...`));
        const currentPrice = await fetchPrice(BASE_PRICE_URL, baseToken.ADDRESS);
        
        // Create new position
        console.log(formatInfo(`${icons.settings} Creating new position...`));
        position = new Position(baseBalance, quoteBalance, currentPrice);
        
        // Reset order book
        console.log(formatInfo(`${icons.settings} Resetting order book...`));
        orderBook.updateStoragePathForTokens();
        orderBook.trades = [];
        orderBook.saveTrades();
        
        // Reset threshold strategy state
        console.log(formatInfo(`${icons.settings} Resetting threshold strategy state...`));
        thresholdStrategy.resetThresholdState();

        // Get current fear & greed index
        console.log(formatInfo(`${icons.sentiment} Fetching Fear & Greed Index...`));
        const fearGreedIndex = await fetchFearGreedIndex();
        
        // Create initial data for UI
        const initialData = {
            timestamp: getTimestamp(),
            price: currentPrice,
            fearGreedIndex,
            sentiment: getSentiment(fearGreedIndex),
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
        console.log(formatInfo(`${icons.settings} Initialising UI data...`));
        setInitialData(initialData);
        emitTradingData({ ...initialData, version: getVersion() });
        clearRecentTrades();

        // Save initial state
        console.log(formatInfo(`${icons.settings} Saving initial state...`));
        saveState({
            position: {
                baseBalance: position.baseBalance,
                quoteBalance: position.quoteBalance,
                initialBaseBalance: position.initialBaseBalance,
                initialQuoteBalance: position.initialQuoteBalance,
                initialPrice: position.initialPrice,
                initialValue: position.initialValue,
                totalBaseBought: position.totalBaseBought,
                totalQuoteSpent: position.totalQuoteSpent,
                totalBaseSold: position.totalBaseSold,
                totalQuoteReceived: position.totalQuoteReceived,
                netBaseTraded: position.netBaseTraded,
                startTime: position.startTime,
                totalCycles: position.totalCycles,
                totalVolumeBase: position.totalVolumeBase,
                totalVolumeQuote: position.totalVolumeQuote,
                trades: []
            },
            tradingData: initialData,
            settings: readSettings(),
            orderBook: orderBook.getState(),
            thresholdState: thresholdStrategy.getThresholdState()
        });
        
        console.log(formatSuccess(`${icons.success} Position reset complete`));
        console.log(formatInfo(`${icons.balance} Initial balances: ${formatBalance(baseBalance, baseToken.NAME)} | ${formatBalance(quoteBalance, quoteToken.NAME)}`));
        console.log(horizontalLine());
        
        return initialData;
    } catch (error) {
        console.error(formatError(`Error resetting position: ${error.message}`));
        console.error(error);
        throw error;
    }
}

/**
 * Handles parameter updates from the UI
 * @param {Object} newParams - Updated parameters
 */
function handleParameterUpdate(newParams) {
    console.log(formatHeading("=== PARAMETER UPDATE ==="));
    console.log(formatInfo(`${icons.settings} Received new configuration parameters`));

    const updatedSettings = readSettings(); // Read the updated settings

    // Check if token pair has changed
    if (updatedSettings.TRADING_PAIR && newParams.TRADING_PAIR) {
        const oldBaseToken = getBaseToken().NAME;
        const oldQuoteToken = getQuoteToken().NAME;
        const newBaseToken = newParams.TRADING_PAIR.BASE_TOKEN?.NAME;
        const newQuoteToken = newParams.TRADING_PAIR.QUOTE_TOKEN?.NAME;
        
        if (newBaseToken && newQuoteToken && 
            (oldBaseToken !== newBaseToken || oldQuoteToken !== newQuoteToken)) {
            console.log(formatInfo(`${icons.trade} Token pair changed: ${oldBaseToken}/${oldQuoteToken} → ${newBaseToken}/${newQuoteToken}`));
            
            // Update orderBook to use new token-specific file
            orderBook.updateStoragePathForTokens();
            console.log(formatSuccess(`${icons.success} OrderBook updated for new token pair`));
        }
    }

    // Check if trading mode changed
    const oldThresholdMode = updatedSettings.THRESHOLD_MODE;
    const newThresholdMode = newParams.THRESHOLD_MODE;
    
    if (oldThresholdMode !== newThresholdMode) {
        console.log(formatInfo(`${icons.settings} Trading mode changed: ${oldThresholdMode ? 'Threshold' : 'Sentiment'} → ${newThresholdMode ? 'Threshold' : 'Sentiment'}`));
        
        // Reset threshold state if switching to threshold mode
        if (newThresholdMode) {
            thresholdStrategy.resetThresholdState();
            console.log(formatInfo(`${icons.settings} Threshold strategy state reset`));
        }
    }

    if (updatedSettings.SENTIMENT_BOUNDARIES) {
        SENTIMENT_BOUNDARIES = updatedSettings.SENTIMENT_BOUNDARIES;
        console.log(formatInfo(`${icons.sentiment} Sentiment boundaries updated`));
    }
    if (updatedSettings.SENTIMENT_MULTIPLIERS) {
        SENTIMENT_MULTIPLIERS = updatedSettings.SENTIMENT_MULTIPLIERS;
        console.log(formatInfo(`${icons.sentiment} Sentiment multipliers updated`));
    }

    console.log(formatInfo(`${icons.info} Trading strategy will adjust in the next cycle`));
    console.log(horizontalLine());
}

/**
 * Handles restart trading event
 */
async function handleRestartTrading() {
    console.log(formatHeading("=== RESTARTING TRADING ==="));
    devLog("Restarting trading...");
    
    try {
        // Get updated wallet and connection
        wallet = getWallet();
        connection = getConnection();

        // Cancel any pending transactions
        console.log(formatInfo(`${icons.warning} Cancelling pending transactions...`));
        cancelJupiterTransactions();

        // Signal the current execution to stop
        console.log(formatInfo(`${icons.warning} Stopping current execution...`));
        isCurrentExecutionCancelled = true;

        // Clear any existing scheduled runs
        console.log(formatInfo(`${icons.warning} Clearing scheduled cycles...`));
        clearTimeout(globalTimeoutId);

        // Stop the progress bar if it's running
        cleanupProgressBar();

        // Wait for current operations to complete
        console.log(formatInfo(`${icons.wait} Waiting for operations to complete...`));
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Reset position and get ready for new trading
        console.log(formatInfo(`${icons.settings} Resetting position...`));
        await resetPosition(wallet, connection);
        console.log(formatSuccess(`${icons.success} Position reset complete`));

        // Reset the cancellation flag
        isCurrentExecutionCancelled = false;

        // Schedule the next trading cycle
        const waitTime = getWaitTime();
        const nextExecutionTime = new Date(Date.now() + waitTime);

        console.log(formatInfo(`${icons.time} Next trading cycle will start at ${nextExecutionTime.toLocaleTimeString()} (in ${formatTime(waitTime)})`));

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
        
        console.log(formatSuccess(`${icons.success} Trading restart initiated successfully`));
        console.log(horizontalLine());
    } catch (error) {
        console.error(formatError(`Error handling restart trading: ${error.message}`));
        console.error(error);
        
        // Wait until next expected cycle rather than using a fixed delay
        const waitTime = getWaitTime();
        console.log(formatWarning(`${icons.warning} Error occurred. Waiting until next expected cycle in ${formatTime(waitTime)}`));
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
        console.log(formatHeading("=== STARTING PULSESURFER ==="));
        console.log(formatInfo(`${icons.info} Version: ${styles.important}${getVersion()}${colours.reset}`));
        await initialize();
    } catch (error) {
        console.error(formatError(`Failed to initialise PulseSurfer: ${error.message}`));
        process.exit(1);
    }
})();

// Export functions for external use
module.exports = { main, initialize, resetPosition };