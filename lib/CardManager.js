/**
 * lib/CardManager.js
 * 
 * Central registry and factory for Nexus Cards. Maintains persistent, 
 * self-updating UI objects and dishes them out dynamically to workspaces.
 */

class CardManager {
    constructor(moduleInstance) {
        this.module = moduleInstance;
        this.registry = {}; // Holds class definitions: { "ClockCard": ClockCard }
        this.instances = {}; // Holds running instances: { "ClockCard": <instance> }
    }

    /**
     * Registers a class definition. Called by custom card scripts on startup.
     */
    registerCard(cardId, cardClass) {
        this.registry[cardId] = cardClass;
        if (this.module.config.debug) {
            console.log(`[Nexus Cards] Registered engine: ${cardId}`);
        }
    }

    /**
     * Retrieves or instantiates a specific Card's active UI element.
     * Guarantees Rule #4: Reusable, cached card instances across workspaces.
     */
    getCardElement(cardId) {
        // 1. If an active instance already exists, return its current DOM node
        if (this.instances[cardId]) {
            return this.instances[cardId].getDom();
        }

        // 2. Locate the constructor in our registry
        const CardClass = this.registry[cardId] || window[cardId];
        if (!CardClass) {
            console.error(`[Nexus Cards] Engine "${cardId}" is not registered or loaded.`);
            return this.createPlaceholderError(cardId);
        }

        // 3. Construct and cache the new card instance
        try {
            const cardInstance = new CardClass(this.module);
            this.instances[cardId] = cardInstance;
            
            // Trigger lifecycle start (allows cards to spawn their own update intervals or hooks)
            if (typeof cardInstance.start === "function") {
                cardInstance.start();
            }

            return cardInstance.getDom();
        } catch (error) {
            console.error(`[Nexus Cards] Critical initialization failure in card: ${cardId}`, error);
            return this.createPlaceholderError(cardId);
        }
    }

    /**
     * Instantiates a card WITHOUT rendering it into a workspace grid slot.
     *
     * getCardElement() above is only ever called by WorkspaceManager while
     * building a workspace's grid from modes.json's per-section "cards"
     * arrays. "Overlay" cards like AuroraCard and WatchBadgeCard don't have
     * (and shouldn't have) a grid cell of their own - they dock into another
     * card's DOM via the data-badge-target pattern instead - so they're
     * never listed in modes.json, which means getCardElement() would never
     * run for them and this.instances[cardId] would stay permanently
     * undefined no matter how correct their own updateState()/render()
     * logic is.
     *
     * Call this directly (e.g. from the module's start()) for any card that
     * needs to exist in the registry/instances map without ever occupying
     * its own layout section.
     */
    instantiateOverlay(cardId) {
        if (this.instances[cardId]) return this.instances[cardId];

        const CardClass = this.registry[cardId] || window[cardId];
        if (!CardClass) {
            console.error(`[Nexus Cards] Overlay engine "${cardId}" is not registered or loaded.`);
            return null;
        }

        try {
            const cardInstance = new CardClass(this.module);
            this.instances[cardId] = cardInstance;

            if (typeof cardInstance.start === "function") {
                cardInstance.start();
            }

            if (this.module.config.debug) {
                console.log(`[Nexus Cards] Instantiated overlay card: ${cardId}`);
            }

            return cardInstance;
        } catch (error) {
            console.error(`[Nexus Cards] Critical initialization failure in overlay card: ${cardId}`, error);
            return null;
        }
    }

    /**
     * Fallback UI element if a card configuration fails or the file is missing
     */
    createPlaceholderError(cardId) {
        const placeholder = document.createElement("div");
        placeholder.className = "nexus-card nexus-card-error";
        placeholder.innerHTML = `
            <div class="card-inner">
                <span class="card-error-icon">⚠️</span>
                <span class="card-error-text">${cardId} unavailable</span>
            </div>
        `;
        return placeholder;
    }

    /**
     * Force-notifies all active card instances to refresh their state.
     * Useful for theme switches, system-wide config updates, or global intervals.
     */
    updateAllCards() {
        Object.keys(this.instances).forEach(cardId => {
            const instance = this.instances[cardId];
            if (instance && typeof instance.update === "function") {
                instance.update();
            }
        });
    }
}
