import { createFearGreedChart } from './chart.js';
import { initializeSlider } from './slider.js';
import { updateSliderBehavior } from './slider.js';

const socket = io({
    transports: ['websocket'],
    upgrade: false
});

const tradingDataElement = document.getElementById('tradingData');
const timestampElement = document.getElementById('timestamp');
const paramForm = document.getElementById('paramForm');
const feedbackElement = document.getElementById('updateFeedback');
const fgiValueElement = document.getElementById('fgiValue');
const fgiGaugeElement = document.getElementById('fgiGauge');
const fgiPointerElement = document.getElementById('fgiPointer');
const tradeListElement = document.getElementById('tradeList');

// Initialize tooltipDefinitions as an empty object
let tooltipDefinitions = {};

function createTooltipDefinitions(baseTokenName, quoteTokenName) {
    return {
        'Portfolio Value': "Current total value of all assets in your trading portfolio",
        'Portfolio Total Change': "Net percentage change in portfolio value since trading began",
        [`${baseTokenName} Price`]: `Current market price of ${baseTokenName} token`,
        [`${baseTokenName} Market Change`]: `Percentage change in ${baseTokenName} price since bot started trading`,
        'Portfolio Weighting': `Current balance distribution between ${baseTokenName} and ${quoteTokenName} as percentages`,
        [`${baseTokenName} Balance`]: `Available ${baseTokenName} tokens in your trading wallet`,
        [`${quoteTokenName} Balance`]: `Available ${quoteTokenName} tokens in your trading wallet`,
        'Average Entry Price': `Average price paid when buying ${baseTokenName}`,
        'Average Sell Price': `Average price received when selling ${baseTokenName}`,
        'Program Run Time (Hours/Mins/Seconds)': "Total time elapsed since trading began",
        [`Estimated APY (Compared to Holding 100% ${baseTokenName})`]: `Estimated annual return compared to holding 100% ${baseTokenName}, includes trading fees and costs`,
        'Win Rate': "Percentage of closed trades that resulted in profit",
        'Total Trades': "Total number of trades executed since trading began",
        'Open Positions': "Number of currently active trades that haven't been closed",
        'Closed Trades': "Number of completed trades that have been fully settled",
        'Total PnL': "Total realized profit or loss from all closed trades",
        'Unrealized PnL': "Current estimated profit or loss of open positions based on current market price",
        'Total Volume': "Total value of all trades executed in USD",
        'Avg Trade Size': "Average dollar value of individual trades"
    };
}



let sentimentBoundaries = {
    EXTREME_FEAR: 20,
    FEAR: 40,
    GREED: 60,
    EXTREME_GREED: 80
};


let currentBaseTokenAddress
let serverName = null;
let priceUnit = 'usd';
let lastTradingData;
export let isLocked = true;
let baseTokenName
let quoteTokenName
let currentTimeframe = '15m'; // Default timeframe

function showLoginForm() {
    document.getElementById('loginForm').style.display = 'block';
    document.getElementById('mainContent').style.display = 'none';
}

function showMainContent() {
    document.getElementById('loginForm').style.display = 'none';
    document.getElementById('mainContent').style.display = 'block';
}

function login() {
    const password = document.getElementById('passwordInput').value;
    fetch('/api/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showMainContent();
                fetchInitialData();
            } else {
                alert('Invalid password');
            }
        })
        .catch(error => console.error('Error:', error));
}

document.getElementById('passwordInput').addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        login();
    }
});

function autoLogin(password) {
    fetch('/api/login', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password }),
    })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showMainContent();
                fetchInitialData();
            }
        })
        .catch(error => console.error('Error:', error));
}

document.getElementById('passwordInput').addEventListener('input', function(event) {
    const password = event.target.value;
    if (password.length > 0) {
        autoLogin(password);
    }
});

function authenticatedFetch(url, options = {}) {
    return fetch(url, options)
        .then(response => {
            if (response.status === 401) {
                showLoginForm();
                throw new Error('Authentication required');
            }
            return response;
        });
}

function handleTokenInfo(tokenInfo) {
    if (tokenInfo && tokenInfo.baseTokenAddress) {
        updateChartTokenAddress(tokenInfo.baseTokenAddress);
    }
}

