const fs = require('fs');
const path = require('path');
const { 
    getTimestamp, 
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
 * OrderBook class manages trading positions, calculates P&L, and handles trade lifecycle
 */
class OrderBook {
    constructor() {
        // Get token configurations
        this.baseToken = getBaseToken();
        this.quoteToken = getQuoteToken();
        
        // Initialise paths with token-specific filename
        this.storageFile = this.getOrderBookStoragePath();
        this.settingsPath = path.join(__dirname, '..', '..', 'user', 'settings.json');
        devLog('OrderBook storage file path:', this.storageFile);
        devLog(`Trading pair: ${this.baseToken.NAME}/${this.quoteToken.NAME}`);
        devLog(`Token decimals: ${this.baseToken.NAME}=${this.baseToken.DECIMALS}, ${this.quoteToken.NAME}=${this.quoteToken.DECIMALS}`);
        
        // Initialise state
        this.trades = [];
        this.cachedSettings = null;
        this.lastSettingsRead = 0;
        
        // Load and validate trade data
        this.loadTrades();
        this.cleanupTrades();
    }

    /**
     * Gets the path to the orderbook storage file based on current tokens
     * @returns {string} Path to orderbook storage file
     */
    getOrderBookStoragePath() {
        const baseTokenLower = this.baseToken.NAME.toLowerCase();
        const quoteTokenLower = this.quoteToken.NAME.toLowerCase();
        const orderBooksDir = path.join(__dirname, '..', '..', 'user', 'orderbooks');
        
        // Create the directory if it doesn't exist
        if (!fs.existsSync(orderBooksDir)) {
            fs.mkdirSync(orderBooksDir, { recursive: true });
        }
        
        // Get current timeframe from settings
        const settings = this.readSettings();
        const timeframe = settings.FGI_TIMEFRAME || "15m";
        
        return path.join(orderBooksDir, `${baseTokenLower}_${quoteTokenLower}_${timeframe}_orderBookStorage.json`);
    }

    /**
     * Updates the storage file path when tokens change
     * @returns {boolean} Success status
     */
    updateStoragePathForTokens() {
        // Get updated token configurations
        this.baseToken = getBaseToken();
        this.quoteToken = getQuoteToken();
        
        // Update storage file path
        const oldStoragePath = this.storageFile;
        this.storageFile = this.getOrderBookStoragePath();
        
        // Ensure directory exists
        const dir = path.dirname(this.storageFile);
        if (!fs.existsSync(dir)) {
          fs.mkdirSync(dir, { recursive: true });
        }
        
        devLog(`OrderBook storage path updated: ${oldStoragePath} -> ${this.storageFile}`);
        
        // Reload trades from new file
        this.loadTrades();
        
        return true;
      }

    /**
     * Reads and caches settings from settings.json
     * @returns {Object} Application settings
     */
    readSettings() {
        const SETTINGS_CACHE_TTL = 30000; // 30 seconds cache
        const currentTime = Date.now();
        
        // Return cached settings if still valid
        if (this.cachedSettings && (currentTime - this.lastSettingsRead) < SETTINGS_CACHE_TTL) {
            return this.cachedSettings;
        }
        
        try {
            if (!fs.existsSync(this.settingsPath)) {
                devLog('Settings file not found, using defaults');
                this.cachedSettings = { MIN_PROFIT_PERCENT: 0.2 };
                this.lastSettingsRead = currentTime;
                return this.cachedSettings;
            }
            
            const settingsData = fs.readFileSync(this.settingsPath, 'utf8');
            this.cachedSettings = JSON.parse(settingsData);
            this.lastSettingsRead = currentTime;
            
            // Ensure MIN_PROFIT_PERCENT exists
            if (typeof this.cachedSettings.MIN_PROFIT_PERCENT !== 'number') {
                devLog('MIN_PROFIT_PERCENT not found in settings, using default');
                this.cachedSettings.MIN_PROFIT_PERCENT = 0.2;
            }
            
            return this.cachedSettings;
        } catch (error) {
            console.error(formatError(`Error reading settings.json: ${error.message}`));
            this.cachedSettings = { MIN_PROFIT_PERCENT: 0.2 };
            this.lastSettingsRead = currentTime;
            return this.cachedSettings;
        }
    }

    /**
     * Loads trade data from storage file
     */
    loadTrades() {
        try {
            // Get the storage path for current tokens
            const storageFile = this.getOrderBookStoragePath();
            
            // Check for token-specific storage file
            if (!fs.existsSync(storageFile)) {
                // Check for legacy storage file
                const legacyStorageFile = path.join(__dirname, '..', '..', 'user', `${this.baseToken.NAME.toLowerCase()}_${this.quoteToken.NAME.toLowerCase()}_orderBookStorage.json`);
                
                if (fs.existsSync(legacyStorageFile)) {
                    // Legacy token-specific file exists in the old location
                    devLog(`Found legacy token-specific orderbook at ${legacyStorageFile}, migrating...`);
                    
                    try {
                        const legacyData = fs.readFileSync(legacyStorageFile, 'utf8');
                        fs.writeFileSync(storageFile, legacyData);
                        devLog(`Migrated orderbook to new location: ${storageFile}`);
                    } catch (migrationError) {
                        console.error(formatError(`Error migrating legacy orderbook: ${migrationError.message}`));
                    }
                } else {
                    // Check for super-legacy file (no token in filename)
                    const superLegacyFile = path.join(__dirname, '..', '..', 'user', 'orderBookStorage.json');
                    
                    if (fs.existsSync(superLegacyFile)) {
                        devLog(`Found super-legacy orderbook at ${superLegacyFile}, checking compatibility...`);
                        
                        try {
                            const legacyData = fs.readFileSync(superLegacyFile, 'utf8');
                            const legacyOrderBook = JSON.parse(legacyData);
                            
                            // Check if tokenInfo matches current tokens
                            if (legacyOrderBook.trades && legacyOrderBook.trades.length > 0 && 
                                legacyOrderBook.trades[0].tokenInfo &&
                                legacyOrderBook.trades[0].tokenInfo.baseToken === this.baseToken.NAME &&
                                legacyOrderBook.trades[0].tokenInfo.quoteToken === this.quoteToken.NAME) {
                                
                                devLog('Super-legacy orderbook is compatible with current tokens, migrating...');
                                fs.writeFileSync(storageFile, legacyData);
                                devLog(`Migrated orderbook to new location: ${storageFile}`);
                            } else {
                                devLog('Super-legacy orderbook has different tokens, starting fresh');
                                this.trades = [];
                                this.saveTrades();
                                return;
                            }
                        } catch (legacyError) {
                            console.error(formatError(`Error processing super-legacy orderbook: ${legacyError.message}`));
                            this.trades = [];
                            this.saveTrades();
                            return;
                        }
                    } else {
                        devLog('No existing trade data found, starting fresh');
                        this.trades = [];
                        this.saveTrades(); // Create the file with valid structure
                        return;
                    }
                }
            }
            
            // Continue with normal loading
            const data = fs.readFileSync(storageFile, 'utf8');
            
            // Handle empty file case
            if (!data || data.trim() === '') {
                devLog('OrderBook storage file is empty, initialising with empty trades array');
                this.trades = [];
                this.saveTrades();
                return;
            }

            try {
                const savedData = JSON.parse(data);
                
                // Validate the loaded data
                if (!Array.isArray(savedData.trades)) {
                    throw new Error('Invalid trade data format');
                }
                
                this.trades = savedData.trades.map(trade => this.validateTradeObject(trade));
                devLog(`Loaded ${this.trades.length} trades from storage: ${storageFile}`);
            } catch (parseError) {
                console.error(formatError(`Error parsing trades JSON: ${parseError.message}`));
                this.trades = [];
                this.saveTrades(); // Save valid structure
            }
        } catch (error) {
            console.error(formatError(`Error loading trades: ${error.message}`));
            this.trades = [];
            this.saveTrades(); // Ensure we have a valid file
        }
    }

    /**
     * Validates and normalizes a trade object
     * @param {Object} trade - Trade object to validate
     * @returns {Object} Validated trade object
     */
    validateTradeObject(trade) {
        // Check for legacy trades without token information
        if (trade && !trade.tokenInfo) {
            trade.tokenInfo = {
                baseToken: this.baseToken.NAME,
                quoteToken: this.quoteToken.NAME,
                baseTokenDecimals: this.baseToken.DECIMALS,
                quoteTokenDecimals: this.quoteToken.DECIMALS
            };
        }
        
        // For backward compatibility with existing data
        const baseTokenAmount = trade.baseTokenAmount 
        const quoteTokenValue = trade.quoteTokenValue
        
        return {
            id: trade.id || `trade-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
            timestamp: trade.timestamp || getTimestamp(),
            price: typeof trade.price === 'number' ? trade.price : 0,
            baseTokenAmount: typeof baseTokenAmount === 'number' ? Math.abs(baseTokenAmount) : 0,
            quoteTokenValue: typeof quoteTokenValue === 'number' ? Math.abs(quoteTokenValue) : 0,
            direction: ['buy', 'sell'].includes(trade.direction) ? trade.direction : 'buy',
            status: ['open', 'closed'].includes(trade.status) ? trade.status : 'open',
            upnl: typeof trade.upnl === 'number' ? trade.upnl : 0,
            closedAt: trade.closedAt || null,
            closePrice: trade.closePrice || null,
            realizedPnl: trade.realizedPnl || 0,
            tokenInfo: trade.tokenInfo || {
                baseToken: this.baseToken.NAME,
                quoteToken: this.quoteToken.NAME,
                baseTokenDecimals: this.baseToken.DECIMALS,
                quoteTokenDecimals: this.quoteToken.DECIMALS
            }
        };
    }

    /**
     * Saves trades to storage file
     * @returns {boolean} Success status
     */
    saveTrades() {
        try {
            const dataToSave = {
                lastUpdated: getTimestamp(),
                trades: Array.isArray(this.trades) ? this.trades : []
            };
            
            // Get the storage file path for current tokens
            const storageFile = this.getOrderBookStoragePath();
            
            // Ensure directory exists (path.dirname gets the directory portion of a path)
            const dir = path.dirname(storageFile);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            
            // Write with valid JSON structure
            fs.writeFileSync(storageFile, JSON.stringify(dataToSave, null, 2));
            devLog(`Saved ${this.trades.length} trades to storage: ${storageFile}`);
            return true;
        } catch (error) {
            console.error(formatError(`Error saving trades: ${error.message}`));
            console.error('Full error details:', {
                message: error.message,
                stack: error.stack
            });
            return false;
        }
    }

    /**
     * Returns current orderbook state
     * @returns {Object} Current state
     */
    getState() {
        return {
            trades: this.trades,
            lastUpdated: getTimestamp(),
            tokenInfo: {
                baseToken: this.baseToken,
                quoteToken: this.quoteToken
            }
        };
    }

    /**
     * Loads orderbook state from provided data
     * @param {Object} state - State to load
     */
    loadState(state) {
        if (state && Array.isArray(state.trades)) {
            this.trades = state.trades.map(trade => this.validateTradeObject(trade));
            devLog(`Loaded ${this.trades.length} trades from state`);
            this.saveTrades();
        }
    }

    /**
     * Adds a new trade to the orderbook
     * @param {number} price - Trade price
     * @param {number} baseTokenChange - Base token amount change
     * @param {number} quoteTokenChange - Quote token amount change
     * @param {string} txId - Transaction ID
     * @returns {Object} Added trade object
     */
    addTrade(price, baseTokenChange, quoteTokenChange, txId) {
        // Input validation
        if (!txId || typeof txId !== 'string') {
            console.error(formatError(`${icons.error} Invalid transaction ID`));
            return null;
        }
        
        if (typeof price !== 'number' || isNaN(price) || price <= 0) {
            console.error(formatError(`${icons.error} Invalid price: ${price}`));
            return null;
        }
        
        if (typeof baseTokenChange !== 'number' || baseTokenChange === 0) {
            console.error(formatError(`${icons.error} Invalid ${this.baseToken.NAME} change: ${baseTokenChange}`));
            return null;
        }
        
        if (typeof quoteTokenChange !== 'number') {
            console.error(formatError(`${icons.error} Invalid ${this.quoteToken.NAME} change: ${quoteTokenChange}`));
            return null;
        }
        
        // Check if trade with this ID already exists
        const existingTrade = this.trades.find(t => t.id === txId);
        if (existingTrade) {
            devLog('Trade with this ID already exists:', txId);
            return existingTrade;
        }
    
        const direction = baseTokenChange > 0 ? 'buy' : 'sell';
        const quoteTokenValue = Math.abs(quoteTokenChange);
        
        devLog('Adding new trade:', {
            txId,
            price,
            baseTokenChange,
            quoteTokenChange,
            direction,
            quoteTokenValue,
            baseToken: this.baseToken.NAME,
            quoteToken: this.quoteToken.NAME
        });
        
        const trade = this.validateTradeObject({
            id: txId,
            timestamp: getTimestamp(),
            price,
            baseTokenAmount: Math.abs(baseTokenChange),
            quoteTokenValue,
            direction,
            status: 'open',
            upnl: 0,
            tokenInfo: {
                baseToken: this.baseToken.NAME,
                quoteToken: this.quoteToken.NAME,
                baseTokenDecimals: this.baseToken.DECIMALS,
                quoteTokenDecimals: this.quoteToken.DECIMALS
            }
        });
    
        this.trades.push(trade);
        this.saveTrades();
        return trade;
    }

    /**
     * Removes duplicate trades and ensures data integrity
     */
    cleanupTrades() {
        // Keep track of original count for logging
        const originalCount = this.trades.length;
        
        // Use Map for more efficient lookup than object
        const uniqueTrades = new Map();
        
        // Process each trade, keeping only the latest version by ID
        this.trades.forEach(trade => {
            if (!trade.id) return; // Skip invalid trades
            
            const existingTrade = uniqueTrades.get(trade.id);
            if (!existingTrade || new Date(trade.timestamp) > new Date(existingTrade.timestamp)) {
                uniqueTrades.set(trade.id, trade);
            }
        });
        
        // Convert Map back to array
        this.trades = Array.from(uniqueTrades.values());
        
        // Validate all trades
        this.trades = this.trades.map(trade => this.validateTradeObject(trade));
        
        // Log results if changes were made
        if (originalCount !== this.trades.length) {
            devLog(`Cleaned up trades: ${originalCount} → ${this.trades.length}`);
            this.saveTrades();
        }
    }

    /**
     * Updates unrealized profit/loss for all open trades
     * @param {number} currentPrice - Current market price
     */
    updateTradeUPNL(currentPrice) {
        if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
            console.error(formatError(`${icons.error} Invalid current price for UPNL update: ${currentPrice}`));
            return;
        }
        
        let updated = false;
        
        this.trades.forEach(trade => {
            if (trade.status !== 'open') return;
            
            const oldUpnl = trade.upnl;
            
            if (trade.direction === 'buy') {
                // For buy positions, calculate P&L based on price difference
                trade.upnl = (currentPrice - trade.price) * trade.baseTokenAmount;
            } else {
                // For sell positions, only show potential profit, not losses
                const potentialProfit = (trade.price - currentPrice) * trade.baseTokenAmount;
                trade.upnl = potentialProfit > 0 ? potentialProfit : 0;
            }
            
            // Track if any values changed
            if (oldUpnl !== trade.upnl) {
                updated = true;
            }
        });
        
        // Only save if something changed
        if (updated) {
            this.saveTrades();
        }
    }

    /**
     * Gets all open trades
     * @returns {Array} Open trades
     */
    getOpenTrades() {
        return this.trades.filter(trade => trade.status === 'open');
    }

    /**
     * Calculates the net position across all open trades
     * @returns {Object} Net position
     */
    getOpenPosition() {
        const position = { baseTokenAmount: 0, quoteTokenValue: 0 };
        
        for (const trade of this.trades) {
            if (trade.status !== 'open') continue;
            
            // Add or subtract based on direction
            const baseTokenSign = trade.direction === 'buy' ? 1 : -1;
            const quoteTokenSign = trade.direction === 'buy' ? 1 : -1;
            
            position.baseTokenAmount += baseTokenSign * trade.baseTokenAmount;
            position.quoteTokenValue += quoteTokenSign * trade.quoteTokenValue;
        }
        
        return position;
    }

    /**
     * Calculates profit percentage for a trade
     * @param {Object} trade - Trade object
     * @param {number} currentPrice - Current market price
     * @returns {number} Profit percentage
     */
    calculateProfitPercentage(trade, currentPrice) {
        if (trade.direction === 'buy') {
            return ((currentPrice - trade.price) / trade.price) * 100;
        } else {
            return ((trade.price - currentPrice) / trade.price) * 100;
        }
    }

    /**
     * Finds the oldest trade that meets profitability criteria
     * @param {string} direction - Trade direction ('buy' or 'sell')
     * @param {number} currentPrice - Current market price
     * @returns {Object|null} Profitable trade or null
     */
    findOldestMatchingTrade(direction, currentPrice) {
        if (!['buy', 'sell'].includes(direction)) {
            console.error(formatError(`${icons.error} Invalid direction: ${direction}`));
            return null;
        }
        
        if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
            console.error(formatError(`${icons.error} Invalid current price: ${currentPrice}`));
            return null;
        }
        
        // Get minimum profit threshold from settings
        const minProfitPercent = this.readSettings().MIN_PROFIT_PERCENT;
        
        // Sort all open trades of matching direction by timestamp (oldest first)
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
            // Calculate profit percentage
            const profitPercent = this.calculateProfitPercentage(trade, currentPrice);

            devLog(`Checking trade from ${trade.timestamp}:
                Direction: ${trade.direction}
                Entry Price: ${formatPrice(trade.price)}
                Current Price: ${formatPrice(currentPrice)}
                Profit: ${formatPercentage(profitPercent)}
                Min Required: ${formatPercentage(minProfitPercent)}
                Token: ${trade.tokenInfo?.baseToken || this.baseToken.NAME}`);

            if (profitPercent >= minProfitPercent) {
                devLog(`Found profitable trade to close:
                    Trade ID: ${trade.id}
                    Profit: ${formatPercentage(profitPercent)}
                    Amount: ${formatBalance(trade.baseTokenAmount, trade.tokenInfo?.baseToken || this.baseToken.NAME)}
                    Value: ${formatPrice(trade.quoteTokenValue)}`);
                return trade;
            }
        }
        
        devLog(`No profitable trades found matching ${direction} direction`);
        return null;
    }

    /**
     * Checks if a specific trade meets profitability criteria
     * @param {string} tradeId - Trade ID
     * @param {number} currentPrice - Current market price
     * @returns {Object} Profitability check result
     */
    checkTradeProfitability(tradeId, currentPrice) {
        if (!tradeId) {
            return { canClose: false, reason: 'Invalid trade ID' };
        }
        
        if (typeof currentPrice !== 'number' || isNaN(currentPrice) || currentPrice <= 0) {
            return { canClose: false, reason: 'Invalid current price' };
        }
        
        const settings = this.readSettings();
        const trade = this.trades.find(t => t.id === tradeId);
        
        if (!trade) {
            return { canClose: false, reason: 'Trade not found' };
        }
        
        if (trade.status !== 'open') {
            return { canClose: false, reason: 'Trade is already closed' };
        }
    
        // Calculate profit percentage
        const profitPercent = this.calculateProfitPercentage(trade, currentPrice);
    
        // Check minimum profit threshold
        if (profitPercent < settings.MIN_PROFIT_PERCENT) {
            return {
                canClose: false,
                reason: `Profit (${formatPercentage(profitPercent)}) below minimum threshold (${formatPercentage(settings.MIN_PROFIT_PERCENT)})`
            };
        }
    
        return { 
            canClose: true, 
            reason: 'Trade meets closing criteria',
            profitPercent: profitPercent.toFixed(2),
            estimatedPnl: ((trade.direction === 'buy' ? 
                (currentPrice - trade.price) : 
                (trade.price - currentPrice)) * trade.baseTokenAmount).toFixed(2)
        };
    }

    /**
     * Closes a trade at specified price
     * @param {string} tradeId - Trade ID
     * @param {number} closePrice - Closing price
     * @returns {boolean} Success status
     */
    closeTrade(tradeId, closePrice) {
        if (!tradeId) {
            console.error(formatError(`${icons.error} Invalid trade ID`));
            return false;
        }
        
        if (typeof closePrice !== 'number' || isNaN(closePrice) || closePrice <= 0) {
            console.error(formatError(`${icons.error} Invalid close price: ${closePrice}`));
            return false;
        }
        
        const trade = this.trades.find(t => t.id === tradeId);
            
        if (!trade) {
            console.error(formatError(`${icons.error} Trade ${tradeId} not found`));
            return false;
        }
        
        if (trade.status !== 'open') {
            console.error(formatError(`${icons.error} Trade ${tradeId} is already closed`));
            return false;
        }
    
        // Calculate realized PnL
        const realizedPnl = trade.direction === 'buy' ? 
            (closePrice - trade.price) * trade.baseTokenAmount :
            (trade.price - closePrice) * trade.baseTokenAmount;
    
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
    
        devLog(`Closed trade ${tradeId} at ${formatPrice(closePrice)} with P&L: ${formatTokenChange(realizedPnl, '$')}`);
        this.saveTrades();
        return true;
    }

    /**
     * Calculates performance statistics for all trades
     * @returns {Object} Trade statistics
     */
    getTradeStatistics() {
        // Use array methods for clean calculations
        const openTrades = this.trades.filter(trade => trade.status === 'open');
        const closedTrades = this.trades.filter(trade => trade.status === 'closed');
        const winningTrades = closedTrades.filter(trade => trade.realizedPnl > 0);
        
        // Calculate volume and P&L
        const totalVolume = this.trades.reduce((acc, trade) => acc + trade.quoteTokenValue, 0);
        const totalRealizedPnl = closedTrades.reduce((acc, trade) => acc + (trade.realizedPnl || 0), 0);
        const totalUnrealizedPnl = openTrades.reduce((acc, trade) => acc + (trade.upnl || 0), 0);
        
        // Calculate additional metrics
        const avgTradeSize = this.trades.length > 0 ? totalVolume / this.trades.length : 0;
        const winRate = closedTrades.length > 0 ? (winningTrades.length / closedTrades.length * 100) : 0;
        const avgProfitPerWinningTrade = winningTrades.length > 0 ? 
            winningTrades.reduce((acc, trade) => acc + trade.realizedPnl, 0) / winningTrades.length : 0;
        
        // Return complete statistics with token information
        return {
            totalTrades: this.trades.length,
            openTrades: openTrades.length,
            closedTrades: closedTrades.length,
            winningTrades: winningTrades.length,
            winRate: winRate,
            totalVolume: totalVolume,
            totalRealizedPnl: totalRealizedPnl,
            totalUnrealizedPnl: totalUnrealizedPnl,
            avgTradeSize: avgTradeSize,
            avgProfitPerWinningTrade: avgProfitPerWinningTrade,
            lastUpdated: getTimestamp(),
            tokenInfo: {
                baseToken: this.baseToken.NAME,
                quoteToken: this.quoteToken.NAME,
                baseTokenDecimals: this.baseToken.DECIMALS,
                quoteTokenDecimals: this.quoteToken.DECIMALS
            }
        };
    }
}

module.exports = OrderBook;