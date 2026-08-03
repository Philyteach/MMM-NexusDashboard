/**
 * cards/WeatherStationCard.js
 *
 * Full-screen deep-dive view of the physical VEVOR weather station,
 * distinct from the Home screen's compact "Right Now" strip (WeatherCard.js)
 * which stays a quick-glance summary. This card is the "proud meteorologist"
 * version: compass wind direction, a 24h temp sparkline, a barometric
 * pressure trend arrow, and daily high/low/rain-since-midnight - all built
 * from the same NEXUS_STATION_DATA broadcast WeatherCard/ForecastCard
 * already consume (node_helper.js's broadcastStationData() rides the extra
 * fields along on that one notification rather than a second type).
 */

const COMPASS_POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

function compassLabel(deg) {
    if (deg == null) return null;
    const index = Math.round(deg / 22.5) % 16;
    return COMPASS_POINTS[index];
}

// Symbol/label/css-class for the pressureTrend object node_helper computes
// from a ~3h-ago history sample - see computeStationExtras() there.
function pressureTrendArrow(trend) {
    if (!trend) return { symbol: "–", label: "Trend unknown", cssClass: "unknown" };
    if (trend.direction === "rising") return { symbol: "▲", label: "Rising", cssClass: "rising" };
    if (trend.direction === "falling") return { symbol: "▼", label: "Falling", cssClass: "falling" };
    return { symbol: "▬", label: "Steady", cssClass: "steady" };
}

