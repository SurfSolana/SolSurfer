# Free Crypto Trading Bot: SolSurfer Self-Hosted Trading Suite - macOS Guide 🏄‍♂️🌊

![GitHub last commit](https://img.shields.io/github/last-commit/SurfSolana/SolSurfer)
![GitHub issues](https://img.shields.io/github/issues/SurfSolana/SolSurfer)
![GitHub number of milestones](https://img.shields.io/github/milestones/all/SurfSolana/SolSurfer)
![GitHub stars](https://img.shields.io/github/stars/SurfSolana/SolSurfer?style=social)
[![Twitter Follow](https://img.shields.io/twitter/follow/spuddya7x?style=social)](https://twitter.com/spuddya7x)

[Join our Discord community](https://discord.gg/dpzudaBwSa) to discuss SolSurfer, get support, and stay updated on the latest developments.

SolSurfer is a **free, self-hosted crypto trading bot** that automates SOL/USDC trading on the Solana blockchain. What sets our bot apart from AI trading bots is our transparent approach - combining targeted machine learning for performance optimization with clear, understandable trading strategies. Our trading approach leverages Fear and Greed Index analysis with ML-optimized parameters, giving you the best of both worlds: advanced technology with complete clarity on how your trades are executed.

## Features 🚀

- ✅ Free and open source
- 🏠 Self-hosted 
- 🤖 ML-optimized parameters
- 💼 Automated trading
- 📊 Performance tracking
- 🖥️ Web dashboard
- 🔒 Security features

## Before You Start

You'll need:
- About $100 worth of SOL and USDC for trading
- About 30 minutes of time
- A Mac computer

## macOS Installation Guide 🛠️

### Opening Terminal

Terminal is a program that lets you type commands to your Mac. To open it:

1. Click the magnifying glass (🔍) in the top-right corner of your screen
2. Type "Terminal"
3. Click the Terminal app (it looks like a black box)

Keep Terminal open throughout the installation process.

### Required Tools Setup

#### 1. Homebrew
Check if installed:
```bash
brew --version
```

If not found, install it:
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

#### 2. Node.js and npm
Check if installed:
```bash
node --version
npm --version
```

If not found, install both:
```bash
brew install node
```

#### 3. Git
Check if installed:
```bash
git --version
```

If not found, install it:
```bash
brew install git
```

### Required Accounts Setup

1. **Solana Wallet**
   - Install [Phantom Wallet](https://phantom.app) from the App Store
   - Create a new wallet or import existing
   - Add SOL and USDC (minimum $50 worth of each)
   - [Guide to get your private key](https://help.phantom.com/hc/en-us/articles/28355165637011-Exporting-Your-Private-Key)

2. **RPC URL**
   - Visit [Helius](https://dashboard.helius.dev/login)
   - Sign up for a free account
   - Create a new API key
   - Copy the RPC URL (starts with https://)

### Installation Steps

1. Download SolSurfer:
```bash
git clone https://github.com/SurfSolana/SolSurfer.git
```

2. Move into the SolSurfer folder:
```bash
cd solsurfer
```

3. Install required packages:
```bash
npm install
```

### Configuration

1. Create your settings file:
```bash
cp user/.env.example user/.env
```

2. Open the settings file in TextEdit:
```bash
open -e user/.env
```

3. Replace these lines with your information:
```bash
PRIVATE_KEY=your_wallet_private_key
RPC_URL=your_solana_rpc_url
ADMIN_PASSWORD=your_web_interface_password
PORT=3000
```

4. Save the file (CMD + S) and close TextEdit
5. Make the start script runnable:
```bash
chmod +x start_surfer.sh
```

## Trading Strategy 📊

### PulseSurfer: Sentiment Trading
Direct Sentiment Trading:
- Buys in fear markets
- Sells in greed periods
- Holds in neutral markets

Position Sizing:
- Position sizing based on sentiment
- Configurable multipliers for each sentiment level

## Configuration Parameters 🔧

### Sentiment Boundaries
```json
{
    "SENTIMENT_BOUNDARIES": {
        "EXTREME_FEAR": 20,    // FGI value below this is considered extreme fear
        "FEAR": 75,           // FGI value below this is considered fear
        "GREED": 82,          // FGI value above this is considered greed
        "EXTREME_GREED": 89   // FGI value above this is considered extreme greed
    }
}
```

![Sentiment Boundaries](/boundarygraph.svg)

### Sentiment Multipliers
```json
{
    "SENTIMENT_MULTIPLIERS": {
        "EXTREME_FEAR": 0.02,  // Position size multiplier during extreme fear (VARIABLE mode only)
        "FEAR": 0.01,         // Position size multiplier during fear (VARIABLE mode only)
        "GREED": 0.01,        // Position size multiplier during greed (VARIABLE mode only)
        "EXTREME_GREED": 0.02  // Position size multiplier during extreme greed (VARIABLE mode only)
    }
}
```

### Trading Parameters
```json
{
    "MIN_PROFIT_PERCENT": 0.2,          // Minimum profit percentage required to close a trade
    "TRADE_COOLDOWN_MINUTES": 30,       // Minimum time between trades
    "TRADE_SIZE_METHOD": "STRATEGIC",   // STRATEGIC or VARIABLE
    "STRATEGIC_PERCENTAGE": 2.5,        // Base percentage of portfolio to trade when using STRATEGIC method
    "MIN_SENTIMENT_CHANGE": 5           // Minimum FGI change required to trigger a new trade
}
```

### Cost Settings
```json
{
    "USER_MONTHLY_COST": 0,             // Monthly operational cost in USD (for APY calculations)
    "DEVELOPER_TIP_PERCENTAGE": 0,      // Optional tip percentage for developers
    "MONITOR_MODE": false               // Enable/disable trading (true = monitor only)
}
```

### Position Sizing Systems

The bot offers two methods for calculating position sizes when opening trades:

**1. STRATEGIC Method (Default, Recommended)**
- Takes a daily snapshot of your SOL and USDC balances every 24 hours
- Uses STRATEGIC_PERCENTAGE to calculate fixed trade sizes for the next 24 hours
- Example: With STRATEGIC_PERCENTAGE of 2.5%
  - Day starts with 100 SOL and 1000 USDC
  - Each trade that day will use 2.5 SOL or 25 USDC
  - Next day, balances are re-snapshot and new trade sizes are calculated
- Provides more consistent, predictable trading sizes

**2. VARIABLE Method**
- Calculates trade size dynamically for each trade based on current balance
- Uses SENTIMENT_MULTIPLIERS as percentages of your current balance
- Example: With Extreme Fear multiplier of 0.07 (7%)
  - Current balance: 100 SOL
  - Trade size: 7 SOL (7% of current balance)
  - Next trade will use 7% of whatever the new balance is
- More aggressive, adapts to changing balances immediately

**Profit Taking (Both Methods)**
- When closing profitable trades, the bot only sells the original purchase amount
- Example:
  - Buy 10 SOL at $10 ($100 total)
  - Price rises to $15
  - Bot sells only $100 worth (6.67 SOL)
  - Keeps remaining 3.33 SOL as profit

![Orderbook Example](/orderbook.png)

## Running SolSurfer 🏃‍♂️

Start the trading bot:
```bash
./start_surfer.sh
```

Access the web interface:
- Local: http://localhost:3000
- Remote: Port forward your selected port and use your machine's Public IPv4 Address

Log in using your configured ADMIN_PASSWORD

## Troubleshooting

If you see "Permission denied":
```bash
sudo chmod +x start_surfer.sh
```

If npm install fails:
```bash
npm cache clean --force
npm install
```

If you can't access the dashboard:
- Change the port in your .env file to 3001 or 3002
- Restart SolSurfer

## Dashboard Features 📊
The web interface provides:
- Fear and Greed Index tracking
- Transaction history
- Portfolio metrics
- Trade notifications
- Analytics

## Risk Disclaimer ⚠️

Trading cryptocurrencies carries a high level of risk and may not be suitable for all investors. The high degree of leverage can work against you as well as for you. Before deciding to trade cryptocurrencies, you should carefully consider your investment objectives, level of experience, and risk appetite. The possibility exists that you could sustain a loss of some or all of your initial investment and therefore you should not invest money that you cannot afford to lose.

## Safety Tips

- Never share your private key or password
- Start with small amounts when trading
- Keep your computer updated and secure
- Regularly check for SolSurfer updates

## Getting Help

1. Join our community:
   - [Discord](https://discord.gg/dpzudaBwSa)
   - Follow [@spuddya7x](https://twitter.com/spuddya7x)
   - [GitHub Issues](https://github.com/SurfSolana/SolSurfer/issues)

## License 📜

This project is licensed under the MIT License - See [LICENSE](./LICENSE) file for details.

## Author 👨‍💻

SpuddyA7X

GitHub: @SurfSolana
Twitter: @SpuddyA7X

## Show your support 🌟

Give a ⭐️ if this project helped you!

Happy trading with SolSurfer! 🏄‍♂️🌊