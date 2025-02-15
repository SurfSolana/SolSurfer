const fs = require('fs');
const path = require('path');
const { getTimestamp, devLog } = require('./utils');

class OrderBook {
    constructor() {
        this.trades = [];
        this.storageFile = path.join(__dirname, '..', '..', 'user', 'orderBookStorage.json');
        this.settingsPath = path.join(__dirname, '..', '..', 'user', 'settings.json');
        devLog('OrderBook storage file path:', this.storageFile);
        this.loadTrades();
        this.cleanupTrades();

        if (!Array.isArray(this.trades)) {
            console.warn('Trades not properly initialized, resetting to empty array');
            this.trades = [];
            this.saveTrades();
        }
    }

    readSettings() {
        try {
            const settingsData = fs.readFileSync(this.settingsPath, 'utf8');
            return JSON.parse(settingsData);
        } catch (error) {
            console.error('Error reading settings.json:', error);
            return {
                MIN_PROFIT_PERCENT: 0.2
            };
        }
    }

    loadTrades() {
        try {
            if (fs.existsSync(this.storageFile)) {
                const data = fs.readFileSync(this.storageFile, 'utf8');
                
                // Handle empty file case
                if (!data || data.trim() === '') {
                    console.log('OrderBook storage file is empty, initializing with empty trades array');
                    this.trades = [];
                    // Initialize the file with a valid JSON structure
                    this.saveTrades();
                    return;
                }
    
                try {
                    const savedData = JSON.parse(data);
                    
                    // Validate the loaded data
                    if (Array.isArray(savedData.trades)) {
                        this.trades = savedData.trades.map(trade => ({
                            ...trade,
                            timestamp: trade.timestamp || getTimestamp(),
                            upnl: trade.upnl || 0
                        }));
                        devLog(`Loaded ${this.trades.length} trades from storage`);
                    } else {
                        devLog('Invalid trade data format. Initializing empty trades array');
                        this.trades = [];
                        this.saveTrades(); // Save valid structure
                    }
                } catch (parseError) {
                    console.error('Error parsing trades JSON, initializing empty trades array:', parseError);
                    this.trades = [];
                    this.saveTrades(); // Save valid structure
                }
            } else {
                devLog('No existing trade data found, starting fresh');
                this.trades = [];
                this.saveTrades(); // Create the file with valid structure
            }
        } catch (error) {
            console.error('Error loading trades:', error);
            this.trades = [];
            this.saveTrades(); // Ensure we have a valid file
        }
    }

