/**
 * cards/ForecastCard.js
 *
 * Full-screen weather command center card. Shares the same NEXUS_WEATHER_DATA
 * payload as WeatherCard (see MMM-NexusDashboard.js's dispatch of that
 * notification) but surfaces more of what NWS/USNO already return that the
 * compact sidebar card doesn't have room for: wind, humidity, precip chance,
 * dewpoint, the full multi-day strip (not capped at 5), and moon phase /
 * illumination / rise-set times from the USNO astronomy fetch in
 * node_helper.js. Also shows live outdoor/indoor readings from the VEVOR
 * weather station (NEXUS_STATION_DATA, polled via Tuya Cloud API) alongside
 * the NWS forecast data - a separate source on its own poll cycle, kept in
 * its own panel rather than merged into the forecast stat row.
 */
class ForecastCard extends NexusCard {
    start() {
        this.weatherData = null;
        this.errorMessage = null;
        this.stationData = null;
    }

    updateState(data, errorMessage = null) {
        this.weatherData = data;
        this.errorMessage = errorMessage;
        this.updateDom();
    }

    // Triggered on NEXUS_STATION_DATA.
    updateStationState(reading) {
        this.stationData = reading;
        this.updateDom();
    }

    // USNO returns local time as "HH:MM" (24-hour). Reformat to 12-hour for
    // display; fall back to the raw string if it's ever in an unexpected shape.
    formatClockTime(timeStr) {
        if (!timeStr) return "--";
        const parts = timeStr.split(":");
        if (parts.length < 2) return timeStr;

        let hours = parseInt(parts[0], 10);
        const minutes = parts[1];
        const suffix = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        if (hours === 0) hours = 12;

        return `${hours}:${minutes} ${suffix}`;
    }

    // Emoji glyph for each of USNO's 8 standard primary/intermediate phase names.
    moonEmoji(phaseName) {
        const map = {
            "New Moon": "\u{1F311}",
            "Waxing Crescent": "\u{1F312}",
            "First Quarter": "\u{1F313}",
            "Waxing Gibbous": "\u{1F314}",
            "Full Moon": "\u{1F315}",
            "Waning Gibbous": "\u{1F316}",
            "Last Quarter": "\u{1F317}",
            "Waning Crescent": "\u{1F318}"
        };
        return map[phaseName] || "\u{1F311}";
    }

    renderStatRow(currentPeriod) {
        const stats = [];

        if (currentPeriod.windSpeed) {
            stats.push({
                label: "Wind",
                value: `${currentPeriod.windDirection || ""} ${currentPeriod.windSpeed}`.trim()
            });
        }
        if (currentPeriod.relativeHumidity?.value !== undefined && currentPeriod.relativeHumidity?.value !== null) {
            stats.push({ label: "Humidity", value: `${Math.round(currentPeriod.relativeHumidity.value)}%` });
        }
        if (currentPeriod.probabilityOfPrecipitation?.value !== undefined && currentPeriod.probabilityOfPrecipitation?.value !== null) {
            stats.push({ label: "Precip Chance", value: `${Math.round(currentPeriod.probabilityOfPrecipitation.value)}%` });
        }
        if (currentPeriod.dewpoint?.value !== undefined && currentPeriod.dewpoint?.value !== null) {
            // NWS API returns dewpoint in whatever unitCode it's configured for
            // (almost always degC) regardless of the display temperatureUnit,
            // so it needs its own conversion rather than reusing currentPeriod.temperature.
            const isCelsius = (currentPeriod.dewpoint.unitCode || "").includes("degC");
            const dewF = isCelsius ? Math.round(currentPeriod.dewpoint.value * 9 / 5 + 32) : Math.round(currentPeriod.dewpoint.value);
            stats.push({ label: "Dew Point", value: `${dewF}\u00b0` });
        }

        if (stats.length === 0) return "";

        return `
            <div class="nexus-forecast-stat-row">
                ${stats.map(s => `
                    <div class="nexus-forecast-stat">
                        <div class="nexus-forecast-stat-label">${s.label}</div>
                        <div class="nexus-forecast-stat-value">${s.value}</div>
                    </div>
                `).join("")}
            </div>
        `;
    }

