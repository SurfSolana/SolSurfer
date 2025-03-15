/*
 * PulseSurfer Token Controller
 * Manages token selection, configuration, and provides pre-defined tokens
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const utils = require('./utils');

// Define the USDC token as a constant (quote token)
const USDC_TOKEN = {
  NAME: "USDC",
  ADDRESS: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  DECIMALS: 6
};

// Path to the tokens configuration file
const TOKENS_FILE_PATH = path.join(__dirname, 'tokens.json');

/**
 * Loads token data from the tokens.json file
 * @returns {Array} List of available tokens
 */
function loadTokensFromFile() {
  try {
    // Check if the tokens file exists
    if (!fs.existsSync(TOKENS_FILE_PATH)) {
      console.error(utils.formatError(`${utils.icons.error} Tokens file not found at: ${TOKENS_FILE_PATH}`));
      return createDefaultTokensFile();
    }
    
    // Read and parse the tokens file
    const tokenData = fs.readFileSync(TOKENS_FILE_PATH, 'utf8');
    const tokens = JSON.parse(tokenData);
    
    // Validate the token data
    if (!Array.isArray(tokens) || tokens.length === 0) {
      console.error(utils.formatError(`${utils.icons.error} Invalid token data format`));
      return createDefaultTokensFile();
    }
    
    // Validate each token has required fields
    const validTokens = tokens.filter(token => {
      return token.id && token.ADDRESS && typeof token.DECIMALS === 'number';
    });
    
    if (validTokens.length === 0) {
      console.error(utils.formatError(`${utils.icons.error} No valid tokens found in the tokens file`));
      return createDefaultTokensFile();
    }
    
    console.log(utils.formatSuccess(`${utils.icons.success} Loaded ${utils.styles.important}${validTokens.length}${utils.colours.reset} tokens from configuration file`));
    return validTokens;
  } catch (error) {
    console.error(utils.formatError(`${utils.icons.error} Error loading tokens from file: ${error.message}`));
    return createDefaultTokensFile();
  }
}

/**
 * Creates a default tokens file with SOL if the file doesn't exist
 * @returns {Array} Default tokens array
 */
function createDefaultTokensFile() {
  const defaultTokens = [
    {
      "id": "SOL",
      "ADDRESS": "So11111111111111111111111111111111111111112",
      "DECIMALS": 9,
      "FULL_NAME": "solana"
    },
    {
      "id": "BTC",
      "ADDRESS": "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh",
      "DECIMALS": 8,
      "FULL_NAME": "bitcoin"
    },
    {
      "id": "ETH",
      "ADDRESS": "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs",
      "DECIMALS": 8,
      "FULL_NAME": "ethereum"
    },
    {
      "id": "BONK",
      "ADDRESS": "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263",
      "DECIMALS": 5,
      "FULL_NAME": "bonk"
    },
    {
      "id": "JUP",
      "ADDRESS": "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
      "DECIMALS": 6,
      "FULL_NAME": "jupiter"
    },
    {
      "id": "WIF",
      "ADDRESS": "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm",
      "DECIMALS": 6,
      "FULL_NAME": "dogwifhat"
    },
    {
      "id": "spx6900",
      "ADDRESS": "J3NKxxXZcnNiMjKw9hYb2K4LUxgwB6t1FtPtQVsv3KFr",
      "DECIMALS": 8,
      "FULL_NAME": "spx6900"
    },
    {
      "id": "POPCAT",
      "ADDRESS": "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr",
      "DECIMALS": 9,
      "FULL_NAME": "popcat"
    },
    {
      "id": "GIGA",
      "ADDRESS": "63LfDmNb3MQ8mw9MtZ2To9bEA2M71kZUUGq5tiJxcqj9",
      "DECIMALS": 9,
      "FULL_NAME": "giga"
    }
  ]
  
  try {
    // Ensure directory exists
    const dirPath = path.dirname(TOKENS_FILE_PATH);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
    
    fs.writeFileSync(TOKENS_FILE_PATH, JSON.stringify(defaultTokens, null, 2));
    console.log(utils.formatSuccess(`${utils.icons.success} Created default tokens file at: ${utils.styles.detail}${TOKENS_FILE_PATH}${utils.colours.reset}`));
    return defaultTokens;
  } catch (error) {
    console.error(utils.formatError(`${utils.icons.error} Error creating default tokens file: ${error.message}`));
    return defaultTokens;
  }
}

