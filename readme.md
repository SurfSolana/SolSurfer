# Free Crypto Trading Bot: SolSurfer Self-Hosted Trading Suite 🏄‍♂️🌊

![GitHub last commit](https://img.shields.io/github/last-commit/SurfSolana/SolSurfer)
![GitHub issues](https://img.shields.io/github/issues/SurfSolana/SolSurfer)
![GitHub number of milestones](https://img.shields.io/github/milestones/all/SurfSolana/SolSurfer)
![GitHub stars](https://img.shields.io/github/stars/SurfSolana/SolSurfer?style=social)
[![Twitter Follow](https://img.shields.io/twitter/follow/spuddya7x?style=social)](https://twitter.com/spuddya7x)

[Join our Discord community](https://discord.gg/dpzudaBwSa) to discuss SolSurfer, get support, and stay updated on the latest developments.

SolSurfer is a **free, self-hosted crypto trading bot** that automates SOL/USDC trading on the Solana blockchain. What sets our bot apart from AI trading bots is our transparent approach - combining targeted machine learning for performance optimization with clear, understandable trading strategies. Our dual trading approaches leverage Fear and Greed Index analysis with ML-optimized parameters, giving you the best of both worlds: advanced technology with complete clarity on how your trades are executed.

Join our Discord community to discuss SolSurfer, get support, and stay updated on the latest developments.

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
- [Trading Strategies](#trading-strategies-)
  - [PulseSurfer: Sentiment Trading](#1-pulsesurfer-sentiment-trading)
  - [WaveSurfer: Momentum Trading](#2-wavesurfer-momentum-trading)
- [Quick Start](#quick-start-)
- [Full Setup](#full-setup-%EF%B8%8F)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
- [Running SolSurfer](#running-solsurfer-%EF%B8%8F)
- [Dashboard Features](#dashboard-features-)
- [Choose Your Strategy](#choose-your-strategy-)
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
For Windows, run the file: start_surfer.bat
For Mac/Linux: start_surfer.sh
# Note: For Mac/Linux, make the file executable first: ```chmod +x start_surfer.sh```
```

## Trading Strategies 📊

### 1. PulseSurfer: Sentiment Trading
Direct Sentiment Trading:
- Buys in fear markets
- Sells in greed periods
- Holds in neutral markets

Position Sizing:
- Position sizing based on sentiment
- Configurable multipliers for each sentiment level

### 2. WaveSurfer: Momentum Trading
Streak Building:
- Tracks consecutive sentiment readings
- Requires minimum streak threshold (default: 5)

Trade Execution:
- Trades on neutral return after streak
- Buys after Fear streaks
- Sells after Greed streaks

Position Sizing:
- Trade size set by Trade Multiplier
- Default is 15% of selling token balance

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

Select your trading strategy (1: PulseSurfer or 2: WaveSurfer)

Edit the `.env` file with your details:
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
```json
{
  "SENTIMENT_BOUNDARIES": {
    "EXTREME_FEAR": 15,
    "FEAR": 35,
    "GREED": 65,
    "EXTREME_GREED": 85
  },
  "USER_MONTHLY_COST": 0,
  "DEVELOPER_TIP_PERCENTAGE": 0,
  "MONITOR_MODE": false,
  
  "SENTIMENT_MULTIPLIERS": {
    "EXTREME_FEAR": 0.05,
    "FEAR": 0.03,
    "GREED": 0.03,
    "EXTREME_GREED": 0.05
  },
  
  "STREAK_THRESHOLD": 5,
  "TRADE_MULTIPLIER": 15
}
```

## Running SolSurfer 🏃‍♂️

Start the trading bot:

Windows: start_surfer.bat

Mac/Linux: start_surfer.sh

-Or-

```node user/start.js```

Select your trading strategy:
1. PulseSurfer (direct sentiment trading)
2. WaveSurfer (momentum trading)

Access the web interface:
- Local: http://localhost:3000
- Remote: Port forward your selected port and use your machine's Public IPv4 Address

Log in using your configured ADMIN_PASSWORD

## Dashboard Features 📊
The web interface provides:
- Fear and Greed Index tracking
- Active sentiment streaks
- Transaction history
- Portfolio metrics
- Trade notifications
- Analytics

## Choose Your Strategy 🤔

**PulseSurfer**: Better for:
- Active trading
- Quick market responses
- Higher trading frequency
- Short-term trading

**WaveSurfer**: Better for:
- Trend following
- Reduced trading frequency
- Momentum-based trades
- Passive approach

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
