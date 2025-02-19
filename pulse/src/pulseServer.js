const express = require('express');
const https = require('https');
const http = require('http');
const socketIo = require('socket.io');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require("express-rate-limit");
const dotenv = require('dotenv');
const cors = require('cors');
const session = require('express-session');
const axios = require('axios');
const readline = require('readline');
const { getVersion, devLog } = require('./utils');
const { getWallet, getConnection } = require('./globalState');
const { PublicKey } = require('@solana/web3.js');
const OrderBook = require('./orderBook');

let orderBook = new OrderBook();

// Settings functionality
const SETTINGS_ORDER = [
  "VERSION",
  "SENTIMENT_BOUNDARIES",
  "SENTIMENT_MULTIPLIERS",
  "MIN_PROFIT_PERCENT",
  "TRADE_COOLDOWN_MINUTES",
  "TRADE_SIZE_METHOD",
  "STRATEGIC_PERCENTAGE",
  "USER_MONTHLY_COST",
  "DEVELOPER_TIP_PERCENTAGE",
  "MONITOR_MODE"
];

const NESTED_ORDERS = {
  "SENTIMENT_BOUNDARIES": ["EXTREME_FEAR", "FEAR", "GREED", "EXTREME_GREED"],
  "SENTIMENT_MULTIPLIERS": ["EXTREME_FEAR", "FEAR", "GREED", "EXTREME_GREED"]
};

const SETTINGS_PATH = path.join(__dirname, '..', '..', 'user', 'settings.json');
const STATE_FILE_PATH = path.join(__dirname, '..', '..', 'user', 'saveState.json');

// Function to check and create necessary files
function ensureRequiredFiles() {
  const envPath = path.join(__dirname, '..', '..', 'user', '.env');
  const settingsPath = path.join(__dirname, '..', '..', 'user', 'settings.json');
  let filesCreated = false;

  if (!fs.existsSync(envPath)) {
    const defaultEnvContent = `
    PRIMARY_RPC=
    SECONDARY_RPC=        # Optional: Recommended for improved reliability
    PRIVATE_KEY=
    ADMIN_PASSWORD=
    PORT=3000
    `;
    fs.writeFileSync(envPath, defaultEnvContent.trim());
    devLog('.env file created. Please fill in the required values before running the application again.');
    filesCreated = true;
  }

  const currentVersion = getVersion();
  const DEFAULT_SETTINGS = orderSettings({
    VERSION: currentVersion,
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
    MIN_PROFIT_PERCENT: 0.2,
    TRADE_COOLDOWN_MINUTES: 30,
    TRADE_SIZE_METHOD: "STRATEGIC",
    STRATEGIC_PERCENTAGE: 2.5,
    USER_MONTHLY_COST: 0,
    DEVELOPER_TIP_PERCENTAGE: 0,
    MONITOR_MODE: false,
  });

  if (!fs.existsSync(settingsPath)) {
    fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2));
    devLog('settings.json file created with default values.');
    filesCreated = true;
  } else {
    // Settings file exists - check version and settings
    const settings = readSettings();
    if (!settings) {
      console.error('Error reading settings.json. Creating new file.');
      fs.writeFileSync(settingsPath, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      filesCreated = true;
    } else {
      // Always check for missing settings, regardless of version
      const missingSettings = checkMissingSettings(settings, DEFAULT_SETTINGS);
      
      if (Object.keys(missingSettings).length > 0 || settings.VERSION !== currentVersion) {
        // We found missing settings or version changed - ask user what to do
        return handleVersionUpgrade(settings, missingSettings, DEFAULT_SETTINGS, currentVersion, settingsPath);
      }
    }
  }

  if (filesCreated) {
    console.log('New configuration files have been created. Please review and update them as necessary before running the application again.');
    return false;
  }

  return true;
}

function deepMerge(target, source) {
  const output = {...target};
  
  for (const key in source) {
    if (
      typeof source[key] === 'object' && 
      source[key] !== null &&
      !Array.isArray(source[key]) &&
      typeof output[key] === 'object' &&
      output[key] !== null
    ) {
      output[key] = deepMerge(output[key], source[key]);
    } else {
      output[key] = source[key];
    }
  }
  
  return output;
}

