/**
 * cards/RadarFullCard.js
 *
 * Full-page deep-dive radar view, distinct from RadarCard's compact
 * half-screen loop in the Weather emergency workspace. Same provider (IEM's
 * NEXRAD composite reflectivity mosaic, see RadarCard.js's header comment
 * for why IEM over a third-party aggregator) and the same animated-loop
 * mechanics, but this card also tracks activeAlert (fed via updateState(),
 * the same NEXUS_WEATHER_DATA/WEATHER_UPDATED payload AlertCard already
 * consumes) to decide how often to rebuild the tile set: every 5 minutes
 * normally, matching IEM's own composite refresh cadence, or every minute
 * while a watch/warning is active, when the picture can change fast enough
 * that 5 minutes is genuinely stale.
 */

// Minutes-before-now for each loop frame, oldest first, "now" last. Single
// source of truth for both the IEM tile URL suffix and the frame's
// displayed timestamp in buildRadarFrames() - two separately-hardcoded
// parallel arrays could silently drift apart after an edit; deriving both
// from one list can't.
const RADAR_FULL_CARD_FRAME_OFFSETS_MIN = [50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];

class RadarFullCard extends NexusCard {
    start() {
        this.map = null;
        this.radarLayers = [];
        this.frameTimestamps = []; // wall-clock time for each radarLayers[i], set in buildRadarFrames()
        this.currentFrameIndex = 0;
        this.animationTimer = null;
        this.refreshTimer = null;
        this.lat = this.configManager.getEnv("LATITUDE", 40.2139);
        this.lon = this.configManager.getEnv("LONGITUDE", -75.0046);
        this.cartoApiKey = this.configManager.getEnv("CARTO_API_KEY", "");
        this.cartoBasemapMode = this.configManager.getEnv("CARTO_BASEMAP_MODE", "raster");
        this.activeAlert = null;
        // Timers only ever run while this card's workspace is the one on
        // screen - see suspend()/resume(), mirroring RadarCard's own
        // "don't animate/refresh what nobody's looking at" behavior.
        this.isFocused = false;
    }

    /**
     * Called by the core module whenever fresh weather data arrives
     * (same payload AlertCard.updateState() already reads activeAlert
     * from). Only the refresh cadence depends on this - the currently
     * running timer, if any, is rebuilt immediately so an alert onset
     * doesn't have to wait out whatever's left of the slower interval.
     */
    updateState(weatherData) {
        const alert = weatherData?.activeAlert || null;
        if (JSON.stringify(this.activeAlert) === JSON.stringify(alert)) return;

        this.activeAlert = alert;
        this.updateStatusTag();
        if (this.isFocused) this.scheduleFrameRefresh();
    }

    render() {
        this.domElement.className = "nexus-card nexus-radar-card nexus-radar-full-card";

        // Leaflet needs a physical div container with an explicit ID to mount to
        this.domElement.innerHTML = `
            <div class="radar-container">
                <div id="nexus-radar-full-map"></div>
                <div class="radar-timeline-tag">Loading NEXRAD…</div>
                <div class="radar-status-tag"></div>
            </div>
        `;

        // Wait a split-second to ensure the DOM element is appended before building the map
        setTimeout(() => {
            this.initializeMap();
        }, 100);
    }

    initializeMap() {
        if (this.map) return; // Prevent double initialization

        this.map = L.map("nexus-radar-full-map", {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            doubleClickZoom: false,
            scrollWheelZoom: false,
            touchZoom: false
        }).setView([this.lat, this.lon], 8);

        // Raster by default; vector opt-in via CARTO_BASEMAP_MODE - see
        // RadarCard.js's initializeMap() for the full explanation (Carto's
        // Aug 2026 watermark, the "key" vs "api_key" param, and why vector
        // isn't the default yet - WebGL fails to init on this deployment).
        if (this.cartoBasemapMode === "vector") {
            L.maplibreGL({
                style: `https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json?key=${this.cartoApiKey}`
            }).addTo(this.map);
        } else {
            L.tileLayer(`https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?key=${this.cartoApiKey}`, {
                maxZoom: 19
            }).addTo(this.map);
        }

        // Carto's free tier requires visible attribution - see
        // https://carto.com/attributions.
        L.control.attribution({ position: "topright", prefix: false })
            .addAttribution('&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors')
            .addTo(this.map);

        const pulseIcon = L.divIcon({
            className: "radar-home-marker",
            html: '<div class="home-pulse"></div>',
            iconSize: [20, 20]
        });
        L.marker([this.lat, this.lon], { icon: pulseIcon }).addTo(this.map);

        // First render counts as "in focus" - transitionWorkspace() only
        // calls resume() on subsequent switches back into this workspace,
        // never on the initial instantiation (see MMM-NexusDashboard.js).
        this.isFocused = true;
        this.updateStatusTag();
        this.buildRadarFrames();
        this.scheduleFrameRefresh();
    }

