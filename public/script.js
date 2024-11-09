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

let sentimentBoundaries = {
    EXTREME_FEAR: 20,
    FEAR: 40,
    GREED: 60,
    EXTREME_GREED: 80
};

let serverType = null;
let serverName = null;
let priceUnit = 'usd';
let lastTradingData;
export let isLocked = true;

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

	// Event listener for Enter key press
	document.getElementById('passwordInput').addEventListener('keypress', function(event) {
    if (event.key === 'Enter') {
        login(); // Trigger the login on Enter press
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
			// No error handling for incorrect password here, so the user can keep typing
        })
        .catch(error => console.error('Error:', error));
}

	// Event listener for automatic login when a valid password is typed
	document.getElementById('passwordInput').addEventListener('input', function(event) {
    const password = event.target.value;
    
    // Send the password to the server as it's typed
    if (password.length > 0) { // Avoid sending empty requests
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

function togglePriceUnit() {
    priceUnit = priceUnit === 'usd' ? 'eur' : 'usd';
    updateTradingData(lastTradingData);
}

function updateTradingData(data) {
    lastTradingData = data;
    const priceLabel = priceUnit === 'usd' ? '$' : '€';
    const price = priceUnit === 'usd' ? data?.price?.usd : data?.price?.eur;

    timestampElement.textContent = data?.timestamp || 'Please Wait';

    const formatValue = (value, prefix = '', suffix = '') => {
        if (value === null || value === undefined) return 'Please Wait';
        if (value === 'N/A') return 'Please Wait';

        // Handle array or object values
        if (typeof value === 'object') {
            if (Array.isArray(value)) {
                return value.join(', ');
            }
            // For streakStats or other objects, check if we need to access specific properties
            if (value.fgi !== undefined) {
                return value.fgi.toString();
            }
            // For other objects, return N/A to avoid [object Object]
            return 'N/A';
        }

        return `${prefix}${value}${suffix}`;
    };

    const dataPoints = [];

    // Only add points if we have valid data
    if (data) {
        dataPoints.push(
            { label: "Portfolio Value", value: formatValue(data.portfolioValue?.[priceUnit], priceLabel), icon: "fa-solid fa-wallet" },
            { label: "Portfolio Total Change", value: formatValue(data.portfolioTotalChange, '', '%'), icon: "fa-solid fa-percentage" },
            { label: "SOL Price", value: formatValue(price, priceLabel), icon: "fa-solid fa-coins" },
            { label: "Solana Market Change", value: formatValue(data.solanaMarketChange, '', '%'), icon: "fa-solid fa-percentage" },
            { label: "Portfolio Weighting", value: data.portfolioWeighting ? `${data.portfolioWeighting.usdc}% USDC, ${data.portfolioWeighting.sol}% SOL` : 'Please Wait', icon: "fa-solid fa-chart-pie", fullWidth: true },
            { label: "SOL Balance", value: formatValue(data.solBalance, '', ' SOL'), icon: "fa-solid fa-coins" },
            { label: "USDC Balance", value: formatValue(data.usdcBalance, '', ' USDC'), icon: "fa-solid fa-credit-card" },
            { label: "Average Entry Price", value: formatValue(data.averageEntryPrice?.[priceUnit], priceLabel), icon: "fa-solid fa-sign-in-alt" },
            { label: "Average Sell Price", value: formatValue(data.averageSellPrice?.[priceUnit], priceLabel), icon: "fa-solid fa-sign-out-alt" },
            { label: "Program Run Time (Hours/Mins/Seconds)", value: `${data.programRunTime || 'Please Wait'}`, icon: "fa-solid fa-clock" },
            { label: "Estimated APY (Compared to Holding 100% SOL)", value: formatValue(data.estimatedAPY, '', typeof data.estimatedAPY === 'number' ? '%' : ''), icon: "fa-solid fa-chart-line" }
        );

        if (serverType === 'wave') {
            // Format sentiment streak - handle both string and object cases
            let streakDisplay = 'No streak';
            if (data.sentimentStreak) {
                if (typeof data.sentimentStreak === 'object') {
                    // If it's an object with fgi values, show those
                    streakDisplay = data.sentimentStreak.values || 'No streak';
                } else if (Array.isArray(data.sentimentStreak)) {
                    // If it's an array, join the values
                    streakDisplay = data.sentimentStreak.join(', ');
                } else {
                    // If it's a simple value, show it directly
                    streakDisplay = data.sentimentStreak.toString();
                }
            }

            dataPoints.push(
                { label: "Current Sentiment Streak", value: streakDisplay, icon: "fa-solid fa-trophy" },
                { label: "Streak Threshold", value: formatValue(data.streakThreshold), icon: "fa-solid fa-bullseye" },
                { label: "Average Streak Length", value: formatValue(data.streakStats?.averageLength), icon: "fa-solid fa-bars-progress" },
                { label: "Total Streaks", value: formatValue(data.streakStats?.totalStreaks), icon: "fa-solid fa-chart-line" }
            );
        }
    }

    // Add error handling for DOM manipulation
    try {
        tradingDataElement.innerHTML = dataPoints.map(point => `
            <div class="data-item ${point.fullWidth ? 'full-width' : ''}">
                <div class="data-icon"><i class="${point.icon}"></i></div>
                <div class="data-content">
                    <div class="data-label">${point.label}</div>
                    <div class="data-value">${point.value}</div>
                </div>
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

    // Handle Wave-specific parameters only if they exist
    if (serverType === 'wave') {
        if (params.STREAK_THRESHOLD !== undefined) {
            const streakThreshold = document.getElementById('streakThreshold');
            if (streakThreshold) {
                streakThreshold.value = params.STREAK_THRESHOLD;
            }
        }
        if (params.TRADE_MULTIPLIER !== undefined) {
            const tradeMultiplier = document.getElementById('tradeMultiplier');
            if (tradeMultiplier) {
                tradeMultiplier.value = params.TRADE_MULTIPLIER;
            }
        }
    }
	updateSentimentBoundaries(params.SENTIMENT_BOUNDARIES);
	if (serverType === 'pulse') {
            createFearGreedChart(params);
        }
	initializeLockButton();
	initializeSlider(params, serverType, isLocked);
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
    const formattedTime = tradeDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    let tradeContent;
    if (trade.success === false) {
        tradeContent = `${formattedTime}: ${trade.sentiment} transaction failed, click for details`;
        tradeItem.classList.add('trade-failed');
    } else {
        const action = trade.type;
        const amount = parseFloat(trade.amount).toFixed(6);
        const price = parseFloat(trade.price).toFixed(2);
        const unit = 'SOL';
        tradeContent = `${formattedTime}: ${action} ${amount} ${unit} at $${price}`;
        tradeItem.classList.add(action.toLowerCase() === 'bought' ? 'trade-buy' : 'trade-sell');
    }

    console.log('Trade content:', tradeContent);

    const tradeLink = document.createElement('a');
    tradeLink.href = trade.txUrl || '#';
    tradeLink.target = "_blank";
    tradeLink.textContent = tradeContent;

    tradeItem.appendChild(tradeLink);

    tradeListElement.insertBefore(tradeItem, tradeListElement.firstChild);
    if (tradeListElement.children.length > 10) {
        tradeListElement.removeChild(tradeListElement.lastChild);
    }

    console.log('Trade added to list');
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

// Initial check
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
    serverType = serverInfo.type;
    serverName = serverInfo.name;

    // Update title and header
    document.title = `${serverName} v${serverInfo.version}`;
    const headerElement = document.querySelector('#botTitle');
    if (headerElement) {
        headerElement.textContent = `> ${serverName} Fear and Greed Trader`;
    }
    document.body.className = serverInfo.type === 'wave' ? 'wave-theme' : 'pulse-theme';

    // Configure UI based on server type
    if (serverType === 'wave') {
        // Show Wave-specific elements and hide Pulse elements
        document.querySelectorAll('.wave-only').forEach(el => el.style.display = 'block');
        document.querySelectorAll('.pulse-only').forEach(el => el.style.display = 'none');
        document.getElementById('chartContainer').style.display = 'none';
    } else {
        // Hide Wave-specific elements and show Pulse elements
        document.querySelectorAll('.wave-only').forEach(el => el.style.display = 'none');
        document.querySelectorAll('.pulse-only').forEach(el => el.style.display = 'block');
    }

    // Update version display with bot identifier
    const versionElement = document.getElementById('versionNumber');
    if (versionElement) {
        const prefix = serverType === 'wave' ? 'Wave v' : 'Pulse v';
        versionElement.textContent = `${prefix}${serverInfo.version}`;
    }
});

socket.on('disconnect', () => {
    console.log('Disconnected from WebSocket');
    showFeedback('Disconnected from server', 'error');
});

socket.on('tradingUpdate', (data) => {
    updateTradingData(data);
    console.log('Client received trading update with version:', data.version);
    console.log('Received trading update:', data);

    if (data.recentTrades && data.recentTrades.length > 0) {
        const mostRecentTrade = data.recentTrades[0];
        console.log('Most recent trade:', mostRecentTrade);

        // Get all current trades in the list
        const currentTradeList = document.querySelector('#tradeList');
        const existingTrades = currentTradeList?.querySelectorAll('li a');

        // Check if this is a duplicate trade by comparing transaction URLs with all existing trades
        let isDuplicate = false;
        if (existingTrades && mostRecentTrade.txUrl) {
            isDuplicate = Array.from(existingTrades).some(trade => trade.href === mostRecentTrade.txUrl);
            if (isDuplicate) {
                console.log('Duplicate trade detected (matching txUrl in list), skipping addition');
            }
        }

        // Only add the trade if it's not a duplicate
        if (!isDuplicate) {
            console.log('Trade to add:', mostRecentTrade);
            addTrade(mostRecentTrade);
        }
    } else {
        console.log('No recent trades in the update');
    }
});

export function updateParams(e, sliderBoundaries) {

    if (e && typeof e.preventDefault === 'function') {
        e.preventDefault();
    }
	
	if (!sliderBoundaries) {
        sliderBoundaries = sentimentBoundaries;
    }
	
    const formData = new FormData(paramForm);

    // Common parameters
    const params = {
        SENTIMENT_BOUNDARIES: sliderBoundaries,
		SENTIMENT_MULTIPLIERS: {}
    };
	
	params.SENTIMENT_MULTIPLIERS = {
        EXTREME_FEAR: parseFloat(formData.get('extremeFearMultiplier')),
        FEAR: parseFloat(formData.get('fearMultiplier')),
        GREED: parseFloat(formData.get('greedMultiplier')),
        EXTREME_GREED: parseFloat(formData.get('extremeGreedMultiplier'))
    };
	
    // Add version-specific parameters
    if (serverType === 'wave') {
        params.STREAK_THRESHOLD = parseInt(formData.get('streakThreshold'));
        params.TRADE_MULTIPLIER = parseFloat(formData.get('tradeMultiplier'));
    }
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
			if (serverType === 'pulse') {
            createFearGreedChart(params);
        }
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

document.addEventListener('DOMContentLoaded', () => {
    fetchRecentTrades();
});

function showFeedback(message, type) {
    feedbackElement.textContent = message;
    feedbackElement.className = type;
    setTimeout(() => {
        feedbackElement.textContent = '';
        feedbackElement.className = '';
    }, 5000);
}

// Function to add the toggle button next to the "Current Trading Data" title
function addToggleButton() {
    const cardHeader = document.querySelector('.card:nth-child(2) h2'); // Select the second card's header
    if (!cardHeader.querySelector('.price-toggle')) {
        const toggleButton = document.createElement('button');
        toggleButton.textContent = 'Toggle USD/EUR';
        toggleButton.className = 'price-toggle';
        toggleButton.onclick = togglePriceUnit;
        cardHeader.appendChild(toggleButton);
    }
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

    // Set initial lock state based on isLocked
    toggleLockedState(isLocked);
    updateLockIcon(lockIcon, isLocked);
	
    // Toggle lock state on button click
    lockToggleButton.addEventListener("click", function () {
        isLocked = !isLocked;
		updateLockIcon(lockIcon, isLocked);
        toggleLockedState(isLocked);
		updateSliderBehavior(slider, isLocked);
    });
}

function updateLockIcon(lockIcon, isLocked) {
    if (isLocked) {
        lockIcon.classList.remove("fa-lock-open"); // Remove the open lock icon
        lockIcon.classList.add("fa-lock"); // Add the closed lock icon
    } else {
        lockIcon.classList.remove("fa-lock"); // Remove the closed lock icon
        lockIcon.classList.add("fa-lock-open"); // Add the open lock icon
    }
}

// Call this function once when the page loads
document.addEventListener('DOMContentLoaded', addToggleButton);
document.addEventListener('DOMContentLoaded', attachInputListeners);