function checkMissingSettings(current, defaults) {
  const missing = {};
  
  for (const key in defaults) {
    // Skip VERSION key
    if (key === 'VERSION') continue;
    
    if (!(key in current)) {
      // Setting is completely missing
      missing[key] = defaults[key];
    } else if (
      typeof defaults[key] === 'object' && 
      defaults[key] !== null && 
      typeof current[key] === 'object' && 
      current[key] !== null &&
      !Array.isArray(defaults[key])
    ) {
      // Recursively check nested objects
      const nestedMissing = checkMissingSettings(current[key], defaults[key]);
      if (Object.keys(nestedMissing).length > 0) {
        missing[key] = nestedMissing;
      }
    }
  }
  
  return missing;
}

function handleVersionUpgrade(settings, missingSettings, defaultSettings, currentVersion, settingsPath) {
  return new Promise((resolve) => {
    console.log(`\nSettings file was created with v${settings.VERSION || 'unknown'} and current version is v${currentVersion}`);
    console.log(`\n(Settings.json file path: ${settingsPath})`);
    if (Object.keys(missingSettings).length > 0) {
      console.log('\nThe following settings are missing in your configuration:');
      
      // Format and display missing settings names only
      const missingKeys = Object.keys(missingSettings);
      missingKeys.forEach(key => {
        if (typeof missingSettings[key] === 'object' && !Array.isArray(missingSettings[key])) {
          // For nested objects like SENTIMENT_BOUNDARIES
          const nestedKeys = Object.keys(missingSettings[key]);
          console.log(`  - ${key}`);
          nestedKeys.forEach(nestedKey => {
            console.log(`    * ${nestedKey}`);
          });
        } else {
          // For simple values
          console.log(`  - ${key}`);
        }
      });
    } else {
      console.log('\nNo settings are missing, but version has changed.');
    }
    
    console.log('\nOptions:');
    console.log('1. Create new settings file (delete current settings)');
    console.log('2. Insert missing settings (keep existing settings)');
    
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    rl.question('\nEnter your choice (1 or 2): ', (answer) => {
      rl.close();
      
      if (answer === '1') {
        // User chose to replace settings
        const orderedDefaultSettings = orderSettings(defaultSettings);
        fs.writeFileSync(settingsPath, JSON.stringify(orderedDefaultSettings, null, 2));
        console.log('Created new settings file with defaults.');
        resolve(true);
      } else if (answer === '2') {
        // User chose to update only missing settings
        const updatedSettings = deepMerge(settings, missingSettings);
        updatedSettings.VERSION = currentVersion;
        const orderedUpdatedSettings = orderSettings(updatedSettings);
        fs.writeFileSync(settingsPath, JSON.stringify(orderedUpdatedSettings, null, 2));
        console.log('Updated settings file with missing values.');
        resolve(true);
      } else {
        console.log('Invalid choice. Please enter 1 or 2.');
        // Recursively ask again
        handleVersionUpgrade(settings, missingSettings, defaultSettings, currentVersion, settingsPath)
          .then(resolve);
      }
    });
  });
}

// Function to validate .env contents
function validateEnvContents() {
  const requiredEnvVars = ['PRIVATE_KEY', 'PRIMARY_RPC', 'ADMIN_PASSWORD'];
  const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

  if (missingVars.length > 0) {
      console.error(`Error: The following required environment variables are missing or empty: ${missingVars.join(', ')}`);
      return false;
  }

  // Validate Primary RPC URL
  if (!process.env.PRIMARY_RPC.startsWith('http://') && !process.env.PRIMARY_RPC.startsWith('https://')) {
      console.error('Error: PRIMARY_RPC must be a valid URL starting with http:// or https://');
      return false;
  }
  
  // Warning for missing Secondary RPC
  if (!process.env.SECONDARY_RPC) {
      console.warn('\x1b[33m%s\x1b[0m', 'Warning: No SECONDARY_RPC provided. For improved reliability, consider adding a backup RPC URL.');
  } else if (!process.env.SECONDARY_RPC.startsWith('http://') && !process.env.SECONDARY_RPC.startsWith('https://')) {
      console.warn('\x1b[33m%s\x1b[0m', 'Warning: SECONDARY_RPC must be a valid URL starting with http:// or https://. It will be ignored.');
  }

  // Validate ADMIN_PASSWORD
  if (process.env.ADMIN_PASSWORD.length < 8) {
      console.error('Error: ADMIN_PASSWORD must be at least 8 characters long.');
      return false;
  }

  return true;
}

const app = express();

function readSettings() {
  try {
    const settingsData = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(settingsData);
  } catch (error) {
    console.error('Error reading settings.json:', error);
    return null;
  }
}

function getMonitorMode() {
  const settings = readSettings();
  return settings.MONITOR_MODE === true;
}

