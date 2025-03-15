process.emitWarning = function() {}; // Completely suppress all warnings

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const utils = require('../pulse/src/utils');

// Create readline interface
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Define paths relative to the root directory
const ROOT_DIR = path.join(__dirname, '..');
const PULSE_DIR = path.join(ROOT_DIR, 'pulse/src');
const PULSE_PATH = path.join(PULSE_DIR, 'pulse.js');

// Import controllers
const tokenController = require('../pulse/src/tokenController');
const timeframeController = require('../pulse/src/timeframeController');

// Verify bot files exist
function verifyBotFiles() {
    if (!fs.existsSync(PULSE_PATH)) {
        console.error(utils.formatError(`${utils.icons.error} Missing required bot file: PulseSurfer (pulse/src/pulse.js)`));
        process.exit(1);
    }
}

function startTrading() {
    try {
        // Use child_process to explicitly spawn a new process with the --no-warnings flag
        const { spawn } = require('child_process');
        const pulse = spawn('node', ['--no-warnings', PULSE_PATH], {
            stdio: 'inherit',  // This will pipe stdin/stdout/stderr between parent and child
            env: process.env   // Pass along environment variables
        });
        
        // Listen for the process exit
        pulse.on('close', (code) => {
            if (code !== 0) {
                console.error(utils.formatError(`${utils.icons.error} PulseSurfer exited with code ${code}`));
                process.exit(code);
            }
            process.exit(0);
        });
        
        // Handle errors
        pulse.on('error', (err) => {
            console.error(utils.formatError(`${utils.icons.error} Failed to start PulseSurfer: ${err.message}`));
            process.exit(1);
        });
    } catch (error) {
        console.error(utils.formatError(`${utils.icons.error} Error starting PulseSurfer: ${error.message}`));
        process.exit(1);
    }
}

// Normalize terminal input mode before using standard readline
function resetTerminalMode() {
    if (process.stdin.isTTY && process.stdin.setRawMode) {
        process.stdin.setRawMode(false);
    }
}

// Simple confirmation prompt that doesn't rely on raw mode
function simplePrompt(question) {
    return new Promise(resolve => {
        // First ensure we're not in raw mode
        resetTerminalMode();
        
        // Create a fresh readline interface
        const promptRl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        promptRl.question(question, answer => {
            promptRl.close();
            resolve(answer);
        });
    });
}

function promptForStart(tokenName, timeframeDesc) {
    // Use the simpler prompt approach
    simplePrompt(utils.formatInfo(`${utils.icons.menu} Confirm Starting PulseSurfer with ${utils.styles.important}${tokenName}/USDC${utils.colours.reset} on ${utils.styles.important}${timeframeDesc}${utils.colours.reset}? (Y/n): `))
        .then(answer => {
            if (answer.toLowerCase() === 'n') {
                console.log(utils.formatInfo(`\n${utils.icons.info} Startup cancelled.`));
                process.exit(0);
            } else {
                console.log(utils.formatSuccess(`\n${utils.icons.success} Starting PulseSurfer...`));
                process.stdout.write('\x1b[0m'); // Reset terminal colors back to white
                startTrading();
            }
        });
}

