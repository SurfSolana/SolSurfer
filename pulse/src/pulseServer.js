/**
 * PulseSurfer Server Module
 * Handles web interface, settings management, and trading data communication
 */

// Core dependencies
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

// ===========================
// Constants and Configuration
// ===========================

// Settings configuration
const SETTINGS_ORDER = [
  "VERSION",
  "SENTIMENT_BOUNDARIES",
  "SENTIMENT_MULTIPLIERS",
  "MIN_PROFIT_PERCENT",
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

// File paths
const USER_DIR = path.join(__dirname, '..', '..', 'user');
const SETTINGS_PATH = path.join(USER_DIR, 'settings.json');
const STATE_FILE_PATH = path.join(USER_DIR, 'saveState.json');
const ENV_PATH = path.join(USER_DIR, '.env');

// Trading data storage
const MAX_RECENT_TRADES = 7;
let orderBook = new OrderBook();
let tradingParams = {};
let initialData = null;
const recentTrades = [];

// Create event emitter for parameter updates
const paramUpdateEmitter = new EventEmitter();
// Set higher limit to prevent "MaxListenersExceededWarning"
paramUpdateEmitter.setMaxListeners(20);

// ===========================
// Server Setup
// ===========================

// Express app setup
const app = express();

// Create HTTP or HTTPS server
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

// Socket.io setup
const io = socketIo(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// Middleware setup
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Helmet for security
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

// Session management
app.use(session({
  secret: process.env.SESSION_SECRET || 'default-secret-key-should-be-changed',
  resave: false,
  saveUninitialized: true,
  cookie: { 
    secure: false, // Set to true if using https
    maxAge: 24 * 60 * 60 * 1000 // 24 hours
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

// ===========================
// Settings Management
// ===========================

/**
 * Read settings from settings.json
 * @returns {Object|null} Settings object or null if error
 */
function readSettings() {
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return null;
    }
    
    const settingsData = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(settingsData);
  } catch (error) {
    // Only log if it's not a "file not found" error
    if (error.code !== 'ENOENT') {
      console.error('Error reading settings.json:', error);
    }
    return null;
  }
}

/**
 * Get monitor mode setting
 * @returns {boolean} Monitor mode enabled status
 */
function getMonitorMode() {
  try {
    const settings = readSettings();
    // Return false as default if settings is null or MONITOR_MODE is not set
    if (!settings) return false;
    return settings.MONITOR_MODE === true;
  } catch (error) {
    // Silently fail and return default value
    return false;
  }
}

/**
 * Write settings to settings.json
 * @param {Object} settings Settings object to write
 * @returns {boolean} Success status
 */
function writeSettings(settings) {
  try {
    // Ensure directory exists
    if (!fs.existsSync(USER_DIR)) {
      fs.mkdirSync(USER_DIR, { recursive: true });
    }
    
    // Order the settings before writing
    const orderedSettings = orderSettings(settings);
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(orderedSettings, null, 2));
    devLog('Settings updated successfully.');
    return true;
  } catch (error) {
    console.error('Error writing settings.json:', error);
    return false;
  }
}

/**
 * Order settings object according to predefined order
 * @param {Object} settings Settings object to order
 * @returns {Object} Ordered settings object
 */
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

/**
 * Update settings with new values
 * @param {Object} newSettings New settings values
 * @returns {Object} Updated settings object
 */
function updateSettings(newSettings) {
  const currentSettings = readSettings();
  if (!currentSettings) {
    console.error('Cannot update settings: current settings not found');
    return newSettings;
  }
  
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

/**
 * Deep merge two objects
 * @param {Object} target Target object
 * @param {Object} source Source object
 * @returns {Object} Merged object
 */
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

/**
 * Check for missing settings compared to defaults
 * @param {Object} current Current settings
 * @param {Object} defaults Default settings
 * @returns {Object} Missing settings
 */
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

/**
 * Handle settings version upgrade
 * @param {Object} settings Current settings
 * @param {Object} missingSettings Missing settings
 * @param {Object} defaultSettings Default settings
 * @param {string} currentVersion Current version
 * @param {string} settingsPath Path to settings file
 * @returns {Promise<boolean>} Success status
 */
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

/**
 * Ensure all required files exist
 * @returns {Promise<boolean>} Success status
 */
function ensureRequiredFiles() {
  return new Promise(async (resolve) => {
    let filesCreated = false;
    let settingsCreated = false;
    let confirmDisplayed = false;
    
    // Make sure the user directory exists
    if (!fs.existsSync(USER_DIR)) {
      try {
        fs.mkdirSync(USER_DIR, { recursive: true });
        console.log('Created user directory');
      } catch (error) {
        console.error('Error creating user directory:', error);
        resolve(false);
        return;
      }
    }

    // Check if .env file exists and create it if it doesn't
    if (!fs.existsSync(ENV_PATH)) {
      const defaultEnvContent = `
PRIMARY_RPC=
SECONDARY_RPC=        # Optional: Recommended for improved reliability
PRIVATE_KEY=
ADMIN_PASSWORD=
PORT=3000
      `;
      try {
        fs.writeFileSync(ENV_PATH, defaultEnvContent.trim());
        console.log('.env file created. Please fill in the required values before running the application again.');
        filesCreated = true;
      } catch (error) {
        console.error('Error creating .env file:', error);
        resolve(false);
        return;
      }
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
      TRADE_SIZE_METHOD: "STRATEGIC",
      STRATEGIC_PERCENTAGE: 2.5,
      USER_MONTHLY_COST: 0,
      DEVELOPER_TIP_PERCENTAGE: 0,
      MONITOR_MODE: false,
    });

    // Check if settings.json file exists
    if (!fs.existsSync(SETTINGS_PATH)) {
      // Create the settings file with default values
      try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
        console.log('settings.json file created with default values.');
        settingsCreated = true;
        filesCreated = true;
      } catch (error) {
        console.error('Error creating settings.json:', error);
        resolve(false);
        return;
      }
      
      // If the .env file doesn't exist with valid values, we need to exit
      if (filesCreated && !fs.existsSync(ENV_PATH)) {
        console.log('New configuration files have been created. Please review and update them as necessary before running the application again.');
        resolve(false);
        return;
      }
      
      // If only settings.json was created, ask the user if they want to continue
      if (settingsCreated && !confirmDisplayed) {
        confirmDisplayed = true;
        // Create readline interface for user input
        const rl = readline.createInterface({
          input: process.stdin,
          output: process.stdout
        });
        
        console.log('\n\x1b[32m%s\x1b[0m', 'Settings.json did not exist, so we generated it with default parameters.');
        console.log('\x1b[32m%s\x1b[0m', 'You can close this and modify them if you wish, or press Y to start PulseSurfer with default parameters.');
        
        rl.question('\nConfirm Starting PulseSurfer? (Y/n): ', (answer) => {
          rl.close();
          
          if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes' || answer === '') {
            // User wants to continue with default settings
            console.log('Starting with default settings...');
            resolve(true);
          } else {
            // User wants to exit and modify settings
            console.log('Exiting to allow settings modification. Run the application again after updating the configuration files.');
            resolve(false);
          }
        });
        return;
      }
    } else {
      // Settings file exists - check version and settings
      try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        
        // Always check for missing settings, regardless of version
        const missingSettings = checkMissingSettings(settings, DEFAULT_SETTINGS);
        
        if (Object.keys(missingSettings).length > 0 || settings.VERSION !== currentVersion) {
          // We found missing settings or version changed - ask user what to do
          const upgradeResult = await handleVersionUpgrade(settings, missingSettings, DEFAULT_SETTINGS, currentVersion, SETTINGS_PATH);
          resolve(upgradeResult);
          return;
        }
      } catch (error) {
        console.error('Error reading or parsing settings.json:', error);
        console.log('Creating new settings.json file with default values.');
        try {
          fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
          filesCreated = true;
          settingsCreated = true;
          
          // Ask the user if they want to continue with the newly created settings
          if (!confirmDisplayed) {
            confirmDisplayed = true;
            const rl = readline.createInterface({
              input: process.stdin,
              output: process.stdout
            });
            
            console.log('\n\x1b[32m%s\x1b[0m', 'Settings.json was corrupted, so we generated a new one with default parameters.');
            console.log('\x1b[32m%s\x1b[0m', 'You can close this and modify them if you wish, or press Y to start PulseSurfer with default parameters.');
            
            rl.question('\nConfirm Starting PulseSurfer? (Y/n): ', (answer) => {
              rl.close();
              
              if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes' || answer === '') {
                // User wants to continue with default settings
                console.log('Starting with default settings...');
                resolve(true);
              } else {
                // User wants to exit and modify settings
                console.log('Exiting to allow settings modification. Run the application again after updating the configuration files.');
                resolve(false);
              }
            });
            return;
          }
        } catch (writeError) {
          console.error('Failed to create new settings.json file:', writeError);
          resolve(false);
          return;
        }
      }
    }

    // If we've created .env file (which requires user configuration), we should exit
    if (filesCreated && !settingsCreated) {
      console.log('New .env file has been created. Please fill in the required values before running the application again.');
      resolve(false);
      return;
    }

    // All checks passed, we can continue
    resolve(true);
  });
}

