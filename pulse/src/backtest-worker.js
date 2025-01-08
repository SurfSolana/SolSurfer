const { parentPort, workerData } = require('worker_threads');
const PulseSurferBacktest = require('./backtest');
const OrderBook = require('./orderBook');

async function runWorkerTests() {
    const backtester = new PulseSurferBacktest(workerData.initialBalance);
    // Use pre-loaded data
    backtester.historicalData = workerData.historicalData;
    const orderBook = new OrderBook();
    orderBook.trades = [];  // Ensure fresh start
    
    const results = [];
    for (let i = 0; i < workerData.testsPerWorker; i++) {
        const testSettings = {
            SENTIMENT_BOUNDARIES: {
                EXTREME_FEAR: Math.floor(Math.random() * 21) + 10,
                FEAR: Math.floor(Math.random() * 20) + 31,
                GREED: Math.floor(Math.random() * 20) + 51,
                EXTREME_GREED: Math.floor(Math.random() * 20) + 71
            },
            SENTIMENT_MULTIPLIERS: {
                EXTREME_FEAR: (Math.floor(Math.random() * 100) + 1) * 0.001,
                FEAR: (Math.floor(Math.random() * 50) + 1) * 0.001,
                GREED: (Math.floor(Math.random() * 50) + 1) * 0.001,
                EXTREME_GREED: (Math.floor(Math.random() * 100) + 1) * 0.001
            },
            MIN_PROFIT_PERCENT: (Math.floor(Math.random() * 10) + 1) * 0.2,
            TRADE_COOLDOWN_MINUTES: (Math.floor(Math.random() * 12) + 1) * 5
        };
        
        const result = await backtester.runBacktest(testSettings);
        results.push(result);
        
        parentPort.postMessage({ type: 'progress', workerId: workerData.workerId });
    }
    
    parentPort.postMessage({ type: 'complete', results });
}

runWorkerTests().catch(error => {
    parentPort.postMessage({ type: 'error', error: error.message });
});