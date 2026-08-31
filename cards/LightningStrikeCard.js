/**
 * cards/LightningStrikeCard.js
 *
 * School-workspace-only. Renders as its own grid tile (not the shared
 * clock badge slot AuroraCard/WatchBadgeCard/LightningBadgeCard fight
 * over) - unlike those, this drives a real go/no-go recess decision, so
 * it stays visible with an explicit "all clear" state rather than
 * disappearing when there's nothing to report (FridgeAlertCard's
 * hide-when-empty approach is wrong here: silence would be
 * indistinguishable from "card never loaded"). A judgment call, not
 * specified in the original brief - flag if a badge-slot version is
 * wanted instead.
 *
 * Driven by node_helper's local AS3935 hardware sensor
 * (NEXUS_LIGHTNING_STRIKE) - completely separate data source from
 * LightningBadgeCard's Xweather cloud feed (NEXUS_LIGHTNING_UPDATE). This
 * one only knows about strikes the sensor itself heard, with no forecast/
 * zone information, but at real-time IRQ latency instead of a poll cadence.
 *
 * Not part of the shared modes.json - added to the School deployment's own
 * (gitignored) config/school.json. LIGHTNING_SENSOR_ENABLED absent in
 * .env means node_helper never spawns the sensor daemon and this card
 * just sits in its "sensor offline" state forever - harmless on any
 * deployment that doesn't opt in.
 */
class LightningStrikeCard extends NexusCard {
    start() {
        this.sensorConfirmed = false;
        this.lastStrike = null;

        this.updateDom();

        // Re-render on a timer even without a new push, so "X min ago"
        // keeps advancing and a strike falls out of the active window on
        // its own rather than only when the next real strike arrives.
        this.timer = setInterval(() => this.render(), 15000);
    }

    suspend() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    resume() {
        if (!this.timer) {
            this.render();
            this.timer = setInterval(() => this.render(), 15000);
        }
    }

    // Triggered on NEXUS_LIGHTNING_STRIKE
    updateState(data) {
        if (!data) return;
        this.sensorConfirmed = data.sensorConfirmed;
        this.lastStrike = data.lastStrike;
        this.updateDom();
    }

    render() {
        const distanceThresholdKm = this.configManager.get("lightningSensor", "distanceThresholdKm", 15);
        const activeWindowMinutes = this.configManager.get("lightningSensor", "activeWindowMinutes", 30);

        this.domElement.className = "nexus-card nexus-lightning-strike-card";

        if (!this.sensorConfirmed) {
            this.domElement.classList.add("nexus-lightning-strike-offline");
            this.domElement.innerHTML = `
                <div class="nexus-lightning-strike-status">Lightning sensor offline</div>
            `;
            return;
        }

        const ageMinutes = this.lastStrike ? (Date.now() - this.lastStrike.ts) / 60000 : Infinity;
        const isActive = this.lastStrike
            && this.lastStrike.distanceKm !== false
            && this.lastStrike.distanceKm <= distanceThresholdKm
            && ageMinutes <= activeWindowMinutes;

        if (isActive) {
            this.domElement.classList.add("nexus-lightning-strike-active");
            const minutesAgo = Math.max(0, Math.round(ageMinutes));
            this.domElement.innerHTML = `
                <img class="nexus-lightning-strike-icon" src="modules/MMM-NexusDashboard/assets/icons/lightning.svg" alt="Lightning detected" />
                <div class="nexus-lightning-strike-details">
                    <div class="nexus-lightning-strike-title">Lightning detected nearby</div>
                    <div class="nexus-lightning-strike-meta">~${this.lastStrike.distanceKm}km away, ${minutesAgo} min ago</div>
                </div>
            `;
            return;
        }

        this.domElement.classList.add("nexus-lightning-strike-clear");
        this.domElement.innerHTML = `
            <div class="nexus-lightning-strike-status">No lightning detected nearby</div>
        `;
    }
}
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("LightningStrikeCard", LightningStrikeCard);
}
window.LightningStrikeCard = LightningStrikeCard;