// Builds an SVG polyline "points" string from node_helper's tempHistory
// array ({t, outdoorTempF} samples, ~5min apart, last 24h). Returns null
// if there isn't enough data yet to draw a meaningful line (e.g. right
// after a fresh install, before history has accumulated).
function buildSparklinePoints(history, width = 300, height = 60, padding = 4) {
    const points = (history || []).filter(h => h.outdoorTempF != null);
    if (points.length < 2) return null;

    const temps = points.map(p => p.outdoorTempF);
    const min = Math.min(...temps);
    const max = Math.max(...temps);
    const range = max - min || 1; // avoid divide-by-zero on a perfectly flat line

    const usableWidth = width - padding * 2;
    const usableHeight = height - padding * 2;

    return points.map((p, i) => {
        const x = padding + (i / (points.length - 1)) * usableWidth;
        const y = padding + usableHeight - ((p.outdoorTempF - min) / range) * usableHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
}

// Same 90s threshold as WeatherCard's Right Now panel - rtl_433's ~20s
// cadence is the primary source now, so anything much longer than that
// means the station has actually gone quiet, not just normal poll jitter.
function computeStaleness(s) {
    const ageMs = Date.now() - (s.lastUpdated || 0);
    return ageMs > 90 * 1000 || !s.sensorOnline;
}

class WeatherStationCard extends NexusCard {
    start() {
        this.stationData = null;
    }

    // Triggered on NEXUS_STATION_DATA - same broadcast WeatherCard/
    // ForecastCard use, this card just reads more of it.
    updateStationState(reading) {
        this.stationData = reading;
        this.updateDom();
    }

    render() {
        this.domElement.className = "nexus-card nexus-station-full-card";

        if (!this.stationData || this.stationData.outdoorTempF == null) {
            this.domElement.innerHTML = `
                <div class="nexus-card-header">Weather Station</div>
                <div class="nexus-card-body">Waiting for a station reading...</div>
            `;
            return;
        }

        const s = this.stationData;
        const isStale = computeStaleness(s);
        const sourceLabel = s.stationSource === "rtl_433" ? "rtl_433 (live RF)" : "Tuya Cloud";
        const ageMs = Date.now() - (s.lastUpdated || 0);
        const ageText = ageMs < 60000 ? "just now" : `${Math.round(ageMs / 60000)} min ago`;

        const compass = compassLabel(s.windDirDeg);
        const trend = pressureTrendArrow(s.pressureTrend);
        const sparklinePoints = buildSparklinePoints(s.tempHistory);

        this.domElement.innerHTML = `
            <div class="nexus-station-full-header">
                <div class="nexus-card-header" style="margin-bottom:0;">Weather Station</div>
                <div class="nexus-station-source${isStale ? ' nexus-station-stale' : ''}">
                    ${isStale ? 'STALE &middot; ' : ''}${sourceLabel} &middot; ${ageText}
                </div>
            </div>

            <div class="nexus-station-main-row">
                <div class="nexus-station-temp-block">
                    <div class="nexus-station-temp-big">${Math.round(s.outdoorTempF)}&deg;</div>
                    <div class="nexus-station-temp-sub">Outdoor</div>
                    <div class="nexus-station-hilo">
                        <span class="hi">H ${s.dailyHighF != null ? Math.round(s.dailyHighF) + '°' : '--'}</span>
                        <span class="lo">L ${s.dailyLowF != null ? Math.round(s.dailyLowF) + '°' : '--'}</span>
                    </div>
                </div>

                <div class="nexus-station-sparkline">
                    <div class="nexus-station-stat-label">Temp Trend (24h)</div>
                    ${sparklinePoints
                        ? `<svg viewBox="0 0 300 60" preserveAspectRatio="none" class="nexus-station-spark-svg">
                             <polyline points="${sparklinePoints}" fill="none" stroke="#6bd0ff" stroke-width="2" />
                           </svg>`
                        : `<div class="nexus-station-spark-empty">Gathering data...</div>`
                    }
                </div>
            </div>

            <div class="nexus-station-grid">
                <div class="nexus-station-tile">
                    <div class="nexus-station-stat-label">Indoor</div>
                    <div class="nexus-station-stat-value">${s.indoorTempF != null ? Math.round(s.indoorTempF) + '°' : '--'}</div>
                    <div class="nexus-station-stat-sub">${s.indoorHumidity != null ? s.indoorHumidity + '% RH' : ''}</div>
                </div>
                <div class="nexus-station-tile">
                    <div class="nexus-station-stat-label">Outdoor Humidity</div>
                    <div class="nexus-station-stat-value">${s.outdoorHumidity != null ? s.outdoorHumidity + '%' : '--'}</div>
                </div>
                <div class="nexus-station-tile">
                    <div class="nexus-station-stat-label">Pressure</div>
                    <div class="nexus-station-stat-value">
                        ${s.pressureInHg != null ? s.pressureInHg.toFixed(2) : '--'}
                        <span class="nexus-station-trend-arrow nexus-trend-${trend.cssClass}">${trend.symbol}</span>
                    </div>
                    <div class="nexus-station-stat-sub">${trend.label}${s.pressureTrend ? ` (${s.pressureTrend.deltaInHg >= 0 ? '+' : ''}${s.pressureTrend.deltaInHg.toFixed(2)} in/3h)` : ''}</div>
                </div>
                <div class="nexus-station-tile">
                    <div class="nexus-station-stat-label">Rain Today</div>
                    <div class="nexus-station-stat-value">${s.rainTodayIn != null ? s.rainTodayIn.toFixed(2) + ' in' : '--'}</div>
                </div>
                <div class="nexus-station-tile">
                    <div class="nexus-station-stat-label">UV Index</div>
                    <div class="nexus-station-stat-value">${s.uvIndex != null ? s.uvIndex : '--'}</div>
                </div>
                <div class="nexus-station-tile">
                    <div class="nexus-station-stat-label">Light</div>
                    <div class="nexus-station-stat-value">${s.lightIntensityKlux != null ? s.lightIntensityKlux.toFixed(1) + ' klux' : '--'}</div>
                </div>
            </div>

            <div class="nexus-station-wind-row">
                <div class="nexus-station-compass">
                    <div class="nexus-compass-face">
                        <span class="nexus-compass-n">N</span>
                        <span class="nexus-compass-e">E</span>
                        <span class="nexus-compass-s">S</span>
                        <span class="nexus-compass-w">W</span>
                        ${s.windDirDeg != null
                            ? `<div class="nexus-compass-needle" style="transform: translate(-50%, -100%) rotate(${s.windDirDeg}deg);"></div>`
                            : ''
                        }
                    </div>
                    <div class="nexus-station-stat-sub">${compass ? `${compass} (${Math.round(s.windDirDeg)}&deg;)` : 'No direction data'}</div>
                </div>
                <div class="nexus-station-wind-stats">
                    <div class="nexus-station-tile">
                        <div class="nexus-station-stat-label">Wind</div>
                        <div class="nexus-station-stat-value">${s.windSpeedKnots != null ? Math.round(s.windSpeedKnots) + ' kt' : '--'}</div>
                    </div>
                    <div class="nexus-station-tile">
                        <div class="nexus-station-stat-label">Gust</div>
                        <div class="nexus-station-stat-value">${s.windGustKnots != null ? Math.round(s.windGustKnots) + ' kt' : '--'}</div>
                    </div>
                    <div class="nexus-station-tile">
                        <div class="nexus-station-stat-label">Battery</div>
                        <div class="nexus-station-stat-value nexus-station-battery-${s.batteryStatus || 'unknown'}">${s.batteryStatus ? s.batteryStatus.toUpperCase() : '--'}</div>
                    </div>
                </div>
            </div>
        `;
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("WeatherStationCard", WeatherStationCard);
}
window.WeatherStationCard = WeatherStationCard;
