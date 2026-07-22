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
