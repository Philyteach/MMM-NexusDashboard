/**
 * cards/FridgeTempsCard.js
 *
 * Full-screen deep-dive view of all 4 mapped fridge/freezer channels
 * (NEXUS_FRIDGE_HISTORY - see node_helper.js's broadcastFridgeHistory()),
 * the "Station" workspace's counterpart for the WH31 sensors: unlike
 * FridgeAlertCard (badge-tier, only shows currently-latched channels and
 * collapses to nothing otherwise), this card always shows all 4 sensors
 * with a 24h line graph each, latched or not.
 */

// Same polyline-building approach as WeatherStationCard's
// buildSparklinePoints, generalized to a {t, tempF} history shape and
// extended to fold thresholdF into the min/max range so the reference
// line drawn alongside it is never clipped off-chart.
function buildSparklineData(history, thresholdF, width = 300, height = 80, padding = 6) {
    const points = (history || []).filter(h => h.tempF != null);
    if (points.length < 2) return null;

    const temps = points.map(p => p.tempF);
    let min = Math.min(...temps, thresholdF);
    let max = Math.max(...temps, thresholdF);
    if (min === max) { min -= 1; max += 1; } // avoid divide-by-zero on a perfectly flat line

    const usableWidth = width - padding * 2;
    const usableHeight = height - padding * 2;
    const range = max - min;

    const linePoints = points.map((p, i) => {
        const x = padding + (i / (points.length - 1)) * usableWidth;
        const y = padding + usableHeight - ((p.tempF - min) / range) * usableHeight;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");

    const thresholdY = padding + usableHeight - ((thresholdF - min) / range) * usableHeight;

    return { linePoints, thresholdY };
}

// WH31 sensors report roughly once a minute - 10 minutes of silence means
// the channel actually went quiet (dead battery, out of RF range), not
// just normal poll jitter.
function isChannelStale(channel) {
    if (channel.lastUpdated == null) return false; // never heard from - "no data" handles this, not "stale"
    return (Date.now() - channel.lastUpdated) > 10 * 60 * 1000;
}

class FridgeTempsCard extends NexusCard {
    start() {
        this.channels = null;
    }

    // Triggered on NEXUS_FRIDGE_HISTORY
    updateState(channels) {
        this.channels = channels || [];
        this.updateDom();
    }

    renderTile(c) {
        const spark = buildSparklineData(c.history, c.thresholdF);
        const stale = isChannelStale(c);
        const hasReading = c.currentTempF != null;

        return `
            <div class="nexus-fridge-temps-tile${c.latched ? ' nexus-fridge-temps-alert' : ''}">
                <div class="nexus-fridge-temps-name">${c.location}</div>
                <div class="nexus-fridge-temps-current">
                    ${hasReading ? Math.round(c.currentTempF) + '&deg;F' : '--'}
                    ${stale ? '<span class="nexus-fridge-temps-stale-tag">STALE</span>' : ''}
                </div>
                <div class="nexus-fridge-temps-threshold-label">Threshold ${c.thresholdF}&deg;F</div>
                <div class="nexus-fridge-temps-graph">
                    ${spark
                        ? `<svg viewBox="0 0 300 80" preserveAspectRatio="none" class="nexus-fridge-temps-spark-svg">
                             <line x1="6" x2="294" y1="${spark.thresholdY.toFixed(1)}" y2="${spark.thresholdY.toFixed(1)}" class="nexus-fridge-temps-threshold-line" />
                             <polyline points="${spark.linePoints}" fill="none" stroke-width="2" class="nexus-fridge-temps-line${c.latched ? ' nexus-fridge-temps-line-alert' : ''}" />
                           </svg>`
                        : `<div class="nexus-fridge-temps-empty">Gathering data&hellip;</div>`
                    }
                </div>
            </div>
        `;
    }

    render() {
        this.domElement.className = "nexus-card nexus-fridge-temps-card";

        if (this.channels === null) {
            this.domElement.innerHTML = `
                <div class="nexus-card-header">Fridge &amp; Freezer Temps</div>
                <div class="nexus-card-body">Waiting for sensor data...</div>
            `;
            return;
        }

        this.domElement.innerHTML = `
            <div class="nexus-card-header">Fridge &amp; Freezer Temps</div>
            <div class="nexus-fridge-temps-grid">
                ${this.channels.map(c => this.renderTile(c)).join("")}
            </div>
        `;
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("FridgeTempsCard", FridgeTempsCard);
}
window.FridgeTempsCard = FridgeTempsCard;
