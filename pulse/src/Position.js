const { devLog } = require('./utils');

/**
 * Class representing a trading position with SOL and USDC balances
 * Tracks trade history and calculates portfolio performance metrics
 */
class Position {
  /**
   * Create a new position
   * @param {number} initialSolBalance - Initial SOL balance
   * @param {number} initialUsdcBalance - Initial USDC balance
   * @param {number} initialPrice - Initial SOL price in USDC
   */
  constructor(initialSolBalance, initialUsdcBalance, initialPrice) {
    // Input validation
    this.initialSolBalance = this._validateNumber(initialSolBalance, 'initialSolBalance', 0);
    this.initialUsdcBalance = this._validateNumber(initialUsdcBalance, 'initialUsdcBalance', 0);
    this.initialPrice = this._validateNumber(initialPrice, 'initialPrice', 0);
    
    // Current balances
    this.solBalance = this.initialSolBalance;
    this.usdcBalance = this.initialUsdcBalance;
    
    // Initial portfolio value
    this.initialValue = this.initialSolBalance * this.initialPrice + this.initialUsdcBalance;
    
    // Trade tracking
    this.trades = [];
    this.isInitialized = true;
    
    // Trading metrics
    this.totalSolBought = 0;
    this.totalUsdcSpent = 0;
    this.totalSolSold = 0;
    this.totalUsdcReceived = 0;
    this.netSolTraded = 0;
    
    // Performance tracking
    this.startTime = Date.now();
    this.totalCycles = 0;
    this.totalVolumeSol = 0;
    this.totalVolumeUsdc = 0;
    
    // Cache for expensive calculations
    this._cache = {
      averageEntryPrice: null,
      averageSellPrice: null,
      lastNetChangePrice: null,
      lastNetChangeValue: null
    };
    
    devLog('Position initialized:', {
      initialSolBalance: this.initialSolBalance,
      initialUsdcBalance: this.initialUsdcBalance,
      initialPrice: this.initialPrice,
      initialValue: this.initialValue
    });
  }

  /**
   * Validate a number input, returning a default if invalid
   * @private
   * @param {any} value - Value to validate
   * @param {string} name - Name of the parameter (for logging)
   * @param {number} defaultValue - Default value to use if invalid
   * @returns {number} - Validated number
   */
  _validateNumber(value, name, defaultValue = 0) {
    if (typeof value !== 'number' || isNaN(value)) {
      console.error(`Invalid ${name}: ${value}, using default ${defaultValue}`);
      return defaultValue;
    }
    return value;
  }

  /**
   * Reset calculation cache when values change
   * @private
   */
  _resetCache() {
    this._cache = {
      averageEntryPrice: null,
      averageSellPrice: null,
      lastNetChangePrice: null,
      lastNetChangeValue: null
    };
  }

  /**
   * Update SOL and USDC balances
   * @param {number} newSolBalance - New SOL balance
   * @param {number} newUsdcBalance - New USDC balance
   * @returns {boolean} - Success status
   */
  updateBalances(newSolBalance, newUsdcBalance) {
    try {
      // Validate inputs
      const validatedSolBalance = this._validateNumber(newSolBalance, 'newSolBalance', this.solBalance);
      const validatedUsdcBalance = this._validateNumber(newUsdcBalance, 'newUsdcBalance', this.usdcBalance);
      
      // Update balances
      this.solBalance = validatedSolBalance;
      this.usdcBalance = validatedUsdcBalance;
      
      // Reset cache since balances have changed
      this._resetCache();
      
      devLog('Balances updated:', {
        solBalance: this.solBalance,
        usdcBalance: this.usdcBalance
      });
      
      return true;
    } catch (error) {
      console.error('Error updating balances:', error);
      return false;
    }
  }

