@echo off
title SolSurfer Trading System
color 0a

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo Error: Node.js is not installed!
    echo Please install Node.js from https://nodejs.org/
    echo.
    pause
    exit /b 1
)

:: Navigate to the correct directory (assuming the .bat file is in the root folder)
cd /d "%~dp0"

:: Start the trading bot
echo Starting SolSurfer...
echo.
node user/start.js
color 07

:: If the script exits with an error, pause to show the error message
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo An error occurred while running the bot.
    pause
)