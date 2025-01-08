const { Worker } = require('worker_threads');
const os = require('os');
const fs = require('fs');


async function loadHistoricalData(csvPath) {
    const rows = fs.readFileSync(csvPath, 'utf8')
        .split('\n')
        .filter(row => row.trim());
    
    const data = [];
    for (const row of rows) {
        const [time, date, price, fgi] = row.split(',');
        if (!time || !date || !price || !fgi) continue;
        
        data.push({
            timestamp: new Date(`${date} ${time}`).getTime(), // Pre-convert to timestamp
            price: parseFloat(price),
            fgi: parseFloat(fgi.trim())
        });
    }
    
    return data.sort((a, b) => a.timestamp - b.timestamp);
}

async function runParallelBacktests(iterations = 1000, csvPath = './historical_data.csv') {
    console.log('Loading historical data...');
    const historicalData = await loadHistoricalData(csvPath);
    console.log(`Loaded ${historicalData.length} data points\n`);

    const numCPUs = os.cpus().length;
    const numWorkers = numCPUs - 1;
    const testsPerWorker = Math.ceil(iterations / numWorkers);
    
    console.log(`Running ${iterations} backtests using ${numWorkers} workers`);
    console.log(`Each worker will run ${testsPerWorker} tests\n`);
    
    const startTime = Date.now();
    let completedTests = 0;
    const allResults = [];
    
    const workers = Array(numWorkers).fill().map((_, i) => {
        const worker = new Worker('./backtest-worker.js', {
            workerData: {
                workerId: i,
                testsPerWorker,
                historicalData,
                initialBalance: {
                    sol: 10,
                    usdc: 1000
                }
            }
        });
        
        worker.on('message', (message) => {
            if (message.type === 'progress') {
                completedTests++;
                if (completedTests % 10 === 0) {
                    const elapsed = (Date.now() - startTime) / 1000;
                    const progress = (completedTests / iterations) * 100;
                    console.log(`Progress: ${progress.toFixed(1)}% (${completedTests}/${iterations}) - ${elapsed.toFixed(0)}s elapsed`);
                }
            }
            else if (message.type === 'complete') {
                allResults.push(...message.results);
                worker.terminate();
            }
        });
    
        worker.on('error', (error) => {
            console.error(`Worker ${i} error:`, error);
        });
    
        worker.on('exit', (code) => {
            if (code !== 0) {
                console.error(`Worker ${i} stopped with exit code ${code}`);
            }
        });
        
        return worker;
    });
    
    await Promise.all(workers.map(worker => 
        new Promise((resolve, reject) => {
            worker.on('exit', resolve);
            worker.on('error', reject);
        })
    ));
    
    const totalTime = (Date.now() - startTime) / 1000;
    console.log(`\nCompleted ${iterations} backtests in ${totalTime.toFixed(0)}s`);
    console.log(`Average time per test: ${(totalTime/iterations).toFixed(2)}s`);

    allResults.sort((a, b) => b.roi - a.roi);
    fs.writeFileSync('backtest-results.json', JSON.stringify(allResults, null, 2));
    
    console.log('\nTop 5 Parameter Combinations:');
    allResults.slice(0, 5).forEach((result, i) => {
        console.log(`\nRank ${i + 1}:`);
        console.log('Settings:', JSON.stringify(result.settings, null, 2));
        console.log('ROI:', result.roi.toFixed(2) + '%');
        console.log('Net PnL:', '$' + result.netPnL.toFixed(2));
        console.log('Win Rate:', result.performance.winRate.toFixed(2) + '%');
        console.log('Max Drawdown:', result.performance.maxDrawdownPercent.toFixed(2) + '%');
        console.log('Total Trades:', result.performance.totalTrades);
    });
    
    return allResults;
}

runParallelBacktests().catch(console.error);