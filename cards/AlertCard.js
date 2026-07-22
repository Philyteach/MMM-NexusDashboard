/**
 * cards/AlertCard.js
 * 
 * Reusable Alert Card for emergency warnings and weather advisory instructions.
 * Ported from legacy alert panel structures.
 */

class AlertCard extends NexusCard {
    start() {
        this.activeAlert = null;
    }

    /**
     * Called dynamically by the core module when new weather data loads.
     */
    updateState(weatherData) {
        const alert = weatherData?.activeAlert || null;
        
        // Only trigger DOM updates if the alert state actually shifts
        if (JSON.stringify(this.activeAlert) !== JSON.stringify(alert)) {
            this.activeAlert = alert;
            this.updateDom();
        }
    }

    render() {
        this.domElement.className = "nexus-card nexus-alert-card";

        if (!this.activeAlert) {
            // Reassuring fallback state when the sky is clear
            this.domElement.classList.add("all-clear");
            this.domElement.innerHTML = `
                <div class="alert-clear-container">
                    <span class="clear-icon">☀️</span>
                    <div class="clear-title">No Active Alerts</div>
                    <div class="clear-subtitle">Local airspace and weather conditions are normal.</div>
                </div>
            `;
            return;
        }

        const alert = this.activeAlert;
        const isWarning = alert.type === "WARNING";

        // Apply visual severity styling
        this.domElement.classList.remove("all-clear");
        this.domElement.classList.add(isWarning ? "severity-warning" : "severity-watch");

        // Not every NWS alert includes instruction/description text (some
        // alert types omit one or both) — guard against both a literal
        // "undefined" rendering and a hard crash from calling .substring()
        // on an undefined value, which would leave this card stuck on
        // stale content during an actual warning.
        const title = alert.title || "Weather Alert";
        const instruction = alert.instruction || "Follow guidance from local officials and NOAA Weather Radio.";
        const description = alert.description || "No further details provided by NWS.";
        const descriptionTrimmed = description.length > 600 ? description.substring(0, 600) + "..." : description;

        // Structured UI split: Flashing header + Safety Instructions + Details[cite: 6]
        this.domElement.innerHTML = `
            <div class="nexus-alert-banner ${isWarning ? 'animate-flash' : ''}">
                ⚠️ ${title.toUpperCase()}
            </div>
            <div class="nexus-alert-body">
                <div class="instruction-section">
                    <h3>IMMEDIATE INSTRUCTIONS:</h3>
                    <p class="instruction-text">${instruction}</p>
                </div>
                <hr class="alert-divider" />
                <div class="details-section">
                    <h3>ALERT DETAILS:</h3>
                    <p class="details-text">${descriptionTrimmed}</p>
                </div>
            </div>
        `;
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("AlertCard", AlertCard);
}
window.AlertCard = AlertCard;