/**
 * Validate environment variables
 * @returns {boolean} Validation result
 */
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

// ===========================
// State Management
// ===========================

/**
 * Save state to file
 * @param {Object} state State object to save
 * @returns {boolean} Success status
 */
function saveState(state) {
  try {
    if (!fs.existsSync(USER_DIR)) {
      fs.mkdirSync(USER_DIR, { recursive: true });
    }
    
    fs.writeFileSync(STATE_FILE_PATH, JSON.stringify(state, null, 2));
    devLog("State saved successfully.");
    return true;
  } catch (error) {
    console.error("Error saving state:", error);
    return false;
  }
}

/**
 * Load state from file
 * @returns {Object|null} Loaded state or null if error
 */
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE_PATH)) {
      const data = fs.readFileSync(STATE_FILE_PATH, 'utf8');
      if (!data || data.trim() === '') {
        devLog("State file exists but is empty");
        return null;
      }
      
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

/**
 * Add a trade to recent trades list
 * @param {Object} trade Trade object to add
 */
function addRecentTrade(trade) {
  // Validate trade object
  if (!trade || typeof trade !== 'object') {
    devLog("Invalid trade object, not adding to recent trades");
    return;
  }

  // Check for duplicates
  if (recentTrades.length > 0) {
    const lastTrade = recentTrades[0];
    if (lastTrade.timestamp === trade.timestamp &&
      lastTrade.amount === trade.amount &&
      lastTrade.price === trade.price) {
      devLog("Duplicate trade detected, not adding to recent trades");
      return;
    }
  }
  
  // Add to front of array
  recentTrades.unshift(trade);
  
  // Maintain maximum size
  if (recentTrades.length > MAX_RECENT_TRADES) {
    recentTrades.pop();
  }
}

/**
 * Clear recent trades list
 */
function clearRecentTrades() {
  recentTrades.length = 0; // This clears the array
  devLog("Recent trades cleared");
}

/**
 * Format time duration into human-readable string
 * @param {number} milliseconds Time in milliseconds
 * @returns {string} Formatted time string
 */
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

// ===========================
// Trading Data Management
// ===========================

/**
 * Calculate Annual Percentage Yield
 * @param {number} initialValue Initial portfolio value
 * @param {number} currentValue Current portfolio value
 * @param {number} runTimeInDays Runtime in days
 * @returns {string|number} APY value or status message
 */
function calculateAPY(initialValue, currentValue, runTimeInDays) {
  // Check if less than 48 hours have passed
  if (runTimeInDays < 2) {
    return "Insufficient data";
  }

  try {
    // Calculate SOL appreciation
    const solAppreciation = (initialValue / initialData.initialSolPrice) * initialData.price;

    // Calculate total return, excluding SOL/USDC market change
    const totalReturn = (currentValue - solAppreciation) / initialValue;

    // Calculate elapsed time in years
    const yearsElapsed = runTimeInDays / 365;

    // User cost (replace with actual user input (0-9999))
    const monthlyCost = parseFloat(tradingParams.USER_MONTHLY_COST || 0);

    // The operational costs and exponential APY impact are applied gradually,
    // preventing drastic early distortions in APY calculations.
    const costEffectScaling = Math.min(0.1 + (runTimeInDays / 28) * 0.9, 1);

    // Calculate operational cost factor
    const opCostFactor = (((monthlyCost * 12) * yearsElapsed) / initialValue) * costEffectScaling;

    // Calculate APY
    const apy = (Math.pow(1 + (totalReturn - opCostFactor), (1 / yearsElapsed) * costEffectScaling) - 1) * 100;

    // Determine the appropriate APY return format based on value
    if (apy < -99.99 || apy > 999) {
      return "Err";  // Return "Err" for extreme values
    } else if (apy < 0) {
      return Math.round(apy);  // Round to the nearest whole number for negative values
    } else if (apy < 0.1) {
      return 0;  // Return 0 for values less than 0.1
    } else if (apy >= 0.5 && apy < 10) {
      return apy.toFixed(2);  // Round to 2 decimals for values between 0.5 and 10
    } else if (apy >= 10 && apy < 20) {
      return apy.toFixed(1);  // Round to 1 decimal for values between 10 and 20
    } else {
      return Math.round(apy);  // Round to the nearest whole number for values 20 or higher
    }
  } catch (error) {
    console.error('Error calculating APY:', error);
    return "Error";
  }
}

/**
 * Calculate runtime in days
 * @param {number} startTime Start time in milliseconds
 * @returns {number} Runtime in days
 */
function getRunTimeInDays(startTime) {
  const currentTime = Date.now();
  const runTimeInMilliseconds = currentTime - startTime;
  return runTimeInMilliseconds / (1000 * 60 * 60 * 24);
}

/**
 * Get latest trading data for UI
 * @returns {Object|null} Trading data object or null if not initialized
 */
function getLatestTradingData() {
  if (!initialData) {
    return null;
  }
  
  try {
    const days = getRunTimeInDays(initialData.startTime);
    const estimatedAPY = calculateAPY(initialData.initialPortfolioValue, initialData.portfolioValue, days);
    const orderBookStats = orderBook.getTradeStatistics();

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
        stats: orderBookStats,
        winRate: orderBookStats.winRate,
        totalTrades: orderBookStats.totalTrades,
        openTrades: orderBookStats.openTrades,
        closedTrades: orderBookStats.closedTrades,
        totalRealizedPnl: orderBookStats.totalRealizedPnl,
        totalUnrealizedPnl: orderBookStats.totalUnrealizedPnl,
        totalVolume: orderBookStats.totalVolume
      }
    };
  } catch (error) {
    console.error('Error generating latest trading data:', error);
    return null;
  }
}

