/**
 * cards/WatchBadgeCard.js
 * No dedicated grid tile - docks badge(s) into another card's slot via the
 * reusable data-badge-target pattern, same as AuroraCard. Driven entirely
 * by node_helper's activeWatches array, piggybacked on the existing
 * NEXUS_WEATHER_DATA payload - no separate poll of its own.
 *
 * Outranks both LightningBadgeCard and AuroraCard in a shared slot: writes
 * its "watch" claim into window.NexusBadgeSlotOwners, which both of those
 * check before they render. When the last watch clears, this card
 * relinquishes the slot and nudges LightningBadgeCard to re-render
 * immediately rather than waiting out its own poll cadence -
 * LightningBadgeCard in turn hands off to AuroraCard if it has nothing to
 * show, so a single call here cascades through the full priority chain
 * (watch > lightning > aurora). See LightningBadgeCard.js/AuroraCard.js.
 */
class WatchBadgeCard extends NexusCard {
    start() {
        this.watches = [];
    }

    updateState(activeWatches) {
        this.watches = activeWatches || [];
        this.render();
    }

    render() {
        const targetName = this.configManager.get("watchBadge", "badgeTarget", "clock");
        const slot = document.querySelector(`[data-badge-target="${targetName}"]`);
        if (!slot) return;

        window.NexusBadgeSlotOwners = window.NexusBadgeSlotOwners || {};

        if (this.watches.length === 0) {
            // Only clear/relinquish the slot if we're actually the one
            // holding it - otherwise we could stomp on something else.
            if (window.NexusBadgeSlotOwners[targetName] === "watch") {
                delete window.NexusBadgeSlotOwners[targetName];
                slot.innerHTML = "";
                window.MMM_NexusDashboard_CardManager?.instances["LightningBadgeCard"]?.render();
            }
            return;
        }

        window.NexusBadgeSlotOwners[targetName] = "watch";

        slot.innerHTML = this.watches.map(watch => `
            <img class="nexus-watch-badge"
                 src="modules/MMM-NexusDashboard/assets/icons/${watch.icon}.svg"
                 title="${watch.title}"
                 alt="${watch.title}" />
        `).join("");
    }
}
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("WatchBadgeCard", WatchBadgeCard);
}
window.WatchBadgeCard = WatchBadgeCard;
