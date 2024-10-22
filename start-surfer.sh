#!/bin/bash

# Set terminal title
echo -ne "\033]0;SolSurfer Trading System\007"

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
node user/start.js

# If the script exits with an error, pause to show the error message
if [ $? -ne 0 ]; then
    echo
    echo "An error occurred while running the bot."
    read -p "Press Enter to exit..."
fi