/**
 * Get OrderBook statistics
 * @returns {Object} OrderBook statistics
 */
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

/**
 * Emit trading data to connected clients
 * @param {Object} data Trading data to emit
 */
function emitTradingData(data) {
  try {
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

    // Emit the data via Socket.IO
    io.emit('tradingUpdate', emitData);

    // Update initialData with the latest data
    initialData = { ...data, recentTrades };
    delete initialData.version; // Remove version from initialData
  } catch (error) {
    console.error('Error emitting trading data:', error);
  }
}

/** 
 * Emit restart trading event
 */
function emitRestartTrading() {
  clearRecentTrades();
  io.emit('restartTrading');
}

// ===========================
// Authentication Middleware
// ===========================

/**
 * Authentication middleware
 */
const authenticate = (req, res, next) => {
  if (req.session.authenticated) {
    next();
  } else {
    res.status(401).json({ error: 'Authentication required' });
  }
};

// ===========================
// API Routes
// ===========================

// Authentication routes
app.post('/api/login', (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.authenticated = false;
  res.json({ success: true });
});

// Apply authentication to /api routes
app.use('/api', authenticate);

// Data retrieval routes
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

// Settings update route
app.post('/api/params', (req, res) => {
  try {
    const newParams = req.body;
    tradingParams = updateSettings(newParams);
    io.emit('paramsUpdated', tradingParams);
    paramUpdateEmitter.emit('paramsUpdated', tradingParams);
    res.json({ message: 'Parameters updated successfully', params: tradingParams });
  } catch (error) {
    console.error('Error updating parameters:', error);
    res.status(500).json({ error: 'Failed to update parameters' });
  }
});

