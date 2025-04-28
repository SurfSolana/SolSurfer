/**
 * PulseSurfer Threshold Strategy Module
 * Implements the Fear & Greed Index threshold-based trading strategy
 * Adapted from lifeguard.js backtest code
 */

const { 
    devLog, 
    getBaseToken, 
    getQuoteToken,
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

// Threshold state tracking
let thresholdState = {
    daysAboveThreshold: 0,
    daysBelowThreshold: 0,
    inHighAllocation: null, // null = no position yet, true = high SOL, false = high USDC
    lastFGI: null,
    consecutiveReadings: []
};

/**
 * Reset threshold state
 */
function resetThresholdState() {
    thresholdState = {
        daysAboveThreshold: 0,
        daysBelowThreshold: 0,
        inHighAllocation: null,
        lastFGI: null,
        consecutiveReadings: []
    };
    devLog('Threshold state has been reset');
}

/**
 * Update threshold state based on current FGI
 * @param {number} currentFGI - Current Fear & Greed Index value
 * @param {Object} thresholdSettings - Threshold strategy settings
 * @returns {Object} Updated state information
 */
function updateThresholdState(currentFGI, thresholdSettings) {
    // Store FGI reading in state
    thresholdState.lastFGI = currentFGI;
    thresholdState.consecutiveReadings.push({
        fgi: currentFGI,
        timestamp: new Date().toISOString()
    });
    
    // Keep only the most recent readings needed for switch delay
    const maxReadingsToKeep = Math.max(thresholdSettings.SWITCH_DELAY * 2, 10);
    if (thresholdState.consecutiveReadings.length > maxReadingsToKeep) {
        thresholdState.consecutiveReadings = thresholdState.consecutiveReadings.slice(-maxReadingsToKeep);
    }
    
    // Check FGI threshold status
    const isAboveThreshold = currentFGI >= thresholdSettings.THRESHOLD;
    
    // Update consecutive cycle counters
    if (isAboveThreshold) {
        thresholdState.daysAboveThreshold++;
        thresholdState.daysBelowThreshold = 0;
    } else {
        thresholdState.daysBelowThreshold++;
        thresholdState.daysAboveThreshold = 0;
    }
    
    // Determine if we need to switch positions
    const shouldSwitchToHighSOL = isAboveThreshold && 
                                 thresholdState.daysAboveThreshold >= thresholdSettings.SWITCH_DELAY && 
                                 thresholdState.inHighAllocation !== true;
                                 
    const shouldSwitchToHighUSDC = !isAboveThreshold && 
                                  thresholdState.daysBelowThreshold >= thresholdSettings.SWITCH_DELAY && 
                                  thresholdState.inHighAllocation !== false;
    
    return {
        isAboveThreshold,
        daysAboveThreshold: thresholdState.daysAboveThreshold,
        daysBelowThreshold: thresholdState.daysBelowThreshold,
        inHighAllocation: thresholdState.inHighAllocation,
        shouldSwitchToHighSOL,
        shouldSwitchToHighUSDC,
        needsRebalance: shouldSwitchToHighSOL || shouldSwitchToHighUSDC
    };
}

/**
 * Calculate target allocations based on threshold strategy
 * @param {boolean} isHighSOL - Whether to allocate high percentage to SOL
 * @param {number} portfolioValue - Total portfolio value
 * @param {number} currentPrice - Current token price
 * @param {number} allocationPercentage - Percentage to allocate (0-100)
 * @returns {Object} Target allocations
 */
function calculateTargetAllocations(isHighSOL, portfolioValue, currentPrice, allocationPercentage) {
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    
    // Validate inputs
    if (typeof portfolioValue !== 'number' || portfolioValue <= 0) {
        throw new Error(`Invalid portfolio value: ${portfolioValue}`);
    }
    
    if (typeof currentPrice !== 'number' || currentPrice <= 0) {
        throw new Error(`Invalid current price: ${currentPrice}`);
    }
    
    if (typeof allocationPercentage !== 'number' || allocationPercentage <= 0 || allocationPercentage > 100) {
        throw new Error(`Invalid allocation percentage: ${allocationPercentage}`);
    }
    
    // Calculate target allocations
    // If isHighSOL is true, allocate high percentage to SOL, small to USDC
    // If isHighSOL is false, allocate low percentage to SOL, high to USDC
    const targetSOLPercentage = isHighSOL ? allocationPercentage : (100 - allocationPercentage);
    const targetUSDCPercentage = 100 - targetSOLPercentage;
    
    const targetSOLValue = (portfolioValue * targetSOLPercentage) / 100;
    const targetUSDCValue = (portfolioValue * targetUSDCPercentage) / 100;
    
    // Convert SOL value to tokens
    const targetSOLTokens = targetSOLValue / currentPrice;
    
    // Log detailed allocation information
    devLog(`Target Allocation Calculation:
    - Portfolio Value: ${portfolioValue}
    - Current Price: ${currentPrice}
    - Target ${baseToken.NAME} %: ${targetSOLPercentage}%
    - Target ${quoteToken.NAME} %: ${targetUSDCPercentage}%
    - Target ${baseToken.NAME} Value: ${targetSOLValue}
    - Target ${quoteToken.NAME} Value: ${targetUSDCValue}
    - Target ${baseToken.NAME} Tokens: ${targetSOLTokens}
    `);
    
    return {
        baseToken: {
            symbol: baseToken.NAME,
            percentage: targetSOLPercentage,
            tokens: targetSOLTokens,
            value: targetSOLValue
        },
        quoteToken: {
            symbol: quoteToken.NAME,
            percentage: targetUSDCPercentage,
            tokens: targetUSDCValue, // USDC is 1:1 with value
            value: targetUSDCValue
        },
        isHighSOL
    };
}

/**
 * Calculate trade amount needed to rebalance portfolio
 * @param {Object} currentAllocations - Current portfolio allocations
 * @param {Object} targetAllocations - Target portfolio allocations
 * @param {Object} thresholdSettings - Threshold strategy settings
 * @returns {Object|null} Trade parameters or null if no trade needed
 */
function calculateRebalanceTrade(currentAllocations, targetAllocations, thresholdSettings) {
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    
    // Calculate differences
    const baseDifference = targetAllocations.baseToken.tokens - currentAllocations.baseToken.tokens;
    const quoteDifference = targetAllocations.quoteToken.tokens - currentAllocations.quoteToken.tokens;
    
    // Determine trade direction
    const isBuyingBase = baseDifference > 0;
    
    // Apply minimum trade threshold only to avoid tiny trades
    const MIN_TRADE_AMOUNT = thresholdSettings.MIN_TRADE_AMOUNT || 0.00001;
    if (Math.abs(baseDifference) < MIN_TRADE_AMOUNT) {
        devLog(`Trade amount (${Math.abs(baseDifference)}) below minimum threshold (${MIN_TRADE_AMOUNT}), skipping`);
        return null;
    }
    
    return {
        baseTokenChange: baseDifference,
        quoteTokenChange: quoteDifference,
        isBuyingBase,
        inputToken: isBuyingBase ? quoteToken.ADDRESS : baseToken.ADDRESS,
        outputToken: isBuyingBase ? baseToken.ADDRESS : quoteToken.ADDRESS,
        inputAmount: isBuyingBase ? Math.abs(quoteDifference) : Math.abs(baseDifference),
        type: isBuyingBase ? 'buy' : 'sell',
        exactOutputAmount: isBuyingBase ? Math.abs(baseDifference) : Math.abs(quoteDifference)
    };
}

/**
 * Gets current allocations from balances
 * @param {number} baseBalance - Base token balance
 * @param {number} quoteBalance - Quote token balance
 * @param {number} currentPrice - Current token price
 * @returns {Object} Current allocations
 */
function getCurrentAllocations(baseBalance, quoteBalance, currentPrice) {
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    
    // Calculate current values
    const baseValue = baseBalance * currentPrice;
    const quoteValue = quoteBalance;
    const totalValue = baseValue + quoteValue;
    
    // Calculate percentages
    const basePercentage = totalValue > 0 ? (baseValue / totalValue) * 100 : 0;
    const quotePercentage = totalValue > 0 ? (quoteValue / totalValue) * 100 : 0;
    
    return {
        totalValue,
        price: currentPrice,
        baseToken: {
            symbol: baseToken.NAME,
            tokens: baseBalance,
            value: baseValue,
            percentage: basePercentage
        },
        quoteToken: {
            symbol: quoteToken.NAME,
            tokens: quoteBalance,
            value: quoteValue,
            percentage: quotePercentage
        }
    };
}

/**
 * Updates the inHighAllocation state after successful trade
 * @param {boolean} isHighSOL - Whether we've allocated high percentage to SOL
 */
function updateAllocationState(isHighSOL) {
    thresholdState.inHighAllocation = isHighSOL;
    devLog(`Allocation state updated: inHighSOL = ${isHighSOL}`);
    
    // Reset counters after successful trade to prevent immediate re-trading
    if (isHighSOL) {
        thresholdState.daysBelowThreshold = 0;
    } else {
        thresholdState.daysAboveThreshold = 0;
    }
    
    // Record the allocation change with timestamp
    thresholdState.lastAllocationChange = {
        timestamp: new Date().toISOString(),
        isHighSOL: isHighSOL
    };
    
    devLog(`Allocation state updated: ${JSON.stringify(thresholdState)}`);
}

module.exports = {
    resetThresholdState,
    updateThresholdState,
    calculateTargetAllocations,
    calculateRebalanceTrade,
    getCurrentAllocations,
    updateAllocationState,
    getThresholdState: () => thresholdState
};