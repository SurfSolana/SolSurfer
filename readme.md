# SolSurfer: Free Crypto Trading Bot for Solana | Self-Hosted Trading Suite 🏄‍♂️

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

## Contents 📑

- [Features](#features-)
- [Trading Strategy](#trading-strategy-)
  - [PulseSurfer: Sentiment Trading](#pulsesurfer-sentiment-trading)
- [Quick Start](#quick-start-)
- [Full Setup](#full-setup-%EF%B8%8F)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
  - [Configuration Parameters](#configuration-parameters-)
- [Running SolSurfer](#running-solsurfer-%EF%B8%8F)
- [Dashboard Features](#dashboard-features-)
- [Risk Disclaimer](#risk-disclaimer-%EF%B8%8F)
- [License](#license-)
- [Contributing](#contributing-)
- [Author](#author-)
- [Show your support](#show-your-support-)

## Quick Start 🚀

1.  **Prerequisites**
```bash
# Install Node.js from nodejs.org
# Update npm
npm install -g npm
# Install Git from git-scm.com
```
2.  **Installation**
```bash
# Clone and enter directory
git clone https://github.com/SurfSolana/SolSurfer.git
cd solsurfer
# Install dependencies
npm install
```
3.  **Configuration**
```bash
# Create and edit .env file in /user/
# Windows:
copy user\.env.example user\.env
#
# Mac/Linux:
cp user/.env.example user/.env
# Edit with your details:
# PRIVATE_KEY=your_wallet_private_key
# RPC_URL=your_solana_rpc_url
# ADMIN_PASSWORD=your_web_interface_password
# PORT=3000
```
4.  **Launch**
```bash
# Start the bot
# Windows:
start_surfer.bat
# Mac/Linux:
start_surfer.sh
# Alternative:
node user/start.js
# Note: For Mac/Linux, make the file executable first:
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


## Full Setup 🛠️

### Prerequisites
- Node.js (v14+) (https://nodejs.org/en/)
- npm (v6+) (After installing Node above, in a command line, run ```npm i -g npm``` )
- Git CLI installed ([Git Download Link](https://git-scm.com/downloads))
- Solana wallet with SOL and USDC (Recommended: $50 minimum in each token)
- A reliable Solana RPC Connection: [Try Helius for Free](https://dashboard.helius.dev/login)

### Installation
Clone the repository:
```bash
git clone https://github.com/SurfSolana/SolSurfer.git
cd solsurfer
```

Install dependencies:
```bash
npm install
```

Run the bot using either:

Windows: start_surfer.bat

Mac/Linux: start_surfer.sh

Note: For Mac/Linux, make the file executable first:
```bash
chmod +x start_surfer.sh
```


Edit the `.env` file (found in user folder) with your details:
```
# Your wallet's private key (keep this secret!)
PRIVATE_KEY=your_wallet_private_key

# Your Solana RPC endpoint URL
RPC_URL=your_solana_rpc_url

# Password for accessing the web interface
ADMIN_PASSWORD=your_web_interface_password

# Port for the web dashboard
PORT=3000
```

Configure trading parameters in `settings.json` or via the web interface:

## Configuration Parameters 🔧

### Sentiment Boundaries
```json
"SENTIMENT_BOUNDARIES": {
    "EXTREME_FEAR": 20,    // FGI value below this is considered extreme fear
    "FEAR": 75,           // FGI value below this is considered fear
    "GREED": 82,          // FGI value above this is considered greed
    "EXTREME_GREED": 89   // FGI value above this is considered extreme greed
}
```

![Sentiment Boundaries](/boundarygraph.svg)

### Sentiment Multipliers
```json
"SENTIMENT_MULTIPLIERS": {
    "EXTREME_FEAR": 0.02,  // Position size multiplier during extreme fear (VARIABLE mode only)
    "FEAR": 0.01,         // Position size multiplier during fear (VARIABLE mode only)
    "GREED": 0.01,        // Position size multiplier during greed (VARIABLE mode only)
    "EXTREME_GREED": 0.02  // Position size multiplier during extreme greed (VARIABLE mode only)
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

### Parameter Explanations

#### Sentiment Boundaries
- **EXTREME_FEAR**: FGI value threshold for extreme fear conditions. Values below this trigger larger buy orders.
- **FEAR**: Upper threshold for fear conditions. Values between this and EXTREME_FEAR trigger smaller buy orders.
- **GREED**: Lower threshold for greed conditions. Values above this trigger sell orders.
- **EXTREME_GREED**: Threshold for extreme greed. Values above this trigger larger sell orders.

#### Trade Execution
- **MIN_PROFIT_PERCENT**: The minimum profit percentage required before the bot will close a position.
- **TRADE_COOLDOWN_MINUTES**: Enforced waiting period between trades to prevent overtrading.
- **MIN_SENTIMENT_CHANGE**: Required change in FGI value to trigger a new trade, prevents small fluctuations from causing unnecessary trades.

#### Position Sizing Systems

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

#### Operational Settings
- **USER_MONTHLY_COST**: Used for accurate APY calculations, factoring in operational expenses
- **DEVELOPER_TIP_PERCENTAGE**: Optional percentage for developer support
- **MONITOR_MODE**: When enabled, bot will track market but not execute trades

## Running SolSurfer 🏃‍♂️

Start the trading bot:

Windows: start_surfer.bat

Mac/Linux: start_surfer.sh

-Or-

```node user/start.js```

Access the web interface:
- Local: http://localhost:3000
- Remote: Port forward your selected port and use your machine's Public IPv4 Address

Log in using your configured ADMIN_PASSWORD

## Dashboard Features 📊
The web interface provides:
- Fear and Greed Index tracking
- Transaction history
- Portfolio metrics
- Trade notifications
- Analytics

## Risk Disclaimer ⚠️

Trading cryptocurrencies carries a high level of risk and may not be suitable for all investors. The high degree of leverage can work against you as well as for you. Before deciding to trade cryptocurrencies, you should carefully consider your investment objectives, level of experience, and risk appetite. The possibility exists that you could sustain a loss of some or all of your initial investment and therefore you should not invest money that you cannot afford to lose.

## License 📜

This project is licensed under the MIT License - see the LICENSE file for details.

## Contributing 🤝

Contributions, issues, and feature requests are welcome! Feel free to check issues page.

## Author 👨‍💻

SpuddyA7X

GitHub: @SurfSolana
Twitter: @SpuddyA7X

## Show your support 🌟

Give a ⭐️ if this project helped you!

Happy trading with SolSurfer! 🏄‍♂️🌊
