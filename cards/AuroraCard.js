/**
 * cards/AuroraCard.js
 * No dedicated grid tile - docks a badge into another card's slot via the
 * reusable data-badge-target pattern. Purely driven by node_helper's
 * cached Kp/OVATION check (NEXUS_AURORA_DATA), never polls itself.
 */
class AuroraCard extends NexusCard {
    start() {
        this.auroraData = { badgeVisible: false, kpValue: null, probability: null };
    }
    updateState(data) {
        this.auroraData = data || this.auroraData;
        this.render();
    }
    render() {
        const targetName = this.configManager.get("aurora", "badgeTarget", "clock");
        const slot = document.querySelector(`[data-badge-target="${targetName}"]`);
        if (!slot) return;

        // Active watches AND an active lightning threat both take priority
        // over the aurora badge in a shared slot - back off entirely
        // rather than fight WatchBadgeCard/LightningBadgeCard over
        // slot.innerHTML. See those two files for the rest of this
        // priority chain (watch > lightning > aurora).
        window.NexusBadgeSlotOwners = window.NexusBadgeSlotOwners || {};
        if (window.NexusBadgeSlotOwners[targetName] === "watch") return;
        if (window.NexusBadgeSlotOwners[targetName] === "lightning") return;

        if (!this.auroraData.badgeVisible) {
            slot.innerHTML = "";
            return;
        }

        const probText = this.auroraData.probability !== null
            ? `${Math.round(this.auroraData.probability)}% chance tonight`
            : "Aurora possible tonight";

        slot.innerHTML = `
            <img class="nexus-aurora-badge"
                 src="modules/MMM-NexusDashboard/assets/icons/aurora.svg"
                 title="${probText}"
                 alt="Aurora borealis indicator" />
        `;
    }
}
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("AuroraCard", AuroraCard);
}
window.AuroraCard = AuroraCard;
