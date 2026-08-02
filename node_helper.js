/**
 * node_helper.js
 * 
 * High-performance Node helper for the MMM-NexusDashboard module.
 * Securely handles configuration reading, environment secrets, NWS API calls,
 * and the Immich private asset streaming proxy.
 */
// Load environment variables from the MagicMirror root directory
const path = require("path");

const NodeHelper = require("node_helper");
const fs = require("fs");
const { exec } = require("child_process");
const formatter = require("./lib/formatter.js");
const TuyaWeatherClient = require("./lib/TuyaWeatherClient.js");
const RtlWeatherClient = require("./lib/RtlWeatherClient.js");

// Maps an NWS event name to one of the hazard icons in assets/icons/.
// Falls back to the generic "ebs" icon for anything unmapped rather than
// silently showing nothing.
function resolveWatchIcon(eventName) {
    const name = (eventName || "").toLowerCase();
    const iconMap = [
        { match: "tornado", icon: "tornado" },
        { match: "hurricane", icon: "hurricane" },
        { match: "tropical storm", icon: "hurricane" },
        { match: "blizzard", icon: "blizzard" },
        { match: "ice storm", icon: "icestorm" },
        { match: "flood", icon: "flood" },
        { match: "thunderstorm", icon: "thunderstorm" },
        { match: "severe", icon: "thunderstorm" },
        { match: "gale", icon: "gale" },
        { match: "heat", icon: "heat" },
        { match: "fog", icon: "fog" }
    ];
    const found = iconMap.find(m => name.includes(m.match));
    return found ? found.icon : "ebs";
}

// Groups NWS's per-hour forecast periods into wider buckets for a compact
// strip - default 8 buckets of 3 hours each covers a rolling 24h window
// starting from the current hour (NWS's hourly endpoint already returns
// periods starting at "now", so no date math needed to find the start).
// Reuses the exact same nexus-forecast-strip/day-col markup and CSS the
// old 5-day strip used - just more (narrower) columns and hour labels
// instead of day names, so this doesn't add any new vertical footprint
// versus what was already budgeted for that row.
function formatHourlyBuckets(periods, bucketSizeHours = 3, bucketCount = 8) {
    if (!periods || periods.length === 0) return [];
    const buckets = [];
    for (let i = 0; i < bucketCount; i++) {
        const period = periods[i * bucketSizeHours];
        if (!period) break;
        const label = i === 0
            ? "Now"
            : new Date(period.startTime)
                .toLocaleTimeString("en-US", { hour: "numeric" })
                .replace(" ", "")
                .toUpperCase();
        buckets.push({
            label: label,
            icon: period.icon,
            shortForecast: period.shortForecast,
            temperature: period.temperature,
            probabilityOfPrecipitation: period.probabilityOfPrecipitation?.value ?? null
        });
    }
    return buckets;
}

