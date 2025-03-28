/**
 * PulseSurfer Discord Notification Module
 * Handles sending stats and notifications to Discord via webhooks
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { readSettings } = require('./pulseServer');
const { getBaseToken, getQuoteToken, formatTime, formatPrice, formatPercentage } = require('./utils');

// 24-hour notification interval in milliseconds
const NOTIFICATION_INTERVAL = 24 * 60 * 60 * 1000;

// Track the last notification time
let lastNotificationTime = null;

/**
 * Sends a notification to Discord via webhook
 * @param {string} webhookUrl - Discord webhook URL
 * @param {Object} content - Message content to send
 * @returns {Promise<boolean>} - Success status
 */
async function sendDiscordNotification(webhookUrl, content) {
    try {
        if (!webhookUrl || !webhookUrl.includes('discord.com/api/webhooks')) {
            console.error('Invalid Discord webhook URL');
            return false;
        }

        const response = await axios.post(webhookUrl, content);
        
        if (response.status >= 200 && response.status < 300) {
            console.log('Discord notification sent successfully');
            return true;
        } else {
            console.error(`Failed to send Discord notification: ${response.status} ${response.statusText}`);
            return false;
        }
    } catch (error) {
        console.error(`Error sending Discord notification: ${error.message}`);
        return false;
    }
}

/**
 * Collects trading stats from the last 24 hours
 * @param {Object} position - Current position data
 * @param {number} currentPrice - Current token price
 * @returns {Object} - Stats for the last 24 hours
 */
function collectDailyStats(position, currentPrice) {
    try {
        const baseToken = getBaseToken();
        const quoteToken = getQuoteToken();
        const enhancedStats = position ? position.getEnhancedStatistics(currentPrice) : null;
        
        // Get trade logs from the last 24 hours
        const now = new Date();
        const yesterday = new Date(now.getTime() - NOTIFICATION_INTERVAL);
        const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const yesterdayStr = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
        
        // Paths to today's and yesterday's log files
        const todayLogPath = path.join(__dirname, '..', '..', 'user', `Pulse Log ${todayStr}.csv`);
        const yesterdayLogPath = path.join(__dirname, '..', '..', 'user', `Pulse Log ${yesterdayStr}.csv`);
        
        // Combined trades from today and yesterday
        let trades = [];
        
        // Get yesterday's trades (if file exists)
        if (fs.existsSync(yesterdayLogPath)) {
            const yesterdayContent = fs.readFileSync(yesterdayLogPath, 'utf8');
            const yesterdayLines = yesterdayContent.split('\n').slice(1); // Skip header
            
            // Filter only trades from the last 24 hours
            const yesterdayTrades = yesterdayLines
                .filter(line => line.trim())
                .map(line => {
                    const [timestamp, inputToken, outputToken, inputAmount, outputAmount, jitoStatus] = line.split(',');
                    return { timestamp, inputToken, outputToken, inputAmount, outputAmount, jitoStatus };
                })
                .filter(trade => {
                    const tradeTime = new Date(trade.timestamp);
                    return tradeTime >= yesterday;
                });
                
            trades = trades.concat(yesterdayTrades);
        }
        
        // Get today's trades (if file exists)
        if (fs.existsSync(todayLogPath)) {
            const todayContent = fs.readFileSync(todayLogPath, 'utf8');
            const todayLines = todayContent.split('\n').slice(1); // Skip header
            
            const todayTrades = todayLines
                .filter(line => line.trim())
                .map(line => {
                    const [timestamp, inputToken, outputToken, inputAmount, outputAmount, jitoStatus] = line.split(',');
                    return { timestamp, inputToken, outputToken, inputAmount, outputAmount, jitoStatus };
                });
                
            trades = trades.concat(todayTrades);
        }
        
        // Calculate daily stats
        const buyTrades = trades.filter(t => t.outputToken === baseToken.NAME);
        const sellTrades = trades.filter(t => t.inputToken === baseToken.NAME);
        
        return {
            totalTrades: trades.length,
            buyTrades: buyTrades.length,
            sellTrades: sellTrades.length,
            currentPrice: currentPrice,
            netChange: enhancedStats?.netChange || 0,
            percentChange: enhancedStats?.portfolioValue?.percentageChange || 0,
            baseBalance: position?.baseBalance || 0,
            quoteBalance: position?.quoteBalance || 0,
            totalVolume: {
                base: enhancedStats?.totalVolume?.baseToken || 0,
                quote: enhancedStats?.totalVolume?.quoteToken || 0
            }
        };
    } catch (error) {
        console.error(`Error collecting daily stats: ${error.message}`);
        return null;
    }
}

/**
 * Creates a Discord embed message with daily trading stats
 * @param {Object} stats - Daily trading statistics
 * @returns {Object} - Discord webhook payload
 */
