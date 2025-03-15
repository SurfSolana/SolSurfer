/**
 * PulseSurfer Timeframe Controller
 * Manages FGI timeframe selection and configuration
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const utils = require('./utils');

// Path to the settings file
const SETTINGS_PATH = path.join(__dirname, '..', '..', 'user', 'settings.json');

// Available timeframes
const AVAILABLE_TIMEFRAMES = [
    { id: "15m", description: "15 Minutes" },
    { id: "1h", description: "1 Hour" },
    { id: "4h", description: "4 Hours" }
];

/**
 * Reads settings from settings.json
 * @returns {Object} Settings object
 */
function readSettings() {
    try {
        if (!fs.existsSync(SETTINGS_PATH)) {
            return {};
        }
        const data = fs.readFileSync(SETTINGS_PATH, 'utf8');
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
        const settingsDir = path.dirname(SETTINGS_PATH);
        
        if (!fs.existsSync(settingsDir)) {
            fs.mkdirSync(settingsDir, { recursive: true });
        }
        
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        return true;
    } catch (error) {
        console.error(utils.formatError(`${utils.icons.error} Error writing settings: ${error.message}`));
        return false;
    }
}

/**
 * Saves timeframe selection to settings
 * @param {string} timeframeId - Timeframe identifier
 * @returns {boolean} Success status
 */
function saveTimeframeSelection(timeframeId) {
    console.log(utils.formatInfo(`${utils.icons.settings} Saving timeframe selection: ${utils.styles.important}${timeframeId}${utils.colours.reset}`));
    
    // Find the timeframe in AVAILABLE_TIMEFRAMES
    const timeframe = AVAILABLE_TIMEFRAMES.find(t => t.id === timeframeId);
    if (!timeframe) {
        console.error(utils.formatError(`${utils.icons.error} Invalid timeframe ID: ${timeframeId}`));
        return false;
    }
    
    try {
        const settings = readSettings();
        
        // Store old timeframe for comparison
        const oldTimeframe = settings.FGI_TIMEFRAME;
        
        // Update timeframe
        settings.FGI_TIMEFRAME = timeframe.id;
        
        // Write the settings to file
        fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
        
        console.log(utils.formatSuccess(`${utils.icons.success} Timeframe configuration saved to ${utils.styles.detail}${SETTINGS_PATH}${utils.colours.reset}`));
        
        // Signal timeframe change
        if (oldTimeframe && oldTimeframe !== timeframe.id) {
            console.log(utils.formatInfo(`${utils.icons.time} Timeframe changed from ${utils.styles.detail}${oldTimeframe}${utils.colours.reset} to ${utils.styles.important}${timeframe.id}${utils.colours.reset}`));
        }
        
        return true;
    } catch (error) {
        console.error(utils.formatError(`${utils.icons.error} Error saving timeframe selection: ${error.message}`));
        return false;
    }
}

/**
 * Displays an interactive timeframe selection menu with arrow key navigation
 * @returns {Promise<string>} Selected timeframe ID
 */
function selectTimeframeWithArrows() {
    return new Promise((resolve) => {
        // Ensure we start fresh
        if (process.stdin.isTTY) {
            process.stdin.setRawMode(false);
        }
        
        // Add a slight delay to ensure terminal is ready
        setTimeout(() => {
            // Clear the console
            console.clear();
            console.log(utils.formatHeading("\n=== TIMEFRAME SELECTION ==="));
            console.log(utils.formatInfo(`${utils.icons.menu} Use arrow keys to select a timeframe for trading, then press Enter:`));
            console.log("");
            
            // Display timeframe options
            let selectedIndex = 0;
            const displayMenu = () => {
                console.clear();
                console.log(utils.formatHeading("\n=== TIMEFRAME SELECTION ==="));
                console.log(utils.formatInfo(`${utils.icons.menu} Use arrow keys to select a timeframe for trading, then press Enter:`));
                console.log("");
                
                AVAILABLE_TIMEFRAMES.forEach((timeframe, index) => {
                    const prefix = index === selectedIndex ? `${utils.styles.important}> ` : '  ';
                    const timeframeStyle = index === selectedIndex ? utils.styles.important : '';
                    console.log(`${prefix}${timeframeStyle}${timeframe.description} (${timeframe.id})${utils.colours.reset}`);
                });
            };
            
            displayMenu();
            
            // Handle keypress events
            readline.emitKeypressEvents(process.stdin);
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            
            // Use a named function so we can remove it later
            const keypressHandler = (str, key) => {
                if (key.name === 'up' && selectedIndex > 0) {
                    selectedIndex--;
                    displayMenu();
                } else if (key.name === 'down' && selectedIndex < AVAILABLE_TIMEFRAMES.length - 1) {
                    selectedIndex++;
                    displayMenu();
                } else if (key.name === 'return') {
                    const selectedTimeframe = AVAILABLE_TIMEFRAMES[selectedIndex];
                    console.log(utils.formatSuccess(`\n${utils.icons.success} Selected ${utils.styles.important}${selectedTimeframe.description} (${selectedTimeframe.id})${utils.colours.reset} for trading`));
                    
                    // Clean up event listener and raw mode
                    process.stdin.removeListener('keypress', keypressHandler);
                    if (process.stdin.isTTY) {
                        process.stdin.setRawMode(false);
                    }
                    
                    resolve(selectedTimeframe.id);
                } else if (key.name === 'c' && key.ctrl) {
                    // Allow Ctrl+C to exit
                    if (process.stdin.isTTY) {
                        process.stdin.setRawMode(false);
                    }
                    process.exit(0);
                }
            };
            
            // Register the keypress handler
            process.stdin.on('keypress', keypressHandler);
        }, 100); // Small delay to ensure console is ready
    });
}

