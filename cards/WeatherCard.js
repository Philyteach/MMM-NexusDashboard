/**
 * cards/WeatherCard.js
 *
 * Reusable current-conditions Weather Card, fed by the NWS bridge in node_helper.js.
 */
class WeatherCard extends NexusCard {
    start() {
        this.weatherData = null;
        this.errorMessage = null;
    }

    // Triggered when backend node_helper fetches new weather data
    updateState(data, errorMessage = null) {
        this.weatherData = data;
        this.errorMessage = errorMessage;
        this.updateDom();
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
                    <div class="nexus-temp-main">${temp}&deg;</div>
                    <div>
                        <div class="nexus-summary">${summary}</div>
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
