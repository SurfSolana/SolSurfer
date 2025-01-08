const fs = require('fs');
const path = require('path');
const csv = require('csv-parser');
const Position = require('./Position');
const OrderBook = require('./orderBook');
const { getSentiment } = require('./api');

class PulseSurferBacktest {
    constructor(initialBalance = {
        sol: 10,
        usdc: 1000
    }) {
        this.initialBalance = initialBalance;
        this.results = [];
        this.currentSettings = null;
    }

    async loadHistoricalData(csvPath) {
        const data = [];
        return new Promise((resolve, reject) => {
            const rows = fs.readFileSync(csvPath, 'utf8')
                .split('\n')
                .filter(row => row.trim());
                
            for (const row of rows) {
                const [time, date, price, fgi] = row.split(',');
                if (!time || !date || !price || !fgi) continue;
                
                console.log('Parsing row:', { time, date, price, fgi });
                
                try {
                    data.push({
                        timestamp: new Date(`${date} ${time}`),
                        price: parseFloat(price),
                        fgi: parseFloat(fgi.trim())
                    });
                } catch (e) {
                    console.error(`Error parsing row: ${row}`, e);
                }
            }
            
            this.historicalData = data.sort((a, b) => a.timestamp - b.timestamp);
            console.log(`Loaded ${data.length} data points`);
            resolve(data);
        });
    }

    calculateDrawdown(currentValue) {
        if (currentValue > this.peakBalance) {
            this.peakBalance = currentValue;
        }
        if (currentValue < this.lowestBalance) {
            this.lowestBalance = currentValue;
        }
        
        const drawdownDollars = this.peakBalance - currentValue;
        const drawdownPercentage = drawdownDollars / this.peakBalance;
        
        if (drawdownPercentage > this.maxDrawdownPercentage) {
            this.maxDrawdownPercentage = drawdownPercentage;
            this.maxDrawdownDollars = drawdownDollars;
        }
    }

    async runBacktest(settings) {
        // Clean initialization at start of each test
        const orderBook = new OrderBook();
        orderBook.trades = [];
        
        this.currentSettings = settings;
        this.peakBalance = this.initialBalance.sol * this.historicalData[0].price + this.initialBalance.usdc;
        this.lowestBalance = this.peakBalance;
        this.maxDrawdownPercentage = 0;
        this.maxDrawdownDollars = 0;
        this.totalTrades = 0;
        this.totalBuyVolume = 0;
        this.totalSellVolume = 0;
        this.avgBuyPrice = 0;
        this.avgSellPrice = 0;
        this.winningTrades = 0;
        this.losingTrades = 0;

        const position = new Position(
            this.initialBalance.sol,
            this.initialBalance.usdc,
            this.historicalData[0].price
        );
        
        let lastTradeTime = null;
        const MIN_PROFIT_PERCENT = settings.MIN_PROFIT_PERCENT || 0.2;

        for (let i = 0; i < this.historicalData.length; i++) {
            const data = this.historicalData[i];
            let sentiment;
            
            if (!isNaN(data.fgi)) {
                sentiment = getSentiment(data.fgi);
            } else {
                console.log(`Invalid FGI value: ${data.fgi}`);
                continue;
            }

            // Skip if on cooldown
            if (lastTradeTime && 
                (data.timestamp - lastTradeTime) < settings.TRADE_COOLDOWN_MINUTES * 60 * 1000) {
                continue;
            }

            // Check for profitable closing opportunities first
            const hasPositionToClose = orderBook.findOldestMatchingTrade(
                ["EXTREME_FEAR", "FEAR"].includes(sentiment) ? "sell" : "buy"
            );

            if (hasPositionToClose) {
                const profitCheck = this.checkTradeProfitability(
                    hasPositionToClose,
                    data.price,
                    MIN_PROFIT_PERCENT
                );
                
                if (profitCheck.canClose) {
                    this.totalTrades++;
                    const profit = (data.price - hasPositionToClose.price) * hasPositionToClose.solAmount;
                    if (profit > 0) this.winningTrades++;
                    else this.losingTrades++;
                    
                    this.totalSellVolume += hasPositionToClose.solAmount;
                    this.avgSellPrice = (this.avgSellPrice * (this.totalSellVolume - hasPositionToClose.solAmount) + 
                        data.price * hasPositionToClose.solAmount) / this.totalSellVolume;
                        
                    orderBook.closeTrade(hasPositionToClose.id, data.price);
                    continue;
                }
            }

            if (sentiment !== "NEUTRAL") {
                const isBuying = ["EXTREME_FEAR", "FEAR"].includes(sentiment);
                const balance = isBuying ? position.usdcBalance : position.solBalance;
                
                // Calculate trade size
                const tradeSize = balance * settings.SENTIMENT_MULTIPLIERS[sentiment];
                
                if (tradeSize > 0) {
                    const solChange = isBuying ? tradeSize / data.price : -tradeSize;
                    const usdcChange = isBuying ? -tradeSize : tradeSize * data.price;

                    // Record trade
                    const txId = `backtest-${Date.now()}-${Math.random()}`;
                    orderBook.addTrade(
                        data.price,
                        solChange,
                        usdcChange,
                        txId
                    );

                    // Update position
                    position.updateBalances(
                        position.solBalance + solChange,
                        position.usdcBalance + usdcChange
                    );
                    position.logTrade(sentiment, data.price, solChange, usdcChange);
                    
                    lastTradeTime = data.timestamp;
                }
            }

            // Update unrealized PnL
            orderBook.updateTradeUPNL(data.price);
        }

        // Calculate final results
        const finalStats = position.getEnhancedStatistics(
            this.historicalData[this.historicalData.length - 1].price
        );
        const orderBookStats = orderBook.getTradeStatistics();

        const result = {
            settings: { ...settings },
            finalStats,
            orderBookStats,
            initialBalance: this.initialBalance,
            performance: {
                totalTrades: this.totalTrades,
                winningTrades: this.winningTrades,
                losingTrades: this.losingTrades,
                winRate: (this.winningTrades / this.totalTrades) * 100,
                avgBuyPrice: this.avgBuyPrice,
                avgSellPrice: this.avgSellPrice,
                totalBuyVolume: this.totalBuyVolume,
                totalSellVolume: this.totalSellVolume,
                peakBalance: this.peakBalance,
                lowestBalance: this.lowestBalance,
                maxDrawdownPercent: this.maxDrawdownPercentage * 100,
                maxDrawdownDollars: this.maxDrawdownDollars
            },
            netPnL: parseFloat(finalStats.netChange),
            roi: parseFloat(finalStats.portfolioValue.percentageChange)
        };

        this.results.push(result);
        return result;
    }

