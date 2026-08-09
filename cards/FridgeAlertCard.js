/**
 * cards/FridgeAlertCard.js
 *
 * Badge/notification-tier display for the fridge/freezer temperature
 * alerts computed in node_helper.js (NEXUS_FRIDGE_ALERTS - latched
 * channels only, already resolved to plain-English locations). Occupies a
 * normal grid slot in the Home sidebar rather than docking into another
 * card's badge slot like AuroraCard/WatchBadgeCard - there's real per-alert
 * detail to show here (name, temp, duration), not just an icon - but when
 * there are zero active alerts it renders nothing and drops out of the
 * flex sidebar entirely (see the nexus-fridge-alert-empty class in
 * css/fridge-alert.css) rather than sitting there as an empty card.
 */
class FridgeAlertCard extends NexusCard {
    start() {
        this.alerts = [];
    }

    // Triggered on NEXUS_FRIDGE_ALERTS
    updateState(alerts) {
        this.alerts = alerts || [];
        this.updateDom();
    }

    formatDuration(latchedAtMs) {
        if (!latchedAtMs) return null;
        const minutes = Math.max(0, Math.round((Date.now() - latchedAtMs) / 60000));
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return remMinutes > 0 ? `${hours} hr ${remMinutes} min` : `${hours} hr`;
    }

    render() {
        if (this.alerts.length === 0) {
            this.domElement.className = "nexus-fridge-alert-card nexus-fridge-alert-empty";
            this.domElement.innerHTML = "";
            return;
        }

        this.domElement.className = "nexus-card nexus-fridge-alert-card";
        this.domElement.innerHTML = this.alerts.map(alert => {
            const duration = this.formatDuration(alert.latchedAt);
            return `
                <div class="nexus-fridge-alert-item">
                    <img class="nexus-fridge-alert-icon" src="modules/MMM-NexusDashboard/assets/icons/warm-fridge.svg" alt="Temperature alert" />
                    <div class="nexus-fridge-alert-details">
                        <div class="nexus-fridge-alert-name">${alert.location}</div>
                        <div class="nexus-fridge-alert-temp">${Math.round(alert.currentTempF)}&deg;F <span class="nexus-fridge-alert-threshold">(above ${alert.thresholdF}&deg;F)</span></div>
                        ${duration ? `<div class="nexus-fridge-alert-duration">Out of range ${duration}</div>` : ""}
                    </div>
                </div>
            `;
        }).join("");
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("FridgeAlertCard", FridgeAlertCard);
}
window.FridgeAlertCard = FridgeAlertCard;