// Check if this is a token or timeframe management command
function checkForCommands() {
    const args = process.argv.slice(2);
    
    if (args.includes('--list-tokens')) {
        // List all available tokens
        const tokens = tokenController.getAvailableTokens();
        console.log(utils.formatHeading('\n=== AVAILABLE TOKENS ==='));
        tokens.forEach(token => {
            console.log(`${utils.styles.important}${token.id}${utils.colours.reset} (${token.fullName}) - ${utils.styles.detail}${token.address}${utils.colours.reset}`);
        });
        process.exit(0);
        return true;
    }

    if (args.includes('--list-timeframes')) {
        // List all available timeframes
        console.log(utils.formatHeading('\n=== AVAILABLE TIMEFRAMES ==='));
        timeframeController.AVAILABLE_TIMEFRAMES.forEach(timeframe => {
            console.log(`${utils.styles.important}${timeframe.id}${utils.colours.reset} - ${timeframe.description}`);
        });
        process.exit(0);
        return true;
    }
    
    // For simplicity, allow direct timeframe setting
    const timeframeArg = args.find(arg => arg.startsWith('--timeframe='));
    if (timeframeArg) {
        const timeframeId = timeframeArg.split('=')[1];
        const validTimeframes = timeframeController.AVAILABLE_TIMEFRAMES.map(t => t.id);
        
        if (validTimeframes.includes(timeframeId)) {
            console.log(utils.formatInfo(`\n${utils.icons.settings} Setting timeframe to ${utils.styles.important}${timeframeId}${utils.colours.reset} via command line.`));
            timeframeController.saveTimeframeSelection(timeframeId);
        } else {
            console.error(utils.formatError(`${utils.icons.error} Invalid timeframe: ${timeframeId}. Valid options are: ${validTimeframes.join(', ')}`));
        }
    }
    
    return false;
}

// Main execution
async function initialize() {
    console.log(utils.formatHeading('\n=== PulseSurfer Trading System ===\n'));

    // Check for management commands
    if (checkForCommands()) {
        return; // Exit if a command was executed
    }

    // Verify bot files exist before proceeding
    verifyBotFiles();
    
    try {
        // Handle token selection first
        const tokenPair = await tokenController.handleTokenSelection(true, rl);
        
        if (!tokenPair || !tokenPair.BASE_TOKEN || !tokenPair.QUOTE_TOKEN) {
            console.error(utils.formatError(`${utils.icons.error} Token selection failed - invalid token pair configuration`));
            process.exit(1);
        }
        
        console.log(utils.formatSuccess(`\n${utils.icons.success} Token configuration complete. Trading will use ${utils.styles.important}${tokenPair.BASE_TOKEN.NAME}/USDC${utils.colours.reset}.`));        
        
        // Force reset terminal state before timeframe selection
        resetTerminalMode();
        
        // Create a new readline interface
        const timeframeRl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });
        
        // Handle timeframe selection next with the new readline interface
        const timeframeId = await timeframeController.handleTimeframeSelection(true, timeframeRl);
        
        if (!timeframeId) {
            console.error(utils.formatError(`${utils.icons.error} Timeframe selection failed`));
            process.exit(1);
        }
        
        // Close the timeframe readline interface
        timeframeRl.close();
        
        // Get timeframe description
        const timeframeDesc = timeframeController.getTimeframeDescription(timeframeId);
        
        console.log(utils.formatSuccess(`\n${utils.icons.success} Timeframe configuration complete. Trading will use ${utils.styles.important}${timeframeDesc} (${timeframeId})${utils.colours.reset}.`));
        
        // Reset terminal mode after selections
        resetTerminalMode();
        
        // Close the original rl to clean up any lingering state
        rl.close();
        
        // Add a short delay to ensure all readline interfaces are cleaned up
        await new Promise(r => setTimeout(r, 200));
        
        // Draw a horizontal line for visual separation
        console.log(utils.horizontalLine());
        
        // Then proceed with normal startup confirmation, including token and timeframe
        promptForStart(tokenPair.BASE_TOKEN.NAME, timeframeDesc);
    } catch (error) {
        console.error(utils.formatError(`${utils.icons.error} Error during configuration: ${error.message}`));
        // Ensure terminal is back to normal mode in case of error
        resetTerminalMode();
        process.exit(1);
    }
}

// Handle errors and cleanup
process.on('uncaughtException', (error) => {
    console.error(utils.formatError(`${utils.icons.error} Uncaught Exception: ${error.message}`));
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log(utils.formatInfo(`\n${utils.icons.info} Shutting down...`));
    process.exit(0);
});

// Start the application
initialize();