    /**
     * Same predictable-URL approach as RadarCard: IEM's "-mXXm" tiles are
     * resolved relative to request time, so rebuilding periodically is what
     * keeps the loop from quietly going stale.
     */
    buildRadarFrames() {
        if (!this.map) return;

        // "Now" is pinned once per build, not re-read per frame - all
        // offsets need to be relative to the same instant IEM will resolve
        // its "-mXXm" suffixes against for this request.
        const buildTime = Date.now();

        this.radarLayers.forEach(layer => this.map.removeLayer(layer));
        this.radarLayers = [];
        this.frameTimestamps = [];

        RADAR_FULL_CARD_FRAME_OFFSETS_MIN.forEach((offsetMin) => {
            const ts = offsetMin === 0 ? "900913" : `900913-m${String(offsetMin).padStart(2, "0")}m`;
            // IEM resolves "-mXXm" relative to request time, so this URL string is
            // identical on every rebuild - without a cache-busting param, staying live
            // depends entirely on the browser re-fetching over HTTP's Cache-Control
            // (max-age=300) exactly on schedule, for as long as this page stays open.
            const tileUrl = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-${ts}/{z}/{x}/{y}.png?_=${buildTime}`;

            const layer = L.tileLayer(tileUrl, {
                opacity: 0,
                zIndex: 100
            });

            layer.addTo(this.map);
            this.radarLayers.push(layer);
            this.frameTimestamps.push(buildTime - offsetMin * 60000);
        });

        this.startLoop();
    }

    /**
     * Cadence adapts to alert state: a minute while a watch/warning is
     * active, otherwise 5 minutes (IEM's own composite update cadence).
     */
    scheduleFrameRefresh() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);

        const intervalMs = this.activeAlert ? 60000 : 300000;
        this.refreshTimer = setInterval(() => {
            this.buildRadarFrames();
        }, intervalMs);
    }

    updateStatusTag() {
        const tag = this.domElement?.querySelector(".radar-status-tag");
        if (!tag) return;

        if (this.activeAlert) {
            tag.textContent = `${this.activeAlert.type || "ALERT"} ACTIVE — updating every 1 min`;
            tag.classList.add("radar-status-alert");
        } else {
            tag.textContent = "Updating every 5 min";
            tag.classList.remove("radar-status-alert");
        }
    }

    /**
     * Shows the wall-clock time of whichever frame is currently visible in
     * the loop (radar tiles are 5-minute snapshots, so minute precision is
     * all IEM's data actually supports) - the whole point being that if
     * this stops advancing, or the "LIVE" frame's time isn't within a
     * refresh cycle of now, you can tell the loop has gone stale at a
     * glance instead of just trusting a static "NEXRAD Loop" label.
     */
    updateFrameTimeLabel(index) {
        const tag = this.domElement?.querySelector(".radar-timeline-tag");
        const timestamp = this.frameTimestamps[index];
        if (!tag || timestamp == null) return;

        const timeLabel = new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        const isLatest = index === this.frameTimestamps.length - 1;
        tag.textContent = `NEXRAD — ${timeLabel}${isLatest ? " (LIVE)" : ""}`;
    }

    startLoop() {
        if (this.animationTimer) clearInterval(this.animationTimer);
        if (this.radarLayers.length === 0) return;

        this.currentFrameIndex = 0;
        this.radarLayers[0].setOpacity(0.65);
        this.updateFrameTimeLabel(0);

        this.animationTimer = setInterval(() => {
            const nextIndex = (this.currentFrameIndex + 1) % this.radarLayers.length;

            this.radarLayers[this.currentFrameIndex].setOpacity(0);
            this.radarLayers[nextIndex].setOpacity(0.65);

            this.currentFrameIndex = nextIndex;
            this.updateFrameTimeLabel(nextIndex);
        }, 1000);
    }

    suspend() {
        this.isFocused = false;
        if (this.animationTimer) {
            clearInterval(this.animationTimer);
            this.animationTimer = null;
        }
        if (this.refreshTimer) {
            clearInterval(this.refreshTimer);
            this.refreshTimer = null;
        }
    }

    resume() {
        this.isFocused = true;
        if (this.map) {
            this.buildRadarFrames();
            this.scheduleFrameRefresh();
            this.updateStatusTag();
        }
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("RadarFullCard", RadarFullCard);
}
window.RadarFullCard = RadarFullCard;