  /**
   * Log a trade with associated sentiment
   * @param {string} sentiment - Market sentiment at time of trade
   * @param {number} price - Trade price
   * @param {number} solChange - Change in SOL amount (positive for buy, negative for sell)
   * @param {number} usdcChange - Change in USDC amount (negative for buy, positive for sell)
   * @returns {Object|null} - Trade object or null if invalid
   */
  logTrade(sentiment, price, solChange, usdcChange) {
    try {
      devLog('Logging trade:', { sentiment, price, solChange, usdcChange });

      // Validate inputs
      if (typeof price !== 'number' || isNaN(price) || price <= 0) {
        throw new Error(`Invalid price: ${price}`);
      }
      
      if (typeof solChange !== 'number' || isNaN(solChange) || solChange === 0) {
        throw new Error(`Invalid SOL change: ${solChange}`);
      }
      
      if (typeof usdcChange !== 'number' || isNaN(usdcChange)) {
        throw new Error(`Invalid USDC change: ${usdcChange}`);
      }

      // Determine trade type
      const tradeType = solChange > 0 ? 'buy' : 'sell';
      const solAmount = Math.abs(solChange);
      const usdcAmount = Math.abs(usdcChange);

      // Create trade object
      const trade = {
        type: tradeType,
        solAmount,
        usdcAmount,
        price,
        sentiment: sentiment || 'NEUTRAL',
        timestamp: new Date()
      };
      
      // Add to trade history
      this.trades.push(trade);

      // Update trading metrics
      if (tradeType === 'buy') {
        this.totalSolBought += solAmount;
        this.totalUsdcSpent += usdcAmount;
        this.netSolTraded += solAmount;
      } else {
        this.totalSolSold += solAmount;
        this.totalUsdcReceived += usdcAmount;
        this.netSolTraded -= solAmount;
      }

      // Update volume statistics
      this.totalVolumeSol += solAmount;
      this.totalVolumeUsdc += usdcAmount;
      
      // Reset calculation cache
      this._resetCache();

      devLog('Trade metrics updated:', {
        totalSolBought: this.totalSolBought,
        totalUsdcSpent: this.totalUsdcSpent,
        totalSolSold: this.totalSolSold,
        totalUsdcReceived: this.totalUsdcReceived,
        netSolTraded: this.netSolTraded
      });
      
      return trade;
    } catch (error) {
      console.error('Error logging trade:', error);
      return null;
    }
  }

  /**
   * Get average price for all buy trades
   * @returns {number} - Average entry price
   */
  getAverageEntryPrice() {
    // Use cached value if available
    if (this._cache.averageEntryPrice !== null) {
      return this._cache.averageEntryPrice;
    }
    
    // Calculate average entry price
    if (this.totalSolBought <= 0) {
      this._cache.averageEntryPrice = 0;
    } else {
      this._cache.averageEntryPrice = this.totalUsdcSpent / this.totalSolBought;
    }
    
    return this._cache.averageEntryPrice;
  }

  /**
   * Get average price for all sell trades
   * @returns {number} - Average sell price
   */
  getAverageSellPrice() {
    // Use cached value if available
    if (this._cache.averageSellPrice !== null) {
      return this._cache.averageSellPrice;
    }
    
    // Calculate average sell price
    if (this.totalSolSold <= 0) {
      this._cache.averageSellPrice = 0;
    } else {
      this._cache.averageSellPrice = this.totalUsdcReceived / this.totalSolSold;
    }
    
    return this._cache.averageSellPrice;
  }

