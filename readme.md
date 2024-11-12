
# SolSurfer: Solana Fear and Greed Index Trading Suite 🏄‍♂️🌊

![GitHub last commit](https://img.shields.io/github/last-commit/SurfSolana/SolSurfer)
![GitHub issues](https://img.shields.io/github/issues/SurfSolana/SolSurfer)
![GitHub number of milestones](https://img.shields.io/github/milestones/all/SurfSolana/SolSurfer)
![GitHub stars](https://img.shields.io/github/stars/SurfSolana/SolSurfer?style=social)
[![Twitter Follow](https://img.shields.io/twitter/follow/spuddya7x?style=social)](https://twitter.com/spuddya7x)

[Join our Discord community](https://discord.gg/H5MCsYjckc) to discuss SolSurfer, get support, and stay updated on the latest developments.

SolSurfer is a comprehensive trading suite featuring two distinct trading bots - PulseSurfer and WaveSurfer - that trade SOL/USDC on the Solana blockchain using different Fear and Greed Index strategies. Choose the strategy that best matches your trading style and risk preferences.

## 🚀 Features

- 📊 Two unique trading strategies based on the Solana Fear and Greed Index
- 💼 Automated SOL/USDC trading on Solana
- 🎛️ Customizable trading parameters for each strategy
- 📈 Live portfolio tracking and performance metrics
- 🖥️ Web-based dashboard for easy monitoring and configuration
- 🔒 Secure, password-protected access to the trading interface

## 📊 Trading Strategies

### 🌊 PulseSurfer
PulseSurfer operates on immediate market sentiment, making trades based on current Fear and Greed readings:

1. **Direct Sentiment Trading**:
   - Buys in fear markets (Extreme Fear or Fear)
   - Sells in greed markets (Greed or Extreme Greed)
   - Holds in neutral markets

2. **Position Sizing**:
   - Trade size determined by sentiment multipliers
   - Configurable multipliers for each sentiment level

### 🌊 WaveSurfer
WaveSurfer uses a momentum-based approach, trading on sustained sentiment trends:

1. **Streak Building**:
   - Tracks consecutive readings of similar sentiments
   - Requires a minimum streak threshold (default: 5) to confirm trends

2. **Trade Execution**:
   - Only trades when sentiment returns to neutral after a streak
   - Buys after Fear/Extreme Fear streaks
   - Sells after Greed/Extreme Greed streaks

3. **Position Sizing**:
   - Trade size determined by the Trade Multiplier setting
   - Default multiplier is 15% of the selling token balance

## 🛠️ Setup

### Prerequisites

- Node.js (v14 or later)
- npm (v6 or later)
- A Solana wallet with SOL and USDC
- (Recommended Minimum is $50 in SOL and USDC each)

### Installation

1. Clone the repository:
```bash
git clone https://github.com/SurfSolana/SolSurfer.git
cd solsurfer
```

2. Install dependencies:
```bash
npm install
```

3. Run the bot once using either:
   - Windows: `start_surfer.bat`
   - Mac/Linux: `start_surfer.sh`

   Note: For Mac/Linux, make the file executable first:
   ```bash
   chmod +x start_surfer.sh
   ```

4. Select your trading strategy (1: PulseSurfer or 2: WaveSurfer)

5. Edit the `.env` file with your details:
```
PRIVATE_KEY=your_wallet_private_key
RPC_URL=your_solana_rpc_url
ADMIN_PASSWORD=your_web_interface_password
PORT=3000
```

6. Configure trading parameters in `settings.json`:

```json
{

// Shared settings between both bots

SENTIMENT_BOUNDARIES: {

EXTREME_FEAR:  15,

FEAR:  35,

GREED:  65,

EXTREME_GREED:  85

},

USER_MONTHLY_COST:  0,

DEVELOPER_TIP_PERCENTAGE:  0,

MONITOR_MODE:  false,

  

// PulseSurfer specific settings

SENTIMENT_MULTIPLIERS: {

EXTREME_FEAR:  0.05,

FEAR:  0.03,

GREED:  0.03,

EXTREME_GREED:  0.05

},

  

// WaveSurfer specific settings

STREAK_THRESHOLD:  5,

TRADE_MULTIPLIER:  15  // Percentage of balance to trade

};
```

## 🏃‍♂️ Running SolSurfer

Either via the start script ```start_surfer```, or manually in your preferred CLI:

1. Start the trading bot:
```bash
npm start
```

2. Select your preferred trading strategy:
   - 1: PulseSurfer (direct sentiment trading)
   - 2: WaveSurfer (momentum-based trading)

3. Access the web interface:
   - Local: `http://localhost:3000`
   - Remote: Port forward your selected port and use your machine's Public IPv4 Address

4. Log in using your configured `ADMIN_PASSWORD`

## 📊 Dashboard Features

The web dashboard provides comprehensive trading information:

- Current Fear and Greed Index with visual indicator
- Active sentiment streaks (WaveSurfer)
- Recent trades and transaction history
- Portfolio value and balance distribution
- Performance metrics and ROI calculations
- Real-time trade notifications

## 🤔 Choosing Your Strategy

- **PulseSurfer**: Better for:
  - Active trading
  - Quick market responses
  - Higher trading frequency
  - Shorter-term opportunities

- **WaveSurfer**: Better for:
  - Trend following
  - Reduced trading frequency
  - Momentum capture
  - Lower maintenance trading

## ⚠️ Disclaimer

Trading cryptocurrencies carries a high level of risk and may not be suitable for all investors. The high degree of leverage can work against you as well as for you. Before deciding to trade cryptocurrencies, you should carefully consider your investment objectives, level of experience, and risk appetite. The possibility exists that you could sustain a loss of some or all of your initial investment and therefore you should not invest money that you cannot afford to lose.

## 📜 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🤝 Contributing

Contributions, issues, and feature requests are welcome! Feel free to check [issues page](https://github.com/SurfSolana/solsurfer/issues).

## 👨‍💻 Author

**SpuddyA7X**
- GitHub: [@SurfSolana](https://github.com/SurfSolana)
- Twitter: [@SpuddyA7X](https://twitter.com/SpuddyA7X)

## 🌟 Show your support

Give a ⭐️ if this project helped you!

---

Happy trading with SolSurfer! 🏄‍♂️🌊
