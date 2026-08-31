/**
 * cards/RadarCard.js
 *
 * High-performance animated radar loop card using Leaflet.js and the Iowa
 * Environmental Mesonet's NEXRAD composite reflectivity tiles.
 *
 * IEM's mosaic is built directly from the same NEXRAD Level III feed the
 * NWS itself uses to issue warnings (rather than a third-party global
 * aggregation), refreshed on the same ~5-minute cadence as the actual radar
 * volume scans. Docs: https://mesonet.agron.iastate.edu/ogc/
 */

// Minutes-before-now for each loop frame, oldest first, "now" last. Single
// source of truth for both the IEM tile URL suffix and the frame's
// displayed timestamp in buildRadarFrames() - two separately-hardcoded
// parallel arrays could silently drift apart after an edit; deriving both
// from one list can't. Mirrors RadarFullCard.js's identical setup.
const RADAR_CARD_FRAME_OFFSETS_MIN = [50, 45, 40, 35, 30, 25, 20, 15, 10, 5, 0];

class RadarCard extends NexusCard {
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
    }

    render() {
        this.domElement.className = "nexus-card nexus-radar-card";

        // Leaflet needs a physical div container with an explicit ID to mount to
        this.domElement.innerHTML = `
            <div class="radar-container">
                <div id="nexus-radar-map"></div>
                <div class="radar-timeline-tag">Loading NEXRAD…</div>
            </div>
        `;

        // Wait a split-second to ensure the DOM element is appended before building the map
        setTimeout(() => {
            this.initializeMap();
        }, 100);
    }

    initializeMap() {
        if (this.map) return; // Prevent double initialization

        // 1. Initialize Leaflet map targeting your exact coordinates
        this.map = L.map("nexus-radar-map", {
            zoomControl: false,
            attributionControl: false,
            dragging: false,
            doubleClickZoom: false,
            scrollWheelZoom: false,
            touchZoom: false
        }).setView([this.lat, this.lon], 8); // Zoom level 8 is ideal for regional storms

        // 2. Add Carto's Dark Matter basemap (perfect for smart mirrors).
        // Raster by default - confirmed 2026-08-30 that this legacy dark_all
        // path needs "key" (not "api_key") to drop the "API KEY REQUIRED"
        // watermark Carto added in Aug 2026. Carto is retiring raster in
        // favor of vector eventually, but their vector GL style needs WebGL,
        // which fails to initialize on this deployment's Electron/GLES stack
        // (ANGLE error 12289 - see mm.sh). Set CARTO_BASEMAP_MODE=vector once
        // that's sorted out and the style.json key param below is confirmed
        // (unverified as of this writing - the style JSON looked identical
        // with/without a key param in testing, unlike the raster endpoint).
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
        // https://carto.com/attributions. attributionControl is off above
        // (kiosk aesthetic) so this is added explicitly instead, styled
        // small via radar.css rather than left at Leaflet's default look.
        L.control.attribution({ position: "topright", prefix: false })
            .addAttribution('&copy; <a href="https://carto.com/attributions">CARTO</a> &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors')
            .addTo(this.map);

        // 3. Drop a minimalist marker directly on your home coordinate
        const pulseIcon = L.divIcon({
            className: "radar-home-marker",
            html: '<div class="home-pulse"></div>',
            iconSize: [20, 20]
        });
        L.marker([this.lat, this.lon], { icon: pulseIcon }).addTo(this.map);

        // 4. Build the animated NEXRAD loop and keep it fresh while visible
        this.buildRadarFrames();
        this.scheduleFrameRefresh();
    }

    /**
     * Builds the animated NEXRAD loop from IEM's composite reflectivity
     * tiles. IEM exposes the last 50 minutes as fixed 5-minute-increment
     * timestamp suffixes relative to request time — no metadata fetch
     * needed, the URLs are predictable and generated locally.
     */
    buildRadarFrames() {
        if (!this.map) return;

        // "Now" is pinned once per build, not re-read per frame - all
        // offsets need to be relative to the same instant IEM will resolve
        // its "-mXXm" suffixes against for this request.
        const buildTime = Date.now();

        // Clear any old layers before rebuilding (e.g. on periodic refresh or resume())
        this.radarLayers.forEach(layer => this.map.removeLayer(layer));
        this.radarLayers = [];
        this.frameTimestamps = [];

        RADAR_CARD_FRAME_OFFSETS_MIN.forEach((offsetMin) => {
            const ts = offsetMin === 0 ? "900913" : `900913-m${String(offsetMin).padStart(2, "0")}m`; // "900913" alone = most recent
            // IEM resolves "-mXXm" relative to request time, so this URL string is
            // identical on every rebuild - without a cache-busting param, staying live
            // depends entirely on the browser re-fetching over HTTP's Cache-Control
            // (max-age=300) exactly on schedule, for as long as this page stays open.
            const tileUrl = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-${ts}/{z}/{x}/{y}.png?_=${buildTime}`;

            const layer = L.tileLayer(tileUrl, {
                opacity: 0, // Hidden initially, faded in/out dynamically by startLoop()
                zIndex: 100
            });

            layer.addTo(this.map);
            this.radarLayers.push(layer);
            this.frameTimestamps.push(buildTime - offsetMin * 60000);
        });

        this.startLoop();
    }

    /**
     * IEM's "-mXXm" tile URLs are resolved relative to whenever the request
     * arrives, not frozen at build time — without periodically rebuilding,
     * the loop would quietly go stale the longer the Weather workspace
     * stays open (which matters most exactly when it's being watched
     * during an active severe weather event).
     */
    scheduleFrameRefresh() {
        if (this.refreshTimer) clearInterval(this.refreshTimer);
        this.refreshTimer = setInterval(() => {
            this.buildRadarFrames();
        }, 300000); // 5 minutes, matching IEM's own update cadence
    }

    /**
     * Shows the wall-clock time of whichever frame is currently visible in
     * the loop (radar tiles are 5-minute snapshots, so minute precision is
     * all IEM's data actually supports) - lets you tell at a glance whether
     * the loop is still live or has quietly gone stale, instead of just
     * trusting a static "NEXRAD Loop" label.
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
        // Make first frame visible
        this.radarLayers[0].setOpacity(0.65);
        this.updateFrameTimeLabel(0);

        this.animationTimer = setInterval(() => {
            const nextIndex = (this.currentFrameIndex + 1) % this.radarLayers.length;

            // Fade out the old, fade in the new
            this.radarLayers[this.currentFrameIndex].setOpacity(0);
            this.radarLayers[nextIndex].setOpacity(0.65);

            this.currentFrameIndex = nextIndex;
            this.updateFrameTimeLabel(nextIndex);
        }, 1000); // 1-second interval creates a smooth loop animation
    }

    suspend() {
        // Clear both timers when switching workspaces to save system resources
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
        // Re-fetch and animate when workspace becomes active
        if (this.map) {
            this.buildRadarFrames();
            this.scheduleFrameRefresh();
        }
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("RadarCard", RadarCard);
}
window.RadarCard = RadarCard;