function writeSettings(settings) {
  try {
    // Order the settings before writing
    const orderedSettings = orderSettings(settings);
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(orderedSettings, null, 2));
    devLog('Settings updated successfully.');
  } catch (error) {
    console.error('Error writing settings.json:', error);
  }
}

function orderSettings(settings) {
  const orderedSettings = {};
  
  // Order top-level keys
  SETTINGS_ORDER.forEach(key => {
    if (key in settings) {
      // If this is a nested object we want to order
      if (typeof settings[key] === 'object' && !Array.isArray(settings[key]) && key in NESTED_ORDERS) {
        const nestedOrder = NESTED_ORDERS[key];
        const orderedNested = {};
        
        // Order the nested keys
        nestedOrder.forEach(nestedKey => {
          if (nestedKey in settings[key]) {
            orderedNested[nestedKey] = settings[key][nestedKey];
          }
        });
        
        // Add any keys not in our nested order
        Object.keys(settings[key]).forEach(nestedKey => {
          if (!nestedOrder.includes(nestedKey)) {
            orderedNested[nestedKey] = settings[key][nestedKey];
          }
        });
        
        orderedSettings[key] = orderedNested;
      } else {
        orderedSettings[key] = settings[key];
      }
    }
  });
  
  // Add any keys not in our order
  Object.keys(settings).forEach(key => {
    if (!SETTINGS_ORDER.includes(key)) {
      orderedSettings[key] = settings[key];
    }
  });
  
  return orderedSettings;
}

function updateSettings(newSettings) {
  const currentSettings = readSettings();
  // Don't overwrite VERSION with user settings
  const versionToKeep = currentSettings.VERSION;
  const updatedSettings = { ...currentSettings, ...newSettings };
  
  // Restore VERSION from before the update
  if (versionToKeep) {
    updatedSettings.VERSION = versionToKeep;
  }

  // ensure tip is at least 0
  updatedSettings.DEVELOPER_TIP_PERCENTAGE = Math.max(0, updatedSettings.DEVELOPER_TIP_PERCENTAGE);

  // ensure MONITOR_MODE is a boolean
  updatedSettings.MONITOR_MODE = updatedSettings.MONITOR_MODE === true;

  writeSettings(updatedSettings);
  return updatedSettings;
}

async function startServer() {
  // Check required files first and handle version updates
  const checkResult = await ensureRequiredFiles();
  if (!checkResult) {
      console.log('Exiting to allow configuration updates. Please run the application again after updating the configuration files in the /user folder.');
      process.exit(0);
  }
  
  // Load environment variables
  dotenv.config({ path: path.join(__dirname, '..', '..', 'user', '.env') });
  
  // Validate .env contents  
  if (!validateEnvContents()) {
      console.log('Exiting due to invalid .env configuration. Please update the .env file and run the application again.');
      process.exit(1);
  }
  
  // Set up server
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
      console.log(`\nLocal Server Running On: http://localhost:${PORT}`);
  });
  
  return true;
}

let tradingParams = readSettings();

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Use Helmet!
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'cdnjs.cloudflare.com'],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", 'wss:', 'https:'],
      frameSrc: ["'self'", 'https://birdeye.so'],
      upgradeInsecureRequests: [],
    },
  }
}));

// Set up session
app.use(session({
  secret: process.env.SESSION_SECRET || 'your-secret-key',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: false } // Set to true if using https
}));

// Set up rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use(limiter);

// Server setup
let server;
if (fs.existsSync('/path/to/privkey.pem') && fs.existsSync('/path/to/cert.pem') && fs.existsSync('/path/to/chain.pem')) {
  const privateKey = fs.readFileSync('/path/to/privkey.pem', 'utf8');
  const certificate = fs.readFileSync('/path/to/cert.pem', 'utf8');
  const ca = fs.readFileSync('/path/to/chain.pem', 'utf8');

  const credentials = { key: privateKey, cert: certificate, ca: ca };
  server = https.createServer(credentials, app);
  devLog('HTTPS server created');
} else {
  server = http.createServer(app);
  devLog('HTTP server created. Consider setting up HTTPS for production use.');
}

const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Authentication middleware
const authenticate = (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
};

// Login route
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

// Logout route
app.post('/api/logout', (req, res) => {
  req.session.authenticated = false;
  res.json({ success: true });
});

// Apply authentication to /api routes
app.use('/api', authenticate);

// Event emitter setup
const paramUpdateEmitter = new EventEmitter();

