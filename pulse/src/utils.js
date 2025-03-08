/**
 * PulseSurfer Utilities Module
 * Contains helper functions for time management, logging, configuration, and system operations
 */

// Core dependencies
const os = require('os');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Keypair, Connection } = require('@solana/web3.js');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const csv = require('csv-writer').createObjectCsvWriter;

// ===========================
// Constants and Configuration
// ===========================

// File paths
const USER_DIR = path.join(__dirname, '..', '..', 'user');
const LOG_FILE_PATH = path.join(USER_DIR, 'fgi_log.csv');
const SETTINGS_PATH = path.join(USER_DIR, 'settings.json');
const ENV_PATH = path.join(USER_DIR, '.env');

// Default settings as fallback
const DEFAULT_SETTINGS = {
  VERSION: 'Settings Fallback - Contact Support',
  FGI_TIMEFRAME: "15m",
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
  MONITOR_MODE: false
};

// Trading state
let DEVELOPER_MODE = false;
let tradingPeriodState = {
  startTime: null,
  baseTradeSizes: {
    SOL: null,
    USDC: null
  }
};

// CSV writer for logging
const csvWriter = csv({
  path: LOG_FILE_PATH,
  header: [
    { id: 'timestamp', title: 'Time/Date' },
    { id: 'price', title: 'Price' },
    { id: 'indexValue', title: 'Index Value' }
  ],
  append: true
});

// ===========================
// Logging Functions
// ===========================

/**
 * Logs messages when in developer mode
 * @param {...any} args - Arguments to log
 */
function devLog(...args) {
  if (DEVELOPER_MODE) {
    console.log(...args);
  }
}

/**
 * Sets developer mode
 * @param {boolean} enabled - Whether to enable developer mode
 */
function setDeveloperMode(enabled) {
  DEVELOPER_MODE = !!enabled;
  devLog(`Developer mode ${DEVELOPER_MODE ? 'enabled' : 'disabled'}`);
}

/**
 * Logs trading data to CSV file
 * @param {string} timestamp - Formatted timestamp
 * @param {number} price - Current price
 * @param {number} indexValue - Fear & Greed Index value
 * @returns {Promise<boolean>} Success status
 */
async function logTradingData(timestamp, price, indexValue) {
  try {
    // Validate inputs
    if (!timestamp || typeof price !== 'number' || typeof indexValue !== 'number') {
      console.error('Invalid trading data:', { timestamp, price, indexValue });
      return false;
    }

    // Ensure directory exists
    const dir = path.dirname(LOG_FILE_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const data = [{
      timestamp: timestamp,
      price: price,
      indexValue: indexValue
    }];

    await csvWriter.writeRecords(data);
    devLog('Trading data logged successfully');
    return true;
  } catch (error) {
    console.error('Error logging trading data:', error);
    return false;
  }
}

// ===========================
// Time Management Functions
// ===========================

/**
 * Gets a formatted timestamp string
 * @returns {string} Formatted timestamp
 */
function getTimestamp() {
  const now = new Date();
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const weekday = days[now.getDay()];
  const day = String(now.getDate()).padStart(2, '0');
  const month = months[now.getMonth()];
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const seconds = String(now.getSeconds()).padStart(2, '0');

  return `${weekday}, ${day}/${month}, ${hours}:${minutes}:${seconds}`;
}

/**
 * Convert FGI timeframe to milliseconds for scheduling
 * @param {string} timeframe - Timeframe string (15m, 1h, 4h)
 * @returns {number} - Interval in milliseconds
 */
function timeframeToMilliseconds(timeframe) {
  switch(timeframe) {
      case "1h":
          return 60 * 60 * 1000; // 1 hour
      case "4h":
          return 4 * 60 * 60 * 1000; // 4 hours
      case "15m":
      default:
          return 15 * 60 * 1000; // 15 minutes
  }
}

/**
 * Formats milliseconds into readable time format
 * @param {number} milliseconds - Time in milliseconds
 * @returns {string} Formatted time string
 */
function formatTime(milliseconds) {
  if (typeof milliseconds !== 'number' || milliseconds < 0) {
      return '00:00';
  }
  
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, '0');
  const seconds = (totalSeconds % 60).toString().padStart(2, '0');
  
  // Include hours if needed
  if (hours > 0) {
      return `${hours}:${minutes}:${seconds}`;
  }
  
  return `${minutes}:${seconds}`;
}

/**
 * Gets the timestamp for the next interval based on configured timeframe
 * @returns {number} Next interval timestamp
 */