module.exports = NodeHelper.create({

    start: function() {
        console.log("[Nexus OS] Backend service helper started.");
        this.configPath = path.join(__dirname, "config");

        // Calendar locations/times, kept in sync by MMM-NexusDashboard.js's
        // SYNC_CALENDAR_LOCATIONS notification every time the core calendar
        // module broadcasts. This is separate from the on-demand
        // GET_TRAVEL_TIMES payload because the prediction scheduler below
        // has to run independent of whether anyone's looking at the Travel
        // workspace - it can't wait for TravelCard to hand it agenda data.
        this.calendarLocations = [];

        // { "<location>|<startDate>": { eventTitle, location, appointmentTime,
        //   baselineDurationSec, baselineCapturedAt, refinedDurationSec,
        //   refinedCapturedAt, suggestedLeaveTime } }
        this.travelPredictions = this.loadPredictions();

        // Runs regardless of workspace/card visibility - checks every 15
        // minutes whether any upcoming appointment needs its ~24h-ahead
        // baseline reading captured, or its day-of refined reading taken.
        // Also runs once immediately at startup in case the Pi rebooted
        // mid-cycle and a check window was missed while it was down.
        this.runPredictionScheduler();
        setInterval(() => this.runPredictionScheduler(), 15 * 60 * 1000);


        // Aurora badge state, refreshed independently of screen/workspace -
        // cheap Kp poll always runs; the heavier OVATION lookup only fires
        // when Kp actually crosses the threshold worth telling anyone about.
        this.auroraCache = { badgeVisible: false, kpValue: null, probability: null, updatedAt: null };
        this.runAuroraCheck();
        setInterval(() => this.runAuroraCheck(), 15 * 60 * 1000);

        // Live outdoor/indoor readings from the VEVOR weather station.
        // Two possible sources feed this cache - see
        // startWeatherStationClients() below for how they're arbitrated.
        // windDirDeg and rainMm are rtl_433-only (Tuya cloud never
        // reported a trustworthy rainfall figure, and didn't expose wind
        // direction at all) - they simply stay null when Tuya is the
        // active source.
        this.stationCache = {
            outdoorTempF: null,
            indoorTempF: null,
            outdoorHumidity: null,
            indoorHumidity: null,
            pressureInHg: null,
            windSpeedKnots: null,
            windGustKnots: null,
            windDirDeg: null,
            rainMm: null,
            lightIntensityKlux: null,
            uvIndex: null,
            batteryStatus: null,
            sensorOnline: false,
            lastUpdated: null
        };
        this.startWeatherStationClients();

        // Setup secure proxy route for private Immich assets
        this.expressApp.get("/nexus-immich-proxy/:assetId", async (req, res) => {
            const env = this.parseEnvFile();
            const url = env.IMMICH_URL;
            const apiKey = env.IMMICH_API_KEY;
            
            if (!url || !apiKey) {
                return res.status(500).send("Immich credentials missing.");
            }

            try {
                // Immich's size param takes named values ("preview", "thumbnail",
                // "fullsize") — the old single-letter values like "L" are not a
                // real option and were silently being ignored/rejected.
                const response = await fetch(`${url}/api/assets/${req.params.assetId}/thumbnail?size=preview`, {
                    headers: { "x-api-key": apiKey }
                });

                if (!response.ok) throw new Error("Failed to fetch image from Immich API.");
                
                res.setHeader("Content-Type", response.headers.get("content-type") || "image/jpeg");
                // node-fetch's response.body was a Node.js Readable stream,
                // so .pipe(res) worked directly. Native fetch's response.body
                // is a Web ReadableStream (per the Fetch spec) - no .pipe()
                // method exists on it. Buffering the whole image and sending
                // it in one shot is simplest and plenty fast for
                // thumbnail-sized images; Node.js's Readable.fromWeb() is the
                // streaming alternative if these images were ever large
                // enough that buffering became a concern.
                const imageBuffer = Buffer.from(await response.arrayBuffer());
                res.send(imageBuffer);
            } catch (error) {
                res.status(500).send(error.message);
            }
        });
    },

    /**
     * Parses the private .env file located inside config/
     * Sanitizes trailing commas, single quotes, and double quotes.
     */
    parseEnvFile: function() {
        const envPath = path.join(this.configPath, ".env");
        const config = {};
        
        if (!fs.existsSync(envPath)) {
            console.error("[Nexus Helper] Error: .env file is missing from config directory.");
            return config;
        }

        const lines = fs.readFileSync(envPath, "utf-8").split("\n");
        lines.forEach(line => {
            const trimmed = line.trim();
            if (trimmed && !trimmed.startsWith("#")) {
                const parts = trimmed.split("=");
                if (parts.length >= 2) {
                    const key = parts[0].trim();
                    let value = parts.slice(1).join("=").trim();
                    
                    // Sanitize trailing commas and quotation marks from manual configuration entry
                    if (value.endsWith(",")) {
                        value = value.slice(0, -1).trim();
                    }
                    if ((value.startsWith('"') && value.endsWith('"')) || 
                        (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1).trim();
                    }
                    
                    config[key] = value;
                }
            }
        });

        return config;
    },

    /**
     * Starts both weather-station data sources and arbitrates between
     * them. rtl_433 is the preferred source once it proves itself - ~20s
     * cadence versus Tuya cloud's ~20min lag is a real difference for a
     * "Right Now" panel. But rtl_433 depends on a USB SDR dongle actually
     * being plugged in and rtl_433 being installed/on PATH, either of
     * which could be true in dev and not (yet) on a freshly cloned Pi -
     * e.g. the school deployment. So: start both, let whichever reports
     * first win, and once rtl_433 has proven itself within the grace
     * window, stop Tuya polling so the two sources don't keep overwriting
     * stationCache with different lag/precision. If rtl_433 never reports
     * within the grace window, Tuya just keeps running indefinitely -
     * degraded (slower) station data beats no station data.
     */
    startWeatherStationClients: function() {
        const RTL_GRACE_MS = 2 * 60 * 1000;
        this.rtlConfirmed = false;

        this.startTuyaWeatherClient();
        this.startRtlWeatherClient();

        setTimeout(() => {
            if (!this.rtlConfirmed) {
                console.warn("[Nexus Station] No rtl_433 reading within the grace window - staying on Tuya cloud polling.");
            }
        }, RTL_GRACE_MS);
    },

    /**
     * Reads Tuya credentials from .env and starts the always-on station
     * poller. Missing credentials disable station polling with a warning
     * rather than crashing the whole helper - the rest of the dashboard
     * (weather, calendar, travel, etc.) should keep working fine without it.
     */
    startTuyaWeatherClient: function() {
        const env = this.parseEnvFile();
        if (!env.TUYA_CLIENT_ID || !env.TUYA_CLIENT_SECRET || !env.TUYA_DEVICE_ID) {
            console.warn("[Nexus Station Helper] Tuya credentials missing from .env - weather station polling disabled.");
            return;
        }

        this.tuyaClient = new TuyaWeatherClient({
            clientId: env.TUYA_CLIENT_ID,
            clientSecret: env.TUYA_CLIENT_SECRET,
            deviceId: env.TUYA_DEVICE_ID,
            baseUrl: (env.TUYA_BASE_URL || "https://openapi.tuyaus.com").trim(),
            pollIntervalMs: parseInt(env.TUYA_POLL_INTERVAL_MS || "60000", 10)
        });

        this.tuyaClient.onUpdate = (reading) => {
            // Once rtl_433 is confirmed live, Tuya's onUpdate is a no-op -
            // the client keeps running (harmless, low resource use) but
            // stops writing over the faster/more-detailed rtl_433 data.
            // (Rather than calling this.tuyaClient.stop() here, which
            // would assume TuyaWeatherClient has a stop() method - safer
            // to just ignore its updates than risk calling something
            // that might not exist.)
            if (this.rtlConfirmed) return;
            this.stationCache = { ...this.stationCache, ...reading };
            console.log(`[Nexus Station][Tuya] Poll OK: ${reading.outdoorTempF?.toFixed(1)}\u00b0F outdoor, ${reading.indoorTempF?.toFixed(1)}\u00b0F indoor (sensorOnline=${reading.sensorOnline})`);
            this.sendSocketNotification("NEXUS_STATION_DATA", this.stationCache);
        };

        this.tuyaClient.start();
    },

    /**
     * Reads rtl_433 spawn settings from .env and starts the near-real-time
     * station poller. RTL433_COMMAND/RTL433_ARGS let this be overridden
     * per-deployment (e.g. a `docker run ...` wrapper) without code
     * changes - see lib/RtlWeatherClient.js for why that matters. Missing
     * env vars just fall back to the plain `rtl_433 -f 915M -F json`
     * invocation that was confirmed working during testing.
     */
    startRtlWeatherClient: function() {
        const env = this.parseEnvFile();
        const command = env.RTL433_COMMAND || "rtl_433";
        const args = env.RTL433_ARGS
            ? env.RTL433_ARGS.split(" ").filter(Boolean)
            : ["-f", env.RTL433_FREQUENCY || "915M", "-F", "json"];
        const deviceId = env.RTL433_DEVICE_ID ? parseInt(env.RTL433_DEVICE_ID, 10) : null;

        this.rtlClient = new RtlWeatherClient({ command, args, deviceId });

        this.rtlClient.onUpdate = (reading) => {
            if (!this.rtlConfirmed) {
                console.log("[Nexus Station] rtl_433 confirmed reporting - now the active station source.");
                this.rtlConfirmed = true;
            }
            // Merge rather than replace: rtl_433 doesn't hear indoor
            // temp/humidity (that only exists on the console/Tuya side),
            // so keep whatever Tuya last reported for those two fields
            // instead of clobbering them with null every reading.
            this.stationCache = {
                ...this.stationCache,
                ...reading,
                indoorTempF: this.stationCache.indoorTempF,
                indoorHumidity: this.stationCache.indoorHumidity
            };
            this.sendSocketNotification("NEXUS_STATION_DATA", this.stationCache);
        };

        this.rtlClient.start();
    },

    socketNotificationReceived: async function(notification, payload) {
        switch (notification) {
            case "NEXUS_INIT":
                this.loadAllConfigurations();
                this.sendSocketNotification("NEXUS_AURORA_DATA", this.auroraCache);
                this.sendSocketNotification("NEXUS_STATION_DATA", this.stationCache);
                break;
            case "GET_NEXUS_WEATHER":
                await this.handleWeatherFetch(payload);
                break;

            case "EMERGENCY_TV_WAKE":
                this.executeSafetyOverride(payload);
                break;

            case "GET_IMMICH_PHOTOS":
                await this.handleImmichFetch();
                break;

            case "GET_TRAVEL_TIMES":
                await this.handleTravelFetch(payload);
                break;

            case "SYNC_CALENDAR_LOCATIONS":
                this.calendarLocations = payload || [];
                break;

            default:
                break;
        }
    },

    /**
     * Gathers all local config JSON structures and private secrets, 
     * broadcasting them to the frontend to boot the workspaces.
     */
    loadAllConfigurations: function() {
        try {
            const modesPath = path.join(this.configPath, "modes.json");
            const modes = fs.existsSync(modesPath) ? JSON.parse(fs.readFileSync(modesPath, "utf8")) : {};

            const dashboardPath = path.join(this.configPath, "dashboard.json");
            const dashboard = fs.existsSync(dashboardPath) ? JSON.parse(fs.readFileSync(dashboardPath, "utf8")) : {};

            const weatherConfigPath = path.join(this.configPath, "weather.json");
            const weather = fs.existsSync(weatherConfigPath) ? JSON.parse(fs.readFileSync(weatherConfigPath, "utf8")) : {};

            const envSecrets = this.parseEnvFile();

            this.sendSocketNotification("NEXUS_CONFIG_LOADED", {
                modes: modes,
                dashboard: dashboard,
                weather: weather,
                env: envSecrets
            });
        } catch (error) {
            console.error("[Nexus Helper] Configuration reading error:", error.message);
        }
    },

    /**
     * Performs standard coordinate queries to the National Weather Service API
     */
    handleWeatherFetch: async function(payload) {
        const env = this.parseEnvFile();
        const lat = env.LATITUDE || payload.latitude;
        const lon = env.LONGITUDE || payload.longitude;

        if (!lat || !lon) {
            this.sendSocketNotification("NEXUS_WEATHER_ERROR", { message: "GPS Coordinates missing." });
            return;
        }

        try {
            const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
            const pointsResponse = await fetch(pointsUrl, {
                headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0 (ken@magic-mirror)" }
            });

            if (!pointsResponse.ok) throw new Error("Could not fetch NWS points data.");
            const pointsData = await pointsResponse.json();

            const forecastGridUrl = pointsData.properties.forecast;
            const forecastHourlyUrl = pointsData.properties.forecastHourly;
            const alertsUrl = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;

            // USNO wants date + a local UTC-offset (in hours, east-positive) rather
            // than a timezone name. getTimezoneOffset() is minutes-west-of-UTC, so
            // negating and converting to hours gives exactly that — and since it's
            // read fresh "now" it already accounts for whether DST is active today.
            const now = new Date();
            const astroDate = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
            const tzOffset = -(now.getTimezoneOffset() / 60);
            const astronomyUrl = `https://aa.usno.navy.mil/api/rstt/oneday?date=${astroDate}&coords=${lat},${lon}&tz=${tzOffset}`;

            const [forecastRes, hourlyRes, alertsRes, astronomyRes] = await Promise.all([
                fetch(forecastGridUrl, { headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" } }),
                fetch(forecastHourlyUrl, { headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" } }),
                fetch(alertsUrl, { headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" } }),
                fetch(astronomyUrl, { headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" } })
            ]);

            const forecastData = forecastRes.ok ? await forecastRes.json() : null;
            const hourlyData = hourlyRes.ok ? await hourlyRes.json() : null;
            const alertsData = alertsRes.ok ? await alertsRes.json() : null;
            const astronomyData = astronomyRes.ok ? await astronomyRes.json() : null;

            // Pull just the fields the Forecast card actually shows out of USNO's
            // fuller GeoJSON response (moondata/sundata each list several
            // phenomena — twilight times, transit, etc. — we only want rise/set).
            let astronomy = null;
            const usnoDay = astronomyData?.properties?.data;
            if (usnoDay) {
                const findPhen = (list, phen) => (list || []).find(item => item.phen === phen)?.time || null;
                astronomy = {
                    moonPhase: usnoDay.curphase || null,
                    moonIllumination: usnoDay.fracillum || null,
                    moonrise: findPhen(usnoDay.moondata, "Rise"),
                    moonset: findPhen(usnoDay.moondata, "Set"),
                    sunrise: findPhen(usnoDay.sundata, "Rise"),
                    sunset: findPhen(usnoDay.sundata, "Set")
                };
            }

            let activeAlert = null;
            // Every currently-active WATCH, one entry per distinct hazard icon
            // (a "Severe Thunderstorm Watch" and a "Tornado Watch" both active
            // at once produces two badges; two differently-worded watches that
            // both map to the same icon collapse into one). This is deliberately
            // separate from the best/activeAlert logic below, which stays
            // focused on picking the single highest-severity item for AlertCard
            // and the workspace-switch automation - Warnings are not included
            // here on purpose, since a Warning already gets the full-screen
            // AlertCard/workspace treatment and doesn't need a small badge too.
            const activeWatches = [];
            if (alertsData && alertsData.features && alertsData.features.length > 0) {
                // Scan every active alert for this point rather than trusting
                // features[0] — NWS does not guarantee severity ordering, and
                // it's common to have a Watch AND a Warning active for the
                // same point simultaneously. Picking the wrong one here means
                // a real Warning could go completely unreported.
                const severityWeight = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };
                const typeWeight = { WARNING: 20, WATCH: 10, ADVISORY: 0 };

                let best = null;
                let bestScore = -1;
                const seenWatchIcons = new Set();

                alertsData.features.forEach(feature => {
                    const props = feature.properties;
                    const eventName = (props.event || "").toLowerCase();

                    let alertType = "ADVISORY";
                    if (eventName.includes("warning")) alertType = "WARNING";
                    else if (eventName.includes("watch")) alertType = "WATCH";

                    const score = (typeWeight[alertType] || 0) + (severityWeight[props.severity] || 0);
                    if (score > bestScore) {
                        bestScore = score;
                        best = {
                            title: props.event,
                            type: alertType,
                            description: props.description,
                            instruction: props.instruction
                        };
                    }

                    if (alertType === "WATCH") {
                        const iconKey = resolveWatchIcon(props.event || "");
                        if (!seenWatchIcons.has(iconKey)) {
                            seenWatchIcons.add(iconKey);
                            activeWatches.push({ title: props.event, icon: iconKey });
                        }
                    }
                });

                activeAlert = best;
            }

            this.sendSocketNotification("NEXUS_WEATHER_DATA", {
                forecast: forecastData ? forecastData.properties.periods : [],
                // Daily-aggregated forecast (one entry per calendar day, with high/low
                // and a NOAA icon URL) built by lib/formatter.js's formatDaily(), which
                // merges each day's daytime/nighttime periods into a single entry.
                // Still used by ForecastCard on the dedicated Forecast workspace.
                daily: forecastData ? formatter.formatDaily(forecastData.properties.periods) : [],
                // Rolling 24h hourly forecast, bucketed into 3-hour groups - what
                // WeatherCard's Home strip uses now instead of daily.
                hourly: hourlyData ? formatHourlyBuckets(hourlyData.properties.periods) : [],
                activeAlert: activeAlert,
                activeWatches: activeWatches,
                astronomy: astronomy
            });

        } catch (error) {
            console.error("[Nexus Helper] Weather fetch failure:", error.message);
            this.sendSocketNotification("NEXUS_WEATHER_ERROR", { message: error.message });
        }
    },

/**
 * Cheap always-on check: NOAA's planetary K-index, a single 0-9 number
 * updated roughly every 3 hours. Only when it crosses the configured
 * threshold do we bother pulling the much heavier OVATION grid.
 */
runAuroraCheck: async function() {
    try {
        const kpResponse = await fetch("https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json", {
            headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" }
        });
        if (!kpResponse.ok) throw new Error("Kp index fetch failed");
        const kpRows = await kpResponse.json();

        // Row 0 is the header ["time_tag","Kp","a_running","station_count"] -
        // the most recent reading is always the last row.

            const latestRow = kpRows[kpRows.length - 1];
            const kpValue = parseFloat(latestRow.Kp);
        const env = this.parseEnvFile();
        const threshold = parseFloat(env.AURORA_KP_THRESHOLD || "6");
        console.log(`[Nexus Aurora] Checked: Kp=${kpValue} (threshold=${threshold})`);

        if (Number.isNaN(kpValue) || kpValue < threshold) {
            this.auroraCache = {
                badgeVisible: false,
                kpValue: Number.isNaN(kpValue) ? null : kpValue,
                probability: null,
                updatedAt: new Date().toISOString()
            };
            this.sendSocketNotification("NEXUS_AURORA_DATA", this.auroraCache);
            return;
        }

        // Kp is high enough to be worth checking our actual location.
        const lat = parseFloat(env.LATITUDE);
        const lon = parseFloat(env.LONGITUDE);

        const ovationResponse = await fetch("https://services.swpc.noaa.gov/json/ovation_aurora_latest.json", {
            headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" }
        });
        if (!ovationResponse.ok) throw new Error("OVATION fetch failed");
        const ovationData = await ovationResponse.json();

        const probability = this.findNearestAuroraProbability(ovationData.coordinates, lat, lon);

        this.auroraCache = {
            badgeVisible: probability !== null && probability > 0,
            kpValue: kpValue,
            probability: probability,
            updatedAt: new Date().toISOString()
        };
        this.sendSocketNotification("NEXUS_AURORA_DATA", this.auroraCache);
        console.log(`[Nexus Aurora] Kp=${kpValue} crossed threshold, OVATION probability at our location: ${probability}%`);

    } catch (error) {
        console.error("[Nexus Aurora Helper] Check failed:", error.message);
    }
},

// OVATION's grid uses 0-360 east-positive longitude, while .env's
// LONGITUDE is stored the normal -180/180 way like every other lat/lon
// in this file - convert before searching, or a Pennsylvania longitude
// like -75 will silently fail to match anything near the ~285 entries
// that actually represent it.
findNearestAuroraProbability: function(coordinates, lat, lon) {
    if (!coordinates || Number.isNaN(lat) || Number.isNaN(lon)) return null;
    const targetLon = lon < 0 ? lon + 360 : lon;

    let closest = null;
    let closestDist = Infinity;
    for (const point of coordinates) {
        const [pointLon, pointLat, value] = point;
        const dist = (pointLon - targetLon) ** 2 + (pointLat - lat) ** 2;
        if (dist < closestDist) {
            closestDist = dist;
            closest = value;
        }
    }
    return closest;
},

    /**
     * Retrieve latest assets from Album or Library via Immich's search API.
     *
     * Immich v3 removed GET /api/assets entirely (404) and removed the
     * `assets` array from GET /api/albums/{id}'s response — both listing
     * paths now go through POST /api/search/metadata instead, optionally
     * filtered by albumIds. See: https://immich.app/blog/v3-migration
     */
    handleImmichFetch: async function() {
        const env = this.parseEnvFile();
        const url = env.IMMICH_URL;
        const apiKey = env.IMMICH_API_KEY;
        const albumId = env.IMMICH_ALBUM_ID;

        if (!url || !apiKey) {
            this.sendSocketNotification("IMMICH_ERROR", "Missing credentials");
            return;
        }

        try {
            const searchBody = { page: 1, size: 100 };
            if (albumId) {
                searchBody.albumIds = [albumId];
            }

            const response = await fetch(`${url}/api/search/metadata`, {
                method: "POST",
                headers: {
                    "x-api-key": apiKey,
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "Connection": "close" // Force the socket to close cleanly so Node-fetch-like engines don't panic
                },
                body: JSON.stringify(searchBody)
            });

            if (!response.ok) {
                throw new Error(`Immich API returned status ${response.status}`);
            }

            const data = await response.json();
            // Response shape: { albums: { items: [...] }, assets: { items: [...], total, nextPage } }
            const items = (data && data.assets && data.assets.items) || [];

            const photoIds = items
                .filter(asset => asset.type === "IMAGE")
                .map(asset => asset.id);

            this.sendSocketNotification("IMMICH_PHOTOS_DATA", photoIds);
        } catch (error) {
            console.error("[Nexus Immich Helper] Error:", error.message);
            this.sendSocketNotification("IMMICH_ERROR", error.message);
        }
    },

    // ---------- shared Routes API helpers (used by both the on-demand
    // GET_TRAVEL_TIMES fetch and the background prediction scheduler) ----------

    // Duration fields come back as strings like "312s" - strip the
    // trailing "s" and parse to a number of seconds.
    parseDurationSeconds: function(durationStr) {
        if (!durationStr) return null;
        const parsed = parseFloat(String(durationStr).replace("s", ""));
        return Number.isNaN(parsed) ? null : parsed;
    },

    formatDurationText: function(seconds) {
        if (seconds == null) return "N/A";
        const minutes = Math.round(seconds / 60);
        if (minutes < 60) return `${minutes} min`;
        const hours = Math.floor(minutes / 60);
        const remMinutes = minutes % 60;
        return remMinutes > 0 ? `${hours} hr ${remMinutes} min` : `${hours} hr`;
    },

    // Classifies how much worse (or not) traffic-aware duration is versus
    // the typical no-traffic baseline. Thresholds are a starting point, not
    // a Google-provided standard - tune to taste once you've watched it
    // against a few real commutes.
    classifyTraffic: function(durationSec, staticDurationSec) {
        if (durationSec == null || staticDurationSec == null || staticDurationSec === 0) return null;
        const ratio = durationSec / staticDurationSec;
        const deltaMinutes = Math.round((durationSec - staticDurationSec) / 60);
        let condition;
        if (ratio <= 1.05) condition = "light";
        else if (ratio <= 1.25) condition = "moderate";
        else condition = "heavy";
        return { condition, deltaMinutes };
    },

    formatToll: function(tollInfo) {
        const price = tollInfo?.estimatedPrice?.[0];
        if (!price) return null;
        const units = parseInt(price.units || "0", 10);
        const cents = Math.round((price.nanos || 0) / 1e7); // nanos -> hundredths
        const amount = (units + cents / 100).toFixed(2);
        return `${price.currencyCode || "$"} ${amount} toll`;
    },

    // Single shared call point for the Routes API computeRouteMatrix
    // endpoint. Returns the raw elements array Google sends back (one
    // element per origin*destination pair, tagged with destinationIndex).
    callRouteMatrix: async function(homeAddress, destinations, apiKey) {
        const requestBody = {
            origins: [{ waypoint: { address: homeAddress } }],
            destinations: destinations.map(dest => ({ waypoint: { address: dest } })),
            travelMode: "DRIVE",
            routingPreference: "TRAFFIC_AWARE_OPTIMAL",
            // No departureTime here on purpose: omitting it defaults to
            // "now" server-side. Setting it explicitly via
            // new Date().toISOString() is a race condition - by the time
            // the request reaches Google (network latency, Pi clock
            // precision), that timestamp can read as already in the
            // past, which Google rejects outright ("Timestamp must be
            // set to a future time.").
            extraComputations: ["TOLLS"]
        };

        const response = await fetch("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "X-Goog-Api-Key": apiKey,
                "X-Goog-FieldMask": "originIndex,destinationIndex,status,condition,distanceMeters,duration,staticDuration,travelAdvisory.tollInfo,fallbackInfo"
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            throw new Error(`Routes API returned status ${response.status}: ${errBody.slice(0, 200)}`);
        }

        return await response.json();
    },

    /**
     * Fetches live, traffic-aware drive times from HOME_ADDRESS to both
     * configured commutes (COMMUTE_1_DEST / COMMUTE_2_DEST) plus any
     * calendar-agenda locations the front end sends over. All destinations
     * go into a single Routes API computeRouteMatrix request (one origin x N
     * destinations = N elements billed) rather than one request per
     * destination, to make the free-tier math in the Travel card's header
     * comment actually hold.
     *
     * Uses the modern Routes API (computeRouteMatrix) rather than legacy
     * Distance Matrix - same batching/billing model, but the response
     * includes both `duration` (traffic-aware) and `staticDuration` (typical,
     * no-traffic baseline) for free in the same call, which is what lets us
     * classify traffic as light/moderate/heavy without any extra requests.
     * Toll estimates (extraComputations: ["TOLLS"]) are also included at no
     * extra element cost, since they're still part of the same matrix call.
     * Fuel consumption and per-road traffic detail are deliberately NOT used
     * here - those only exist on the single-origin computeRoutes method,
     * which would mean one API call per destination instead of one call
     * covering all of them, breaking the batching this whole card is built
     * around.
     */
    handleTravelFetch: async function(payload) {
        const env = this.parseEnvFile();
        const apiKey = env.GOOGLE_MAPS_API_KEY;
        const homeAddress = env.HOME_ADDRESS;

        if (!apiKey || !homeAddress) {
            this.sendSocketNotification("TRAVEL_TIMES_ERROR", "Missing GOOGLE_MAPS_API_KEY or HOME_ADDRESS in .env");
            return;
        }

        const commuteDests = [env.COMMUTE_1_DEST, env.COMMUTE_2_DEST].filter(Boolean);
        const agendaLocations = (payload?.agendaLocations || []).map(item => item.location);

        // De-dupe in case a commute destination also happens to match an
        // agenda location string exactly - avoids billing the same element twice.
        const allDestinations = [...new Set([...commuteDests, ...agendaLocations])];

        if (allDestinations.length === 0) {
            this.sendSocketNotification("TRAVEL_TIMES_DATA", {});
            return;
        }

        try {
            const elements = await this.callRouteMatrix(homeAddress, allDestinations, apiKey);
            const results = {};

            (elements || []).forEach(el => {
                const dest = allDestinations[el.destinationIndex];
                if (!dest) return;

                if (el.condition !== "ROUTE_EXISTS" || el.status?.code) {
                    results[dest] = { status: el.status?.message || el.condition || "UNKNOWN" };
                    return;
                }

                const durationSec = this.parseDurationSeconds(el.duration);
                const staticDurationSec = this.parseDurationSeconds(el.staticDuration);
                const traffic = this.classifyTraffic(durationSec, staticDurationSec);
                const tollText = this.formatToll(el.travelAdvisory?.tollInfo);

                results[dest] = {
                    durationSec: durationSec,
                    durationText: this.formatDurationText(durationSec),
                    distanceText: el.distanceMeters
                        ? `${(el.distanceMeters / 1609.34).toFixed(1)} mi`
                        : "",
                    trafficCondition: traffic?.condition ?? null,
                    trafficDeltaMinutes: traffic?.deltaMinutes ?? null,
                    tollText: tollText,
                    // Google fell back to a non-traffic-aware estimate for
                    // this route (outage, unsupported area, etc.) - the
                    // traffic badge above is a guess, not a real read, so
                    // the front end tags it as such rather than showing it
                    // with the same confidence as a normal result.
                    isEstimate: !!el.fallbackInfo,
                    status: "OK"
                };
            });

            this.sendSocketNotification("TRAVEL_TIMES_DATA", results);
        } catch (error) {
            console.error("[Nexus Travel Helper] Routes API fetch failure:", error.message);
            this.sendSocketNotification("TRAVEL_TIMES_ERROR", error.message);
        }
    },

    // ---------- predictive appointment leave-time scheduler ----------
    //
    // The idea: for an appointment tomorrow, grab one drive-time reading at
    // roughly the same time of day today as a baseline ("normal" drive time
    // for that time slot). Then, on the day of, use that baseline to figure
    // out roughly when you'd need to leave, and take one fresh reading
    // around an hour before that estimated leave time to refine it into an
    // actual suggested leave-by time. Two extra single-destination API calls
    // per appointment (a handful of elements each), not a continuous poll -
    // this runs independent of whether Travel is ever on screen.

    loadPredictions: function() {
        const predictionsPath = path.join(this.configPath, "travel.json");
        if (!fs.existsSync(predictionsPath)) return {};
        try {
            return JSON.parse(fs.readFileSync(predictionsPath, "utf-8"));
        } catch (error) {
            console.error("[Nexus Travel Scheduler] Failed to read travel.json, starting fresh:", error.message);
            return {};
        }
    },

    savePredictions: function() {
        const predictionsPath = path.join(this.configPath, "travel.json");
        try {
            fs.writeFileSync(predictionsPath, JSON.stringify(this.travelPredictions, null, 2), "utf-8");
        } catch (error) {
            console.error("[Nexus Travel Scheduler] Failed to write travel.json:", error.message);
        }
    },

    // One single-destination lookup (1 element), used by the scheduler for
    // both the baseline and refined checks - deliberately not batched with
    // anything else, since these fire at arbitrary times unrelated to any
    // on-screen poll cycle.
    fetchSingleTravelTime: async function(homeAddress, destination, apiKey) {
        const elements = await this.callRouteMatrix(homeAddress, [destination], apiKey);
        const el = (elements || [])[0];
        if (!el || el.condition !== "ROUTE_EXISTS" || el.status?.code) {
            throw new Error(el?.status?.message || el?.condition || "No route found");
        }
        return this.parseDurationSeconds(el.duration);
    },

    runPredictionScheduler: async function() {
        const env = this.parseEnvFile();
        const apiKey = env.GOOGLE_MAPS_API_KEY;
        const homeAddress = env.HOME_ADDRESS;
        if (!apiKey || !homeAddress) return;

        const now = new Date();
        const events = this.calendarLocations || [];
        const cushionMs = 60 * 60 * 1000; // 1hr "get ready to leave" buffer, matches the design as discussed
        let changed = false;

        for (const ev of events) {
            const appointmentTime = new Date(parseInt(ev.startDate, 10));
            if (Number.isNaN(appointmentTime.getTime())) continue;

            const msUntil = appointmentTime - now;
            // Ignore anything already past, or further out than 2 days -
            // no point tracking predictions that far ahead.
            if (msUntil <= 0 || msUntil > 48 * 60 * 60 * 1000) continue;

            const key = `${ev.location}|${ev.startDate}`;
            if (!this.travelPredictions[key]) {
                this.travelPredictions[key] = {
                    eventTitle: ev.title,
                    location: ev.location,
                    appointmentTime: appointmentTime.toISOString(),
                    baselineDurationSec: null,
                    baselineCapturedAt: null,
                    refinedDurationSec: null,
                    refinedCapturedAt: null,
                    suggestedLeaveTime: null
                };
                changed = true;
            }
            const pred = this.travelPredictions[key];
            const hoursUntil = msUntil / 3600000;

            // 1. Baseline capture: one reading in the 23-25 hour window
            // before the appointment (i.e. "about a day before, same-ish
            // time"), captured once.
            if (!pred.baselineCapturedAt && hoursUntil <= 25 && hoursUntil >= 23) {
                try {
                    const durationSec = await this.fetchSingleTravelTime(homeAddress, ev.location, apiKey);
                    pred.baselineDurationSec = durationSec;
                    pred.baselineCapturedAt = now.toISOString();
                    changed = true;
                    console.log(`[Nexus Travel Scheduler] Captured baseline for "${pred.eventTitle}": ${this.formatDurationText(durationSec)}`);
                } catch (error) {
                    console.error(`[Nexus Travel Scheduler] Baseline fetch failed for "${pred.eventTitle}":`, error.message);
                }
            }

            // 2. Refined check: once a baseline exists, take one fresh
            // reading about an hour before the estimated leave time
            // (appointment time minus baseline drive time minus the get-
            // ready cushion), then compute the actual suggested leave-by
            // time from that fresh reading.
            if (pred.baselineDurationSec != null && !pred.refinedCapturedAt) {
                const estimatedLeaveTime = new Date(appointmentTime.getTime() - pred.baselineDurationSec * 1000 - cushionMs);
                const checkTime = new Date(estimatedLeaveTime.getTime() - cushionMs);

                if (now >= checkTime && now < appointmentTime) {
                    try {
                        const durationSec = await this.fetchSingleTravelTime(homeAddress, ev.location, apiKey);
                        pred.refinedDurationSec = durationSec;
                        pred.refinedCapturedAt = now.toISOString();
                        pred.suggestedLeaveTime = new Date(appointmentTime.getTime() - durationSec * 1000 - cushionMs).toISOString();
                        changed = true;
                        console.log(`[Nexus Travel Scheduler] Refined leave-by for "${pred.eventTitle}": ${pred.suggestedLeaveTime}`);
                    } catch (error) {
                        console.error(`[Nexus Travel Scheduler] Refined fetch failed for "${pred.eventTitle}":`, error.message);
                    }
                }
            }
        }

        // Clean up predictions for events that have already passed (plus a
        // few hours' grace) so travel.json doesn't grow forever.
        for (const key of Object.keys(this.travelPredictions)) {
            const pred = this.travelPredictions[key];
            if (new Date(pred.appointmentTime).getTime() < now.getTime() - 6 * 60 * 60 * 1000) {
                delete this.travelPredictions[key];
                changed = true;
            }
        }

        if (changed) {
            this.savePredictions();
            this.sendSocketNotification("TRAVEL_PREDICTIONS_DATA", this.travelPredictions);
        }
    },


    /**
     * Executes localized system hardware overrides for severe threats.
     */
    executeSafetyOverride: function(payload) {
        console.log(`[Nexus OS Automation] CRITICAL AUTOMATION ENGAGED: "${payload.title}"`);

        exec("echo 'on 0' | cec-client -s -d 1", (error) => {
            if (error) console.error("[Nexus Hardware Control] CEC TV Wake failed:", error.message);
        });

        const chimePath = path.join(__dirname, "assets/alert-chime.wav");
        if (fs.existsSync(chimePath)) {
            exec(`aplay ${chimePath}`, (error) => {
                if (error) console.error("[Nexus Hardware Control] Audio chime play failed:", error.message);
            });
        }

        const announcementText = `Warning: ${payload.title}. Please review instructions on dashboard immediately.`;
        exec(`espeak-ng "${announcementText}"`, (error) => {
            if (error) console.warn("[Nexus Hardware Control] TTS voice engine skipped.");
        });
    }
});
