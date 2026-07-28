/**
 * MMM-NexusDashboard.js
 * 
 * Core controller for the Nexus Dashboard operating system built on top of MagicMirror.
 * Manages configuration loading, workspace state, card rendering lifecycle, and automation.
 */

Module.register("MMM-NexusDashboard", {
    // Default configuration
    defaults: {
        debug: false,
        startupWorkspace: "Home",
        rotationInterval: 0, // In minutes (0 = disabled)
    },

    /**
     * Load required scripts for core Managers and cards before initializing the module.
     */
    getScripts: function() {
        return [
            // 1. External dependencies first
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",

            // 2. Base Utility Class
            this.file("lib/NexusCard.js"),

            // 3. Core structural Managers
            this.file("lib/ConfigManager.js"),
            this.file("lib/WorkspaceManager.js"),
            this.file("lib/CardManager.js"),
            this.file("lib/ThemeManager.js"),
            
            // 4. Render Cards
            this.file("cards/ClockCard.js"),
            this.file("cards/WeatherCard.js"),
            this.file("cards/ForecastCard.js"),
            this.file("cards/AlertCard.js"),
            this.file("cards/RadarCard.js"),
            this.file("cards/ImmichCard.js"),
            this.file("cards/CalendarCard.js"),
            this.file("cards/TravelCard.js"),
            this.file("cards/AuroraCard.js"),
            this.file("cards/WatchBadgeCard.js")
        ];
    },

    /**
     * Break the monolithic CSS into modular, single-responsibility stylesheets.
     */
    getStyles: function() {
        return [
            "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
            this.file("css/theme.css"),     
            this.file("css/layout.css"),    
            this.file("css/cards.css"),     
            this.file("css/clock.css"),     
            this.file("css/weather.css"),   
            this.file("css/forecast.css"),  
            this.file("css/radar.css"),     
            this.file("css/calendar.css"),  
            this.file("css/immich.css"),    
            this.file("css/alerts.css"),    
            this.file("css/server.css"),
            this.file("css/travel.css"),
            this.file("css/badges.css")
        ];
    },

    /**
     * Module initialization.
     */
    init: function() {
        Log.info(`Initializing Nexus Dashboard: ${this.name}`);
        this.activeWorkspace = null;
        this.configManager = null;
        this.workspaceManager = null;
        this.cardManager = null;
        this.themeManager = null;
        this.emergencyModeActive = false;
        this.weatherInterval = null;
        // Core MagicMirror modules (like "calendar") can broadcast their
        // notifications before Nexus's own config round-trip finishes and
        // CalendarCard actually exists yet. Cache the latest payload here so
        // it isn't silently dropped — see notificationReceived() and the
        // NEXUS_CONFIG_LOADED handler below.
        this.latestCalendarEvents = null;
        this.latestWeatherData = null;
        this.latestAuroraData = null;
        this.latestWatchData = null;
    },

    /**
     * System is ready. Instantiate managers, apply configs, and boot up.
     */
    start: function() {
        this.activeWorkspace = this.config.startupWorkspace;

        // Initialize Core Managers
        this.configManager = new ConfigManager(this);
        this.workspaceManager = new WorkspaceManager(this);
        this.cardManager = new CardManager(this);
        this.themeManager = new ThemeManager(this);

        // Cards call window.MMM_NexusDashboard_CardManager.registerCard(...) on load
        // (see cards/*.js). Without this, that check always fails silently and
        // CardManager falls back to a plain window[cardId] lookup — which happens
        // to work, but the registry (and its debug logging) is never actually used.
        window.MMM_NexusDashboard_CardManager = this.cardManager;

        // AuroraCard and WatchBadgeCard render into another card's badge
        // slot (data-badge-target="clock") rather than occupying their own
        // grid cell, so they are deliberately never listed in modes.json's
        // per-section "cards" arrays. WorkspaceManager only ever asks
        // CardManager for cards that ARE listed there, so without this call
        // neither card would ever be instantiated — this.instances[...]
        // would stay undefined forever, silently no-op'ing every
        // updateState() call from NEXUS_WEATHER_DATA/NEXUS_AURORA_DATA no
        // matter how correct their own logic is.
        this.cardManager.instantiateOverlay("AuroraCard");
        this.cardManager.instantiateOverlay("WatchBadgeCard");

        // Request initial configs from node_helper.js
        this.sendSocketNotification("NEXUS_INIT", {
            startupWorkspace: this.activeWorkspace
        });

        Log.log(`${this.name} service managers initialized successfully.`);
    },

    /**
     * Primary DOM generation for the Nexus Dashboard layout container.
     */
    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.id = "nexus-dashboard-root";
        wrapper.className = `nexus-theme-${this.themeManager?.currentTheme || 'default'}`;

        if (!this.workspaceManager) {
            wrapper.innerHTML = "Loading Nexus Dashboard Core Engines...";
            return wrapper;
        }

        // Render current workspace layout container
        const workspaceContainer = this.workspaceManager.renderWorkspace(this.activeWorkspace);
        wrapper.appendChild(workspaceContainer);

        return wrapper;
    },

    /**
     * Intercept standard MagicMirror background broadcasts (like third-party calendars)
     */
/**
     * Intercept standard MagicMirror background broadcasts (like third-party calendars and weather)
     */
    notificationReceived: function(notification, payload, sender) {
        if (notification === "CALENDAR_EVENTS") {
            // Cache unconditionally — the core calendar module can fire this
            // before CalendarCard has been instantiated (e.g. right at
            // startup, before NEXUS_CONFIG_LOADED comes back from
            // node_helper). Without caching, that first broadcast — and
            // whatever events it contained — was silently lost until the
            // calendar module's next poll.
            this.latestCalendarEvents = payload;
            this.cardManager.instances["CalendarCard"]?.updateState(payload);

            // The Travel prediction scheduler in node_helper.js runs
            // independently of whether anyone's looking at the Travel
            // workspace (it has to - the whole point is catching a
            // same-time-tomorrow baseline reading and a day-of refined
            // reading regardless of screen state). It needs its own copy
            // of calendar locations/times to know what to check and when,
            // since it can't reach into a card that might not even be
            // instantiated right now.
            const locatedEvents = (payload || [])
                .filter(ev => ev.location && String(ev.location).trim().length > 0 && ev.startDate)
                .map(ev => ({
                    title: ev.title || "Event",
                    location: String(ev.location).trim(),
                    startDate: ev.startDate
                }));
            this.sendSocketNotification("SYNC_CALENDAR_LOCATIONS", locatedEvents);
        }
        
        // Lets anything on the standard MagicMirror notification bus ask for
        // a workspace switch - MMM-Remote-Control's custom menu / REST API
        // right now, and the CYD remote later, since both just need to fire
        // a notification with { workspace: "Travel" } (etc.) as the payload.
        // This is the only external entry point into transitionWorkspace();
        // without it, nothing outside this module's own weather automation
        // can ever change the active workspace.
        if (notification === "NEXUS_SWITCH_WORKSPACE") {
            if (payload && payload.workspace) {
                this.transitionWorkspace(payload.workspace, `External Switch (${sender?.name || "unknown"})`);
            } else {
                Log.warn("[Nexus Dashboard] NEXUS_SWITCH_WORKSPACE received with no workspace in payload.");
            }
        }

        // This is the bridge! It catches MagicMirror's background NOAA data
        // and pipes it right into your existing WeatherCard and AlertCard state loaders.
        if (notification === "WEATHER_UPDATED") {
            if (this.config.debug) {
                Log.info(`[Nexus Bridge] Intercepted NOAA weather update from standard module.`);
            }
            this.cardManager.instances["WeatherCard"]?.updateState(payload);
            this.cardManager.instances["ForecastCard"]?.updateState(payload);
            this.cardManager.instances["AlertCard"]?.updateState(payload);
            this.updateDom();
        }
    },

    /**
     * Handle incoming socket notifications from node_helper.js
     */
    socketNotificationReceived: function(notification, payload) {
        if (this.config.debug) {
            Log.info(`Nexus Dashboard received socket notification: ${notification}`);
        }

        switch (notification) {
            case "NEXUS_CONFIG_LOADED":
                this.configManager.setRawConfigs(payload);
                this.themeManager.applyTheme(payload.dashboard?.Theme);
                this.workspaceManager.loadWorkspaces(payload.modes);
                
                // Boot up background weather fetching routines on module initialization
                this.requestWeatherUpdate();
                this.scheduleWeatherPoll(null);

                this.updateDom();

                // The Home workspace's cards (including CalendarCard) now
                // exist as a result of the updateDom() call above. Replay
                // any calendar payload that arrived earlier and was cached
                // in notificationReceived() before the card existed.
                if (this.latestCalendarEvents) {
                    this.cardManager.instances["CalendarCard"]?.updateState(this.latestCalendarEvents);
                }
                break;

            case "NEXUS_WEATHER_DATA":
                this.latestWeatherData = payload;
                this.latestWatchData = payload.activeWatches;
                this.cardManager.instances["WeatherCard"]?.updateState(payload);
                this.cardManager.instances["ForecastCard"]?.updateState(payload);
                this.cardManager.instances["AlertCard"]?.updateState(payload);
                this.evaluateWeatherAutomation(payload.activeAlert);
    
                // WatchBadgeCard doesn't own a grid cell - it injects its
                // icons directly into ClockCard's data-badge-target slot via
                // querySelector, outside the normal getDom() render cycle.
                // this.updateDom() rebuilds ClockCard's DOM fresh (a new,
                // empty badge slot div) but - unlike the Promise-returning
                // function of the same name buried in MagicMirror core's
                // own main.js - Module.prototype.updateDom() (what this
                // actually calls) gives module code no real way to know
                // when that rebuild has finished; there's no callback or
                // usable promise here (confirmed - a prior attempt at
                // `this.updateDom().then(...)` threw immediately with
                // "Cannot read properties of undefined (reading 'then')").
                // A short setTimeout is the pragmatic workaround: none of
                // these updateDom() calls pass a speed/animation argument,
                // so the swap should be effectively immediate, and 100ms
                // gives comfortable margin without being visible as a delay.
                setTimeout(() => {
                    this.cardManager.instances["WatchBadgeCard"]?.updateState(payload.activeWatches);
                }, 100);

                this.scheduleWeatherPoll(payload.activeAlert);
                break;

            case "NEXUS_WEATHER_ERROR":
                this.cardManager.instances["WeatherCard"]?.updateState(null, payload.message);
                this.cardManager.instances["ForecastCard"]?.updateState(null, payload.message);
                this.updateDom();
                // Keep retrying at the fast cadence on error rather than
                // silently going quiet for 15 minutes — a fetch failure
                // during active severe weather is exactly when you can't
                // afford to stop checking.
                this.scheduleWeatherPoll(null, true);
                break;

            case "NEXUS_AURORA_DATA":
                this.latestAuroraData = payload;
                this.cardManager.instances["AuroraCard"]?.updateState(payload);
                break;

            case "IMMICH_PHOTOS_DATA":
            case "IMMICH_PHOTOS_DATA":
                this.cardManager.instances["ImmichCard"]?.updateState(payload);
                break;

            case "IMMICH_ERROR":
                console.error("[Nexus Immich Card] Fetch failed:", payload);
                break;

            case "TRAVEL_TIMES_DATA":
                this.cardManager.instances["TravelCard"]?.updateState(payload, null);
                break;

            case "TRAVEL_TIMES_ERROR":
                this.cardManager.instances["TravelCard"]?.updateState(null, payload);
                break;

            case "TRAVEL_PREDICTIONS_DATA":
                this.cardManager.instances["TravelCard"]?.updatePredictions(payload);
                break;

            default:
                break;
        }
    },

    /**
     * Helper to safely request a weather update payload from backend services
     */
    requestWeatherUpdate: function() {
        if (!this.configManager) return;
        
        const lat = this.configManager.getEnv("LATITUDE");
        const lon = this.configManager.getEnv("LONGITUDE");

        this.sendSocketNotification("GET_NEXUS_WEATHER", {
            latitude: lat,
            longitude: lon
        });
    },

    /**
     * Schedules the next weather/alert poll. Cadence adapts to the current
     * threat level instead of a fixed 15-minute interval: a Warning polls
     * every minute, a Watch every 3 minutes, and normal conditions fall
     * back to every 15 minutes. This is a setTimeout chain (not
     * setInterval) so each poll's cadence is decided fresh once its result
     * comes back, letting it speed up or back off automatically.
     */
    scheduleWeatherPoll: function(activeAlert, forceFastRetry) {
        if (this.weatherInterval) clearTimeout(this.weatherInterval);

        const alertType = activeAlert?.type;
        const intervalMs = forceFastRetry ? 60000
                          : alertType === "WARNING" ? 60000
                          : alertType === "WATCH" ? 180000
                          : 900000;

        if (this.config.debug) {
            Log.info(`[Nexus Weather] Next poll in ${intervalMs / 1000}s (alert: ${alertType || "none"})`);
        }

        this.weatherInterval = setTimeout(() => {
            this.requestWeatherUpdate();
        }, intervalMs);
    },

    /**
     * Core weather automation router.
     */
    evaluateWeatherAutomation: function(alert) {
        if (!alert) {
            this.clearEmergencyMode();
            return;
        }

        const currentHour = new Date().getHours();
        const isDaytime = currentHour >= 7 && currentHour < 22;
        const alertTitle = alert.title.toLowerCase();

        if (alert.type === "WARNING" && alertTitle.includes("tornado")) {
            if (!this.emergencyModeActive) {
                this.emergencyModeActive = true;
                
                this.sendSocketNotification("EMERGENCY_TV_WAKE", {
                    title: alert.title,
                    description: alert.instruction || alert.description || "A tornado warning has been issued."
                });

                this.transitionWorkspace("Weather", "CRITICAL TORNADO WARNING");
            }
        }
        else if (alert.type === "WARNING" && isDaytime && (alertTitle.includes("thunderstorm") || alertTitle.includes("flood"))) {
            if (!this.emergencyModeActive) {
                this.emergencyModeActive = true;
                this.transitionWorkspace("Weather", "DAYTIME SEVERE WEATHER WARNING");
            }
        } 
        else {
            this.clearEmergencyMode();

            if (alert.type === "WATCH" || alert.type === "WARNING") {
                this.sendNotification("SHOW_ALERT", {
                    title: alert.title,
                    message: alert.instruction || "Take necessary local precautions.",
                    timer: 10000
                });
            }
        }
    },

    /**
     * Transition workspace state dynamically
     */
    transitionWorkspace: function(targetWorkspace, reason) {
        if (this.activeWorkspace === targetWorkspace) return;

        Log.log(`Nexus Automation Triggered [${reason}]: Switching to ${targetWorkspace} Workspace`);

        // Suspend cards that are leaving view (e.g. RadarCard's animation
        // loop, which otherwise runs forever in the background once
        // instantiated) and resume cards entering view. Cards without
        // suspend()/resume() defined are left alone.
        const outgoingCardIds = this.workspaceManager.getCardIdsForWorkspace(this.activeWorkspace);
        const incomingCardIds = this.workspaceManager.getCardIdsForWorkspace(targetWorkspace);

        outgoingCardIds
            .filter(id => !incomingCardIds.includes(id))
            .forEach(id => {
                const instance = this.cardManager.instances[id];
                if (instance && typeof instance.suspend === "function") instance.suspend();
            });

        this.activeWorkspace = targetWorkspace;

        incomingCardIds.forEach(id => {
            const instance = this.cardManager.instances[id];
            if (instance && typeof instance.resume === "function") instance.resume();
        });

        this.sendNotification("NEXUS_WORKSPACE_CHANGED", {
            workspace: this.activeWorkspace,
            reason: reason
        });

        // Cards for the incoming workspace may have just been instantiated
        // for the first time as part of the updateDom() call below (their
        // start() runs, but start() only initializes empty state - it has
        // no way to know about data that arrived before the card existed).
        // Without this replay, a freshly-created ForecastCard/WeatherCard/
        // AlertCard shows nothing until the next scheduled weather poll
        // happens to land, which can be several minutes away. Same pattern
        // already used for CalendarCard at boot in NEXUS_CONFIG_LOADED,
        // just generalized here to fire on every workspace switch rather
        // than only once at startup.
        if (this.latestWeatherData) {
            this.cardManager.instances["WeatherCard"]?.updateState(this.latestWeatherData);
            this.cardManager.instances["ForecastCard"]?.updateState(this.latestWeatherData);
            this.cardManager.instances["AlertCard"]?.updateState(this.latestWeatherData);
        }
        if (this.latestAuroraData) {
            this.cardManager.instances["AuroraCard"]?.updateState(this.latestAuroraData);
        }

        this.updateDom();

        // this.updateDom() (Module.prototype.updateDom) gives module code
        // no completion callback or usable promise - confirmed via a
        // console error when a prior attempt tried `.then()` on it. A
        // short setTimeout is the pragmatic workaround, same as in the
        // NEXUS_WEATHER_DATA handler above: none of these updateDom()
        // calls pass a speed/animation argument, so the rebuild should be
        // effectively immediate, and 100ms gives comfortable margin.
        // Replayed after Aurora on purpose: WatchBadgeCard's updateState()
        // claims the shared badge slot when watches are active, which
        // should win over whatever Aurora just rendered.
        setTimeout(() => {
            if (this.latestWatchData) {
                this.cardManager.instances["WatchBadgeCard"]?.updateState(this.latestWatchData);
            }
        }, 100);
    },
    /**
     * Revert dashboard to default configurations when conditions are clear
     */
    clearEmergencyMode: function() {
        if (this.emergencyModeActive) {
            this.emergencyModeActive = false;
            const defaultWorkspace = this.configManager.get("dashboard", "DefaultWorkspace", "Home");
            this.transitionWorkspace(defaultWorkspace, "Emergency Mode Cleared");
        }
    }
});
