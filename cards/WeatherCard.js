/**
 * cards/WeatherCard.js
 *
 * Reusable current-conditions Weather Card, fed by the NWS bridge in node_helper.js.
 */
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

    // Compact one-line live-conditions readout under the forecast summary.
    // Only rendered once a station reading has actually arrived - stays
    // silent rather than showing "--" placeholders before the first poll
    // completes. Flags the reading as stale if node_helper hasn't heard
    // from the station in a while (sensor offline, WiFi drop, etc.).
    renderStationLine() {
        if (!this.stationData || this.stationData.outdoorTempF == null) return "";

        const ageMs = Date.now() - (this.stationData.lastUpdated || 0);
        const isStale = ageMs > 5 * 60 * 1000 || !this.stationData.sensorOnline;

        const temp = Math.round(this.stationData.outdoorTempF);
        const humidity = this.stationData.outdoorHumidity;

        return `
            <div class="nexus-station-line${isStale ? ' nexus-station-stale' : ''}">
                Now: ${temp}&deg;F${humidity != null ? ` &middot; ${humidity}% humidity` : ''}
            </div>
        `;
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
        // How many days to show is a config value (config/weather.json ->
        // maxForecastEntries), not hard-coded, per project Rule #2.
        const maxEntries = this.configManager.get("weather", "maxForecastEntries", 5);
        const dailyForecast = (this.weatherData.daily || []).slice(0, maxEntries);

        const forecastStripHtml = dailyForecast.length > 0
            ? `
                <div class="nexus-forecast-strip" style="grid-template-columns: repeat(${dailyForecast.length}, 1fr);">
                    ${dailyForecast.map(day => `
                        <div class="nexus-forecast-day-col">
                            <div class="nexus-forecast-day-label">${day.day}</div>
                            <img class="nexus-forecast-day-icon" src="${day.icon}" alt="${day.shortForecast || ''}" />
                            <div class="nexus-forecast-day-temps">
                                <span class="temp-high">${day.high !== null ? Math.round(day.high) + '\u00b0' : '--'}</span>
                                <span class="temp-low">${day.low !== null ? Math.round(day.low) + '\u00b0' : '--'}</span>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `
            : '';

        this.domElement.innerHTML = `
            <div class="nexus-card-header">Weather</div>
            <div class="nexus-current">
                <div class="nexus-current-row">
            <div class="nexus-temp-main">
                ${temp}&deg;
                <span class="nexus-temp-label">${tempLabel}</span>
            </div>
                    <div>
                        <div class="nexus-summary">${summary}</div>
                        ${this.renderStationLine()}
                    </div>
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
