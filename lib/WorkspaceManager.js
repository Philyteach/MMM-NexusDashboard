/**
 * lib/WorkspaceManager.js
 * 
 * Orchestrates layout engines, dynamic grid rendering, and workspace states.
 * Translates configuration profiles into UI structures.
 */

class WorkspaceManager {
    constructor(moduleInstance) {
        this.module = moduleInstance;
        this.workspaces = {};
    }

    /**
     * Cache workspace profiles loaded from modes.json
     */
    loadWorkspaces(modesConfig) {
        this.workspaces = modesConfig || {};
        if (this.module.config.debug) {
            console.log("[Nexus Workspaces] Available workspaces configured:", Object.keys(this.workspaces));
        }
    }

    /**
     * Flat list of every cardId a given workspace references, whether from
     * profile.sections[].cards or a flat profile.cards list. Used to decide
     * which cards to suspend()/resume() on a workspace switch (see
     * transitionWorkspace() in MMM-NexusDashboard.js).
     */
    getCardIdsForWorkspace(workspaceName) {
        const profile = this.workspaces[workspaceName];
        if (!profile) return [];

        if (profile.sections && Array.isArray(profile.sections)) {
            return profile.sections.reduce((ids, section) => {
                return ids.concat(section.cards || []);
            }, []);
        }
        if (profile.cards && Array.isArray(profile.cards)) {
            return profile.cards;
        }
        return [];
    }

    /**
     * Primary entry point called by the main module getDom() loop.
     * Generates a structural grid/flex layout container and populates it with cards.
     */
    renderWorkspace(workspaceName) {
        const workspaceContainer = document.createElement("div");
        workspaceContainer.id = "nexus-workspace-container";
        
        // Fetch workspace profile. Fallback to a clean CSS Grid flow.
        const profile = this.workspaces[workspaceName];
        if (!profile) {
            console.warn(`[Nexus Workspaces] Workspace layout not found: ${workspaceName}. Loading standard fallback.`);
            workspaceContainer.className = "nexus-grid-fallback";
            workspaceContainer.innerHTML = `<div class="nexus-error-message">Workspace "${workspaceName}" not configured.</div>`;
            return workspaceContainer;
        }

        // Apply visual and structural metadata to the wrapper
        // NOTE: "nexus-workspace" (base class) must come first — layout.css's grid rules
        // target that class. Without it, this container gets no display:grid at all,
        // which collapses any child card relying on height:100% (e.g. ImmichCard) to 0px.
        workspaceContainer.className = `nexus-workspace nexus-workspace-${workspaceName.toLowerCase()} nexus-layout-${profile.layout || 'grid'}`;
        
        // Set up CSS custom properties (variables) for custom grid templates if specified in JSON
        if (profile.gridTemplateColumns) {
            workspaceContainer.style.setProperty("--grid-template-cols", profile.gridTemplateColumns);
        }
        if (profile.gridTemplateRows) {
            workspaceContainer.style.setProperty("--grid-template-rows", profile.gridTemplateRows);
        }

        // Render sections/regions inside this workspace (e.g., top-bar, main-grid, sidebar)
        if (profile.sections && Array.isArray(profile.sections)) {
            profile.sections.forEach(section => {
                const sectionEl = this.createSection(section);
                workspaceContainer.appendChild(sectionEl);
            });
        } else if (profile.cards && Array.isArray(profile.cards)) {
            // Flat, single-grid style workspace
            profile.cards.forEach(cardId => {
                const cardEl = this.module.cardManager.getCardElement(cardId);
                if (cardEl) workspaceContainer.appendChild(cardEl);
            });
        }

        // Watch/aurora badges previously only appeared on the Home workspace,
        // since ClockCard (the only thing hosting a data-badge-target slot)
        // only ever sat in Home's sidebar - every other workspace's DOM
        // never had a slot for AuroraCard/WatchBadgeCard to dock into.
        // Mounting the same reusable slot directly on the workspace
        // container itself (already position:relative via .nexus-workspace,
        // see layout.css) makes badges visible no matter which workspace is
        // active, without duplicating the badge slot into every card.
        workspaceContainer.appendChild(this.createBadgeSlot());

        return workspaceContainer;
    }

    /**
     * Same reusable badge slot markup ClockCard hosts (see css/badges.css) -
     * AuroraCard/WatchBadgeCard find whichever one is currently mounted via
     * document.querySelector('[data-badge-target="clock"]'), and only one
     * workspace's container is ever attached to the document at a time, so
     * reusing the same target name here is safe.
     */
    createBadgeSlot() {
        const slot = document.createElement("div");
        slot.className = "nexus-badge-slot nexus-badge-slot--top-right";
        slot.setAttribute("data-badge-target", "clock");
        return slot;
    }

    /**
     * Creates a workspace sub-container (e.g., sidebar, top-header, bottom-footer)
     */
    createSection(sectionConfig) {
        const sectionEl = document.createElement("div");
        sectionEl.className = `nexus-section nexus-section-${sectionConfig.id}`;
        
        if (sectionConfig.className) {
            sectionEl.classList.add(...sectionConfig.className.split(" "));
        }

        // Populate this structural subsection with reusable cards
        if (sectionConfig.cards && Array.isArray(sectionConfig.cards)) {
            sectionConfig.cards.forEach(cardId => {
                // Fetch instance of card from CardManager
                const cardEl = this.module.cardManager.getCardElement(cardId);
                if (cardEl) {
                    sectionEl.appendChild(cardEl);
                }
            });
        }

        return sectionEl;
    }
}