// Load the available tokens from file
const AVAILABLE_TOKENS = loadTokensFromFile();

/**
 * Gets token by ID
 * @param {string} tokenId - Token identifier
 * @returns {Object|null} Token object or null if not found
 */
function getTokenById(tokenId) {
  return AVAILABLE_TOKENS.find(t => t.id === tokenId) || null;
}

/**
 * Displays an interactive token selection menu with arrow key navigation
 * @returns {Promise<string>} Selected token ID
 */
function selectTokenWithArrows() {
  return new Promise((resolve) => {
    // Clear the console
    console.clear();
    console.log(utils.formatHeading("\n=== TOKEN SELECTION ==="));
    console.log(utils.formatInfo(`${utils.icons.menu} Use arrow keys to select a token for trading, then press Enter:`));
    console.log("");
    
    // Display token options
    let selectedIndex = 0;
    const displayMenu = () => {
      console.clear();
      console.log(utils.formatHeading("\n=== TOKEN SELECTION ==="));
      console.log(utils.formatInfo(`${utils.icons.menu} Use arrow keys to select a token for trading, then press Enter:`));
      console.log("");
      
      AVAILABLE_TOKENS.forEach((token, index) => {
        const prefix = index === selectedIndex ? `${utils.styles.important}> ` : '  ';
        const tokenStyle = index === selectedIndex ? utils.styles.important : '';
        console.log(`${prefix}${tokenStyle}${token.id}${utils.colours.reset}/USDC (${token.FULL_NAME || token.id})`);
      });
    };
    
    displayMenu();
    
    // Handle keypress events
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    
    process.stdin.on('keypress', (str, key) => {
      if (key.name === 'up' && selectedIndex > 0) {
        selectedIndex--;
        displayMenu();
      } else if (key.name === 'down' && selectedIndex < AVAILABLE_TOKENS.length - 1) {
        selectedIndex++;
        displayMenu();
      } else if (key.name === 'return') {
        const selectedToken = AVAILABLE_TOKENS[selectedIndex];
        console.log(utils.formatSuccess(`\n${utils.icons.success} Selected ${utils.styles.important}${selectedToken.id}${utils.colours.reset}/USDC for trading`));
        
        // Clean up event listener and raw mode
        process.stdin.removeAllListeners('keypress');
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(false);
        }
        
        resolve(selectedToken.id);
      } else if (key.name === 'c' && key.ctrl) {
        // Allow Ctrl+C to exit
        process.exit(0);
      }
    });
  });
}

/**
 * Fallback function if arrow selection doesn't work on some systems
 * @returns {Promise<string>} Selected token ID
 */
async function promptTokenSelection() {
  console.clear();
  console.log(utils.formatHeading("\n=== TOKEN SELECTION ==="));
  console.log(utils.formatInfo(`${utils.icons.menu} Please select a token for trading:`));
  console.log("");
  
  AVAILABLE_TOKENS.forEach((token, index) => {
    console.log(`${utils.styles.important}${index + 1}.${utils.colours.reset} ${token.id}/USDC (${token.FULL_NAME || token.id})`);
  });
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  
  return new Promise((resolve) => {
    rl.question(utils.formatInfo(`\n${utils.icons.menu} Select a token (enter number): `), (answer) => {
      rl.close();
      
      const selection = parseInt(answer);
      if (isNaN(selection) || selection < 1 || selection > AVAILABLE_TOKENS.length) {
        console.log(utils.formatWarning(`\n${utils.icons.warning} Invalid selection, defaulting to SOL/USDC`));
        resolve('SOL');
      } else {
        const selectedToken = AVAILABLE_TOKENS[selection - 1];
        console.log(utils.formatSuccess(`\n${utils.icons.success} Selected ${utils.styles.important}${selectedToken.id}${utils.colours.reset}/USDC for trading`));
        resolve(selectedToken.id);
      }
    });
  });
}

/**
 * Gets the path to the settings file
 * @returns {string} Path to settings.json
 */
function getSettingsPath() {
  return path.join(__dirname, '..', '..', 'user', 'settings.json');
}

