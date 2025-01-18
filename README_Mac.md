# SolSurfer Installation Guide for macOS

SolSurfer is an automated trading bot for SOL/USDC pairs on the Solana blockchain. This guide will walk you through the installation process on your Mac, starting from the absolute basics.

## Before You Start

You'll need:

- About $100 worth of SOL and USDC for trading
- About 30 minutes of time

## Opening Terminal

Terminal is a program that lets you type commands to your Mac. To open it:

1. Click the magnifying glass (🔍) in the top-right corner of your screen
2. Type "Terminal"
3. Click the Terminal app (it looks like a black box)

You'll use Terminal for many of the following steps. Keep it open throughout the installation process.

## Checking and Installing Required Tools

### 1. Homebrew

Homebrew is a tool that helps install development related software on your Mac.

Check if installed:

```other
brew --version
```

If you see "command not found", install it:

```other
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

After installation, you might need to restart Terminal.

### 2. Node.js and npm

Node.js lets you run JavaScript programs on your computer. npm helps install Node.js packages.

Check if installed:

```other
node --version
npm --version
```

If either command shows "command not found", install both:

```other
brew install node
```

### 3. Git

Git helps download and manage code.

Check if installed:

```other
git --version
```

If not found, install it:

```other
brew install git
```

## Required Accounts Setup

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

## Installation Steps

1. Download SolSurfer:

```other
git clone https://github.com/SurfSolana/SolSurfer.git
```

2. Move into the SolSurfer folder:

```other
cd solsurfer
```

3. Install required packages:

```other
npm install
```

## Configuration

1. Create your settings file:

```other
cp user/.env.example user/.env
```

2. Open the settings file in TextEdit:

```other
open -e user/.env
```

3. Replace these lines with your information:

```other
# Before:
PRIVATE_KEY=your_wallet_private_key
RPC_URL=your_solana_rpc_url
ADMIN_PASSWORD=choose_a_secure_password
PORT=3000

# After (example - use your own values):
PRIVATE_KEY=5KNsxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
RPC_URL=https://rpc-devnet.helius.xyz/v0/xxxxx
ADMIN_PASSWORD=MySecurePassword123
PORT=3000
```

4. Save the file (CMD + S) and close TextEdit
5. Make the start script runnable:

```other
chmod +x start_surfer.sh
```

## Starting SolSurfer

1. Start the program:

```other
./start_surfer.sh
```

2. Choose your trading strategy when prompted:
   - **PulseSurfer**: Trades based on market sentiment
   - **WaveSurfer**: Trades based on price momentum
3. View your dashboard:
   - Open Safari or your preferred browser
   - Go to: [http://localhost:3000](http://localhost:3000)
   - Log in using the ADMIN_PASSWORD you set earlier

## Trading Setup

1. Start with Test Mode:
   - Open `user/settings.json` in TextEdit:

```other
open -e user/settings.json
```

2. Adjust trading settings:

```json
{
  "SENTIMENT_BOUNDARIES": {
    "EXTREME_FEAR": 15,
    "FEAR": 35,
    "GREED": 65,
    "EXTREME_GREED": 85
  },
  "SENTIMENT_MULTIPLIERS": {
    "EXTREME_FEAR": 0.05,
    "FEAR": 0.03,
    "GREED": 0.03,
    "EXTREME_GREED": 0.05
  }
}
```

## Troubleshooting

If you see "Permission denied":

```other
sudo chmod +x start_surfer.sh
```

If npm install fails:

```other
npm cache clean --force
npm install
```

If you can't access the dashboard:

- Change the port in your .env file to 3001 or 3002
- Restart SolSurfer

## Getting Help

1. Join our community:
   - [Discord](https://discord.gg/dpzudaBwSa)
   - Follow [@spuddya7x](https://twitter.com/spuddya7x)
   - [GitHub Issues](https://github.com/SurfSolana/SolSurfer/issues)
2. Read more:
   - Check the FAQ
   - Review [Strategy Guides](./docs/strategies/)
   - Read the Risk Disclaimer

## Safety Tips

- Never share your private key or password
- Start with small amounts when trading
- Keep your computer updated and secure
- Regularly check for SolSurfer updates

## License

MIT License - See [LICENSE](./LICENSE) file for details