function updateChartTokenAddress(baseTokenAddress) {
    if (!baseTokenAddress) {
      console.error("Missing base token address for chart update");
      return;
    }
    
    // Get the iframe element
    const chartIframe = document.getElementById('tokenChart');
    if (!chartIframe) {
      console.error("Chart iframe not found");
      return;
    }
    
    try {
      // Save the current src
      const currentSrc = chartIframe.src;
      
      // Create a new URL using the token address
      const baseChartUrl = "https://birdeye.so/tv-widget/";
      const chartParams = "?chain=solana&viewMode=pair&chartInterval=15&chartType=AREA&chartTimezone=Europe%2FLondon&chartLeftToolbar=hide&theme=dark&chartOverrides=mainSeriesProperties.areaStyle.linecolor%3A%239945ff";
      const newSrc = `${baseChartUrl}${baseTokenAddress}${chartParams}`;
      
      // Only update if different
      if (newSrc !== currentSrc) {
        console.log(`Updating chart from ${currentBaseTokenAddress} to: ${baseTokenAddress}`);
        
        // Add event listeners to detect load errors
        chartIframe.onerror = () => {
          console.error(`Failed to load chart for token: ${baseTokenAddress}`);
          // Optionally show a user-visible error message
        };
        
        chartIframe.src = newSrc;
        currentBaseTokenAddress = baseTokenAddress;
      }
    } catch (error) {
      console.error(`Error updating chart for token ${baseTokenAddress}:`, error);
    }
  }

