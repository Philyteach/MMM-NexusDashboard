/**
 * cards/WeatherCard.js
 *
 * Reusable current-conditions Weather Card, fed by the NWS bridge in node_helper.js.
 */

// --- Right Now / mascot helpers --------------------------------------------
// Plain functions, not card methods - no card state needed, and it keeps
// the feels-like math and mascot-rotation logic easy to reason about (and
// unit-test later) independent of DOM/lifecycle concerns.

/**
 * NWS-style heat index (Rothfusz regression). The simple averaging formula
 * is used below ~80F "feel"; the full regression kicks in above that,
 * matching how NWS actually computes it.
 */
function computeHeatIndexF(tempF, humidityPct) {
    const T = tempF, R = humidityPct;
    let hi = 0.5 * (T + 61.0 + ((T - 68.0) * 1.2) + (R * 0.094));
    if ((hi + T) / 2 >= 80) {
        hi = -42.379 + 2.04901523 * T + 10.14333127 * R
            - 0.22475541 * T * R - 0.00683783 * T * T
            - 0.05481717 * R * R + 0.00122874 * T * T * R
            + 0.00085282 * T * R * R - 0.00000199 * T * T * R * R;
    }
    return hi;
}

// Standard NWS wind chill formula - only meaningful at/below 50F with wind > 3mph.
function computeWindChillF(tempF, windMph) {
    return 35.74 + (0.6215 * tempF) - (35.75 * Math.pow(windMph, 0.16))
        + (0.4275 * tempF * Math.pow(windMph, 0.16));
}

function computeFeelsLikeF(tempF, humidityPct, windMph) {
    if (tempF <= 50 && windMph > 3) {
        return computeWindChillF(tempF, windMph);
    }
    if (tempF >= 80 && humidityPct != null) {
        return computeHeatIndexF(tempF, humidityPct);
    }
    return tempF;
}

function windLabel(windMph) {
    if (windMph == null) return null;
    if (windMph < 5) return "Calm";
    if (windMph < 15) return "Breezy";
    if (windMph < 25) return "Windy";
    return "Very Windy";
}

function outfitBand(feelsLikeF) {
    if (feelsLikeF < 35) return "heavy_coat";
    if (feelsLikeF < 55) return "jacket";
    if (feelsLikeF < 70) return "light_layer";
    return "tshirt";
}

/**
 * Alternates the mascot character (girl/boy) hourly, skipping the 5am
 * increment specifically. 24 hours is even, so naive hourly alternation
 * would lock the SAME character to every fixed hour forever (e.g. always
 * the boy at 8am, every single day). Skipping one hour makes the daily
 * tick count 23 (odd), so whichever character shows at a given hour flips
 * day-to-day instead. Purely date-derived - no persisted counter needed,
 * safe across reboots.
 */
function getMascotChild(date = new Date()) {
    const epoch = new Date(2026, 0, 1);
    const msPerDay = 86400000;
    const daysSinceEpoch = Math.floor((date - epoch) / msPerDay);
    const hourOfDay = date.getHours();
    const hourIndex = hourOfDay > 5 ? hourOfDay - 1 : hourOfDay;
    const totalTicks = daysSinceEpoch * 23 + hourIndex;
    return totalTicks % 2 === 0 ? "girl" : "boy";
}

// Resolves the actual mascot PNG filename in assets/icons/mascot/ for the
// current outfit band + rain state + which character is "on duty". One
// outfit per band per character - no per-band variants to pick between.
function resolveMascotFilename(band, isRainy, child) {
    const suffix = child === "boy" ? "_boy" : "";
    if (isRainy) return `rainy_day${suffix}.png`;
    return `${band}${suffix}.png`;
}

class WeatherCard extends NexusCard {
    start() {
        this.weatherData = null;
        this.errorMessage = null;
        this.stationData = null;
    }

    // Triggered when backend node_helper fetches new weather data
    updateState(data, errorMessage = null) {
        this.weatherData = data;
        this.errorMessage = errorMessage;
        this.updateDom();
    }

    // Triggered on NEXUS_STATION_DATA - live outdoor/indoor readings from
    // the VEVOR weather station (polled via Tuya Cloud API in node_helper).
    // Kept separate from updateState() since it's a different data source
    // on its own poll cycle, not part of the NWS forecast payload.
    updateStationState(reading) {
        this.stationData = reading;
        this.updateDom();
    }

