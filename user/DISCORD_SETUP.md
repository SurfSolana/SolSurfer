# Discord Notifications for SolSurfer

This guide will help you set up Discord notifications for your SolSurfer trading bot. With this feature, you'll receive:

1. A startup notification when the bot begins running
2. Daily reports with trading statistics and performance metrics

## Setup Instructions

### Step 1: Create a Discord Webhook

1. Open Discord and go to the server where you want to receive notifications
2. Right-click on the channel and select "Edit Channel"
3. Go to "Integrations"
4. Click on "Webhooks"
5. Click "New Webhook"
6. Name your webhook "Surfs Up 🏄" (or any name you prefer)
7. You can also upload a surfing-related image as the avatar
8. Click "Copy Webhook URL" to copy the webhook URL to your clipboard
9. Click "Save"

### Step 2: Add Webhook URL to SolSurfer Settings

1. Open your `settings.json` file in the `user` folder
2. Add your Discord webhook URL to the `DISCORD_WEBHOOK` field:

```json
"DISCORD_WEBHOOK": "https://discord.com/api/webhooks/your-webhook-url-here",
"NOTIFICATIONS_ENABLED": true
```

3. Save the file

### Step 3: Restart SolSurfer

1. Restart your SolSurfer bot
2. You should receive a startup notification in your Discord channel from "Surfs Up 🏄"
3. After 24 hours, you'll receive your first daily report

## Notification Types

### Startup Notification

Sent when the bot starts running. Includes:
- Trading pair information
- Trading method
- Monitor mode status
- Timeframe settings
- Trade cooldown period

### Daily Report

Sent every 24 hours with:
- Current balances
- Price information
- Performance metrics
- Trade count for the past 24 hours
- Total trading volume

## Troubleshooting

If you're not receiving notifications:

1. Check that your webhook URL is correct
2. Ensure `NOTIFICATIONS_ENABLED` is set to `true`
3. Verify that your Discord server allows webhook messages
4. Check the bot's console for any error messages related to Discord notifications

## Privacy & Security

- Your webhook URL allows posting messages to your Discord channel
- Do not share your webhook URL with others
- The bot will only send trading statistics, no wallet information is shared
- If you need to disable notifications, set `NOTIFICATIONS_ENABLED` to `false` 