// Trading restart route
app.post('/api/restart', authenticate, (req, res) => {
  try {
    console.log("Restart trading request received");
    const wallet = getWallet();
    const connection = getConnection();
    devLog("Wallet in restart endpoint:", wallet ? "Defined" : "Undefined");
    devLog("Connection in restart endpoint:", connection ? "Defined" : "Undefined");
    paramUpdateEmitter.emit('restartTrading');
    res.json({ success: true, message: 'Trading restart initiated' });
  } catch (error) {
    console.error('Error restarting trading:', error);
    res.status(500).json({ error: 'Failed to restart trading' });
  }
});

// OrderBook API endpoints
app.get('/api/orderbook-stats', authenticate, (req, res) => {
  try {
    const stats = orderBook.getTradeStatistics();
    res.json(stats);
  } catch (error) {
    console.error('Error getting orderbook stats:', error);
    res.status(500).json({ error: 'Failed to get orderbook stats' });
  }
});

app.get('/api/orderbook', authenticate, (req, res) => {
  try {
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
  } catch (error) {
    console.error('Error getting orderbook:', error);
    res.status(500).json({ error: 'Failed to get orderbook' });
  }
});

// ===========================
// Socket.io Handling
// ===========================

// Socket.io connection handling
io.on('connection', (socket) => {
  devLog('\nNew client connected');
  
  // Send server identification
  socket.emit('serverIdentification', {
    type: 'pulse',
    name: 'PulseSurfer',
    version: getVersion()
  });
  
  // Listen for disconnection
  socket.on('disconnect', () => {
    devLog('\nClient disconnected');
  });
});

// ===========================
// Server Startup
// ===========================

/**
 * Start the server
 * @returns {Promise<boolean>} Success status
 */
async function startServer() {
  try {
    // Check required files first and handle version updates
    const checkResult = await ensureRequiredFiles();
    if (!checkResult) {
      // Exit without showing additional error messages
      process.exit(0);
    }
    
    // Now that we've ensured the settings file exists, we can safely read it
    tradingParams = readSettings();
    if (!tradingParams) {
      console.error('Failed to read settings after creation. Please check file permissions.');
      process.exit(1);
    }
    
    // Load environment variables
    dotenv.config({ path: ENV_PATH });
    
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
  } catch (error) {
    console.error('Error during server startup:', error);
    process.exit(1);
  }
}

// ===========================
// Module Exports
// ===========================

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