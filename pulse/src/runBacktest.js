const PulseSurferBacktest = require('./backtest');

async function main() {
    const backtester = new PulseSurferBacktest({
        sol: 10,
        usdc: 1000
    });

    // Load your historical data
    await backtester.loadHistoricalData('./historical_data.csv');
    
    // Run 1000 parameter combinations
    const results = await backtester.optimizeParameters(1000);
    
    // Save results
    console.log('Top 5 Parameter Combinations:');
    results.slice(0, 5).forEach((result, i) => {
        console.log(`\nRank ${i + 1}:`);
        console.log('Settings:', result.settings);
        console.log('ROI:', result.roi.toFixed(2) + '%');
        console.log('Net PnL:', '$' + result.netPnL.toFixed(2));
        console.log('Win Rate:', result.performance.winRate.toFixed(2) + '%');
        console.log('Max Drawdown:', result.performance.maxDrawdownPercent.toFixed(2) + '%');
    });
}

main().catch(console.error);