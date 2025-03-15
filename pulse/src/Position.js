const { 
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

/**
 * Class representing a trading position with Base Token and Quote Token balances
 * Tracks trade history and calculates portfolio performance metrics
 */
class Position {
  /**
   * Create a new position
   * @param {number} initialBaseTokenBalance - Initial Base Token balance
   * @param {number} initialQuoteTokenBalance - Initial Quote Token balance
   * @param {number} initialPrice - Initial Base Token price in Quote Token
   */
  constructor(initialBaseTokenBalance, initialQuoteTokenBalance, initialPrice) {
    // Get token configurations
    this.baseToken = getBaseToken();
    this.quoteToken = getQuoteToken();
    
    // Input validation
    this.initialBaseBalance = this._validateNumber(initialBaseTokenBalance, 'initialBaseTokenBalance', 0);
    this.initialQuoteBalance = this._validateNumber(initialQuoteTokenBalance, 'initialQuoteTokenBalance', 0);
    this.initialPrice = this._validateNumber(initialPrice, 'initialPrice', 0);
    
    // Current balances
    this.baseBalance = this.initialBaseBalance;
    this.quoteBalance = this.initialQuoteBalance;
    
    // Initial portfolio value
    this.initialValue = this.initialBaseBalance * this.initialPrice + this.initialQuoteBalance;
    
    // Trade tracking
    this.trades = [];
    this.isInitialized = true;
    
    // Trading metrics
    this.totalBaseBought = 0;
    this.totalQuoteSpent = 0;
    this.totalBaseSold = 0;
    this.totalQuoteReceived = 0;
    this.netBaseTraded = 0;
    
    // Performance tracking
    this.startTime = Date.now();
    this.totalCycles = 0;
    this.totalVolumeBase = 0;
    this.totalVolumeQuote = 0;
    
    // Cache for expensive calculations
    this._cache = {
      averageEntryPrice: null,
      averageSellPrice: null,
      lastNetChangePrice: null,
      lastNetChangeValue: null
    };
    
    devLog(formatInfo(`${icons.info} Position initialized with:`));
    devLog(`  ${styles.balance}${this.initialBaseBalance}${colours.reset} ${this.baseToken.NAME}`);
    devLog(`  ${styles.balance}${this.initialQuoteBalance}${colours.reset} ${this.quoteToken.NAME}`);
    devLog(`  Initial Price: ${formatPrice(this.initialPrice)}`);
    devLog(`  Initial Value: ${formatPrice(this.initialValue)}`);
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
      console.error(formatError(`${icons.error} Invalid ${name}: ${value}, using default ${defaultValue}`));
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
   * Update token balances
   * @param {number} newBaseTokenBalance - New base token balance
   * @param {number} newQuoteTokenBalance - New quote token balance
   * @returns {boolean} - Success status
   */
  updateBalances(newBaseTokenBalance, newQuoteTokenBalance) {
    try {
      // Validate inputs
      const validatedBaseTokenBalance = this._validateNumber(newBaseTokenBalance, 'newBaseTokenBalance', this.baseBalance);
      const validatedQuoteTokenBalance = this._validateNumber(newQuoteTokenBalance, 'newQuoteTokenBalance', this.quoteBalance);
      
      // Update balances
      this.baseBalance = validatedBaseTokenBalance;
      this.quoteBalance = validatedQuoteTokenBalance;
      
      // Reset cache since balances have changed
      this._resetCache();
      
      devLog(formatInfo(`${icons.balance} Balances updated:`));
      devLog(`  ${this.baseToken.NAME}: ${formatBalance(this.baseBalance, this.baseToken.NAME)}`);
      devLog(`  ${this.quoteToken.NAME}: ${formatBalance(this.quoteBalance, this.quoteToken.NAME)}`);
      
      return true;
    } catch (error) {
      console.error(formatError(`${icons.error} Error updating balances: ${error.message}`));
      return false;
    }
  }

  /**
   * Log a trade with associated sentiment
   * @param {string} sentiment - Market sentiment at time of trade
   * @param {number} price - Trade price
   * @param {number} baseTokenChange - Change in base token amount (positive for buy, negative for sell)
   * @param {number} quoteTokenChange - Change in quote token amount (negative for buy, positive for sell)
   * @returns {Object|null} - Trade object or null if invalid
   */
  logTrade(sentiment, price, baseTokenChange, quoteTokenChange) {
    try {
      devLog(formatInfo(`${icons.trade} Logging trade:`));
      devLog(`  Sentiment: ${formatSentiment(sentiment)}`); 
      devLog(`  Price: ${formatPrice(price)}`);
      devLog(`  ${this.baseToken.NAME} Change: ${formatTokenChange(baseTokenChange, this.baseToken.NAME)}`);
      devLog(`  ${this.quoteToken.NAME} Change: ${formatTokenChange(quoteTokenChange, this.quoteToken.NAME)}`);

      // Validate inputs
      if (typeof price !== 'number' || isNaN(price) || price <= 0) {
        throw new Error(`Invalid price: ${price}`);
      }
      
      if (typeof baseTokenChange !== 'number' || isNaN(baseTokenChange) || baseTokenChange === 0) {
        throw new Error(`Invalid ${this.baseToken.NAME} change: ${baseTokenChange}`);
      }
      
      if (typeof quoteTokenChange !== 'number' || isNaN(quoteTokenChange)) {
        throw new Error(`Invalid ${this.quoteToken.NAME} change: ${quoteTokenChange}`);
      }

      // Determine trade type
      const tradeType = baseTokenChange > 0 ? 'buy' : 'sell';
      const baseTokenAmount = Math.abs(baseTokenChange);
      const quoteTokenAmount = Math.abs(quoteTokenChange);

      // Create trade object
      const trade = {
        type: tradeType,
        baseAmount: baseTokenAmount,  // Keep for backward compatibility
        quoteAmount: quoteTokenAmount, // Keep for backward compatibility
        baseTokenAmount,  // New field with proper naming
        quoteTokenAmount, // New field with proper naming
        price,
        sentiment: sentiment || 'NEUTRAL',
        timestamp: new Date(),
        tokenInfo: {
          baseToken: this.baseToken.NAME,
          quoteToken: this.quoteToken.NAME,
          baseTokenDecimals: this.baseToken.DECIMALS,
          quoteTokenDecimals: this.quoteToken.DECIMALS
        }
      };
      
      // Add to trade history
      this.trades.push(trade);

      // Update trading metrics
      if (tradeType === 'buy') {
        this.totalBaseBought += baseTokenAmount;
        this.totalQuoteSpent += quoteTokenAmount;
        this.netBaseTraded += baseTokenAmount;
      } else {
        this.totalBaseSold += baseTokenAmount;
        this.totalQuoteReceived += quoteTokenAmount;
        this.netBaseTraded -= baseTokenAmount;
      }

      // Update volume statistics
      this.totalVolumeBase += baseTokenAmount;
      this.totalVolumeQuote += quoteTokenAmount;
      
      // Reset calculation cache
      this._resetCache();

      devLog(formatSuccess(`${icons.success} Trade metrics updated:`));
      devLog(`  Total ${this.baseToken.NAME} Bought: ${formatBalance(this.totalBaseBought, this.baseToken.NAME)}`);
      devLog(`  Total ${this.quoteToken.NAME} Spent: ${formatBalance(this.totalQuoteSpent, this.quoteToken.NAME)}`);
      devLog(`  Total ${this.baseToken.NAME} Sold: ${formatBalance(this.totalBaseSold, this.baseToken.NAME)}`);
      devLog(`  Total ${this.quoteToken.NAME} Received: ${formatBalance(this.totalQuoteReceived, this.quoteToken.NAME)}`);
      devLog(`  Net ${this.baseToken.NAME} Traded: ${formatTokenChange(this.netBaseTraded, this.baseToken.NAME, false)}`);
      
      return trade;
    } catch (error) {
      console.error(formatError(`${icons.error} Error logging trade: ${error.message}`));
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
    if (this.totalBaseBought <= 0) {
      this._cache.averageEntryPrice = 0;
    } else {
      this._cache.averageEntryPrice = this.totalQuoteSpent / this.totalBaseBought;
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
    if (this.totalBaseSold <= 0) {
      this._cache.averageSellPrice = 0;
    } else {
      this._cache.averageSellPrice = this.totalQuoteReceived / this.totalBaseSold;
    }
    
    return this._cache.averageSellPrice;
  }

  /**
   * Calculate net change in portfolio value from trades
   * @param {number} currentPrice - Current token price
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
      
      devLog(formatInfo(`${icons.stats} getNetChange input:`));
      devLog(`  Current Price: ${formatPrice(currentPrice)}`);
      devLog(`  Net ${this.baseToken.NAME} Traded: ${formatBalance(this.netBaseTraded, this.baseToken.NAME)}`);
      devLog(`  Total ${this.quoteToken.NAME} Received: ${formatBalance(this.totalQuoteReceived, this.quoteToken.NAME)}`);
      devLog(`  Total ${this.quoteToken.NAME} Spent: ${formatBalance(this.totalQuoteSpent, this.quoteToken.NAME)}`);

      // Validate netBaseTraded
      if (isNaN(this.netBaseTraded)) {
        console.error(formatError(`${icons.error} netBaseTraded is NaN. Resetting to 0.`));
        this.netBaseTraded = 0;
      }

      // Calculate net change
      const currentValueOfTradedBase = this.netBaseTraded * currentPrice;
      const netQuoteChange = this.totalQuoteReceived - this.totalQuoteSpent;

      devLog(formatInfo(`${icons.stats} getNetChange calculation:`));
      devLog(`  Current Value of Traded ${this.baseToken.NAME}: ${formatPrice(currentValueOfTradedBase)}`);
      devLog(`  Net ${this.quoteToken.NAME} Change: ${formatTokenChange(netQuoteChange, this.quoteToken.NAME)}`);

      const netChange = currentValueOfTradedBase + netQuoteChange;
      
      // Cache the result
      this._cache.lastNetChangePrice = currentPrice;
      this._cache.lastNetChangeValue = isNaN(netChange) ? 0 : netChange;

      return this._cache.lastNetChangeValue;
    } catch (error) {
      console.error(formatError(`${icons.error} Error calculating net change: ${error.message}`));
      return 0;
    }
  }

  /**
   * Calculate current portfolio value
   * @param {number} currentPrice - Current token price
   * @returns {number} - Current portfolio value
   */
  getCurrentValue(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate current value
      return this.baseBalance * currentPrice + this.quoteBalance;
    } catch (error) {
      console.error(formatError(`${icons.error} Error calculating current value: ${error.message}`));
      return this.initialValue;
    }
  }

  /**
   * Calculate percentage change in portfolio value
   * @param {number} currentPrice - Current token price
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
      console.error(formatError(`${icons.error} Error calculating portfolio percentage change: ${error.message}`));
      return 0;
    }
  }

  /**
   * Calculate percentage change in token price
   * @param {number} currentPrice - Current token price
   * @returns {number} - Percentage change
   */
  getBasePricePercentageChange(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate percentage change
      if (this.initialPrice === 0) return 0;
      return ((currentPrice - this.initialPrice) / this.initialPrice) * 100;
    } catch (error) {
      console.error(formatError(`${icons.error} Error calculating token price percentage change: ${error.message}`));
      return 0;
    }
  }

  /**
   * Calculate performance of traded token in absolute terms
   * @param {number} currentPrice - Current token price
   * @returns {number} - Performance value
   */
  getTradedBasePerformance(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate performance
      const initialValueOfTradedBase = this.totalQuoteSpent - this.totalQuoteReceived;
      const currentValueOfTradedBase = this.netBaseTraded * currentPrice;
      return currentValueOfTradedBase - initialValueOfTradedBase;
    } catch (error) {
      console.error(formatError(`${icons.error} Error calculating traded token performance: ${error.message}`));
      return 0;
    }
  }

  /**
   * Calculate percentage change in traded token value
   * @param {number} currentPrice - Current token price
   * @returns {number} - Percentage change
   */
  getTradedBasePercentageChange(currentPrice) {
    try {
      // Validate price
      currentPrice = this._validateNumber(currentPrice, 'currentPrice', this.initialPrice);
      
      // Calculate percentage change
      const initialValueOfTradedBase = this.totalQuoteSpent - this.totalQuoteReceived;
      const currentValueOfTradedBase = this.netBaseTraded * currentPrice;
      
      if (initialValueOfTradedBase === 0) return 0;
      return ((currentValueOfTradedBase - initialValueOfTradedBase) / Math.abs(initialValueOfTradedBase)) * 100;
    } catch (error) {
      console.error(formatError(`${icons.error} Error calculating traded token percentage change: ${error.message}`));
      return 0;
    }
  }

  /**
   * Get comprehensive trading statistics
   * @param {number} currentPrice - Current token price
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
      const totalVolumeUsd = this.totalVolumeQuote + (this.totalVolumeBase * currentPrice);
      
      // Calculate net change
      const netChange = this.getNetChange(currentPrice);

      // Get token names
      const baseTokenName = this.baseToken.NAME;
      const quoteTokenName = this.quoteToken.NAME;

      devLog(formatInfo(`${icons.stats} Generating enhanced statistics:`));
      devLog(`  Current Portfolio Value: ${formatPrice(currentPortfolioValue)}`);
      devLog(`  Portfolio Change: ${formatTokenChange(portfolioChange, '$')}`);
      devLog(`  Total Runtime: ${styles.time}${totalRuntime.toFixed(2)} hours${colours.reset}`);
      devLog(`  Total Volume (USD): ${formatPrice(totalVolumeUsd)}`);
      devLog(`  Net Change: ${formatTokenChange(netChange, '$')}`);

      // Format statistics object with proper token information
      return {
        totalRuntime: totalRuntime.toFixed(2),
        totalCycles: this.totalCycles,
        portfolioValue: {
          initial: this.initialValue.toFixed(2),
          current: currentPortfolioValue.toFixed(2),
          change: portfolioChange.toFixed(2),
          percentageChange: this.getPortfolioPercentageChange(currentPrice).toFixed(2)
        },
        tokenPrice: {
          initial: this.initialPrice.toFixed(2),
          current: currentPrice.toFixed(2),
          percentageChange: this.getBasePricePercentageChange(currentPrice).toFixed(2)
        },
        netChange: netChange.toFixed(2),
        netTokenTraded: this.netBaseTraded.toFixed(this.baseToken.DECIMALS), // Using proper decimals
        totalVolume: {
          baseToken: this.totalVolumeBase.toFixed(this.baseToken.DECIMALS), // New field with proper naming
          quoteToken: this.totalVolumeBase.toFixed(this.quoteToken.DECIMALS), // New field with proper naming
          usd: totalVolumeUsd.toFixed(2)
        },
        balances: {
          baseToken: {  // New field with proper naming
            initial: this.initialBaseBalance.toFixed(this.baseToken.DECIMALS),
            current: this.baseBalance.toFixed(this.baseToken.DECIMALS),
            net: this.netBaseTraded.toFixed(this.baseToken.DECIMALS)
          },
          quoteToken: {  // New field with proper naming
            initial: this.initialQuoteBalance.toFixed(this.quoteToken.DECIMALS),
            current: this.quoteBalance.toFixed(this.quoteToken.DECIMALS),
            net: (this.totalQuoteReceived - this.totalQuoteSpent).toFixed(this.quoteToken.DECIMALS)
          }
        },
        averagePrices: {
          entry: this.getAverageEntryPrice().toFixed(2),
          sell: this.getAverageSellPrice().toFixed(2)
        },
        tradedValue: (this.totalQuoteSpent + this.totalQuoteReceived).toFixed(this.quoteToken.DECIMALS),
        tradesCount: this.trades.length,
        buysCount: this.trades.filter(t => t.type === 'buy').length,
        sellsCount: this.trades.filter(t => t.type === 'sell').length,
        lastUpdated: new Date().toISOString(),
        tokenInfo: {
          baseToken: baseTokenName, 
          quoteToken: quoteTokenName,
          baseTokenDecimals: this.baseToken.DECIMALS,
          quoteTokenDecimals: this.quoteToken.DECIMALS
        }
      };
    } catch (error) {
      console.error(formatError(`${icons.error} Error generating enhanced statistics: ${error.message}`));
      
      // Return basic stats if advanced ones fail
      return {
        totalRuntime: ((Date.now() - this.startTime) / 1000 / 60 / 60).toFixed(2),
        totalCycles: this.totalCycles,
        portfolioValue: {
          initial: this.initialValue.toFixed(2),
          current: "Error calculating"
        },
        error: error.message,
        tokenInfo: {
          baseToken: this.baseToken.NAME,
          quoteToken: this.quoteToken.NAME,
          baseTokenDecimals: this.baseToken.DECIMALS,
          quoteTokenDecimals: this.quoteToken.DECIMALS
        }
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

}

module.exports = Position;