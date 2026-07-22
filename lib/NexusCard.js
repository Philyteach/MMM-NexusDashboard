// MMM-NexusDashboard/lib/NexusCard.js

/**
 * lib/NexusCard.js (Base Class)
 * 
 * Shared class providing lifecycle hooks and config abstractions for all Nexus cards.
 */
class NexusCard {
    constructor(moduleInstance) {
        this.module = moduleInstance;
        this.configManager = moduleInstance.configManager;
        this.domElement = null;
        this.notificationHandlers = {}; // Store custom handlers
    }

    /**
     * Helper: Register a callback for global MagicMirror broadcasts.
     */
    registerNotificationReceiver(notification, callback) {
        this.notificationHandlers[notification] = callback;
    }

    /**
     * Dispatcher: Triggered by main module when a notification is broadcasted.
     */
    handleNotification(notification, payload) {
        if (typeof this.notificationHandlers[notification] === "function") {
            this.notificationHandlers[notification](payload);
        }
    }

    /**
     * Lifecycle: Override in sub-cards to set up updating intervals or events.
     */
    start() {
        // To be overridden
    }

    /**
     * Lifecycle: Override to define internal HTML/DOM construction.
     */
    getDom() {
        if (!this.domElement) {
            this.domElement = document.createElement("div");
            this.domElement.className = "nexus-card";
            this.render();
        }
        return this.domElement;
    }

    /**
     * Abstract rendering logic. Implement in card subclasses.
     */
    render() {
        this.domElement.innerHTML = `<div class="card-title">Empty Card</div>`;
    }

    /**
     * Request parent workspace redrawing or simple module UI updates.
     */
    updateDom() {
        if (this.domElement) {
            this.render();
        }
    }
}

// Bind to window to allow extension in downstream card files
window.NexusCard = NexusCard;