    // Live readings from the VEVOR station itself, distinct from the NWS
    // forecast stat row above (that's forecast data; this is your own
    // sensor, on its own poll cycle). Only renders once a reading has
    // actually arrived. Rain is deliberately NOT shown - the raw dp value
    // didn't match the console's own "Today" figure when spot-checked, so
    // it's not trustworthy yet (see TuyaWeatherClient.js's calibration notes).
    renderStationPanel() {
        if (!this.stationData || this.stationData.outdoorTempF == null) return "";

        const s = this.stationData;
        const ageMs = Date.now() - (s.lastUpdated || 0);
        const isStale = ageMs > 5 * 60 * 1000 || !s.sensorOnline;
        const ageText = ageMs < 60000
            ? "just now"
            : `${Math.round(ageMs / 60000)} min ago`;

        // rtl_433 only hears the outdoor sensor - indoorTempF/pressureInHg
        // stay null under that source (see RtlWeatherClient.js), so each
        // stat here is only included once it's actually present rather
        // than crashing on null.toFixed()/etc.
        const stats = [];
        if (s.outdoorTempF != null) {
            stats.push({ label: "Outdoor", value: `${Math.round(s.outdoorTempF)}\u00b0F` });
        }
        if (s.indoorTempF != null) {
            stats.push({ label: "Indoor", value: `${Math.round(s.indoorTempF)}\u00b0F` });
        }
        if (s.outdoorHumidity != null) {
            stats.push({ label: "Outdoor Humidity", value: `${s.outdoorHumidity}%` });
        }
        if (s.pressureInHg != null) {
            stats.push({ label: "Pressure", value: `${s.pressureInHg.toFixed(2)} inHg` });
        }

        return `
            <div class="nexus-station-panel${isStale ? ' nexus-station-stale' : ''}">
                <div class="nexus-station-panel-header">
                    From your weather station
                    <span class="nexus-station-panel-age">${isStale ? 'stale &middot; ' : ''}${ageText}</span>
                </div>
                <div class="nexus-station-panel-stats">
                    ${stats.map(s => `
                        <div class="nexus-forecast-stat">
                            <div class="nexus-forecast-stat-label">${s.label}</div>
                            <div class="nexus-forecast-stat-value">${s.value}</div>
                        </div>
                    `).join("")}
                </div>
            </div>
        `;
    }

    renderAstronomy(astronomy) {
        if (!astronomy) return "";

        return `
            <div class="nexus-astronomy-panel">
                <div class="nexus-astronomy-moon">
                    <span class="nexus-moon-emoji">${this.moonEmoji(astronomy.moonPhase)}</span>
                    <div>
                        <div class="nexus-moon-phase-name">${astronomy.moonPhase || "Unknown"}</div>
                        <div class="nexus-moon-illum">${astronomy.moonIllumination || "--"} illuminated</div>
                    </div>
                </div>
                <div class="nexus-astronomy-times">
                    <div class="nexus-astronomy-time-item">
                        <div class="nexus-astronomy-time-label">Sunrise</div>
                        <div class="nexus-astronomy-time-value">${this.formatClockTime(astronomy.sunrise)}</div>
                    </div>
                    <div class="nexus-astronomy-time-item">
                        <div class="nexus-astronomy-time-label">Sunset</div>
                        <div class="nexus-astronomy-time-value">${this.formatClockTime(astronomy.sunset)}</div>
                    </div>
                    <div class="nexus-astronomy-time-item">
                        <div class="nexus-astronomy-time-label">Moonrise</div>
                        <div class="nexus-astronomy-time-value">${this.formatClockTime(astronomy.moonrise)}</div>
                    </div>
                    <div class="nexus-astronomy-time-item">
                        <div class="nexus-astronomy-time-label">Moonset</div>
                        <div class="nexus-astronomy-time-value">${this.formatClockTime(astronomy.moonset)}</div>
                    </div>
                </div>
            </div>
        `;
    }

    renderDailyStrip(daily) {
        if (!daily || daily.length === 0) return "";

        return `
            <div class="nexus-forecast-full-strip" style="grid-template-columns: repeat(${daily.length}, 1fr);">
                ${daily.map(day => `
                    <div class="nexus-forecast-full-day-col">
                        <div class="nexus-forecast-full-day-label">${day.day}</div>
                        <img class="nexus-forecast-full-day-icon" src="${day.icon}" alt="${day.shortForecast || ""}" />
                        <div class="nexus-forecast-full-day-summary">${day.shortForecast || ""}</div>
                        <div class="nexus-forecast-full-day-temps">
                            <span class="temp-high">${day.high !== null ? Math.round(day.high) + "\u00b0" : "--"}</span>
                            <span class="temp-low">${day.low !== null ? Math.round(day.low) + "\u00b0" : "--"}</span>
                        </div>
                    </div>
                `).join("")}
            </div>
        `;
    }

    render() {
        this.domElement.className = "nexus-card nexus-forecast-card";

        if (this.errorMessage) {
            this.domElement.innerHTML = `
                <div class="nexus-card-header">Forecast</div>
                <div class="nexus-card-body">${this.errorMessage}</div>
            `;
            return;
        }

        if (!this.weatherData || !this.weatherData.forecast || this.weatherData.forecast.length === 0) {
            this.domElement.innerHTML = `
                <div class="nexus-card-header">Forecast</div>
                <div class="nexus-card-body">Updating weather...</div>
            `;
            return;
        }

        const currentPeriod = this.weatherData.forecast[0];
        const temp = currentPeriod.temperature !== undefined ? Math.round(currentPeriod.temperature) : "--";
        const summary = currentPeriod.shortForecast || "No data available";

        this.domElement.innerHTML = `
            <div class="nexus-forecast-current-block">
                <img class="nexus-forecast-current-icon" src="${currentPeriod.icon || ""}" alt="${summary}" />
                <div class="nexus-forecast-current-temp">${temp}&deg;</div>
                <div class="nexus-forecast-current-summary">${summary}</div>
                ${this.renderStatRow(currentPeriod)}
            </div>
            ${this.renderStationPanel()}
            ${this.renderAstronomy(this.weatherData.astronomy)}
            ${this.renderDailyStrip(this.weatherData.daily)}
        `;
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("ForecastCard", ForecastCard);
}
window.ForecastCard = ForecastCard;