/**
 * Fallback function if arrow selection doesn't work on some systems
 * @returns {Promise<string>} Selected timeframe ID
 */
async function promptTimeframeSelection() {
    // Ensure we're not in raw mode
    if (process.stdin.isTTY) {
        process.stdin.setRawMode(false);
    }
    
    // Add a short delay to let the terminal settle
    await new Promise(r => setTimeout(r, 100));
    
    console.clear();
    console.log(utils.formatHeading("\n=== TIMEFRAME SELECTION ==="));
    console.log(utils.formatInfo(`${utils.icons.menu} Please select a timeframe for trading:`));
    console.log("");
    
    AVAILABLE_TIMEFRAMES.forEach((timeframe, index) => {
        console.log(`${utils.styles.important}${index + 1}.${utils.colours.reset} ${timeframe.description} (${timeframe.id})`);
    });
    
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise((resolve) => {
        rl.question(utils.formatInfo(`\n${utils.icons.menu} Select a timeframe (enter number): `), (answer) => {
            rl.close();
            
            const selection = parseInt(answer);
            if (isNaN(selection) || selection < 1 || selection > AVAILABLE_TIMEFRAMES.length) {
                console.log(utils.formatWarning(`\n${utils.icons.warning} Invalid selection, defaulting to 15 Minutes (15m)`));
                resolve('15m');
            } else {
                const selectedTimeframe = AVAILABLE_TIMEFRAMES[selection - 1];
                console.log(utils.formatSuccess(`\n${utils.icons.success} Selected ${utils.styles.important}${selectedTimeframe.description} (${selectedTimeframe.id})${utils.colours.reset} for trading`));
                resolve(selectedTimeframe.id);
            }
        });
    });
}

/**
 * Handles timeframe selection during startup
 * @param {boolean} useArrowKeys - Whether to use arrow key selection
 * @param {readline.Interface} [existingRl] - Existing readline interface to use
 * @returns {Promise<string>} Selected timeframe
 */
async function handleTimeframeSelection(useArrowKeys = true, existingRl = null) {
    console.log(utils.formatInfo(`\n${utils.icons.time} Preparing timeframe selection...`));
    
    // Check if a timeframe is already selected
    const settings = readSettings();
    const currentTimeframe = settings.FGI_TIMEFRAME || '15m';
    const currentTimeframeObj = AVAILABLE_TIMEFRAMES.find(t => t.id === currentTimeframe) || AVAILABLE_TIMEFRAMES[0];
    
    console.log(utils.formatInfo(`\n${utils.icons.settings} Current timeframe: ${utils.styles.important}${currentTimeframeObj.description} (${currentTimeframeObj.id})${utils.colours.reset}`));
    
    // Create a new readline interface if one wasn't provided
    const rlToUse = existingRl || readline.createInterface({
        input: process.stdin,
        output: process.stdout
    });
    
    return new Promise((resolve) => {
        rlToUse.question(utils.formatInfo(`\n${utils.icons.menu} Would you like to change the timeframe? (y/N): `), async (answer) => {
            // Only close if we created our own readline instance
            if (!existingRl) {
                rlToUse.close();
            }
            
            if (answer.toLowerCase() === 'y') {
                // User wants to change the timeframe
                try {
                    // Ensure terminal is back to normal mode before proceeding
                    if (process.stdin.isTTY) {
                        process.stdin.setRawMode(false);
                    }
                    
                    // Since we're switching modes, add a small delay
                    await new Promise(r => setTimeout(r, 100));
                    
                    let timeframeId;
                    // Try using arrow keys first, fall back to numeric selection if it fails
                    try {
                        if (useArrowKeys) {
                            timeframeId = await selectTimeframeWithArrows();
                        } else {
                            timeframeId = await promptTimeframeSelection();
                        }
                    } catch (selectionError) {
                        console.error(utils.formatError(`${utils.icons.error} Arrow key selection failed, falling back to numeric selection`));
                        timeframeId = await promptTimeframeSelection();
                    }
                    
                    // Save timeframe selection and wait for it to complete
                    const saveSuccess = saveTimeframeSelection(timeframeId);
                    
                    if (!saveSuccess) {
                        console.error(utils.formatError(`${utils.icons.error} Failed to save timeframe selection`));
                        resolve(currentTimeframe); // Return current timeframe as fallback
                    } else {
                        // Read the updated settings to ensure we have the latest
                        const updatedSettings = readSettings();
                        resolve(updatedSettings.FGI_TIMEFRAME || timeframeId);
                    }
                } catch (error) {
                    console.error(utils.formatError(`${utils.icons.error} Error during timeframe selection: ${error.message}`));
                    // Ensure we're back in normal mode in case of error
                    if (process.stdin.isTTY) {
                        process.stdin.setRawMode(false);
                    }
                    resolve(currentTimeframe); // Return current timeframe as fallback
                }
            } else {
                // Keep current timeframe
                console.log(utils.formatSuccess(`\n${utils.icons.success} Continuing with ${utils.styles.important}${currentTimeframeObj.description} (${currentTimeframeObj.id})${utils.colours.reset}`));
                resolve(currentTimeframe);
            }
        });
    });
}

/**
 * Gets timeframe description by ID
 * @param {string} timeframeId - Timeframe identifier
 * @returns {string} Timeframe description
 */
function getTimeframeDescription(timeframeId) {
    const timeframe = AVAILABLE_TIMEFRAMES.find(t => t.id === timeframeId);
    return timeframe ? timeframe.description : timeframeId;
}

module.exports = {
    AVAILABLE_TIMEFRAMES,
    readSettings,
    writeSettings,
    saveTimeframeSelection,
    selectTimeframeWithArrows,
    promptTimeframeSelection,
    handleTimeframeSelection,
    getTimeframeDescription
};