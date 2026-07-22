/**
 * lib/ConfigManager.js
 * 
 * Frontend storage structure. Acts as the client-side central repository 
 * for module behavior without hard-coded fallbacks.
 */

class ConfigManager {
    constructor(moduleInstance) {
        this.module = moduleInstance;
        this.rawConfigs = {};
    }

    /**
     * Invoked when node_helper completes file system scan.
     */
    setRawConfigs(data) {
        this.rawConfigs = data;
        if (this.module.config.debug) {
            console.log("[Nexus Config] System configurations updated and cached.", this.rawConfigs);
        }
    }

    /**
     * Get property from a specific workspace/config file (e.g., configManager.get('weather', 'provider'))
     */
    get(configScope, key, fallback = null) {
        if (!this.rawConfigs[configScope]) return fallback;
        return this.rawConfigs[configScope][key] !== undefined ? this.rawConfigs[configScope][key] : fallback;
    }

    /**
     * Access sensitive environment variables (e.g. coordinates or access keys)
     */
    getEnv(key, fallback = null) {
        if (!this.rawConfigs.env) return fallback;
        return this.rawConfigs.env[key] !== undefined ? this.rawConfigs.env[key] : fallback;
    }

    /**
     * Get workspace layout specific setup profiles
     */
    getWorkspaceProfile(workspaceName) {
        if (!this.rawConfigs.modes || !this.rawConfigs.modes[workspaceName]) {
            return null;
        }
        return this.rawConfigs.modes[workspaceName];
    }
}
