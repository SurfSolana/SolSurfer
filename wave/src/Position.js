class Position {
  constructor(initialSolBalance, initialUsdcBalance, initialPrice) {
    this.solBalance = initialSolBalance;
    this.usdcBalance = initialUsdcBalance;
    this.initialValue = this.solBalance * initialPrice + this.usdcBalance;
    this.initialSolBalance = initialSolBalance;
    this.initialUsdcBalance = initialUsdcBalance;
    this.initialPrice = initialPrice;
    this.trades = [];
    this.isInitialized = true;

    // Track bought and sold amounts separately
    this.totalSolBought = 0;
    this.totalUsdcSpent = 0;
    this.totalSolSold = 0;
    this.totalUsdcReceived = 0;

    // Track net traded position
    this.netSolTraded = 0;

    // Enhanced statistics
    this.startTime = Date.now();
    this.totalCycles = 0;
    this.totalVolumeSol = 0;
    this.totalVolumeUsdc = 0;
  }

  updateBalances(newSolBalance, newUsdcBalance) {
    this.solBalance = newSolBalance;
    this.usdcBalance = newUsdcBalance;
  }

  logTrade(sentiment, price, solChange, usdcChange) {
    console.log('Logging trade:', { sentiment, price, solChange, usdcChange });

    if (price === undefined || solChange === undefined || usdcChange === undefined) {
      console.error('Invalid trade data. Skipping trade log.');
      return;
    }

    const tradeType = solChange > 0 ? 'buy' : 'sell';
    const solAmount = Math.abs(solChange);
    const usdcAmount = Math.abs(usdcChange);

    this.trades.push({
      type: tradeType,
      solAmount,
      usdcAmount,
      price,
      sentiment,
      timestamp: new Date()
    });

    // Update traded amounts
    if (tradeType === 'buy') {
      this.totalSolBought += solAmount;
      this.totalUsdcSpent += usdcAmount;
      this.netSolTraded += solAmount;
    } else {
      this.totalSolSold += solAmount;
      this.totalUsdcReceived += usdcAmount;
      this.netSolTraded -= solAmount;
    }

    console.log('After trade update:', {
      totalSolBought: this.totalSolBought,
      totalUsdcSpent: this.totalUsdcSpent,
      totalSolSold: this.totalSolSold,
      totalUsdcReceived: this.totalUsdcReceived,
      netSolTraded: this.netSolTraded
    });

    // Update total volume
    this.totalVolumeSol += solAmount;
    this.totalVolumeUsdc += usdcAmount;
  }

  getAverageEntryPrice() {
    return this.totalSolBought > 0 ? this.totalUsdcSpent / this.totalSolBought : 0;
  }

  getAverageSellPrice() {
    return this.totalSolSold > 0 ? this.totalUsdcReceived / this.totalSolSold : 0;
  }

  getNetChange(currentPrice) {
    console.log('getNetChange input:', {
      currentPrice,
      netSolTraded: this.netSolTraded,
      totalUsdcReceived: this.totalUsdcReceived,
      totalUsdcSpent: this.totalUsdcSpent
    });

    if (isNaN(this.netSolTraded)) {
      console.error('netSolTraded is NaN. Resetting to 0.');
      this.netSolTraded = 0;
    }

    const currentValueOfTradedSol = this.netSolTraded * currentPrice;
    const netUsdcChange = this.totalUsdcReceived - this.totalUsdcSpent;

    console.log('getNetChange calculation:', {
      currentValueOfTradedSol,
      netUsdcChange,
      totalUsdcReceived: this.totalUsdcReceived,
      totalUsdcSpent: this.totalUsdcSpent
    });

    const netChange = currentValueOfTradedSol + netUsdcChange;

    console.log('getNetChange result:', netChange);

    // If netChange is NaN, return 0 or some default value
    return isNaN(netChange) ? 0 : netChange;
  }

  getCurrentValue(currentPrice) {
    return this.solBalance * currentPrice + this.usdcBalance;
  }

  getPortfolioPercentageChange(currentPrice) {
    const currentValue = this.getCurrentValue(currentPrice);
    return ((currentValue - this.initialValue) / this.initialValue) * 100;
  }

  getSolPricePercentageChange(currentPrice) {
    return ((currentPrice - this.initialPrice) / this.initialPrice) * 100;
  }

  getTradedSolPerformance(currentPrice) {
    const initialValueOfTradedSol = this.totalUsdcSpent - this.totalUsdcReceived;
    const currentValueOfTradedSol = this.netSolTraded * currentPrice;
    return currentValueOfTradedSol - initialValueOfTradedSol;
  }

  getTradedSolPercentageChange(currentPrice) {
    const initialValueOfTradedSol = this.totalUsdcSpent - this.totalUsdcReceived;
    const currentValueOfTradedSol = this.netSolTraded * currentPrice;
    if (initialValueOfTradedSol === 0) return 0;
    return ((currentValueOfTradedSol - initialValueOfTradedSol) / Math.abs(initialValueOfTradedSol)) * 100;
  }

  getEnhancedStatistics(currentPrice) {
    const currentPortfolioValue = this.getCurrentValue(currentPrice);
    const portfolioChange = currentPortfolioValue - this.initialValue;
    const totalRuntime = (Date.now() - this.startTime) / 1000 / 60 / 60; // in hours
    const totalVolumeUsd = this.totalVolumeUsdc + (this.totalVolumeSol * currentPrice);
    const netChange = this.getNetChange(currentPrice);

    console.log('getEnhancedStatistics:', {
      currentPortfolioValue,
      portfolioChange,
      totalRuntime,
      totalVolumeUsd,
      netChange
    });

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
      tradedValue: (this.totalUsdcSpent + this.totalUsdcReceived).toFixed(2)
    };
  }

  incrementCycle() {
    this.totalCycles++;
  }
}

module.exports = Position;