// Data storage
let initialData = null;
const recentTrades = [];
const MAX_RECENT_TRADES = 7;

function addRecentTrade(trade) {
  if (recentTrades.length > 0) {
    const lastTrade = recentTrades[0];
    if (lastTrade.timestamp === trade.timestamp &&
      lastTrade.amount === trade.amount &&
      lastTrade.price === trade.price) {
      devLog("Duplicate trade detected, not adding to recent trades");
      return;
    }
  }
  recentTrades.unshift(trade);
  if (recentTrades.length > MAX_RECENT_TRADES) {
    recentTrades.pop();
  }
}

// API routes
app.get('/api/initial-data', (req, res) => {
  const latestData = getLatestTradingData();
  if (latestData) {
    res.json(latestData);
  } else {
    res.status(503).json({ error: 'Initial data not yet available' });
  }
});

app.get('/api/params', (req, res) => {
  res.json(tradingParams);
});

app.get('/api/recent-trades', (req, res) => {
  res.json(recentTrades);
});

app.post('/api/params', (req, res) => {
  const newParams = req.body;
  tradingParams = updateSettings(newParams);
  io.emit('paramsUpdated', tradingParams);
  paramUpdateEmitter.emit('paramsUpdated', tradingParams);
  res.json({ message: 'Parameters updated successfully', params: tradingParams });
});

app.post('/api/restart', authenticate, (req, res) => {
  console.log("Restart trading request received");
  const wallet = getWallet();
  const connection = getConnection();
  devLog("Wallet in restart endpoint:", wallet ? "Defined" : "Undefined");
  devLog("Connection in restart endpoint:", connection ? "Defined" : "Undefined");
  paramUpdateEmitter.emit('restartTrading');
  res.json({ success: true, message: 'Trading restart initiated' });
});

// OrderBook API endpoints
app.get('/api/orderbook-stats', authenticate, (req, res) => {
  const stats = orderBook.getTradeStatistics();
  res.json(stats);
});

app.get('/api/orderbook', authenticate, (req, res) => {
  const trades = orderBook.trades.map(trade => ({
    id: trade.id,
    timestamp: trade.timestamp,
    direction: trade.direction,
    status: trade.status,
    price: parseFloat(trade.price.toFixed(2)),
    solAmount: parseFloat(trade.solAmount.toFixed(6)),
    value: parseFloat(trade.value.toFixed(2)),
    upnl: trade.status === 'open' ? parseFloat(trade.upnl.toFixed(2)) : null,
    realizedPnl: trade.status === 'closed' ? parseFloat(trade.realizedPnl.toFixed(2)) : null,
    closedAt: trade.closedAt || null,
    closePrice: trade.closePrice ? parseFloat(trade.closePrice.toFixed(2)) : null,
    txUrl: trade.id ? `https://solscan.io/tx/${trade.id}` : null
  }));
  res.json({ trades, stats: orderBook.getTradeStatistics() });
});

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
    devLog("State saved successfully.");
  } catch (error) {
    console.error("Error saving state:", error);
  }
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
      const state = JSON.parse(data);
      
      // Initialize orderBook with saved state if it exists
      if (state.orderBook) {
        orderBook.loadState(state.orderBook);
        devLog("OrderBook state restored");
      } else {
        devLog("No OrderBook state found in saved state");
      }
      
      return state;
    }
  } catch (error) {
    console.error("Error loading state:", error);
  }
  return null;
}

function emitRestartTrading() {
  clearRecentTrades();
  io.emit('restartTrading');
}

function clearRecentTrades() {
  recentTrades.length = 0; // This clears the array
  devLog("Recent trades cleared");
}

// Socket.io setup
io.on('connection', (socket) => {
  devLog('\nNew client connected');
  // Send server identification
  socket.emit('serverIdentification', {
    type: 'pulse',
    name: 'PulseSurfer',
    version: getVersion()
  });
  socket.on('disconnect', () => {
    devLog('\nClient disconnected');
  });
});

