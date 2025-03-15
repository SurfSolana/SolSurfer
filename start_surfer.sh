#!/bin/bash

# Set terminal title
echo -ne "\033]0;PulseSurfer Trading System\007"

# Set green text on black background (equivalent to color 0a in Windows)
echo -e "\033[32m\033[40m"

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "Error: Node.js is not installed!"
    echo "Please install Node.js from https://nodejs.org/"
    echo
    read -p "Press Enter to exit..."
    exit 1
fi

# Navigate to the script's directory
cd "$(dirname "$0")"

# Start the trading bot
echo "Starting SolSurfer..."
echo

# Small delay to ensure proper initialization (equivalent to ping delay in Windows)
sleep 2

# Run the start script
node user/start.js

# Capture the exit code
EXIT_CODE=$?

# Reset terminal colors (equivalent to color 07 in Windows)
echo -e "\033[0m"

# If the script exits with an error, pause to show the error message
if [ $EXIT_CODE -ne 0 ]; then
    echo
    echo "An error occurred while running the bot."
    read -p "Press Enter to exit..."
fi