    checkTradeProfitability(trade, currentPrice, minProfitPercent) {
        if (!trade) return { canClose: false, reason: 'No trade found' };
        
        const profitPercent = trade.direction === 'buy' ? 
            ((currentPrice - trade.price) / trade.price) * 100 :
            ((trade.price - currentPrice) / trade.price) * 100;
        
        if (profitPercent < minProfitPercent) {
            return {
                canClose: false,
                reason: `Profit (${profitPercent.toFixed(2)}%) below minimum threshold (${minProfitPercent}%)`
            };
        }
        
        return { canClose: true, reason: 'Trade meets closing criteria' };
    }

    async optimizeParameters(iterations = 1000) {
        console.log(`\nStarting parameter optimization...\n`);
        const startTime = Date.now();
        const results = [];
        let testedCombinations = 0;

        // Base settings template
        const baseSettings = this.currentSettings || {
            SENTIMENT_BOUNDARIES: {
                EXTREME_FEAR: 15,
                FEAR: 35,
                GREED: 65,
                EXTREME_GREED: 85
            },
            SENTIMENT_MULTIPLIERS: {
                EXTREME_FEAR: 0.04,
                FEAR: 0.02,
                GREED: 0.02,
                EXTREME_GREED: 0.04
            },
            TRADE_COOLDOWN_MINUTES: 30,
            MIN_PROFIT_PERCENT: 0.2,
            MIN_SENTIMENT_CHANGE: 5
        };

        for (let i = 0; i < iterations; i++) {
            const testSettings = {
                ...baseSettings,
                SENTIMENT_BOUNDARIES: {
                    EXTREME_FEAR: Math.floor(Math.random() * 21) + 10,
                    FEAR: Math.floor(Math.random() * 20) + 31,
                    GREED: Math.floor(Math.random() * 20) + 51,
                    EXTREME_GREED: Math.floor(Math.random() * 20) + 71
                },
                SENTIMENT_MULTIPLIERS: {
                    EXTREME_FEAR: (Math.floor(Math.random() * 100) + 1) * 0.001,
                    FEAR: (Math.floor(Math.random() * 50) + 1) * 0.001,
                    GREED: (Math.floor(Math.random() * 50) + 1) * 0.001,
                    EXTREME_GREED: (Math.floor(Math.random() * 100) + 1) * 0.001
                },
                MIN_PROFIT_PERCENT: (Math.floor(Math.random() * 10) + 1) * 0.2,
                TRADE_COOLDOWN_MINUTES: (Math.floor(Math.random() * 12) + 1) * 5
            };

            const result = await this.runBacktest(testSettings);
            results.push(result);
            
            testedCombinations++;
            if (testedCombinations % 10 === 0) {
                const elapsed = (Date.now() - startTime) / 1000;
                const progress = (testedCombinations / iterations) * 100;
                console.log(`Progress: ${progress.toFixed(1)}% (${testedCombinations}/${iterations}) - ${elapsed.toFixed(0)}s elapsed`);
            }
        }

        results.sort((a, b) => b.roi - a.roi);
        return results;
    }

    generateReport(outputPath) {
        if (this.results.length === 0) {
            throw new Error('No backtest results available');
        }

        const report = {
            timestamp: new Date().toISOString(),
            totalTestsRun: this.results.length,
            bestResult: this.results.reduce((best, current) => 
                current.roi > best.roi ? current : best
            ),
            worstResult: this.results.reduce((worst, current) => 
                current.roi < worst.roi ? current : worst
            ),
            allResults: this.results
        };

        fs.writeFileSync(
            outputPath,
            JSON.stringify(report, null, 2)
        );

        return report;
    }
}

module.exports = PulseSurferBacktest;