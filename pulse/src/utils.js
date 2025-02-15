const os = require('os');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { Keypair, Connection } = require('@solana/web3.js');
const { Wallet } = require('@project-serum/anchor');
const bs58 = require('bs58');
const csv = require('csv-writer').createObjectCsvWriter;

const LOG_FILE_PATH = path.join(__dirname, '..', '..', 'user', 'fgi_log.csv');

let DEVELOPER_MODE = false;

let tradingPeriodState = {
    startTime: null,
    baseTradeSizes: {
        SOL: null,
        USDC: null
    }
};

function devLog(...args) {
    if (DEVELOPER_MODE) {
        console.log(...args);
    }
}

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

function formatTime(milliseconds) {
    const totalSeconds = Math.ceil(milliseconds / 1000);
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

function getNextIntervalTime() {
    const now = new Date();
    const minutes = now.getMinutes();
    const seconds = now.getSeconds();
    const milliseconds = now.getMilliseconds();

    const INTERVAL = 900000; // 15 minutes
    const DELAY_AFTER_INTERVAL = 45000; // 45 seconds

    const minutesToNext = 15 - (minutes % 15);
    let totalMs = (minutesToNext * 60 * 1000) - (seconds * 1000) - milliseconds + DELAY_AFTER_INTERVAL;

    if (totalMs < DELAY_AFTER_INTERVAL) {
        totalMs += INTERVAL;
    }

    return now.getTime() + totalMs;
}

function getWaitTime() {
    const now = new Date().getTime();
    const nextInterval = getNextIntervalTime();
    return nextInterval - now;
}

function getLocalIpAddress() {
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
    return 'Unable to determine LAN IP address';
}

function updateSettings(newParams) {
    const currentSettings = readSettings();
    const updatedSettings = { ...currentSettings, ...newParams };

    //ensure tip is at least 0
    updatedSettings.DEVELOPER_TIP_PERCENTAGE = Math.max(0, updatedSettings.DEVELOPER_TIP_PERCENTAGE);

    // ensure MONITOR_MODE is a boolean
    updatedSettings.MONITOR_MODE = updatedSettings.MONITOR_MODE === true;

    writeSettings(updatedSettings);
    return updatedSettings;
}

function readSettings() {
    ensureSettingsFile();
    try {
        const settingsData = fs.readFileSync(SETTINGS_PATH, 'utf8');
        return JSON.parse(settingsData);
    } catch (error) {
        console.error('Error reading settings.json:', error);
        return DEFAULT_SETTINGS;
    }
}

function writeSettings(settings) {
    try {
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        console.log('Settings updated successfully.');
    } catch (error) {
        console.error('Error writing settings.json:', error);
    }
}

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

function setNewTradingPeriod(solBalance, usdcBalance, strategicPercentage) {
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
    console.log(`Base trade sizes set to: ${baseSOL} SOL / ${baseUSDC} USDC`);
    return tradingPeriodState.baseTradeSizes;
}

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

function resetTradingPeriod() {
    tradingPeriodState = {
        startTime: null,
        baseTradeSize: null
    };
    console.log('Trading period has been reset');
}

// Logging functions
const csvWriter = csv({
    path: LOG_FILE_PATH,
    header: [
        { id: 'timestamp', title: 'Time/Date' },
        { id: 'price', title: 'Price' },
        { id: 'indexValue', title: 'Index Value' }
    ],
    append: true
});

async function logTradingData(timestamp, price, indexValue) {
    const data = [{
        timestamp: timestamp,
        price: price,
        indexValue: indexValue
    }];

    try {
        await csvWriter.writeRecords(data);
        console.log('Trading data logged successfully');
    } catch (error) {
        console.error('Error logging trading data:', error);
    }
}

// Config functions
function setupEnvFile() {
    const envPath = path.join(__dirname, '..', '..', 'user', '.env');

    if (!fs.existsSync(envPath)) {
        console.log('.env file not found. Creating a new one...');

        const envContent = `PRIVATE_KEY=
RPC_URL=
ADMIN_PASSWORD=
PORT=3000
`;

        fs.writeFileSync(envPath, envContent);
        console.log('.env file created successfully. Please fill in your details.');
        process.exit(0);
    }
}

async function loadEnvironment() {
    dotenv.config({ path: path.join(__dirname, '..', '..', 'user', '.env') });

    if (!process.env.PRIMARY_RPC) {
        console.error("Missing required PRIMARY_RPC. Please ensure PRIMARY_RPC is set in your .env file.");
        process.exit(1);
    }

    try {
        const privateKey = bs58.default.decode(process.env.PRIVATE_KEY);
        const keypair = Keypair.fromSecretKey(new Uint8Array(privateKey));
        
        // Connect to primary RPC
        let connection = new Connection(process.env.PRIMARY_RPC, 'confirmed');
        
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

        return { keypair, connection, wallet };
    } catch (error) {
        console.error("Error verifying keypair or establishing connection:", error.message);
        process.exit(1);
    }
}

// Version function
function getVersion() {
    try {
        const path = require('path');
        const fs = require('fs');

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
        return false;
    } catch (error) {
        console.error("Failover attempt failed:", error);
        return false;
    }
}

module.exports = {
    getTimestamp,
    formatTime,
    getNextIntervalTime,
    getWaitTime,
    getLocalIpAddress,
    updateSettings,
    readSettings,
    writeSettings,
    checkTradingPeriod,
    setNewTradingPeriod,
    getCurrentPeriodInfo,
    resetTradingPeriod,
    logTradingData,
    setupEnvFile,
    loadEnvironment,
    getVersion,
    attemptRPCFailover,
    devLog
};