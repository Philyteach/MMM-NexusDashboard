/**
 * cards/FridgeAlertChartCard.js
 *
 * Full-bleed overlay for the Home workspace's main column. While any
 * fridge/freezer channel is latched (NEXUS_FRIDGE_HISTORY's `latched`
 * flag - the same source of truth node_helper.js's broadcastFridgeAlerts/
 * FridgeAlertCard use), this covers ImmichCard with that channel's 24h
 * temp curve, so the alert already showing as a badge in the sidebar has
 * its actual trend on screen too, without a trip to the full-screen
 * FridgeTemps workspace. Collapses to nothing (display:none) the instant
 * nothing's latched, letting Immich show straight through - Immich itself
 * is never paused or reached into by this card, it just keeps running
 * underneath and reappears exactly where it left off.
 *
 * Reuses FridgeTempsCard's tile CSS classes (css/fridge-temps.css) so the
 * chart itself looks identical to the deep-dive view; only the overlay
 * chrome around it is new (css/fridge-chart-overlay.css). The sparkline/
 * staleness helpers below are deliberately duplicated rather than shared
 * across files - same pattern FridgeTempsCard.js and WeatherStationCard.js
 * already use for their own sparkline helpers, since these cards load as
 * plain concatenated scripts, not modules.
 */

function buildSparklineData(history, thresholdF, width = 300, height = 80, padding = 6) {
    const points = (history || []).filter(h => h.tempF != null);
    if (points.length < 2) return null;

    const temps = points.map(p => p.tempF);
    let min = Math.min(...temps, thresholdF);
    let max = Math.max(...temps, thresholdF);
    if (min === max) { min -= 1; max += 1; }

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

// Same 10min threshold as FridgeTempsCard.js's isChannelStale - WH31
// sensors report roughly once a minute, so 10 minutes of silence means
// the channel actually went quiet, not just normal poll jitter.
function isChannelStale(channel) {
    if (channel.lastUpdated == null) return false;
    return (Date.now() - channel.lastUpdated) > 10 * 60 * 1000;
}

class FridgeAlertChartCard extends NexusCard {
    start() {
        this.channels = null;
    }

    // Triggered on NEXUS_FRIDGE_HISTORY (same payload/notification
    // FridgeTempsCard consumes - no separate node_helper wiring needed)
    updateState(channels) {
        this.channels = channels || [];
        this.updateDom();
    }

    renderTile(c) {
        const spark = buildSparklineData(c.history, c.thresholdF);
        const stale = isChannelStale(c);
        const hasReading = c.currentTempF != null;

        return `
            <div class="nexus-fridge-temps-tile nexus-fridge-temps-alert">
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
                             <polyline points="${spark.linePoints}" fill="none" stroke-width="2" class="nexus-fridge-temps-line-alert" />
                           </svg>`
                        : `<div class="nexus-fridge-temps-empty">Gathering data&hellip;</div>`
                    }
                </div>
            </div>
        `;
    }

    render() {
        const alerting = (this.channels || []).filter(c => c.latched);

        if (alerting.length === 0) {
            // Deliberately NOT also carrying "nexus-fridge-chart-overlay"
            // here - that class sets its own `display` (flex) and
            // `background`/`position` for the active state, which would
            // tie with -empty's `display: none` at equal specificity and
            // (being declared later in the stylesheet) win, leaving a
            // permanently visible dark box over Immich regardless of
            // alert state. Keeping the two states on non-overlapping
            // classes avoids the tie entirely.
            this.domElement.className = "nexus-fridge-chart-overlay-empty";
            this.domElement.innerHTML = "";
            return;
        }

        this.domElement.className = "nexus-fridge-chart-overlay";
        this.domElement.innerHTML = `
            <div class="nexus-fridge-chart-header">
                <img class="nexus-fridge-chart-header-icon" src="modules/MMM-NexusDashboard/assets/icons/warm-fridge.svg" alt="" />
                Temperature Alert
            </div>
            <div class="nexus-fridge-chart-grid nexus-fridge-chart-grid-${Math.min(alerting.length, 2)}">
                ${alerting.map(c => this.renderTile(c)).join("")}
            </div>
        `;
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("FridgeAlertChartCard", FridgeAlertChartCard);
}
window.FridgeAlertChartCard = FridgeAlertChartCard;