function calculateAPY(initialValue, currentValue, runTimeInDays) {
  // Check if less than 48 hours have passed
  if (runTimeInDays < 2) {
    return "Insufficient data";
  }

  // Calculate SOL appreciation
  const solAppreciation = (initialValue / initialData.initialSolPrice) * initialData.price;

  // Calculate total return, excluding SOL/USDC market change
  const totalReturn = (currentValue - solAppreciation) / initialValue;

  // Calculate elapsed time in years
  const yearsElapsed = runTimeInDays / 365;

  // User cost (replace with actual user input (0-9999))
  const monthlyCost= parseFloat(tradingParams.USER_MONTHLY_COST);

  // The operational costs and exponential APY impact are applied gradually,
  // preventing drastic early distortions in APY calculations.
  const costEffectScaling = Math.min(0.1 + (runTimeInDays / 28) * 0.9, 1);

  // Calculate operational cost factor
  const opCostFactor = (((monthlyCost * 12) * yearsElapsed) / initialValue) * costEffectScaling;

  // Calculate APY
  const apy = (Math.pow(1 + (totalReturn - opCostFactor), (1 / yearsElapsed) * costEffectScaling) - 1) * 100;

  // Determine the appropriate APY return format based on value
  if (apy < -99.99) {
    return "Err";  // Return "Err" for APY less than -99.99%
  } else if (apy > 999) {
    return "Err";  // Return "Err" for APY greater than 999%
  } else if (apy < 0) {
    return Math.round(apy);  // Round to the nearest whole number for negative values
  } else if (apy < 0.1) {
    return 0;  // Return 0 for values less than 0.1
  } else if (apy >= 0.5 && apy < 10) {
    return apy.toFixed(2);  // Round to 2 decimals for values between 0.5 and 10
  } else if (apy >= 10 && apy < 20) {
    return apy.toFixed(1);  // Round to 1 decimal for values between 10 and 20
  } else if (apy >= 20) {
    return Math.round(apy);  // Round to the nearest whole number for values 20 or higher
  }
}

function getRunTimeInDays(startTime) {
  const currentTime = Date.now();
  const runTimeInMilliseconds = currentTime - startTime;
  const runTimeInDays = runTimeInMilliseconds / (1000 * 60 * 60 * 24);
  return runTimeInDays;
}

function getLatestTradingData() {
  if (!initialData) {
    return null;
  }
  const days = getRunTimeInDays(initialData.startTime);
  const estimatedAPY = calculateAPY(initialData.initialPortfolioValue, initialData.portfolioValue, days);

  devLog(`Server Version: ${getVersion()}`);
  return {
    version: getVersion(),
    fearGreedIndex: initialData.fearGreedIndex,
    sentiment: initialData.sentiment,
    timestamp: initialData.timestamp,
    netChange: parseFloat(initialData.netChange.toFixed(3)),
    price: {
      usd: parseFloat(initialData.price.toFixed(2)),
    },
    portfolioValue: {
      usd: parseFloat(initialData.portfolioValue.toFixed(2)),
    },
    solBalance: parseFloat(initialData.solBalance.toFixed(6)),
    usdcBalance: parseFloat(initialData.usdcBalance.toFixed(2)),
    portfolioWeighting: {
      usdc: parseFloat(((initialData.usdcBalance / initialData.portfolioValue) * 100).toFixed(2)),
      sol: parseFloat(((initialData.solBalance * initialData.price / initialData.portfolioValue) * 100).toFixed(2))
    },
    averageEntryPrice: {
      usd: initialData.averageEntryPrice > 0 ? parseFloat(initialData.averageEntryPrice.toFixed(2)) : 'N/A'
    },
    averageSellPrice: {
      usd: initialData.averageSellPrice > 0 ? parseFloat(initialData.averageSellPrice.toFixed(2)) : 'N/A'
    },
    programRunTime: formatTime(Date.now() - initialData.startTime),
    portfolioTotalChange: parseFloat(((initialData.portfolioValue - initialData.initialPortfolioValue) / initialData.initialPortfolioValue * 100).toFixed(2)),
    solanaMarketChange: parseFloat(((initialData.price - initialData.initialSolPrice) / initialData.initialSolPrice * 100).toFixed(2)),
    estimatedAPY: estimatedAPY,
    recentTrades: recentTrades,
    monitorMode: getMonitorMode(),
    orderbook: {
      trades: orderBook.trades,
      stats: orderBook.getTradeStatistics(),
      winRate: orderBook.getTradeStatistics().winRate,
      totalTrades: orderBook.getTradeStatistics().totalTrades,
      openTrades: orderBook.getTradeStatistics().openTrades,
      closedTrades: orderBook.getTradeStatistics().closedTrades,
      totalRealizedPnl: orderBook.getTradeStatistics().totalRealizedPnl,
      totalUnrealizedPnl: orderBook.getTradeStatistics().totalUnrealizedPnl,
      totalVolume: orderBook.getTradeStatistics().totalVolume
    }
  };
}

