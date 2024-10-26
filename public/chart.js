let fearGreedChart;
export function createFearGreedChart(params) {
	
    if (!params || !params.SENTIMENT_MULTIPLIERS || !params.SENTIMENT_BOUNDARIES) {
        console.error('Invalid parameters provided to createFearGreedChart.');
        return;
    }
	
    const ctx = document.getElementById('fearGreedChart').getContext('2d');
	
	if (fearGreedChart) {
        fearGreedChart.destroy();
    }
	
	const highestMultiplier = Math.max(
    params.SENTIMENT_MULTIPLIERS.EXTREME_FEAR,
    params.SENTIMENT_MULTIPLIERS.FEAR,
    params.SENTIMENT_MULTIPLIERS.GREED,
    params.SENTIMENT_MULTIPLIERS.EXTREME_GREED
);

const yMax = highestMultiplier * 1.25;

const boundaryPoints = [
        { x: params.SENTIMENT_BOUNDARIES.EXTREME_FEAR, y: params.SENTIMENT_MULTIPLIERS.EXTREME_FEAR },
        { x: params.SENTIMENT_BOUNDARIES.FEAR, y: params.SENTIMENT_MULTIPLIERS.FEAR },
        { x: params.SENTIMENT_BOUNDARIES.GREED, y: params.SENTIMENT_MULTIPLIERS.GREED },
        { x: params.SENTIMENT_BOUNDARIES.EXTREME_GREED, y: params.SENTIMENT_MULTIPLIERS.EXTREME_GREED },
		{ x: 100, y: params.SENTIMENT_MULTIPLIERS.EXTREME_GREED },
		{ x: 0, y: params.SENTIMENT_MULTIPLIERS.EXTREME_FEAR },
		{ x: params.SENTIMENT_BOUNDARIES.EXTREME_FEAR, y: params.SENTIMENT_MULTIPLIERS.FEAR },
		{ x: params.SENTIMENT_BOUNDARIES.EXTREME_GREED, y: params.SENTIMENT_MULTIPLIERS.GREED }
    ];
	
	const xAxisPoints = Array.from({ length: 21 }, (_, i) => i * 5);
		
    fearGreedChart = new Chart(ctx, {
        type: 'scatter',
        data: {
			datasets: [
            // Dataset to draw the greed to extreme greed line with no dots and tooltips
            {
                data: [
                    { x: params.SENTIMENT_BOUNDARIES.GREED, y: params.SENTIMENT_MULTIPLIERS.GREED },          // Start at greed
                    { x: params.SENTIMENT_BOUNDARIES.EXTREME_GREED, y: params.SENTIMENT_MULTIPLIERS.GREED }, // Horizontal line to extreme greed at greed's y
                    { x: params.SENTIMENT_BOUNDARIES.EXTREME_GREED, y: params.SENTIMENT_MULTIPLIERS.EXTREME_GREED }, // Vertical line to extreme greed
                    { x: 100, y: params.SENTIMENT_MULTIPLIERS.EXTREME_GREED } // Horizontal line to x=100 at extreme greed's y
                ],
                borderColor: 'rgba(20, 241, 149, 0.6)',
				backgroundColor: 'rgba(20, 241, 149, 0.35)',
                pointRadius: 0,
                showLine: true,
                fill: true
            },
            // Dataset to draw the fear to extreme fear line with no dots and tooltips
            {
                data: [
                    { x: params.SENTIMENT_BOUNDARIES.FEAR, y: params.SENTIMENT_MULTIPLIERS.FEAR },          // Start at fear
                    { x: params.SENTIMENT_BOUNDARIES.EXTREME_FEAR, y: params.SENTIMENT_MULTIPLIERS.FEAR }, // Horizontal line to extreme fear at fear's y
                    { x: params.SENTIMENT_BOUNDARIES.EXTREME_FEAR, y: params.SENTIMENT_MULTIPLIERS.EXTREME_FEAR }, // Vertical line to extreme fear
                    { x: 0, y: params.SENTIMENT_MULTIPLIERS.EXTREME_FEAR }                                // Horizontal line to x=0 at extreme fear's y
                ],
                borderColor: 'rgba(255, 99, 132, 0.6)',
				backgroundColor: 'rgba(255, 99, 132, 0.35)',
                pointRadius: 0,
                showLine: true,
                fill: true
            },
            // Dataset to show dots and tooltips ONLY for the key points (greed, extreme greed, fear, extreme fear)
            {
                data: [
                    { x: params.SENTIMENT_BOUNDARIES.EXTREME_FEAR, y: params.SENTIMENT_MULTIPLIERS.EXTREME_FEAR }, // Extreme fear
                    { x: params.SENTIMENT_BOUNDARIES.FEAR, y: params.SENTIMENT_MULTIPLIERS.FEAR },                 // Fear
                    { x: params.SENTIMENT_BOUNDARIES.GREED, y: params.SENTIMENT_MULTIPLIERS.GREED },               // Greed
                    { x: params.SENTIMENT_BOUNDARIES.EXTREME_GREED, y: params.SENTIMENT_MULTIPLIERS.EXTREME_GREED } // Extreme greed
                ], 
				    backgroundColor: function(context) {
                    const point = context.dataIndex;
                    if (point === 0 || point === 1) {
                        return 'rgba(255, 99, 132, 1)'; // Red color for Fear points (Extreme Fear, Fear)
                    }
                    if (point === 2 || point === 3) {
                        return 'rgba(20, 241, 149, 1)'; // Green color for Greed points (Greed, Extreme Greed)
                    }
                    return 'rgba(0, 0, 0, 1)'; // Default color if needed
                },
                borderColor: 'transparent',
                pointRadius: 3, // Show dots
                pointHoverRadius: 6,
                showLine: false,
                fill: false
            }
        ]
    },
        options: {
			responsive: true, // Make the chart responsive
            maintainAspectRatio: true, // Maintain aspect ratio based on the canvas size
            scales: {
                x: {
                    type: 'linear',
                    min: 0,
                    max: 100,
                    ticks: {
                        stepSize: 5
                    },
                    title: {
                        display: false,
                        text: 'FGI'
                    }
                },
                y: {
                    type: 'linear',
                    min: 0,
                    max: yMax,
                    title: {
                        display: false,
						text: 'MULTIPLIER'
                    }
                }
            },
            plugins: {
			legend: {
                display: false, // Hide the legend
            },
            tooltip: {
                callbacks: {
                    label: function(context) {
                        // Hide tooltip for x = 0 and x = 100
                        if (context.parsed.x === 0 || context.parsed.x === 100) {
                            return ''; // Return an empty string to hide tooltip
                        }
                        return `FGI: ${context.parsed.x}, Multiplier: ${context.parsed.y.toFixed(3)}`; // Show tooltip for other points
                    }
                }
            }
        }
    }
});
    
}
