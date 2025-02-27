const fs = require('fs');
const path = require('path');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

// Define paths relative to the root directory
const ROOT_DIR = path.join(__dirname, '..');
const PULSE_PATH = path.join(ROOT_DIR, 'pulse/src/pulse.js');

// Suppress the "bigint: Failed to load bindings" message by modifying environment
process.env.NODE_OPTIONS = process.env.NODE_OPTIONS || '';
if (!process.env.NODE_OPTIONS.includes('--no-warnings')) {
  process.env.NODE_OPTIONS += ' --no-warnings';
}

// Verify bot files exist
function verifyBotFiles() {
    if (!fs.existsSync(PULSE_PATH)) {
        console.error('Error: Missing required bot file:');
        console.error(`- PulseSurfer (pulse/src/pulse.js)`);
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
                console.error(`PulseSurfer exited with code ${code}`);
                process.exit(code);
            }
            process.exit(0);
        });
        
        // Handle errors
        pulse.on('error', (err) => {
            console.error('Failed to start PulseSurfer:', err);
            process.exit(1);
        });
    } catch (error) {
        console.error('Error starting PulseSurfer:', error);
        process.exit(1);
    }
}

function promptForStart() {
    rl.question('> Confirm Starting PulseSurfer? (Y/n): ', (answer) => {
        if (answer.toLowerCase() === 'n') {
            console.log('\nStartup cancelled.');
            rl.close();
            process.exit(0);
        } else {
            rl.close();
            startTrading();
        }
    });
}

// Main execution
function initialize() {
    console.log('\n=== PulseSurfer Trading System ===\n');

    // Verify bot files exist before proceeding
    verifyBotFiles();
    promptForStart();
}

// Handle errors and cleanup
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    rl.close();
    process.exit(1);
});

process.on('SIGINT', () => {
    console.log('\nShutting down...');
    rl.close();
    process.exit(0);
});

// Start the application
initialize();