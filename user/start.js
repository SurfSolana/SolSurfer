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
const WAVE_PATH = path.join(ROOT_DIR, 'wave/src/wave.js');
const MODE_FILE = path.join(__dirname, 'last-mode.txt');

// Verify bot files exist
function verifyBotFiles() {
    const missing = [];

    if (!fs.existsSync(PULSE_PATH)) {
        missing.push('PulseSurfer (pulse/src/pulse.js)');
    }
    if (!fs.existsSync(WAVE_PATH)) {
        missing.push('WaveSurfer (wave/src/wave.js)');
    }

    if (missing.length > 0) {
        console.error('Error: Missing required bot files:');
        missing.forEach(file => console.error(`- ${file}`));
        process.exit(1);
    }
}

function startTrading(mode) {
    console.log(`Starting trading in ${mode} mode...`);
    try {
        if (mode === 'pulse') {
            require(PULSE_PATH);
        } else if (mode === 'wave') {
            require(WAVE_PATH);
        } else {
            console.error(`Invalid mode: ${mode}`);
            process.exit(1);
        }
    } catch (error) {
        console.error(`Error starting ${mode} mode:`, error);
        process.exit(1);
    }
}

function promptForMode() {
    const prompt = `
Select trading mode:
1. PulseSurfer (pulse)
2. WaveSurfer (wave)

Enter your choice (1/2 or pulse/wave): `;

    rl.question(prompt, (answer) => {
        let mode;
        answer = answer.toLowerCase().trim();

        // Handle both numeric and text inputs
        if (answer === '1' || answer === 'pulse') {
            mode = 'pulse';
        } else if (answer === '2' || answer === 'wave') {
            mode = 'wave';
        }

        if (mode) {
            fs.writeFileSync(MODE_FILE, mode);
            rl.close();
            startTrading(mode);
        } else {
            console.log('\nInvalid input. Please enter 1, 2, pulse, or wave.');
            promptForMode();
        }
    });
}

// Main execution
function initialize() {
    console.log('\n=== SurferBot Trading System ===\n');

    // Verify bot files exist before proceeding
    verifyBotFiles();

    // Check if mode is saved
    if (fs.existsSync(MODE_FILE)) {
        const savedMode = fs.readFileSync(MODE_FILE, 'utf8').trim();
        console.log(`Last used mode: ${savedMode === 'pulse' ? 'PulseSurfer' : 'WaveSurfer'} (${savedMode})`);

        rl.question(`Do you want to continue with ${savedMode} mode? (Y/n): `, (answer) => {
            if (answer.toLowerCase() === 'n') {
                promptForMode();
            } else {
                rl.close();
                startTrading(savedMode);
            }
        });
    } else {
        console.log('No previous trading mode found.');
        promptForMode();
    }
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