    saveTrades() {
        try {
            const dataToSave = {
                lastUpdated: getTimestamp(),
                trades: this.trades || [] // Ensure we always have an array
            };
            devLog('Attempting to save trades:', dataToSave);
            
            // Ensure directory exists
            const dir = path.dirname(this.storageFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            // Write with valid JSON structure
            fs.writeFileSync(this.storageFile, JSON.stringify(dataToSave, null, 2));
            devLog('Trades saved successfully to:', this.storageFile);
        } catch (error) {
            console.error('Error saving trades:', error);
            console.error('Full error details:', {
                message: error.message,
                stack: error.stack,
                storageFile: this.storageFile
            });
        }
    }

    getState() {
        return {
            trades: this.trades,
            lastUpdated: getTimestamp()
        };
    }

    loadState(state) {
        if (state && Array.isArray(state.trades)) {
            this.trades = state.trades;
            devLog(`Loaded ${this.trades.length} trades from state`);
        }
    }

    addTrade(price, solChange, usdcChange, txId) {
        // Check if trade with this ID already exists
        const existingTrade = this.trades.find(t => t.id === txId);
        if (existingTrade) {
            devLog('Trade with this ID already exists:', txId);
            return existingTrade;
        }
    
        const direction = solChange > 0 ? 'buy' : 'sell';
        const value = Math.abs(usdcChange);
        
        devLog('Adding new trade:', {
            txId,
            price,
            solChange,
            usdcChange,
            direction,
            value
        });
        
        const trade = {
            id: txId,
            timestamp: getTimestamp(),
            price,
            solAmount: Math.abs(solChange),
            value,
            direction,
            status: 'open',
            upnl: 0
        };
    
        this.trades.push(trade);
        devLog('Current trades array:', this.trades);
        this.saveTrades();
        return trade;
    }

    cleanupTrades() {
        // Remove duplicates keeping the latest version of each trade
        const uniqueTrades = {};
        this.trades.forEach(trade => {
            uniqueTrades[trade.id] = trade;
        });
        this.trades = Object.values(uniqueTrades);
        this.saveTrades();
    }

    updateTradeUPNL(currentPrice) {
        this.trades.forEach(trade => {
            if (trade.status === 'open') {
                if (trade.direction === 'buy') {
                    trade.upnl = (currentPrice - trade.price) * trade.solAmount;
                } else {
                    trade.upnl = (trade.price - currentPrice) * trade.solAmount;
                }
            }
        });
        this.saveTrades();
    }

    getOpenTrades() {
        return this.trades.filter(trade => trade.status === 'open');
    }

    getOpenPosition() {
        return this.trades.reduce((position, trade) => {
            if (trade.status === 'open') {
                position.solAmount += trade.direction === 'buy' ? trade.solAmount : -trade.solAmount;
                position.value += trade.direction === 'buy' ? trade.value : -trade.value;
            }
            return position;
        }, { solAmount: 0, value: 0 });
    }

    findOldestMatchingTrade(direction, currentPrice) {
        // Sort all open trades of matching direction by timestamp
        const openTrades = this.trades
            .filter(trade => trade.status === 'open' && trade.direction === direction)
            .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            
        devLog(`Finding ${direction} trades to close, checking ${openTrades.length} trades`);
        
        if (openTrades.length === 0) {
            devLog('No open trades found matching direction:', direction);
            return null;
        }

        // Check each trade in chronological order for profitability
        for (const trade of openTrades) {
            // Calculate actual profit percentage based on current market price
            const profitPercent = trade.direction === 'buy' ? 
                ((currentPrice - trade.price) / trade.price) * 100 :
                ((trade.price - currentPrice) / trade.price) * 100;

            devLog(`Checking trade from ${trade.timestamp}:
                Direction: ${trade.direction}
                Entry Price: $${trade.price}
                Current Price: $${currentPrice}
                Profit: ${profitPercent.toFixed(2)}%
                Min Required: ${this.readSettings().MIN_PROFIT_PERCENT}%`);

            if (profitPercent >= this.readSettings().MIN_PROFIT_PERCENT) {
                devLog(`Found profitable trade to close:
                    Trade ID: ${trade.id}
                    Profit: ${profitPercent.toFixed(2)}%
                    Amount: ${trade.solAmount} SOL
                    Value: $${trade.value}`);
                return trade;
            } else {
                devLog(`Trade ${trade.id} not profitable enough: ${profitPercent.toFixed(2)}% < ${this.readSettings().MIN_PROFIT_PERCENT}%`);
            }
        }
        
        devLog(`No profitable trades found matching ${direction} direction`);
        return null;
    }

    checkTradeProfitability(tradeId, currentPrice) {
        const settings = this.readSettings();
        const trade = this.trades.find(t => t.id === tradeId);
        
        if (!trade) {
            return { canClose: false, reason: 'Trade not found' };
        }
    
        // Calculate profit percentage
        const profitPercent = trade.direction === 'buy' ? 
            ((currentPrice - trade.price) / trade.price) * 100 :
            ((trade.price - currentPrice) / trade.price) * 100;
    
        // Check minimum profit threshold
        if (profitPercent < settings.MIN_PROFIT_PERCENT) {
            return {
                canClose: false,
                reason: `Profit (${profitPercent.toFixed(2)}%) below minimum threshold (${settings.MIN_PROFIT_PERCENT}%)`
            };
        }
    
        return { canClose: true, reason: 'Trade meets closing criteria' };
    }

    closeTrade(tradeId, closePrice) {
        const trade = this.trades.find(t => t.id === tradeId);
            
        if (!trade) {
            console.error(`Trade ${tradeId} not found`);
            return false;
        }
    
        // Calculate realized PnL
        const realizedPnl = trade.direction === 'buy' ? 
            (closePrice - trade.price) * trade.solAmount :
            (trade.price - closePrice) * trade.solAmount;
    
        // Update the trade
        this.trades = this.trades.map(t => {
            if (t.id === tradeId) {
                return {
                    ...t,
                    status: 'closed',
                    closedAt: getTimestamp(),
                    closePrice: closePrice,
                    realizedPnl: realizedPnl,
                    upnl: 0
                };
            }
            return t;
        });
    
        this.saveTrades();
        return true;
    }

    getTradeStatistics() {
        const openTrades = this.trades.filter(trade => trade.status === 'open');
        const closedTrades = this.trades.filter(trade => trade.status === 'closed');
        const winningTrades = closedTrades.filter(trade => trade.realizedPnl > 0);
        
        const totalVolume = this.trades.reduce((acc, trade) => acc + trade.value, 0);
        const totalRealizedPnl = closedTrades.reduce((acc, trade) => acc + (trade.realizedPnl || 0), 0);
        const totalUnrealizedPnl = openTrades.reduce((acc, trade) => acc + (trade.upnl || 0), 0);
    
        return {
            totalTrades: this.trades.length,
            openTrades: openTrades.length,
            closedTrades: closedTrades.length,
            winningTrades: winningTrades.length,
            winRate: closedTrades.length > 0 ? (winningTrades.length / closedTrades.length * 100) : 0,
            totalVolume: totalVolume,
            totalRealizedPnl: totalRealizedPnl,
            totalUnrealizedPnl: totalUnrealizedPnl,
            avgTradeSize: this.trades.length > 0 ? totalVolume / this.trades.length : 0
        };
    }
}

module.exports = OrderBook;