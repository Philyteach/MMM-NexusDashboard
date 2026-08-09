/**
 * lib/PwsWeatherClient.js
 *
 * Pushes readings from node_helper.js's stationCache to PWSWeather
 * (run by Vaisala Xweather, formerly AerisWeather - the WU-protocol PWS
 * network whose Contributor Plan grants free Xweather Weather API +
 * Maps/radar access in exchange for sharing station data).
 *
 * Upload is a plain HTTP GET using the same query-param protocol
 * originally defined by Weather Underground's PWS upload API - PWSWeather
 * adopted it as-is, so this is a simple fetch(), not a signed/JSON API.
 *
 * Requires a PWSWeather account + station registered at
 * https://www.pwsweather.com/register and
 * https://dashboard.pwsweather.com/stations/add - this client cannot
 * create that registration, only push data once a station ID + station
 * key exist.
 */

// Simple Magnus-formula dewpoint approximation - not in stationCache
// today, but dewptf is a standard/expected field for this upload
// protocol and costs nothing to derive from temp+humidity here.
function computeDewpointF(tempF, humidityPct) {
    if (tempF == null || humidityPct == null) return null;
    const tempC = (tempF - 32) * (5 / 9);
    const a = 17.625, b = 243.04;
    const gamma = Math.log(humidityPct / 100) + (a * tempC) / (b + tempC);
    const dewC = (b * gamma) / (a - gamma);
    return dewC * (9 / 5) + 32;
}

function knotsToMph(knots) {
    if (knots == null) return null;
    return knots * 1.15078;
}

class PwsWeatherClient {
    /**
     * @param {object} opts
     * @param {string} opts.stationId
     * @param {string} opts.stationKey - PWSWeather calls this "PASSWORD" / station key
     * @param {string} [opts.baseUrl="https://www.pwsweather.com/pwsupdate/pwsupdate.php"]
     * @param {string} [opts.softwareId="NexusDashboard1.0"]
     * @param {number} [opts.pushIntervalMs=300000]
     */
    constructor(opts) {
        this.stationId = opts.stationId;
        this.stationKey = opts.stationKey;
        this.baseUrl = opts.baseUrl || "https://www.pwsweather.com/pwsupdate/pwsupdate.php";
        this.softwareId = opts.softwareId || "NexusDashboard1.0";
        this.pushIntervalMs = opts.pushIntervalMs || 5 * 60 * 1000;
        this.getReading = null; // set by node_helper to a fn returning current merged stationCache+extras
        this.timer = null;
    }

    start() {
        if (!this.stationId || !this.stationKey) {
            console.warn("[Nexus PWSWeather] Missing station ID or station key - PWSWeather posting disabled.");
            return;
        }
        this.pushOnce();
        this.timer = setInterval(() => this.pushOnce(), this.pushIntervalMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }

    async pushOnce() {
        if (!this.getReading) return;
        const reading = this.getReading();
        if (!reading || reading.sensorOnline === false) {
            console.warn("[Nexus PWSWeather] Station data not currently online - skipping this cycle.");
            return;
        }

        const params = this.buildParams(reading);
        const url = `${this.baseUrl}?${params.toString()}`;

        try {
            const response = await fetch(url);
            const text = await response.text();
            if (!response.ok || !/success/i.test(text)) {
                console.warn(`[Nexus PWSWeather] Upload may have failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
            } else {
                console.log("[Nexus PWSWeather] Upload OK.");
            }
        } catch (error) {
            console.error("[Nexus PWSWeather] Push failed:", error.message);
        }
    }

    buildParams(reading) {
        const dewptF = computeDewpointF(reading.outdoorTempF, reading.outdoorHumidity);
        const params = new URLSearchParams({
            ID: this.stationId,
            PASSWORD: this.stationKey,
            dateutc: "now",
            action: "updateraw",
            softwaretype: this.softwareId
        });

        const maybeSet = (key, value, digits = 1) => {
            if (value != null && !Number.isNaN(value)) {
                params.set(key, value.toFixed(digits));
            }
        };

        maybeSet("tempf", reading.outdoorTempF);
        maybeSet("humidity", reading.outdoorHumidity, 0);
        maybeSet("dewptf", dewptF);
        maybeSet("windspeedmph", knotsToMph(reading.windSpeedKnots));
        maybeSet("windgustmph", knotsToMph(reading.windGustKnots));
        if (reading.windDirDeg != null) params.set("winddir", Math.round(reading.windDirDeg).toString());
        maybeSet("baromin", reading.pressureInHg, 2);
        maybeSet("dailyrainin", reading.rainTodayIn, 2);
        maybeSet("indoortempf", reading.indoorTempF);
        maybeSet("indoorhumidity", reading.indoorHumidity, 0);

        return params;
    }
}

module.exports = PwsWeatherClient;