function getNextIntervalTime() {
  const now = new Date();
  
  // Get timeframe from settings
  const settings = readSettings();
  const timeframe = settings.FGI_TIMEFRAME || "15m";
  
  // Convert timeframe to milliseconds
  const INTERVAL = timeframeToMilliseconds(timeframe);
  const DELAY_AFTER_INTERVAL = 45000; // 45 seconds delay remains the same
  
  let minutesToNext, hourToNext;
  
  switch(timeframe) {
      case "1h":
          // Align to the next full hour
          minutesToNext = 60 - now.getMinutes();
          break;
      case "4h":
          // Align to the next 4-hour block (00:00, 04:00, 08:00, 12:00, 16:00, 20:00)
          const currentHour = now.getHours();
          const nextBlock = Math.ceil((currentHour + 1) / 4) * 4;
          hourToNext = (nextBlock - currentHour);
          minutesToNext = (hourToNext * 60) - now.getMinutes();
          break;
      case "15m":
      default:
          // Original 15-minute interval logic
          minutesToNext = 15 - (now.getMinutes() % 15);
          break;
  }
  
  const seconds = now.getSeconds();
  const milliseconds = now.getMilliseconds();
  
  // Calculate total milliseconds to next interval
  let totalMs = (minutesToNext * 60 * 1000) - (seconds * 1000) - milliseconds + DELAY_AFTER_INTERVAL;
  
  // If we're already close to the next interval, add another interval
  if (totalMs < DELAY_AFTER_INTERVAL) {
      totalMs += INTERVAL;
  }
  
  return now.getTime() + totalMs;
}

/**
 * Gets the wait time until the next trading cycle
 * @returns {number} Wait time in milliseconds
 */
function getWaitTime() {
  const now = new Date().getTime();
  const nextInterval = getNextIntervalTime();
  return nextInterval - now;
}

// ===========================
// System Information Functions
// ===========================

/**
 * Gets the local IP address
 * @returns {string} Local IP address
 */
function getLocalIpAddress() {
  try {
    const interfaces = os.networkInterfaces();
    for (const devName in interfaces) {
      const iface = interfaces[devName];
      for (let i = 0; i < iface.length; i++) {
        const alias = iface[i];
        if (alias.family === 'IPv4' && !alias.internal) {
          if (alias.address.startsWith('192.168.') ||
              alias.address.startsWith('10.') ||
              alias.address.match(/^172\.(1[6-9]|2[0-9]|3[0-1])\./)) {
            return alias.address;
          }
        }
      }
    }
    return 'localhost';
  } catch (error) {
    console.error('Error getting local IP address:', error);
    return 'localhost';
  }
}

/**
 * Gets the current application version from package.json
 * @returns {string} Application version
 */
function getVersion() {
  try {
    // Get the root directory (2 levels up from utils.js in src folder)
    const rootDir = path.resolve(__dirname, '../..');
    const packagePath = path.join(rootDir, 'package.json');

    if (fs.existsSync(packagePath)) {
      const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      return packageData.version;
    }

    // Try one more level up if not found
    const altRootDir = path.resolve(__dirname, '../../..');
    const altPackagePath = path.join(altRootDir, 'package.json');

    if (fs.existsSync(altPackagePath)) {
      const packageData = JSON.parse(fs.readFileSync(altPackagePath, 'utf8'));
      return packageData.version;
    }

    console.error('Could not find package.json in', rootDir, 'or', altRootDir);
    return 'unknown';
  } catch (error) {
    console.error('Error reading package.json:', error);
    return 'unknown';
  }
}

// ===========================
// Settings Management Functions
// ===========================

/**
 * Ensures settings file exists
 * @returns {boolean} Success status
 */
function ensureSettingsFile() {
  try {
    if (!fs.existsSync(USER_DIR)) {
      fs.mkdirSync(USER_DIR, { recursive: true });
    }
    
    if (!fs.existsSync(SETTINGS_PATH)) {
      fs.writeFileSync(SETTINGS_PATH, JSON.stringify(DEFAULT_SETTINGS, null, 2));
      console.log('Created default settings file.');
    }
    return true;
  } catch (error) {
    console.error('Error creating settings file:', error);
    return false;
  }
}

/**
 * Reads settings from file
 * @returns {Object} Settings object
 */