/**
 * Reads settings from settings.json
 * @returns {Object} Settings object
 */
function readSettings() {
  try {
    const settingsPath = getSettingsPath();
    if (!fs.existsSync(settingsPath)) {
      return {};
    }
    const data = fs.readFileSync(settingsPath, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(utils.formatError(`${utils.icons.error} Error reading settings: ${error.message}`));
    return {};
  }
}

/**
 * Writes settings to settings.json
 * @param {Object} settings - Settings object
 * @returns {boolean} Success status
 */
function writeSettings(settings) {
  try {
    const settingsPath = getSettingsPath();
    const settingsDir = path.dirname(settingsPath);
    
    if (!fs.existsSync(settingsDir)) {
      fs.mkdirSync(settingsDir, { recursive: true });
    }
    
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return true;
  } catch (error) {
    console.error(utils.formatError(`${utils.icons.error} Error writing settings: ${error.message}`));
    return false;
  }
}

/**
 * Saves token selection to settings
 * @param {string} tokenId - Token identifier
 * @returns {boolean} Success status
 */
function saveTokenSelection(tokenId) {
  console.log(utils.formatInfo(`${utils.icons.settings} Saving token selection: ${utils.styles.important}${tokenId}${utils.colours.reset}`));
  
  // Find the token in AVAILABLE_TOKENS
  const token = getTokenById(tokenId);
  if (!token) {
    console.error(utils.formatError(`${utils.icons.error} Invalid token ID: ${tokenId}`));
    return false;
  }
  
  try {
    const settings = readSettings();
    
    // Store old token pair for comparison
    const oldBaseToken = settings.TRADING_PAIR?.BASE_TOKEN?.NAME;
    const oldQuoteToken = settings.TRADING_PAIR?.QUOTE_TOKEN?.NAME;
    
    // Construct TRADING_PAIR with proper structure
    settings.TRADING_PAIR = {
      BASE_TOKEN: {
        NAME: token.id,
        ADDRESS: token.ADDRESS,
        DECIMALS: token.DECIMALS,
        FULL_NAME: token.FULL_NAME || token.id
      },
      QUOTE_TOKEN: USDC_TOKEN
    };
    
    // Write the settings to file
    const settingsPath = getSettingsPath();
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    
    console.log(utils.formatSuccess(`${utils.icons.success} Token configuration saved to ${utils.styles.detail}${settingsPath}${utils.colours.reset}`));
    
    // Signal token change if OrderBook is available
    if (oldBaseToken && oldBaseToken !== token.id) {
      console.log(utils.formatInfo(`${utils.icons.trade} Token changed from ${utils.styles.detail}${oldBaseToken}${utils.colours.reset} to ${utils.styles.important}${token.id}${utils.colours.reset}`));
      
      // Note: We don't update the OrderBook here because it might not be
      // initialized yet. The OrderBook will be updated when the app restarts
      // or when resetPosition is called in response to the parameter update.
    }
    
    return true;
  } catch (error) {
    console.error(utils.formatError(`${utils.icons.error} Error saving token selection: ${error.message}`));
    return false;
  }
}

/**
 * Handles token selection during startup
 * @param {boolean} useArrowKeys - Whether to use arrow key selection
 * @param {readline.Interface} [existingRl] - Existing readline interface to use
 * @returns {Promise<Object>} Selected token configuration
 */
async function handleTokenSelection(useArrowKeys = true, existingRl = null) {
  console.log(utils.formatInfo(`\n${utils.icons.settings} Preparing token selection...`));
  console.log(utils.formatWarning(`\n${utils.icons.warning} Warning, do not modify the token.json file.`));
  console.log(utils.formatInfo(`${utils.icons.info} This is only for tokens supported by the PulseSurfer Trading System.`));
  console.log(utils.formatInfo(`${utils.icons.info} If you need to add a token, please contact the SurfSolana Team.`));
  
  // Check if a token is already selected
  const settings = readSettings();
  if (settings.TRADING_PAIR && settings.TRADING_PAIR.BASE_TOKEN && settings.TRADING_PAIR.QUOTE_TOKEN) {
    const baseToken = settings.TRADING_PAIR.BASE_TOKEN;
    console.log(utils.formatInfo(`\n${utils.icons.trade} Current token pair: ${utils.styles.important}${baseToken.NAME}${utils.colours.reset}/USDC`));
    
    // Create a new readline interface if one wasn't provided
    const rlToUse = existingRl || readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    
    return new Promise((resolve) => {
      rlToUse.question(utils.formatInfo(`\n${utils.icons.menu} Would you like to change the token? (y/N): `), async (answer) => {
        // Only close if we created our own readline instance
        if (!existingRl) {
          rlToUse.close();
        }
        
        if (answer.toLowerCase() === 'y') {
          // User wants to change the token
          try {
            let tokenId;
            if (useArrowKeys) {
              tokenId = await selectTokenWithArrows();
            } else {
              tokenId = await promptTokenSelection();
            }
            
            // Save token selection and wait for it to complete
            const saveSuccess = saveTokenSelection(tokenId);
            
            if (!saveSuccess) {
              console.error(utils.formatError(`${utils.icons.error} Failed to save token selection`));
              resolve(settings.TRADING_PAIR); // Return current settings as fallback
            } else {
              // Read the updated settings to ensure we have the latest
              const updatedSettings = readSettings();
              resolve(updatedSettings.TRADING_PAIR);
            }
          } catch (error) {
            console.error(utils.formatError(`${utils.icons.error} Error during token selection: ${error.message}`));
            resolve(settings.TRADING_PAIR); // Return current settings as fallback
          }
        } else {
          // Keep current token
          console.log(utils.formatSuccess(`\n${utils.icons.success} Continuing with ${utils.styles.important}${baseToken.NAME}${utils.colours.reset}/USDC`));
          resolve(settings.TRADING_PAIR);
        }
      });
    });
  }
  
  // No token selected yet, show selection menu
  try {
    let tokenId;
    if (useArrowKeys) {
      tokenId = await selectTokenWithArrows();
    } else {
      tokenId = await promptTokenSelection();
    }
    
    // Save the selection
    const saveSuccess = saveTokenSelection(tokenId);
    
    if (!saveSuccess) {
      console.error(utils.formatError(`${utils.icons.error} Failed to save initial token selection`));
      throw new Error('Token selection save failed');
    }
    
    // Read settings again to ensure we have the updated version
    return readSettings().TRADING_PAIR;
  } catch (error) {
    console.error(utils.formatError(`${utils.icons.error} Error during token selection: ${error.message}`));
    console.log(utils.formatWarning(`${utils.icons.warning} Falling back to standard selection method...`));
    
    try {
      const tokenId = await promptTokenSelection();
      const saveSuccess = saveTokenSelection(tokenId);
      
      if (!saveSuccess) {
        console.error(utils.formatError(`${utils.icons.error} Failed to save token selection (fallback)`));
        throw new Error('Token selection save failed (fallback)');
      }
      
      return readSettings().TRADING_PAIR;
    } catch (secondError) {
      console.error(utils.formatError(`${utils.icons.error} Fallback token selection also failed: ${secondError.message}`));
      throw new Error('Token selection completely failed');
    }
  }
}

/**
 * Gets list of available tokens
 * @returns {Array} List of available tokens
 */
function getAvailableTokens() {
  return AVAILABLE_TOKENS.map(token => ({
    id: token.id,
    name: token.id, // Use id as name for consistency
    fullName: token.FULL_NAME || token.id,
    decimals: token.DECIMALS,
    address: token.ADDRESS
  }));
}

/**
 * Checks if the selected token is properly configured in settings
 * @returns {boolean} True if token is configured
 */
function isTokenConfigured() {
  const settings = readSettings();
  return !!(settings.TRADING_PAIR && 
          settings.TRADING_PAIR.BASE_TOKEN && 
          settings.TRADING_PAIR.BASE_TOKEN.DECIMALS && 
          settings.TRADING_PAIR.QUOTE_TOKEN);
}

// Exports
module.exports = {
  AVAILABLE_TOKENS,
  USDC_TOKEN,
  getSettingsPath,
  readSettings,
  writeSettings,
  saveTokenSelection,
  selectTokenWithArrows,
  promptTokenSelection,
  handleTokenSelection,
  getTokenById,
  getAvailableTokens,
  isTokenConfigured,
  loadTokensFromFile
};