function getOrderBookStats() {
  if (!orderBook) {
    return {
      winRate: 0,
      totalTrades: 0,
      openTrades: 0,
      closedTrades: 0,
      totalRealizedPnl: 0,
      totalUnrealizedPnl: 0,
      totalVolume: 0
    };
  }
  return orderBook.getTradeStatistics();
}

function emitTradingData(data) {
  devLog('Server emitting trading data with version:', data.version);
  
  if (!orderBook) {
    console.error('OrderBook not initialized');
    return;
  }

  // Get fresh orderbook data and stats
  const orderBookStats = orderBook.getTradeStatistics();
  const orderBookTrades = orderBook.trades;

  const runTimeMs = Date.now() - data.startTime;
  const programRunTime = formatTime(runTimeMs);

  const days = getRunTimeInDays(data.startTime);
  const estimatedAPY = calculateAPY(data.initialPortfolioValue, data.portfolioValue, days);

  const emitData = {
    version: data.version,
    timestamp: data.timestamp,
    price: {
      usd: parseFloat(data.price.toFixed(2))
    },
    netChange: {
      usd: parseFloat(data.netChange.toFixed(3))
    },
    portfolioValue: {
      usd: parseFloat(data.portfolioValue.toFixed(2))
    },
    fearGreedIndex: data.fearGreedIndex,
    sentiment: data.sentiment,
    usdcBalance: parseFloat(data.usdcBalance.toFixed(2)),
    solBalance: parseFloat(data.solBalance.toFixed(6)),
    averageEntryPrice: {
      usd: data.averageEntryPrice > 0 ? parseFloat(data.averageEntryPrice.toFixed(2)) : 'N/A'
    },
    averageSellPrice: {
      usd: data.averageSellPrice > 0 ? parseFloat(data.averageSellPrice.toFixed(2)) : 'N/A'
    },
    recentTrades: recentTrades,
    txId: data.txId || null,
    txUrl: data.txId ? `https://solscan.io/tx/${data.txId}` : null,
    portfolioWeighting: {
      usdc: parseFloat(((data.usdcBalance / data.portfolioValue) * 100).toFixed(2)),
      sol: parseFloat(((data.solBalance * data.price / data.portfolioValue) * 100).toFixed(2))
    },
    programRunTime,
    portfolioTotalChange: parseFloat(((data.portfolioValue - data.initialPortfolioValue) / data.initialPortfolioValue * 100).toFixed(2)),
    solanaMarketChange: parseFloat(((data.price - data.initialSolPrice) / data.initialSolPrice * 100).toFixed(2)),
    estimatedAPY: estimatedAPY,
    monitorMode: getMonitorMode(),
    orderbook: {
      trades: orderBookTrades,
      winRate: orderBookStats.winRate,
      totalTrades: orderBookStats.totalTrades,
      openTrades: orderBookStats.openTrades,
      closedTrades: orderBookStats.closedTrades,
      totalRealizedPnl: orderBookStats.totalRealizedPnl,
      totalUnrealizedPnl: orderBookStats.totalUnrealizedPnl,
      totalVolume: orderBookStats.totalVolume
    },
    initialData: {
      solPrice: {
        usd: parseFloat(data.initialSolPrice.toFixed(2))
      },
      portfolioValue: {
        usd: parseFloat(data.initialPortfolioValue.toFixed(2))
      },
      solBalance: parseFloat(data.initialSolBalance.toFixed(6)),
      usdcBalance: parseFloat(data.initialUsdcBalance.toFixed(2))
    }
  };

  devLog('Emitting trading data:', emitData);
  io.emit('tradingUpdate', emitData);

  // Update initialData with the latest data
  initialData = { ...data, recentTrades };
  delete initialData.version; // Remove version from initialData
}

function formatTime(milliseconds) {
  const totalSeconds = Math.floor(milliseconds / 1000);
  const days = Math.floor(totalSeconds / (24 * 3600));
  const hours = Math.floor((totalSeconds % (24 * 3600)) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  // Format with days if present, otherwise just show HH:MM:SS
  if (days > 0) {
    return `${days}d ${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

module.exports = {
  startServer,
  server,
  io,
  paramUpdateEmitter,
  orderBook,
  setInitialData: (data) => {
    initialData = data;
  },
  addRecentTrade,
  emitTradingData,
  getLatestTradingData,
  readSettings,
  getMonitorMode,
  emitRestartTrading,
  clearRecentTrades,
  saveState,
  loadState
};