    // Computes local-station "Right Now" values (temp, feels-like, wind
    // label, mascot) without building any markup - the caller decides
    // where each piece lands in the DOM. Returns null before the first
    // station reading arrives, so render() can skip this section
    // entirely rather than showing "--" placeholders.
    computeRightNow() {
        if (!this.stationData || this.stationData.outdoorTempF == null) return null;

        const ageMs = Date.now() - (this.stationData.lastUpdated || 0);
        const isStale = ageMs > 5 * 60 * 1000 || !this.stationData.sensorOnline;

        const tempF = this.stationData.outdoorTempF;
        const humidity = this.stationData.outdoorHumidity;
        // node_helper broadcasts windSpeedKnots (Tuya's declared unit,
        // confirmed in node_helper.js's stationCache shape) - convert to
        // mph since the feels-like formulas below are both defined in mph.
        const windMph = this.stationData.windSpeedKnots != null
            ? this.stationData.windSpeedKnots * 1.15078
            : null;

        const feelsLike = Math.round(computeFeelsLikeF(tempF, humidity, windMph || 0));
        const band = outfitBand(feelsLike);
        const label = windLabel(windMph);

        // Rain-chance comes from the NWS period data (already on
        // this.weatherData), not the station - the station can't tell you
        // what's *about* to happen.
        const rainChance = this.weatherData?.forecast?.[0]?.probabilityOfPrecipitation?.value;
        const isRainy = rainChance != null && rainChance >= 40 && feelsLike >= 55 && feelsLike <= 65;

        const child = getMascotChild();
        const mascotFile = resolveMascotFilename(band, isRainy, child);

        return {
            tempF: Math.round(tempF),
            feelsLike: feelsLike,
            windLabel: label,
            mascotFile: mascotFile,
            isStale: isStale
        };
    }

    render() {
        this.domElement.className = "nexus-card nexus-weather-card";

        if (this.errorMessage) {
            this.domElement.innerHTML = `
                <div class="nexus-card-header">Weather</div>
                <div class="nexus-card-body">${this.errorMessage}</div>
            `;
            return;
        }

        if (!this.weatherData || !this.weatherData.forecast || this.weatherData.forecast.length === 0) {
            this.domElement.innerHTML = `
                <div class="nexus-card-header">Weather</div>
                <div class="nexus-card-body">Updating weather...</div>
            `;
            return;
        }

        // First period from NWS is always the current/next applicable conditions
        const currentPeriod = this.weatherData.forecast[0];
        const temp = currentPeriod.temperature !== undefined ? Math.round(currentPeriod.temperature) : "--";
        const summary = currentPeriod.shortForecast || "No data available";
        const tempLabel = currentPeriod.isDaytime ? "High" : "Low";
        // How many hourly buckets to show is a config value (config/weather.json
        // -> maxForecastEntries), not hard-coded, per project Rule #2. Default
        // 8 matches node_helper's default bucket count (8 x 3hr = rolling 24h).
        const maxEntries = this.configManager.get("weather", "maxForecastEntries", 8);
        const hourlyForecast = (this.weatherData.hourly || []).slice(0, maxEntries);

        const forecastStripHtml = hourlyForecast.length > 0
            ? `
                <div class="nexus-forecast-strip" style="grid-template-columns: repeat(${hourlyForecast.length}, 1fr);">
                    ${hourlyForecast.map(hour => `
                        <div class="nexus-forecast-day-col">
                            <div class="nexus-forecast-day-label">${hour.label}</div>
                            <img class="nexus-forecast-day-icon" src="${hour.icon}" alt="${hour.shortForecast || ''}" />
                            <div class="nexus-forecast-day-temps">
                                <span class="temp-high">${hour.temperature !== null ? Math.round(hour.temperature) + '\u00b0' : '--'}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `
            : '';

        // Right Now content (station temp/feels-like/wind + mascot) slots
        // into the SAME row as the forecast high/low, using space that
        // was already sitting empty next to the summary text - no second
        // row, no added vertical footprint, nothing that can push a
        // sibling card off-screen.
        const rightNow = this.computeRightNow();
        const rightNowHtml = rightNow ? `
            <div class="nexus-right-now-group${rightNow.isStale ? ' nexus-station-stale' : ''}">
                <div class="nexus-temp-main nexus-station-temp">
                    ${rightNow.tempF}&deg;
                    <span class="nexus-temp-label">Right Now</span>
                </div>
                <div class="nexus-current-details">
                    <div class="nexus-summary">${summary}</div>
                    <div class="nexus-feels-like-line">Feels like ${rightNow.feelsLike}&deg;</div>
                    ${rightNow.windLabel ? `<div class="nexus-wind-line">Winds ${rightNow.windLabel}</div>` : ''}
                </div>
                <img class="nexus-mascot-img" src="modules/MMM-NexusDashboard/assets/icons/mascot/${rightNow.mascotFile}" alt="What to wear right now" />
            </div>
        ` : `<div class="nexus-summary">${summary}</div>`;

        this.domElement.innerHTML = `
            <div class="nexus-card-header">Weather</div>
            <div class="nexus-current">
                <div class="nexus-current-row">
                    <div class="nexus-temp-main">
                        ${temp}&deg;
                        <span class="nexus-temp-label">${tempLabel}</span>
                    </div>
                    ${rightNowHtml}
                </div>
            </div>
            ${forecastStripHtml}
        `;
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("WeatherCard", WeatherCard);
}
// Global registration (fallback lookup used by CardManager)
window.WeatherCard = WeatherCard;
