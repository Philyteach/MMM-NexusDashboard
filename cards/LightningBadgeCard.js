/**
 * cards/LightningBadgeCard.js
 * No dedicated grid tile - docks a badge into another card's slot via the
 * reusable data-badge-target pattern, same as AuroraCard/WatchBadgeCard.
 * Purely driven by node_helper's Xweather Lightning Threats poll
 * (NEXUS_LIGHTNING_UPDATE), never polls itself.
 *
 * Priority chain in the shared slot (not specified in the original brief -
 * a judgment call, flag if this should be reordered):
 *   WatchBadgeCard (NWS watch) > LightningBadgeCard > AuroraCard
 * An NWS Tornado/Severe Thunderstorm Watch is a vetted, human-issued
 * product covering a whole county, so it still wins outright. A nearby
 * lightning threat is a more immediate, actionable "right now" thing than
 * "aurora maybe visible tonight", so it outranks Aurora in turn. See
 * WatchBadgeCard.js/AuroraCard.js for the other two legs of this cascade.
 */
class LightningBadgeCard extends NexusCard {
    start() {
        this.lightningData = { hasThreat: false, severe: false, threatCount: 0, nearestThreat: null };
    }

    updateState(data) {
        this.lightningData = data || this.lightningData;
        this.render();
    }

    render() {
        const targetName = this.configManager.get("lightning", "badgeTarget", "clock");
        const slot = document.querySelector(`[data-badge-target="${targetName}"]`);
        if (!slot) return;

        window.NexusBadgeSlotOwners = window.NexusBadgeSlotOwners || {};

        // An active NWS watch outranks us - back off entirely rather than
        // fight WatchBadgeCard over slot.innerHTML.
        if (window.NexusBadgeSlotOwners[targetName] === "watch") return;

        if (!this.lightningData.hasThreat) {
            if (window.NexusBadgeSlotOwners[targetName] === "lightning") {
                delete window.NexusBadgeSlotOwners[targetName];
            }
            // Always hand off to Aurora here (not just when we previously
            // owned the slot) - this is also how a Watch clearing cascades
            // down to us: WatchBadgeCard calls our render() directly, and
            // if we have nothing to show, Aurora needs its shot at the
            // now-open slot in the same tick rather than waiting out its
            // own slow poll cadence. Cheap/idempotent when nothing changed.
            slot.innerHTML = "";
            window.MMM_NexusDashboard_CardManager?.instances["AuroraCard"]?.render();
            return;
        }

        window.NexusBadgeSlotOwners[targetName] = "lightning";

        const threat = this.lightningData.nearestThreat;
        let title = "Lightning threat nearby";
        if (threat) {
            if (threat.severe) title += " (severe)";
            if (threat.validUntil) {
                const until = new Date(threat.validUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
                title += ` - active until ${until}`;
            }
        }

        slot.innerHTML = `
            <img class="nexus-lightning-badge"
                 src="modules/MMM-NexusDashboard/assets/icons/lightning.svg"
                 title="${title}"
                 alt="Lightning threat indicator" />
        `;
    }
}
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("LightningBadgeCard", LightningBadgeCard);
}
window.LightningBadgeCard = LightningBadgeCard;
