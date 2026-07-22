/**
 * node_helper.js
 * 
 * High-performance Node helper for the MMM-NexusDashboard module.
 * Securely handles configuration reading, environment secrets, NWS API calls,
 * and the Immich private asset streaming proxy.
 */
// Load environment variables from the MagicMirror root directory
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const NodeHelper = require("node_helper");
const fs = require("fs");
const fetch = require("node-fetch");
const { exec } = require("child_process");
const formatter = require("./lib/formatter.js");

module.exports = NodeHelper.create({

    start: function() {
        console.log("[Nexus OS] Backend service helper started.");
        this.configPath = path.join(__dirname, "config");
        
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
                response.body.pipe(res); // Stream the binary straight to the mirror UI
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

    socketNotificationReceived: async function(notification, payload) {
        switch (notification) {
            case "NEXUS_INIT":
                this.loadAllConfigurations();
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
            const alertsUrl = `https://api.weather.gov/alerts/active?point=${lat},${lon}`;

            // USNO wants date + a local UTC-offset (in hours, east-positive) rather
            // than a timezone name. getTimezoneOffset() is minutes-west-of-UTC, so
            // negating and converting to hours gives exactly that — and since it's
            // read fresh "now" it already accounts for whether DST is active today.
            const now = new Date();
            const astroDate = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
            const tzOffset = -(now.getTimezoneOffset() / 60);
            const astronomyUrl = `https://aa.usno.navy.mil/api/rstt/oneday?date=${astroDate}&coords=${lat},${lon}&tz=${tzOffset}`;

            const [forecastRes, alertsRes, astronomyRes] = await Promise.all([
                fetch(forecastGridUrl, { headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" } }),
                fetch(alertsUrl, { headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" } }),
                fetch(astronomyUrl, { headers: { "User-Agent": "MagicMirrorNexusDashboard/1.0" } })
            ]);

            const forecastData = forecastRes.ok ? await forecastRes.json() : null;
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
                });

                activeAlert = best;
            }

            this.sendSocketNotification("NEXUS_WEATHER_DATA", {
                forecast: forecastData ? forecastData.properties.periods : [],
                // Daily-aggregated forecast (one entry per calendar day, with high/low
                // and a NOAA icon URL) built by lib/formatter.js's formatDaily(), which
                // merges each day's daytime/nighttime periods into a single entry.
                daily: forecastData ? formatter.formatDaily(forecastData.properties.periods) : [],
                activeAlert: activeAlert,
                astronomy: astronomy
            });

        } catch (error) {
            console.error("[Nexus Helper] Weather fetch failure:", error.message);
            this.sendSocketNotification("NEXUS_WEATHER_ERROR", { message: error.message });
        }
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
