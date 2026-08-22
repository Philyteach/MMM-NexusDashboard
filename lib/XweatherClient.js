/**
 * lib/XweatherClient.js
 *
 * Polls Xweather's (Vaisala AerisWeather) Lightning Threats endpoint for
 * active/forecast lightning threat zones near this dashboard's location -
 * one of the API endpoints unlocked by the free PWSWeather Contributor
 * Plan (see lib/PwsWeatherClient.js's header) in exchange for sharing
 * station data with PWSWeather.
 *
 * Auth is two plain query params (client_id/client_secret) appended to
 * every request - no OAuth token exchange/refresh cycle, unlike Tuya (see
 * lib/TuyaWeatherClient.js).
 *
 * IMPORTANT - this endpoint carries a 10x "access" multiplier (confirmed
 * against https://www.xweather.com/docs/weather-api/endpoints/lightning-threats,
 * which lists "Default Multiplier: 10x" for this endpoint specifically).
 * The Contributor Plan's daily quota is 1,000 *accesses*, not 1,000 raw
 * requests, so every poll here actually costs 10 against that budget. At
 * the default 30-minute cadence below that's 48 requests/day * 10 = 480
 * accesses/day (48% of quota) - comfortable headroom for retries and for
 * other Xweather endpoints added later. A naive 5-minute cadence (a
 * reasonable first guess before checking this endpoint's actual pricing)
 * would burn 2,880 accesses/day - nearly 3x the *entire* daily quota - so
 * don't lower XWEATHER_POLL_INTERVAL_MS without redoing this math.
 *
 * Response shape, per the docs above:
 *   { success, error, response: [ { id, dataSource, details: { stormId,
 *     issuedTimestamp, range: { minTimestamp, maxTimestamp, ... },
 *     movement: { dir, dirTo, speedMPH, reliability }, totalPeriods,
 *     severe (bool) }, periods: [...10-min forecast polygons...],
 *     forecastPath, profile } ] }
 * There is no numeric 0-9 "threat level" scale on this endpoint (despite
 * that being a natural assumption for anything called "threats") - an
 * empty `response` array IS the "no threat" signal, and `details.severe`
 * is the only per-zone severity flag that exists.
 */

class XweatherClient {
    /**
     * @param {object} opts
     * @param {string} opts.clientId
     * @param {string} opts.clientSecret
     * @param {number} opts.latitude
     * @param {number} opts.longitude
     * @param {string} [opts.baseUrl="https://data.api.xweather.com"]
     * @param {number} [opts.pollIntervalMs=1800000] - 30 min default, see file header for the quota math
     */
    constructor(opts) {
        this.clientId = opts.clientId;
        this.clientSecret = opts.clientSecret;
        this.latitude = opts.latitude;
        this.longitude = opts.longitude;
        this.baseUrl = opts.baseUrl || "https://data.api.xweather.com";
        this.pollIntervalMs = opts.pollIntervalMs || 30 * 60 * 1000;

        this.latestReading = null;
        this.onUpdate = null; // set externally: (readingObj) => {...}
        this.pollTimer = null;
        this.backoffUntil = 0; // epoch ms - set on a 429, checked before the next poll fires
    }

    start() {
        if (!this.clientId || !this.clientSecret || this.latitude == null || this.longitude == null) {
            console.warn("[Nexus Xweather] Missing client ID/secret or lat/lon - lightning threat polling disabled.");
            return;
        }
        this.scheduleNext(0);
    }

    stop() {
        if (this.pollTimer) clearTimeout(this.pollTimer);
    }

    // setTimeout chaining (rather than setInterval, used by the other
    // clients in this directory) so a 429 backoff can push the next poll
    // further out without fighting a fixed-cadence interval timer.
    scheduleNext(delayMs) {
        if (this.pollTimer) clearTimeout(this.pollTimer);
        this.pollTimer = setTimeout(() => this.pollOnce(), delayMs);
    }

    async pollOnce() {
        const now = Date.now();
        if (now < this.backoffUntil) {
            this.scheduleNext(this.backoffUntil - now);
            return;
        }

        try {
            const url = `${this.baseUrl}/lightning/threats/${this.latitude},${this.longitude}` +
                `?client_id=${encodeURIComponent(this.clientId)}&client_secret=${encodeURIComponent(this.clientSecret)}`;
            const response = await fetch(url);

            if (response.status === 429) {
                // Back off one extra full interval before trying again,
                // rather than retrying immediately into the same limit.
                console.warn("[Nexus Xweather] Rate limited (429) - backing off one extra poll interval.");
                this.backoffUntil = Date.now() + this.pollIntervalMs;
                this.scheduleNext(this.pollIntervalMs);
                return;
            }

            const json = await response.json();
            if (!response.ok || json.success === false) {
                throw new Error(`Xweather API error (HTTP ${response.status}): ${json.error?.description || "unknown"}`);
            }

            const reading = this.parseThreats(json.response || []);
            this.latestReading = reading;
            if (this.onUpdate) this.onUpdate(reading);
            this.scheduleNext(this.pollIntervalMs);
        } catch (error) {
            // Keep this.latestReading as whatever it last was - a fetch
            // failure shouldn't erase a still-valid prior reading, and the
            // badge should keep showing it until the next successful poll
            // says otherwise.
            console.error("[Nexus Xweather] Lightning threat poll failed - keeping last known reading:", error.message);
            this.scheduleNext(this.pollIntervalMs);
        }
    }

    /**
     * Reduces the raw threat-zone array down to what the badge needs:
     * whether ANY zone currently covers this location (the array being
     * non-empty IS the "worth surfacing" signal - see file header), plus
     * the most urgent zone's details for the badge tooltip. "Most urgent"
     * prefers a severe zone over a non-severe one, then whichever expires
     * soonest, so the tooltip reflects the most time-critical threat
     * rather than an arbitrary array order.
     */
    parseThreats(zones) {
        if (!Array.isArray(zones) || zones.length === 0) {
            return { hasThreat: false, severe: false, threatCount: 0, nearestThreat: null, updatedAt: Date.now() };
        }

        const bySeverityThenExpiry = [...zones].sort((a, b) => {
            const aSevere = a.details?.severe ? 1 : 0;
            const bSevere = b.details?.severe ? 1 : 0;
            if (aSevere !== bSevere) return bSevere - aSevere;
            return (a.details?.range?.maxTimestamp || 0) - (b.details?.range?.maxTimestamp || 0);
        });
        const top = bySeverityThenExpiry[0];

        return {
            hasThreat: true,
            severe: zones.some(z => z.details?.severe === true),
            threatCount: zones.length,
            nearestThreat: {
                stormId: top.details?.stormId ?? top.id ?? null,
                severe: top.details?.severe === true,
                validUntil: top.details?.range?.maxDateTimeISO ?? null,
                movementDir: top.details?.movement?.dir ?? null,
                movementSpeedMph: top.details?.movement?.speedMPH ?? null
            },
            updatedAt: Date.now()
        };
    }
}

module.exports = XweatherClient;
