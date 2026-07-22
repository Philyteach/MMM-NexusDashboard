/**
 * lib/ThemeManager.js
 * 
 * Handles color palettes, typography, status transitions,
 * and matches the active layout to dark, light, or custom themes.
 */

class ThemeManager {
    constructor(moduleInstance) {
        this.module = moduleInstance;
        this.currentTheme = "default";
    }

    /**
     * Applies a theme style rule globally by updating CSS class states
     * on the root dashboard wrapper.
     */
    applyTheme(themeName) {
        if (!themeName) return;
        
        const oldTheme = this.currentTheme;
        this.currentTheme = themeName.toLowerCase();

        const root = document.getElementById("nexus-dashboard-root");
        if (root) {
            root.classList.remove(`nexus-theme-${oldTheme}`);
            root.classList.add(`nexus-theme-${this.currentTheme}`);
        }

        if (this.module.config.debug) {
            console.log(`[Nexus Theme] Transitioned theme from "${oldTheme}" to "${this.currentTheme}"`);
        }
    }
}