  /**
   * Calculate net change in portfolio value from trades
   * @param {number} currentPrice - Current SOL price
   * @returns {number} - Net change in value
   */
  getNetChange(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Use cache if price hasn't changed
      if (this._cache.lastNetChangePrice === currentPrice && 
          this._cache.lastNetChangeValue !== null) {
        return this._cache.lastNetChangeValue;
      }
      
      devLog('getNetChange input:', {
        currentPrice,
        netSolTraded: this.netSolTraded,
        totalUsdcReceived: this.totalUsdcReceived,
        totalUsdcSpent: this.totalUsdcSpent
      });

      // Validate netSolTraded
      if (isNaN(this.netSolTraded)) {
        console.error('netSolTraded is NaN. Resetting to 0.');
        this.netSolTraded = 0;
      }

      // Calculate net change
      const currentValueOfTradedSol = this.netSolTraded * currentPrice;
      const netUsdcChange = this.totalUsdcReceived - this.totalUsdcSpent;

      devLog('getNetChange calculation:', {
        currentValueOfTradedSol,
        netUsdcChange
      });

      const netChange = currentValueOfTradedSol + netUsdcChange;
      
      // Cache the result
      this._cache.lastNetChangePrice = currentPrice;
      this._cache.lastNetChangeValue = isNaN(netChange) ? 0 : netChange;

      return this._cache.lastNetChangeValue;
    } catch (error) {
      console.error('Error calculating net change:', error);
      return 0;
    }
  }

  /**
   * Calculate current portfolio value
   * @param {number} currentPrice - Current SOL price
   * @returns {number} - Current portfolio value
   */
  getCurrentValue(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate current value
      return this.solBalance * currentPrice + this.usdcBalance;
    } catch (error) {
      console.error('Error calculating current value:', error);
      return this.initialValue;
    }
  }

  /**
   * Calculate percentage change in portfolio value
   * @param {number} currentPrice - Current SOL price
   * @returns {number} - Percentage change
   */
  getPortfolioPercentageChange(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Get current value
      const currentValue = this.getCurrentValue(currentPrice);
      
      // Calculate percentage change
      if (this.initialValue === 0) return 0;
      return ((currentValue - this.initialValue) / this.initialValue) * 100;
    } catch (error) {
      console.error('Error calculating portfolio percentage change:', error);
      return 0;
    }
  }

  /**
   * Calculate percentage change in SOL price
   * @param {number} currentPrice - Current SOL price
   * @returns {number} - Percentage change
   */
  getSolPricePercentageChange(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate percentage change
      if (this.initialPrice === 0) return 0;
      return ((currentPrice - this.initialPrice) / this.initialPrice) * 100;
    } catch (error) {
      console.error('Error calculating SOL price percentage change:', error);
      return 0;
    }
  }

  /**
   * Calculate performance of traded SOL in absolute terms
   * @param {number} currentPrice - Current SOL price
   * @returns {number} - Performance value
   */
  getTradedSolPerformance(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate performance
      const initialValueOfTradedSol = this.totalUsdcSpent - this.totalUsdcReceived;
      const currentValueOfTradedSol = this.netSolTraded * currentPrice;
      return currentValueOfTradedSol - initialValueOfTradedSol;
    } catch (error) {
      console.error('Error calculating traded SOL performance:', error);
      return 0;
    }
  }

  /**
   * Calculate percentage change in traded SOL value
   * @param {number} currentPrice - Current SOL price
   * @returns {number} - Percentage change
   */
  getTradedSolPercentageChange(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate percentage change
      const initialValueOfTradedSol = this.totalUsdcSpent - this.totalUsdcReceived;
      const currentValueOfTradedSol = this.netSolTraded * currentPrice;
      
      if (initialValueOfTradedSol === 0) return 0;
      return ((currentValueOfTradedSol - initialValueOfTradedSol) / Math.abs(initialValueOfTradedSol)) * 100;
    } catch (error) {
      console.error('Error calculating traded SOL percentage change:', error);
      return 0;
    }
  }

  /**
   * Get comprehensive trading statistics
   * @param {number} currentPrice - Current SOL price
   * @returns {Object} - Statistics object
   */
  getEnhancedStatistics(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate portfolio metrics
      const currentPortfolioValue = this.getCurrentValue(currentPrice);
      const portfolioChange = currentPortfolioValue - this.initialValue;
      
      // Calculate time metrics
      const totalRuntime = (Date.now() - this.startTime) / 1000 / 60 / 60; // in hours
      
      // Calculate volume metrics
      const totalVolumeUsd = this.totalVolumeUsdc + (this.totalVolumeSol * currentPrice);
      
      // Calculate net change
      const netChange = this.getNetChange(currentPrice);

      devLog('getEnhancedStatistics:', {
        currentPortfolioValue,
        portfolioChange,
        totalRuntime,
        totalVolumeUsd,
        netChange
      });

      // Format statistics object
      return {
        totalRuntime: totalRuntime.toFixed(2),
        totalCycles: this.totalCycles,
        portfolioValue: {
          initial: this.initialValue.toFixed(2),
          current: currentPortfolioValue.toFixed(2),
          change: portfolioChange.toFixed(2),
          percentageChange: this.getPortfolioPercentageChange(currentPrice).toFixed(2)
        },
        solPrice: {
          initial: this.initialPrice.toFixed(2),
          current: currentPrice.toFixed(2),
          percentageChange: this.getSolPricePercentageChange(currentPrice).toFixed(2)
        },
        netChange: netChange.toFixed(2),
        netSolTraded: this.netSolTraded.toFixed(6),
        totalVolume: {
          sol: this.totalVolumeSol.toFixed(6),
          usdc: this.totalVolumeUsdc.toFixed(2),
          usd: totalVolumeUsd.toFixed(2)
        },
        balances: {
          sol: {
            initial: this.initialSolBalance.toFixed(6),
            current: this.solBalance.toFixed(6),
            net: this.netSolTraded.toFixed(6)
          },
          usdc: {
            initial: this.initialUsdcBalance.toFixed(2),
            current: this.usdcBalance.toFixed(2),
            net: (this.totalUsdcReceived - this.totalUsdcSpent).toFixed(2)
          }
        },
        averagePrices: {
          entry: this.getAverageEntryPrice().toFixed(2),
          sell: this.getAverageSellPrice().toFixed(2)
        },
        tradedValue: (this.totalUsdcSpent + this.totalUsdcReceived).toFixed(2),
        tradesCount: this.trades.length,
        buysCount: this.trades.filter(t => t.type === 'buy').length,
        sellsCount: this.trades.filter(t => t.type === 'sell').length,
        lastUpdated: new Date().toISOString()
      };
    } catch (error) {
      console.error('Error generating enhanced statistics:', error);
      
      // Return basic stats if advanced ones fail
      return {
        totalRuntime: ((Date.now() - this.startTime) / 1000 / 60 / 60).toFixed(2),
        totalCycles: this.totalCycles,
        portfolioValue: {
          initial: this.initialValue.toFixed(2),
          current: "Error calculating"
        },
        error: error.message
      };
    }
  }

  /**
   * Increment cycle counter
   * @returns {number} - New cycle count
   */
  incrementCycle() {
    return ++this.totalCycles;
  }
  
  /**
   * Get trade history
   * @param {number} limit - Maximum number of trades to return
   * @returns {Array} - Trade history
   */
  getTradeHistory(limit = 0) {
    // Sort trades by timestamp (newest first)
    const sortedTrades = [...this.trades].sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    
    // Apply limit if specified
    return limit > 0 ? sortedTrades.slice(0, limit) : sortedTrades;
  }
  
  /**
   * Get summary of recent trading activity
   * @param {number} lookbackHours - Hours to look back
   * @returns {Object} - Trading summary
   */
  getRecentTradingSummary(lookbackHours = 24) {
    try {
      const cutoffTime = new Date(Date.now() - (lookbackHours * 60 * 60 * 1000));
      
      // Filter recent trades
      const recentTrades = this.trades.filter(trade => 
        new Date(trade.timestamp) >= cutoffTime
      );
      
      // Calculate recent metrics
      const recentSolBought = recentTrades
        .filter(t => t.type === 'buy')
        .reduce((sum, t) => sum + t.solAmount, 0);
        
      const recentSolSold = recentTrades
        .filter(t => t.type === 'sell')
        .reduce((sum, t) => sum + t.solAmount, 0);
        
      const recentUsdcSpent = recentTrades
        .filter(t => t.type === 'buy')
        .reduce((sum, t) => sum + t.usdcAmount, 0);
        
      const recentUsdcReceived = recentTrades
        .filter(t => t.type === 'sell')
        .reduce((sum, t) => sum + t.usdcAmount, 0);
      
      return {
        period: `${lookbackHours}h`,
        tradesCount: recentTrades.length,
        buysCount: recentTrades.filter(t => t.type === 'buy').length,
        sellsCount: recentTrades.filter(t => t.type === 'sell').length,
        solBought: recentSolBought.toFixed(6),
        solSold: recentSolSold.toFixed(6),
        usdcSpent: recentUsdcSpent.toFixed(2),
        usdcReceived: recentUsdcReceived.toFixed(2),
        netSol: (recentSolBought - recentSolSold).toFixed(6),
        netUsdc: (recentUsdcReceived - recentUsdcSpent).toFixed(2)
      };
    } catch (error) {
      console.error('Error generating recent trading summary:', error);
      return {
        period: `${lookbackHours}h`,
        tradesCount: 0,
        error: error.message
      };
    }
  }
}

module.exports = Position;