function updateTradingData(data) {
    lastTradingData = data;
    const priceLabel = '$';
    const price = data?.price?.usd;
    
    // Get token names from the data
    baseTokenName = data?.tokenInfo?.baseToken;
    quoteTokenName = data?.tokenInfo?.quoteToken;
    
    // Get timeframe from the data if available
    if (data?.params?.FGI_TIMEFRAME) {
        currentTimeframe = data.params.FGI_TIMEFRAME;
    }

    // Update token pair in the title with timeframe
    const tokenPairTitle = document.getElementById('tokenPairTitle');
    if (tokenPairTitle && baseTokenName && quoteTokenName) {
        tokenPairTitle.textContent = `> ${baseTokenName}/${quoteTokenName} (${currentTimeframe})`;
    }

    tooltipDefinitions = createTooltipDefinitions(baseTokenName, quoteTokenName);

    timestampElement.textContent = data?.timestamp || 'Please Wait';

    const formatValue = (value, prefix = '', suffix = '') => {
        if (value === null || value === undefined) return 'Please Wait';
        if (value === 'N/A') return 'Please Wait';

        if (typeof value === 'object') {
            if (Array.isArray(value)) {
                return value.join(', ');
            }
            if (value.fgi !== undefined) {
                return value.fgi.toString();
            }
            return 'N/A';
        }

        return `${prefix}${value}${suffix}`;
    };

    const dataPoints = [];

    if (data) {
        dataPoints.push(
            { label: "Portfolio Value", value: formatValue(data.portfolioValue?.[priceUnit], priceLabel), icon: "fa-solid fa-wallet" },
            { label: "Portfolio Total Change", value: formatValue(data.portfolioTotalChange, '', '%'), icon: "fa-solid fa-percentage" },
            { label: `${baseTokenName} Price`, value: formatValue(price, priceLabel), icon: "fa-solid fa-coins" },
            { label: `${baseTokenName} Market Change`, value: formatValue(data.tokenMarketChange || data.solanaMarketChange, '', '%'), icon: "fa-solid fa-percentage" },
            { label: "Portfolio Weighting", value: data.portfolioWeighting ? 
              `${data.portfolioWeighting.quoteToken || data.portfolioWeighting.usdc}% ${quoteTokenName}, ${data.portfolioWeighting.baseToken || data.portfolioWeighting.sol}% ${baseTokenName}` : 
              'Please Wait', icon: "fa-solid fa-chart-pie", fullWidth: true },
            { label: `${baseTokenName} Balance`, value: formatValue(data.baseTokenBalance || data.solBalance, '', ` ${baseTokenName}`), icon: "fa-solid fa-coins" },
            { label: `${quoteTokenName} Balance`, value: formatValue(data.quoteTokenBalance || data.usdcBalance, '', ` ${quoteTokenName}`), icon: "fa-solid fa-credit-card" },
            { label: "Average Entry Price", value: formatValue(data.averageEntryPrice?.[priceUnit], priceLabel), icon: "fa-solid fa-sign-in-alt" },
            { label: "Average Sell Price", value: formatValue(data.averageSellPrice?.[priceUnit], priceLabel), icon: "fa-solid fa-sign-out-alt" },
            { label: "Program Run Time (Hours/Mins/Seconds)", value: `${data.programRunTime || 'Please Wait'}`, icon: "fa-solid fa-clock" },
            { label: `Estimated APY (Compared to Holding 100% ${baseTokenName})`, value: formatValue(data.estimatedAPY, '', typeof data.estimatedAPY === 'number' ? '%' : ''), icon: "fa-solid fa-chart-line" }
        );
    }

    if (data.orderbook) {
        document.getElementById('winRate').textContent = 
            `${data.orderbook.winRate ? data.orderbook.winRate.toFixed(1) : '0.0'}%`;
        document.getElementById('totalTrades').textContent = 
            data.orderbook.totalTrades || '0';
        document.getElementById('openTrades').textContent = 
            data.orderbook.openTrades || '0';
        document.getElementById('closedTrades').textContent = 
            data.orderbook.closedTrades || '0';

        const totalPnlElement = document.getElementById('totalPnl');
        const unrealizedPnlElement = document.getElementById('unrealizedPnl');
        const volumeElement = document.getElementById('totalVolume');
        const avgSizeElement = document.getElementById('avgTradeSize');

        totalPnlElement.textContent = `$${data.orderbook.totalRealizedPnl ? data.orderbook.totalRealizedPnl.toFixed(4) : '0.00'}`;
        unrealizedPnlElement.textContent = `$${data.orderbook.totalUnrealizedPnl ? data.orderbook.totalUnrealizedPnl.toFixed(4) : '0.00'}`;
        volumeElement.textContent = `$${data.orderbook.totalVolume ? data.orderbook.totalVolume.toFixed(4) : '0.00'}`;
        avgSizeElement.textContent = data.orderbook.totalTrades > 0 
            ? `$${(data.orderbook.totalVolume / data.orderbook.totalTrades).toFixed(4)}` 
            : '$0.00';

        totalPnlElement.className = `data-value ${data.orderbook.totalRealizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;
        unrealizedPnlElement.className = `data-value ${data.orderbook.totalUnrealizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}`;

        if (data.orderbook.trades) {
            updateOrderbookTable(data.orderbook.trades, baseTokenName);
        }
    }

    try {
        tradingDataElement.innerHTML = dataPoints.map(point => `
            <div class="data-item ${point.fullWidth ? 'full-width' : ''}">
                <div class="data-icon"><i class="${point.icon}"></i></div>
                <div class="data-content">
                    <div class="data-label">${point.label}</div>
                    <div class="data-value">${point.value}</div>
                </div>
                ${tooltipDefinitions[point.label] ? `
                    <div class="tooltip-trigger">
                        <i class="fa-regular fa-circle-question"></i>
                        <div class="tooltip">${tooltipDefinitions[point.label]}</div>
                    </div>
                ` : ''}
            </div>
        `).join('');

        if (data?.fearGreedIndex) {
            updateFGI(data.fearGreedIndex);
        }
    } catch (error) {
        console.error('Error updating trading data UI:', error);
        tradingDataElement.innerHTML = '<div>Error displaying trading data. Please refresh the page.</div>';
    }
}

function updateOrderbookTable(trades, baseTokenName) {
    const tbody = document.getElementById('orderbookBody');
    if (!tbody) return;

    const sortedTrades = trades.sort((a, b) => {
        const dateA = new Date(a.timestamp);
        const dateB = new Date(b.timestamp);
        return dateB - dateA;
    });

    const limitedTrades = sortedTrades.slice(0, 20);

    tbody.innerHTML = limitedTrades.map(trade => {
        // Get the token amount field name (either baseTokenAmount or solAmount for backward compatibility)
        const amountField = trade.baseTokenAmount !== undefined ? 'baseTokenAmount' : 'solAmount';
        const valueField = trade.quoteTokenValue !== undefined ? 'quoteTokenValue' : 'value';
        
        return `
        <tr>
            <td>${trade.timestamp}</td>
            <td>
                <span class="trade-badge ${trade.direction === 'buy' ? 'trade-type-buy' : 'trade-type-sell'}">
                    ${trade.direction.toUpperCase()}
                </span>
            </td>
            <td>
                <span class="trade-badge ${trade.status === 'open' ? 'trade-status-open' : 'trade-status-closed'}">
                    ${trade.status.toUpperCase()}
                </span>
            </td>
            <td>$${trade.price.toFixed(2)}</td>
            <td>${trade[amountField].toFixed(9)} ${baseTokenName}</td>
            <td>$${trade[valueField].toFixed(2)}</td>
            <td class="${trade.status === 'open' ? 
                (trade.upnl >= 0 ? 'pnl-positive' : 'pnl-negative') : 
                (trade.realizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative')}">
                $${trade.status === 'open' ? 
                    trade.upnl.toFixed(2) : 
                    trade.realizedPnl.toFixed(2)}
            </td>
            <td>${trade.closePrice ? `$${trade.closePrice.toFixed(2)}` : '-'}</td>
        </tr>
    `}).join('') || `<tr><td colspan="8" class="empty-state">No ${baseTokenName} trades found</td></tr>`;
}

function updateFGI(value) {
    fgiValueElement.textContent = value;
    const position = Math.max(0, Math.min(100, value));
    fgiPointerElement.style.left = `${position}%`;

    let currentSentiment;
    if (value < sentimentBoundaries.EXTREME_FEAR) {
        currentSentiment = 'Extreme Fear';
    } else if (value < sentimentBoundaries.FEAR) {
        currentSentiment = 'Fear';
    } else if (value < sentimentBoundaries.GREED) {
        currentSentiment = 'Neutral';
    } else if (value < sentimentBoundaries.EXTREME_GREED) {
        currentSentiment = 'Greed';
    } else {
        currentSentiment = 'Extreme Greed';
    }

    const currentSentimentElement = document.getElementById('currentSentiment');
    if (currentSentimentElement) {
        currentSentimentElement.textContent = currentSentiment;
    }
}

function updateSentimentBoundaries(newBoundaries) {
    sentimentBoundaries = { ...newBoundaries };
    let currentFGI = document.getElementById('fgiValue').textContent;
    updateFGI(parseInt(currentFGI));
}

function updateFormValues(params) {
    if (params.SENTIMENT_MULTIPLIERS) {
        document.getElementById('extremeFearMultiplier').value = params.SENTIMENT_MULTIPLIERS.EXTREME_FEAR;
        document.getElementById('fearMultiplier').value = params.SENTIMENT_MULTIPLIERS.FEAR;
        document.getElementById('greedMultiplier').value = params.SENTIMENT_MULTIPLIERS.GREED;
        document.getElementById('extremeGreedMultiplier').value = params.SENTIMENT_MULTIPLIERS.EXTREME_GREED;
    }
    document.getElementById('monthlyCost').value = params.USER_MONTHLY_COST;
    document.getElementById('devTip').value = params.DEVELOPER_TIP_PERCENTAGE;

    updateSentimentBoundaries(params.SENTIMENT_BOUNDARIES);
    createFearGreedChart(params);
    initializeLockButton();
    initializeSlider(params, isLocked);
    
    // Update timeframe from settings
    if (params.FGI_TIMEFRAME) {
        currentTimeframe = params.FGI_TIMEFRAME;
        
        // Update token pair title with timeframe
        const tokenPairTitle = document.getElementById('tokenPairTitle');
        if (tokenPairTitle && baseTokenName && quoteTokenName) {
            tokenPairTitle.textContent = `> ${baseTokenName}/${quoteTokenName} (${currentTimeframe})`;
        }
    }
}

function updateTradeList(trades) {
    console.log('Updating trade list with:', trades);
    tradeListElement.innerHTML = '';

    if (!trades || trades.length === 0) {
        console.log('No trades available, adding placeholder');
        const placeholderItem = document.createElement('li');
        if (lastTradingData && lastTradingData.monitorMode) {
            placeholderItem.textContent = "This instance is in monitor mode, and will not perform live trades";
            placeholderItem.style.color = 'red';
        } else {
            placeholderItem.textContent = "No trades yet - check back soon!";
        }
        placeholderItem.classList.add('trade-placeholder');
        tradeListElement.appendChild(placeholderItem);
    } else {
        console.log('Adding trades to the list');
        trades.slice().reverse().forEach(trade => addTrade(trade));
    }
}

function addTrade(trade) {
    console.log('Adding trade:', trade);

    if (!trade) {
        console.log('Trade object is null or undefined');
        return;
    }

    const placeholder = tradeListElement.querySelector('.trade-placeholder');
    if (placeholder) {
        tradeListElement.removeChild(placeholder);
    }

    const tradeItem = document.createElement('li');
    const tradeDate = new Date(trade.timestamp);
    
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
    
    const dayName = days[tradeDate.getDay()];
    const day = String(tradeDate.getDate()).padStart(2, '0');
    const month = months[tradeDate.getMonth()];
    const time = tradeDate.toTimeString().split(' ')[0];
    
    const formattedDate = `${dayName}, ${day}/${month}, ${time}`;

    let tradeContent;
    if (trade.success === false) {
        tradeContent = `${formattedDate}: ${trade.sentiment} transaction failed, click for details`;
        tradeItem.classList.add('trade-failed');
    } else {
        const action = trade.type;
        const amount = parseFloat(trade.amount).toFixed(9);
        const price = parseFloat(trade.price).toFixed(2);
        const unit = `${baseTokenName}`;
        tradeContent = `${formattedDate}: ${action} ${amount} ${unit} at $${price}`;
        tradeItem.classList.add(action.toLowerCase() === 'bought' ? 'trade-buy' : 'trade-sell');
    }

    const tradeLink = document.createElement('a');
    tradeLink.href = trade.txUrl || '#';
    tradeLink.target = "_blank";
    tradeLink.textContent = tradeContent;

    tradeItem.appendChild(tradeLink);
    tradeListElement.insertBefore(tradeItem, tradeListElement.firstChild);
    
    if (tradeListElement.children.length > 10) {
        tradeListElement.removeChild(tradeListElement.lastChild);
    }
}

function fetchRecentTrades() {
    authenticatedFetch('/api/recent-trades')
        .then(response => response.json())
        .then(trades => {
            updateTradeList(trades);
        })
        .catch(error => console.error('Error fetching recent trades:', error));
}

function fetchInitialData() {
    authenticatedFetch('/api/initial-data')
        .then(response => {
            if (!response.ok) {
                throw new Error('Initial data not yet available');
            }
            return response.json();
        })
        .then(data => {
            updateTradingData(data);
            updateTradeList(data.recentTrades);
            return authenticatedFetch('/api/params');
        })
        .then(response => response.json())
        .then(data => {
            updateFormValues(data);
        })
        .catch(error => {
            console.error('Error fetching initial data:', error);
            if (error.message !== 'Authentication required') {
                showFeedback('Retrying in 5 seconds...', 'info');
                setTimeout(fetchInitialData, 5000);
            }
        });
}

authenticatedFetch('/api/initial-data')
    .then(() => {
        showMainContent();
        fetchInitialData();
    })
    .catch(() => showLoginForm());

socket.on('connect', () => {
    console.log('Connected to WebSocket');
    showFeedback('Connected to server', 'success');
});

socket.on('serverIdentification', (serverInfo) => {
    console.log('Connected to server:', serverInfo);
    serverName = serverInfo.name;

    // Update the document title with token pair
    const baseToken = serverInfo.tokenInfo?.baseToken || '';
    const quoteToken = serverInfo.tokenInfo?.quoteToken || '';
    
    // Get timeframe if available
    if (serverInfo.params && serverInfo.params.FGI_TIMEFRAME) {
        currentTimeframe = serverInfo.params.FGI_TIMEFRAME;
    }
    
    document.title = `${serverName} v${serverInfo.version} (${baseToken}/${quoteToken} ${currentTimeframe})`;
    
    const headerElement = document.querySelector('h1');
    if (headerElement) {
        headerElement.textContent = `> PulseSurfer Fear and Greed Trader`;
    }
    
    // Set token pair in subtitle with timeframe
    const tokenPairTitle = document.getElementById('tokenPairTitle');
    if (tokenPairTitle && baseToken && quoteToken) {
        tokenPairTitle.textContent = `> ${baseToken}/${quoteToken} (${currentTimeframe})`;
    }
    
    document.body.className = 'pulse-theme';

    const versionElement = document.getElementById('versionNumber');
    if (versionElement) {
        versionElement.textContent = `${serverName} v${serverInfo.version} (${baseToken}/${quoteToken} ${currentTimeframe})`;
    }
    
    // Extract token info if available
    if (serverInfo.tokenInfo) {
        handleTokenInfo(serverInfo.tokenInfo);
    }
});

socket.on('disconnect', () => {
    console.log('Disconnected from WebSocket');
    showFeedback('Disconnected from server', 'error');
});

socket.on('tradingUpdate', (data) => {
    updateTradingData(data);
    
    // Extract token info and update chart
    if (data.tokenInfo) {
        handleTokenInfo(data.tokenInfo);
    }
    
    // Get timeframe if available
    if (data.params && data.params.FGI_TIMEFRAME && data.params.FGI_TIMEFRAME !== currentTimeframe) {
        currentTimeframe = data.params.FGI_TIMEFRAME;
        
        // Update token pair title with new timeframe
        const tokenPairTitle = document.getElementById('tokenPairTitle');
        if (tokenPairTitle && baseTokenName && quoteTokenName) {
            tokenPairTitle.textContent = `> ${baseTokenName}/${quoteTokenName} (${currentTimeframe})`;
        }
        
        // Update version display
        const versionElement = document.getElementById('versionNumber');
        if (versionElement && serverName) {
            versionElement.textContent = `${serverName} v${data.version || 'unknown'} (${baseTokenName}/${quoteTokenName} ${currentTimeframe})`;
        }
    }

    if (data.recentTrades && data.recentTrades.length > 0) {
        const mostRecentTrade = data.recentTrades[0];
        console.log('Most recent trade:', mostRecentTrade);

        const currentTradeList = document.querySelector('#tradeList');
        const existingTrades = currentTradeList?.querySelectorAll('li a');

        let isDuplicate = false;
        if (existingTrades && mostRecentTrade.txUrl) {
            isDuplicate = Array.from(existingTrades).some(trade => trade.href === mostRecentTrade.txUrl);
            if (isDuplicate) {
                console.log('Duplicate trade detected (matching txUrl in list), skipping addition');
            }
        }

        if (!isDuplicate) {
            console.log('Trade to add:', mostRecentTrade);
            addTrade(mostRecentTrade);
        }
    } else {
        console.log('No recent trades in the update');
    }
});

socket.on('paramsUpdated', (params) => {
    // Check if timeframe changed
    if (params.FGI_TIMEFRAME && params.FGI_TIMEFRAME !== currentTimeframe) {
        currentTimeframe = params.FGI_TIMEFRAME;
        
        // Update token pair title with new timeframe
        const tokenPairTitle = document.getElementById('tokenPairTitle');
        if (tokenPairTitle && baseTokenName && quoteTokenName) {
            tokenPairTitle.textContent = `> ${baseTokenName}/${quoteTokenName} (${currentTimeframe})`;
        }
        
        // Update version display
        const versionElement = document.getElementById('versionNumber');
        if (versionElement && serverName) {
            versionElement.textContent = `${serverName} v${lastTradingData?.version || 'unknown'} (${baseTokenName}/${quoteTokenName} ${currentTimeframe})`;
        }
    }
    
    // Update form values
    updateFormValues(params);
});

export function updateParams(e, sliderBoundaries) {
    if (e && typeof e.preventDefault === 'function') {
        e.preventDefault();
    }
    
    if (!sliderBoundaries) {
        sliderBoundaries = sentimentBoundaries;
    }
    
    const formData = new FormData(paramForm);

    console.log('Slider Boundaries:', sliderBoundaries);
    const params = {
        SENTIMENT_BOUNDARIES: sliderBoundaries,
        SENTIMENT_MULTIPLIERS: {
            EXTREME_FEAR: parseFloat(formData.get('extremeFearMultiplier')),
            FEAR: parseFloat(formData.get('fearMultiplier')),
            GREED: parseFloat(formData.get('greedMultiplier')),
            EXTREME_GREED: parseFloat(formData.get('extremeGreedMultiplier'))
        }
    };

    paramsApi(params);
    updateSentimentBoundaries(params.SENTIMENT_BOUNDARIES);
}

function paramsApi(params) {
    authenticatedFetch('/api/params', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
    })
        .then(response => response.json())
        .then(data => {
            console.log('Server response:', data);
            showFeedback('Parameters updated successfully.', 'success');
            createFearGreedChart(params);
        })
        .catch((error) => {
            console.error('Error:', error);
            showFeedback('Error updating parameters. Please try again.', 'error');
        });
}

document.getElementById('restartButton').addEventListener('click', function () {
    if (confirm('Are you sure you want to restart trading? This will reset all position data.')) {
        restartTrading();
    }
});

function restartTrading() {
    authenticatedFetch('/api/restart', { method: 'POST' })
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                showFeedback('Trading restarted successfully. Refreshing data...', 'success');
                fetchInitialData();
            } else {
                showFeedback('Failed to restart trading. Please try again.', 'error');
            }
        })
        .catch(error => {
            console.error('Error restarting trading:', error);
            showFeedback('Error restarting trading. Please try again.', 'error');
        });
}

function showFeedback(message, type) {
    feedbackElement.textContent = message;
    feedbackElement.className = type;
    setTimeout(() => {
        feedbackElement.textContent = '';
        feedbackElement.className = '';
    }, 5000);
}

document.getElementById('settingsButton').addEventListener('click', function () {
    document.getElementById('settingsPopup').style.display = 'block';
    document.getElementById('mainContent').classList.add('blur');
    document.body.classList.add('no-scroll');
});

document.getElementById('closePopupButton').addEventListener('click', function () {
    document.getElementById('settingsPopup').style.display = 'none';
    document.getElementById('mainContent').classList.remove('blur');
    document.body.classList.remove('no-scroll');
});

document.getElementById('monthlyCostButton').addEventListener('click', function() {
    const monthlyCostInput = document.getElementById('monthlyCost');
    const monthlyCost = parseFloat(monthlyCostInput.value);
    
    const params = {
        USER_MONTHLY_COST: monthlyCost,
    }
    paramsApi(params);
});

document.getElementById('devTipButton').addEventListener('click', function() {
    const devTipInput = document.getElementById('devTip');
    const devTip = parseFloat(devTipInput.value);
    
    const params = {
        DEVELOPER_TIP_PERCENTAGE: devTip,
    }
    paramsApi(params);
});

function attachInputListeners() {
    const numberInputs = document.querySelectorAll('#paramForm input[type="number"]');
    numberInputs.forEach(input => {
        input.addEventListener('change', updateParams);
    });
}

function toggleLockedState(isLocked) {
    const paramForm = document.getElementById("paramForm");
    Array.from(paramForm.elements).forEach(element => {
        if (isLocked) {
            element.classList.add("locked");
            element.setAttribute("readonly", true);
        } else {
            element.classList.remove("locked");
            element.removeAttribute("readonly");
        }
    });
}

function initializeLockButton() {
    const lockToggleButton = document.getElementById("lockToggleButton");
    const lockIcon = document.getElementById("lockIcon");

    toggleLockedState(isLocked);
    updateLockIcon(lockIcon, isLocked);
    
    lockToggleButton.addEventListener("click", function () {
        isLocked = !isLocked;
        updateLockIcon(lockIcon, isLocked);
        toggleLockedState(isLocked);
        updateSliderBehavior(slider, isLocked);
    });
}

function updateLockIcon(lockIcon, isLocked) {
    if (isLocked) {
        lockIcon.classList.remove("fa-lock-open");
        lockIcon.classList.add("fa-lock");
    } else {
        lockIcon.classList.remove("fa-lock");
        lockIcon.classList.add("fa-lock-open");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    fetchRecentTrades();
});

document.addEventListener('DOMContentLoaded', attachInputListeners);