function readSettings() {
  ensureSettingsFile();
  try {
    if (!fs.existsSync(SETTINGS_PATH)) {
      return DEFAULT_SETTINGS;
    }
    
    const settingsData = fs.readFileSync(SETTINGS_PATH, 'utf8');
    return JSON.parse(settingsData);
  } catch (error) {
    console.error('Error reading settings.json:', error);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Writes settings to file
 * @param {Object} settings - Settings object to write
 * @returns {boolean} Success status
 */
function writeSettings(settings) {
  try {
    if (!fs.existsSync(USER_DIR)) {
      fs.mkdirSync(USER_DIR, { recursive: true });
    }
    
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
    console.log('Settings updated successfully.');
    return true;
  } catch (error) {
    console.error('Error writing settings.json:', error);
    return false;
  }
}

/**
 * Updates specific settings
 * @param {Object} newParams - New settings values
 * @returns {Object} Updated settings
 */
function updateSettings(newParams) {
  const currentSettings = readSettings();
  const updatedSettings = { ...currentSettings, ...newParams };

  // Validate values
  updatedSettings.DEVELOPER_TIP_PERCENTAGE = Math.max(0, updatedSettings.DEVELOPER_TIP_PERCENTAGE);
  updatedSettings.MONITOR_MODE = updatedSettings.MONITOR_MODE === true;

  writeSettings(updatedSettings);
  return updatedSettings;
}

// ===========================
// Trading Period Management
// ===========================

/**
 * Checks if a new trading period is needed
 * @returns {Object} Trading period status
 */
function checkTradingPeriod() {
  const now = Date.now();
  
  // Check if we need to start a new period
  if (!tradingPeriodState.startTime || 
      now - tradingPeriodState.startTime >= 24 * 60 * 60 * 1000) {
    return {
      needsNewPeriod: true,
      currentBaseSizes: null
    };
  }

  return {
    needsNewPeriod: false,
    currentBaseSizes: tradingPeriodState.baseTradeSizes
  };
}

/**
 * Sets a new trading period with calculated base sizes
 * @param {number} solBalance - Current SOL balance
 * @param {number} usdcBalance - Current USDC balance
 * @param {number} strategicPercentage - Strategic percentage for sizing
 * @returns {Object} Base trade sizes
 */
function setNewTradingPeriod(solBalance, usdcBalance, strategicPercentage) {
  // Validate inputs
  if (typeof solBalance !== 'number' || isNaN(solBalance) || solBalance < 0) {
    console.error('Invalid SOL balance:', solBalance);
    solBalance = 0;
  }
  
  if (typeof usdcBalance !== 'number' || isNaN(usdcBalance) || usdcBalance < 0) {
    console.error('Invalid USDC balance:', usdcBalance);
    usdcBalance = 0;
  }
  
  if (typeof strategicPercentage !== 'number' || isNaN(strategicPercentage) || strategicPercentage <= 0) {
    console.error('Invalid strategic percentage:', strategicPercentage);
    strategicPercentage = 2.5; // Default value
  }

  const baseSOL = solBalance * (strategicPercentage / 100);
  const baseUSDC = usdcBalance * (strategicPercentage / 100);

  tradingPeriodState = {
    startTime: Date.now(),
    baseTradeSizes: {
      SOL: baseSOL,
      USDC: baseUSDC
    }
  };
  
  console.log(`New trading period started at ${new Date(tradingPeriodState.startTime).toISOString()}`);
  console.log(`Base trade sizes set to: ${baseSOL.toFixed(6)} SOL / ${baseUSDC.toFixed(2)} USDC`);
  return tradingPeriodState.baseTradeSizes;
}

/**
 * Gets information about the current trading period
 * @returns {Object} Trading period info
 */
function getCurrentPeriodInfo() {
  if (!tradingPeriodState.startTime) {
    return {
      active: false,
      message: 'No active trading period'
    };
  }

  const now = Date.now();
  const elapsedHours = (now - tradingPeriodState.startTime) / (1000 * 60 * 60);
  const remainingHours = 24 - elapsedHours;

  return {
    active: true,
    startTime: new Date(tradingPeriodState.startTime).toISOString(),
    baseTradeSizes: tradingPeriodState.baseTradeSizes,
    elapsedHours: elapsedHours.toFixed(2),
    remainingHours: Math.max(0, remainingHours).toFixed(2)
  };
}

/**
 * Resets the current trading period
 */
function resetTradingPeriod() {
  tradingPeriodState = {
    startTime: null,
    baseTradeSizes: {
      SOL: null,
      USDC: null
    }
  };
  console.log('Trading period has been reset');
}

// ===========================
// Environment and Connection Management
// ===========================

/**
 * Creates environment file if it doesn't exist
 */
function setupEnvFile() {
  try {
    if (!fs.existsSync(ENV_PATH)) {
      console.log('.env file not found. Creating a new one...');

      const envContent = `PRIMARY_RPC=
SECONDARY_RPC=        # Optional: Recommended for improved reliability
PRIVATE_KEY=
ADMIN_PASSWORD=
PORT=3000
`;

      // Ensure user directory exists
      if (!fs.existsSync(USER_DIR)) {
        fs.mkdirSync(USER_DIR, { recursive: true });
      }

      fs.writeFileSync(ENV_PATH, envContent);
      console.log('.env file created successfully. Please fill in your details.');
      return true;
    }
    return true;
  } catch (error) {
    console.error('Error setting up .env file:', error);
    return false;
  }
}

/**
 * Checks if a Solana connection is healthy
 * @param {Connection} connection - Solana connection
 * @param {PublicKey} publicKey - Public key to check
 * @returns {Promise<boolean>} Connection health status
 */
async function checkConnectionHealth(connection, publicKey) {
  if (!connection || !publicKey) {
    return false;
  }
  
  try {
    const startTime = Date.now();
    await connection.getBalance(publicKey);
    const endTime = Date.now();
    
    // If response takes more than 5 seconds, consider it unhealthy
    const responseTime = endTime - startTime;
    devLog(`RPC response time: ${responseTime}ms`);
    return responseTime < 5000;
  } catch (error) {
    console.error('Connection health check failed:', error.message);
    return false;
  }
}

/**
 * Attempts to failover to secondary RPC
 * @param {Object} wallet - Wallet object
 * @returns {Promise<boolean>} Success status
 */
async function attemptRPCFailover(wallet) {
  // Check if secondary RPC exists
  if (!process.env.SECONDARY_RPC) {
    console.log("No secondary RPC configured - cannot attempt failover");
    return false;
  }

  try {
    console.log("Attempting RPC failover...");
    const newConnection = new Connection(process.env.SECONDARY_RPC, 'confirmed');
    
    // Test new connection
    const isHealthy = await checkConnectionHealth(newConnection, wallet.publicKey);
    
    if (isHealthy) {
      console.log("Successfully failed over to secondary RPC");
      wallet.connection = newConnection;
      return true;
    }
    
    console.log("Secondary RPC is not healthy");
    return false;
  } catch (error) {
    console.error("Failover attempt failed:", error);
    return false;
  }
}

/**
 * Loads environment variables and establishes connection
 * @returns {Promise<Object>} Environment object with wallet and connection
 */
async function loadEnvironment() {
  // Check if .env file exists and load it
  setupEnvFile();
  dotenv.config({ path: ENV_PATH });

  if (!process.env.PRIMARY_RPC) {
    console.error("Missing required PRIMARY_RPC. Please ensure PRIMARY_RPC is set in your .env file.");
    process.exit(1);
  }

  try {
    if (!process.env.PRIVATE_KEY) {
      console.error("Missing required PRIVATE_KEY. Please ensure PRIVATE_KEY is set in your .env file.");
      process.exit(1);
    }
    
    const privateKey = bs58.default.decode(process.env.PRIVATE_KEY);
    const keypair = Keypair.fromSecretKey(new Uint8Array(privateKey));
    
    // Connect to primary RPC
    let connection = new Connection(process.env.PRIMARY_RPC, 'confirmed');
    let connectionSource = 'primary';
    
    // Test connection
    try {
      await connection.getBalance(keypair.publicKey);
      console.log("Connected to primary RPC successfully");
    } catch (error) {
      console.error("Primary RPC connection failed:", error.message);
      
      // Only try secondary if it exists
      if (process.env.SECONDARY_RPC) {
        console.log("Attempting to connect to secondary RPC...");
        try {
          connection = new Connection(process.env.SECONDARY_RPC, 'confirmed');
          await connection.getBalance(keypair.publicKey);
          console.log("Connected to secondary RPC successfully");
          connectionSource = 'secondary';
        } catch (secondaryError) {
          console.error("Secondary RPC connection also failed.");
          throw new Error("Unable to establish connection to any RPC endpoint");
        }
      } else {
        throw new Error("Primary RPC failed and no secondary RPC configured");
      }
    }

    const wallet = new Wallet(keypair);
    wallet.connection = connection;

    return { keypair, connection, wallet, connectionSource };
  } catch (error) {
    console.error("Error verifying keypair or establishing connection:", error.message);
    process.exit(1);
  }
}

// ===========================
// Module Exports
// ===========================

module.exports = {
  // Time management
  getTimestamp,
  timeframeToMilliseconds,
  formatTime,
  getNextIntervalTime,
  getWaitTime,
  
  // System info
  getLocalIpAddress,
  getVersion,
  
  // Settings management
  updateSettings,
  readSettings,
  writeSettings,
  
  // Trading period management
  checkTradingPeriod,
  setNewTradingPeriod,
  getCurrentPeriodInfo,
  resetTradingPeriod,
  
  // Logging
  logTradingData,
  devLog,
  setDeveloperMode,
  
  // Environment and connection
  setupEnvFile,
  loadEnvironment,
  attemptRPCFailover,
  checkConnectionHealth
};