function createDailyStatsMessage(stats) {
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    
    // Format values for display
    const currentPrice = formatPrice(stats.currentPrice);
    const netChange = stats.netChange > 0 ? `+$${stats.netChange.toFixed(2)}` : `-$${Math.abs(stats.netChange).toFixed(2)}`;
    const percentChange = formatPercentage(stats.percentChange);
    const baseBalance = stats.baseBalance.toFixed(4);
    const quoteBalance = stats.quoteBalance.toFixed(2);
    
    // Create Discord embed
    return {
        embeds: [{
            title: "📊 Surfs Up 🏄 Daily Report",
            color: stats.netChange >= 0 ? 5025616 : 15684432, // Green for profit, red for loss
            timestamp: new Date().toISOString(),
            fields: [
                {
                    name: "Trading Pair",
                    value: `${baseToken.NAME}/${quoteToken.NAME}`,
                    inline: true
                },
                {
                    name: "Current Price",
                    value: currentPrice,
                    inline: true
                },
                {
                    name: "Trades (24h)",
                    value: `${stats.totalTrades} (${stats.buyTrades} buys, ${stats.sellTrades} sells)`,
                    inline: true
                },
                {
                    name: `${baseToken.NAME} Balance`,
                    value: `${baseBalance} ${baseToken.NAME}`,
                    inline: true
                },
                {
                    name: `${quoteToken.NAME} Balance`,
                    value: `${quoteBalance} ${quoteToken.NAME}`,
                    inline: true
                },
                {
                    name: "Net Change",
                    value: `${netChange} (${percentChange})`,
                    inline: true
                },
                {
                    name: "Total Volume",
                    value: `${stats.totalVolume.base.toFixed(4)} ${baseToken.NAME} / ${stats.totalVolume.quote.toFixed(2)} ${quoteToken.NAME}`,
                    inline: false
                }
            ],
            footer: {
                text: `SolSurfer v${readSettings()?.VERSION || '3.1'} | Next report in 24 hours`
            }
        }]
    };
}

/**
 * Creates a startup notification message
 * @returns {Object} - Discord webhook payload
 */
function createStartupMessage() {
    const baseToken = getBaseToken();
    const quoteToken = getQuoteToken();
    const settings = readSettings();
    
    return {
        embeds: [{
            title: "🚀 Surfs Up 🏄 Bot Started",
            color: 45015, // Blue
            timestamp: new Date().toISOString(),
            fields: [
                {
                    name: "Trading Pair",
                    value: `${baseToken.NAME}/${quoteToken.NAME}`,
                    inline: true
                },
                {
                    name: "Trading Method",
                    value: settings?.TRADE_SIZE_METHOD || "VARIABLE",
                    inline: true
                },
                {
                    name: "Monitor Mode",
                    value: settings?.MONITOR_MODE ? "Enabled" : "Disabled",
                    inline: true
                },
                {
                    name: "FGI Timeframe",
                    value: settings?.FGI_TIMEFRAME || "15m",
                    inline: true
                },
                {
                    name: "Trade Cooldown",
                    value: `${settings?.TRADE_COOLDOWN_MINUTES || 10} minutes`,
                    inline: true
                }
            ],
            footer: {
                text: `SolSurfer v${settings?.VERSION || '3.1'} | First daily report in 24 hours`
            }
        }]
    };
}

/**
 * Checks if it's time to send a daily notification
 * @returns {boolean} - True if it's time to send notification
 */
function shouldSendDailyNotification() {
    if (!lastNotificationTime) {
        return true;
    }
    
    const now = new Date().getTime();
    return (now - lastNotificationTime) >= NOTIFICATION_INTERVAL;
}

/**
 * Sends a daily stats notification if it's time
 * @param {Object} position - Current position data
 * @param {number} currentPrice - Current token price
 * @returns {Promise<boolean>} - Success status
 */
async function processDailyNotification(position, currentPrice) {
    try {
        const settings = readSettings();
        
        // If Discord webhook is not configured, skip
        if (!settings?.DISCORD_WEBHOOK) {
            return false;
        }
        
        // Check if it's time to send a notification
        if (!shouldSendDailyNotification()) {
            return false;
        }
        
        // Collect stats and create message
        const stats = collectDailyStats(position, currentPrice);
        if (!stats) {
            return false;
        }
        
        const message = createDailyStatsMessage(stats);
        
        // Send notification
        const success = await sendDiscordNotification(settings.DISCORD_WEBHOOK, message);
        
        if (success) {
            lastNotificationTime = new Date().getTime();
        }
        
        return success;
    } catch (error) {
        console.error(`Error processing daily notification: ${error.message}`);
        return false;
    }
}

/**
 * Sends a startup notification when the bot starts
 * @returns {Promise<boolean>} - Success status
 */
async function sendStartupNotification() {
    try {
        const settings = readSettings();
        
        // If Discord webhook is not configured, skip
        if (!settings?.DISCORD_WEBHOOK) {
            return false;
        }
        
        // Create and send startup message
        const message = createStartupMessage();
        const success = await sendDiscordNotification(settings.DISCORD_WEBHOOK, message);
        
        if (success) {
            lastNotificationTime = new Date().getTime();
        }
        
        return success;
    } catch (error) {
        console.error(`Error sending startup notification: ${error.message}`);
        return false;
    }
}

module.exports = {
    processDailyNotification,
    sendStartupNotification
}; 