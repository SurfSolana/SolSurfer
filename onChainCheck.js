const { Connection, PublicKey } = require('@solana/web3.js');
const { struct, u128 } = require('@project-serum/borsh');
const axios = require('axios');

const BASE_PRICE_URL = "https://api.jup.ag/price/v2?ids=";
const TOKEN = "So11111111111111111111111111111111111111112";

// Token decimal configurations
const TOKEN_DECIMALS = {
    SOL: 9,
    USDC: 6,
    JUP: 6,
    WIF: 6,
    BONK: 5
};

// Helper function to convert from raw to UI amount
function toUIAmount(amount, decimals) {
    return (Number(amount) / Math.pow(10, decimals)).toFixed(decimals);
}

async function fetchPrice(BASE_PRICE_URL, TOKEN, maxRetries = 5, retryDelay = 5000) {
    if (!BASE_PRICE_URL || !TOKEN) {
        throw new Error('BASE_PRICE_URL and TOKEN are required');
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const response = await axios.get(`${BASE_PRICE_URL}${TOKEN}`);
            
            if (!response.data?.data?.[TOKEN]) {
                throw new Error('Invalid response structure');
            }
            
            const priceData = response.data.data[TOKEN];
            const price = parseFloat(priceData.price);
            
            if (!price || isNaN(price)) {
                throw new Error('Invalid price value received');
            }
            
            console.log(`Current ${TOKEN.slice(0, 8)}... Price: $${price.toFixed(2)}`);
            
            return parseFloat(price.toFixed(2));
            
        } catch (error) {
            console.error(`Error fetching price (attempt ${attempt}/${maxRetries}):`, error.message);

            if (attempt === maxRetries) {
                throw new Error(`Failed to fetch price after ${maxRetries} attempts`);
            }

            console.log(`Retrying in ${retryDelay / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
}

// Account discriminator for the Counter account
const COUNTER_DISCRIMINATOR = Buffer.from([255, 176, 4, 245, 188, 253, 124, 25]);

// Define the data layout for the account data (excluding discriminator)
const dataLayout = struct([
    u128('successful_trades'),
    u128('sol_lamport_volume'),
    u128('usd_lamport_volume'),
    u128('jup_lamport_volume'),
    u128('wif_lamport_volume'),
    u128('bonk_lamport_volume'),
]);

async function fetchAndDecodeAccount() {
    const connection = new Connection('https://api.mainnet-beta.solana.com', 'confirmed');
    const accountAddress = new PublicKey('GNZtRcvcik8UBtekeLDBY34K1yiuVv7mej8g5aPgZxhh');

    try {
        // Fetch SOL price first
        const solPrice = await fetchPrice(BASE_PRICE_URL, TOKEN);
        
        const accountInfo = await connection.getAccountInfo(accountAddress);
        
        if (!accountInfo) {
            console.log('Account not found');
            return;
        }

        // Verify the account discriminator
        const accountDiscriminator = accountInfo.data.slice(0, 8);
        if (!accountDiscriminator.equals(COUNTER_DISCRIMINATOR)) {
            console.error('Invalid account discriminator');
            console.error('Expected:', COUNTER_DISCRIMINATOR);
            console.error('Got:', accountDiscriminator);
            return;
        }

        // Skip the 8-byte discriminator and decode the rest
        const decodedData = dataLayout.decode(accountInfo.data.slice(8));
        
        // First show raw decoded data
        console.log('Raw Account Data:');
        Object.entries(decodedData).forEach(([key, value]) => {
            console.log(`${key}: ${value.toString(10)}`); // Convert BN to decimal string
        });

        // Calculate UI amounts
        const solUIAmount = Number(decodedData.sol_lamport_volume.toString()) / 1e9;
        const usdcUIAmount = Number(decodedData.usd_lamport_volume.toString()) / 1e6;
        const jupUIAmount = Number(decodedData.jup_lamport_volume.toString()) / 1e6;
        const wifUIAmount = Number(decodedData.wif_lamport_volume.toString()) / 1e6;
        const bonkUIAmount = Number(decodedData.bonk_lamport_volume.toString()) / 1e5;

        // Calculate total value in USD
        const totalValueUSD = solUIAmount * solPrice;

        const formattedData = {
            successful_trades: Number(decodedData.successful_trades.toString()),
            volumes: {
                SOL: {
                    raw_lamports: decodedData.sol_lamport_volume.toString(),
                    amount: solUIAmount.toFixed(9),
                    usd_value: (solUIAmount * solPrice).toFixed(2)
                },
                USDC: {
                    raw_units: decodedData.usd_lamport_volume.toString(),
                    amount: usdcUIAmount.toFixed(6)
                },
                JUP: {
                    raw_units: decodedData.jup_lamport_volume.toString(),
                    amount: jupUIAmount.toFixed(6)
                },
                WIF: {
                    raw_units: decodedData.wif_lamport_volume.toString(),
                    amount: wifUIAmount.toFixed(6)
                },
                BONK: {
                    raw_units: decodedData.bonk_lamport_volume.toString(),
                    amount: bonkUIAmount.toFixed(5)
                }
            },
            summary: {
                sol_price_usd: solPrice,
                sol_value_usd: (solUIAmount * solPrice).toFixed(2),
                usdc_value: usdcUIAmount.toFixed(2),
                total_usd_volume: (solUIAmount * solPrice + usdcUIAmount).toFixed(2)
            }
        };

        console.log('\nFormatted Account Data:');
        console.log(JSON.stringify(formattedData, null, 2));
        
        console.log('\nVolume Summary:');
        console.log(`SOL/USD Volume: $${(solUIAmount * solPrice).toFixed(2)}`);
        console.log(`USDC Volume: $${usdcUIAmount.toFixed(2)}`);
        console.log(`Total Volume: $${(solUIAmount * solPrice + usdcUIAmount).toFixed(2)}`);

    } catch (error) {
        console.error('Error fetching or decoding account:', error);
    }
}

// Run the decoder
fetchAndDecodeAccount();