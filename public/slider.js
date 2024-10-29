import { updateParams } from './script.js';

export function initializeSlider(params, serverType) {
    const slider = document.getElementById('slider');

     let startValues, buttonLabels;
    
    if (serverType === 'pulse') {
        startValues = [
            params.SENTIMENT_BOUNDARIES?.EXTREME_FEAR ?? 20,
            params.SENTIMENT_BOUNDARIES?.FEAR ?? 40,
            params.SENTIMENT_BOUNDARIES?.GREED ?? 60,
            params.SENTIMENT_BOUNDARIES?.EXTREME_GREED ?? 80
        ];

        buttonLabels = [
            'Extreme Fear', // For 0
            'Fear',         // For 1
            'Greed',        // For 2
            'Extreme Greed' // For 3
        ];
    } else if (serverType === 'wave') {
        startValues = [
            params.SENTIMENT_BOUNDARIES?.FEAR ?? 40,
            params.SENTIMENT_BOUNDARIES?.GREED ?? 60
        ];

        buttonLabels = [
            'Fear',   // For 0
            'Greed'   // For 1
        ];
    }


    noUiSlider.create(slider, {
        start: startValues,
        connect: [true, ...Array(startValues.length - 1).fill(true), true],
        margin: 5,
        padding: 5,
        range: {
            'min': 0,
            'max': 100
        },
        step: 1,
        tooltips: true,
        pips: {
            mode: 'values',
            values: [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100],
            density: 10,
            stepped: true,
        }
    });

    updateTooltips(slider, startValues, buttonLabels);

    slider.noUiSlider.on('update', function (values, handle) {
        updateTooltips(slider, values, buttonLabels);
        mergeTooltips(slider, 10, buttonLabels);
    });

    slider.noUiSlider.on('change', function (values) {
        const sliderBoundaries = serverType === 'pulse' ? {
            EXTREME_FEAR: Math.round(values[0]),
            FEAR: Math.round(values[1]),
            GREED: Math.round(values[2]),
            EXTREME_GREED: Math.round(values[3])
        } : {
            FEAR: Math.round(values[0]),
            GREED: Math.round(values[1])
        };

        console.log('Slider Boundaries:', sliderBoundaries);
        updateParams(null, sliderBoundaries);
    });
}

function updateTooltips(slider, values, buttonLabels) {
    const tooltips = slider.noUiSlider.getTooltips();
    tooltips.forEach((tooltip, index) => {
        if (tooltip) {
            const value = Math.round(values[index]);
            tooltip.innerHTML = `${buttonLabels[index]}<br>${value}`;
        }
    });
}

function mergeTooltips(slider, threshold = 10, buttonLabels) { 
    const tooltips = slider.noUiSlider.getTooltips();
    const values = slider.noUiSlider.get();

    tooltips.forEach((tooltip, index) => {
        if (!tooltip) return;

        const currentValue = Math.round(values[index]);

        if (index > 0) {
            const position = parseFloat(values[index]);
            const previousPosition = parseFloat(values[index - 1]);

            if (position - previousPosition < threshold) {
                tooltip.style.display = 'none';
                const combinedTooltip = tooltips[index - 1];
                combinedTooltip.innerHTML = 
                    `<div style="display: flex; justify-content: space-between;">
                        <div>${buttonLabels[index - 1]}<br>${Math.round(values[index - 1])}</div>
                        <div>&nbsp;-&nbsp;</div>
                        <div>${buttonLabels[index]}<br>${currentValue}</div>
                    </div>`;
                combinedTooltip.classList.add('merged');
            } else {
                tooltip.style.display = 'block';
                tooltip.innerHTML = `${buttonLabels[index]}<br>${currentValue}`;
                tooltip.classList.remove('merged');
            }
        } else {
            tooltip.style.display = 'block'; 
            tooltip.innerHTML = `${buttonLabels[index]}<br>${currentValue}`;
            tooltip.classList.remove('merged');
        }
    });
}
