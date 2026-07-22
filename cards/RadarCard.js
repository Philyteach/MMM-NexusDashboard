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

class RadarCard extends NexusCard {
    start() {
        this.map = null;
        this.radarLayers = [];
        this.currentFrameIndex = 0;
        this.animationTimer = null;
        this.refreshTimer = null;
        this.lat = this.configManager.getEnv("LATITUDE", 40.2139);
        this.lon = this.configManager.getEnv("LONGITUDE", -75.0046);
    }

    render() {
        this.domElement.className = "nexus-card nexus-radar-card";

        // Leaflet needs a physical div container with an explicit ID to mount to
        this.domElement.innerHTML = `
            <div class="radar-container">
                <div id="nexus-radar-map"></div>
                <div class="radar-timeline-tag">NEXRAD Loop — IEM</div>
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

        // 2. Add an ultra-sleek, clean Dark Matter base map (perfect for smart mirrors)
        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            maxZoom: 19
        }).addTo(this.map);

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

        const timestamps = [
            "900913-m50m", "900913-m45m", "900913-m40m", "900913-m35m",
            "900913-m30m", "900913-m25m", "900913-m20m", "900913-m15m",
            "900913-m10m", "900913-m05m", "900913" // "900913" alone = most recent
        ];

        // Clear any old layers before rebuilding (e.g. on periodic refresh or resume())
        this.radarLayers.forEach(layer => this.map.removeLayer(layer));
        this.radarLayers = [];

        timestamps.forEach((ts) => {
            const tileUrl = `https://mesonet.agron.iastate.edu/cache/tile.py/1.0.0/nexrad-n0q-${ts}/{z}/{x}/{y}.png`;

            const layer = L.tileLayer(tileUrl, {
                opacity: 0, // Hidden initially, faded in/out dynamically by startLoop()
                zIndex: 100
            });

            layer.addTo(this.map);
            this.radarLayers.push(layer);
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

    startLoop() {
        if (this.animationTimer) clearInterval(this.animationTimer);
        if (this.radarLayers.length === 0) return;

        this.currentFrameIndex = 0;
        // Make first frame visible
        this.radarLayers[0].setOpacity(0.65);

        this.animationTimer = setInterval(() => {
            const nextIndex = (this.currentFrameIndex + 1) % this.radarLayers.length;

            // Fade out the old, fade in the new
            this.radarLayers[this.currentFrameIndex].setOpacity(0);
            this.radarLayers[nextIndex].setOpacity(0.65);

            this.currentFrameIndex = nextIndex;
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
