/**
 * lib/CwopClient.js
 *
 * Pushes readings from node_helper.js's stationCache to NOAA's Citizen
 * Weather Observer Program (CWOP) over APRS-IS.
 *
 * CWOP is NOT a REST API - it's the APRS protocol (ham-radio position/
 * telemetry format) carried over a plain TCP socket. The flow is:
 *   1. Connect to cwop.aprs.net:14580
 *   2. Server sends a banner line - ignore it
 *   3. Send a login line: "user CALLSIGN pass -1 vers SOFTWARE VERSION"
 *      (passcode -1 is correct and expected for non-ham CW####/DW####
 *      station IDs - it is NOT a placeholder or a broken auth. A real
 *      ham-radio passcode is only relevant if posting under an amateur
 *      radio call sign instead.)
 *   4. Send one APRS weather packet line
 *   5. Close the socket
 *
 * Requires a CWOP station ID (CW#### / DW#### etc.) obtained by
 * registering at http://wxqa.com/csite.html - this client cannot create
 * that registration, only push data once you have an ID + lat/lon/
 * elevation on file with CWOP.
 */
const net = require("net");

// Pads a numeric value into a fixed-width APRS weather field. Missing/NaN
// values become dots ("...") per the APRS spec's convention for "field not
// reported", rather than a misleading 0.
function padField(value, width, allowNegative = false) {
    if (value == null || Number.isNaN(value)) return ".".repeat(width);
    const rounded = Math.round(value);
    if (!allowNegative) {
        return Math.max(0, rounded).toString().padStart(width, "0").slice(-width);
    }
    const sign = rounded < 0 ? "-" : "";
    const digits = Math.abs(rounded).toString().padStart(sign ? width - 1 : width, "0");
    return (sign + digits).slice(-width);
}

// Converts decimal degrees to APRS's DDMM.mmN / DDDMM.mmW format.
function toAprsLat(lat) {
    const hemi = lat >= 0 ? "N" : "S";
    const abs = Math.abs(lat);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${String(deg).padStart(2, "0")}${min.toFixed(2).padStart(5, "0")}${hemi}`;
}

function toAprsLon(lon) {
    const hemi = lon >= 0 ? "E" : "W";
    const abs = Math.abs(lon);
    const deg = Math.floor(abs);
    const min = (abs - deg) * 60;
    return `${String(deg).padStart(3, "0")}${min.toFixed(2).padStart(5, "0")}${hemi}`;
}

// DDHHMMz in UTC, as required by the APRS position/weather timestamp field.
function toAprsTimestamp(date) {
    const d = String(date.getUTCDate()).padStart(2, "0");
    const h = String(date.getUTCHours()).padStart(2, "0");
    const m = String(date.getUTCMinutes()).padStart(2, "0");
    return `${d}${h}${m}z`;
}

class CwopClient {
    /**
     * @param {object} opts
     * @param {string} opts.stationId - CWOP station ID (e.g. "DW1234") or ham call sign
     * @param {number} opts.latitude
     * @param {number} opts.longitude
     * @param {string} [opts.host="cwop.aprs.net"]
     * @param {number} [opts.port=14580]
     * @param {string} [opts.softwareId="NexusDashboard1.0"]
     * @param {number} [opts.pushIntervalMs=300000] - CWOP asks contributors not to post more often than ~5 min
     */
    constructor(opts) {
        this.stationId = opts.stationId;
        this.latitude = opts.latitude;
        this.longitude = opts.longitude;
        this.host = opts.host || "cwop.aprs.net";
        this.port = opts.port || 14580;
        this.softwareId = opts.softwareId || "NexusDashboard1.0";
        this.pushIntervalMs = opts.pushIntervalMs || 5 * 60 * 1000;
        this.getReading = null; // set by node_helper to a fn returning current merged stationCache+extras
        this.timer = null;
    }

    start() {
        if (!this.stationId || this.latitude == null || this.longitude == null) {
            console.warn("[Nexus CWOP] Missing station ID or lat/lon - CWOP posting disabled.");
            return;
        }
        this.pushOnce();
        this.timer = setInterval(() => this.pushOnce(), this.pushIntervalMs);
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
    }

    pushOnce() {
        if (!this.getReading) return;
        const reading = this.getReading();
        if (!reading || reading.sensorOnline === false) {
            console.warn("[Nexus CWOP] Station data not currently online - skipping this cycle.");
            return;
        }

        const packet = this.buildPacket(reading);
        const socket = net.createConnection({ host: this.host, port: this.port }, () => {
            socket.write(`user ${this.stationId} pass -1 vers ${this.softwareId}\r\n`);
            socket.write(`${packet}\r\n`);
            // CWOP's servers don't send a meaningful application-level ack -
            // give the write a moment to flush, then close. Keeping the
            // connection open longer just holds a socket for no benefit.
            setTimeout(() => socket.end(), 2000);
        });

        socket.setTimeout(10000);
        socket.on("timeout", () => {
            console.warn("[Nexus CWOP] Connection to CWOP server timed out.");
            socket.destroy();
        });
        socket.on("error", (error) => {
            console.error("[Nexus CWOP] Push failed:", error.message);
        });
        socket.on("close", () => {
            console.log(`[Nexus CWOP] Packet sent: ${packet}`);
        });
    }

    /**
     * Builds the APRS weather packet body. Wind/temp/humidity/pressure
     * come straight from stationCache; hourly and 24h rain totals are
     * left as "unreported" (...) since node_helper.js doesn't currently
     * track those windows - only rain-since-midnight (computeStationExtras'
     * rainTodayIn), which maps to APRS's "P" (since-midnight) field.
     */
    buildPacket(reading) {
        const now = new Date();
        const timestamp = toAprsTimestamp(now);
        const lat = toAprsLat(this.latitude);
        const lon = toAprsLon(this.longitude);

        const windDir = padField(reading.windDirDeg, 3);
        const windSpeedMph = padField(knotsToMph(reading.windSpeedKnots), 3);
        const windGustMph = padField(knotsToMph(reading.windGustKnots), 3);
        const tempF = padField(reading.outdoorTempF, 3, true);
        const rainSinceMidnightHundredths = padField(
            reading.rainTodayIn != null ? reading.rainTodayIn * 100 : null, 3
        );
        const humidity = padField(
            reading.outdoorHumidity != null ? Math.min(reading.outdoorHumidity, 99) : null, 2
        );
        const pressureTenthsMb = padField(
            reading.pressureInHg != null ? reading.pressureInHg * 33.8639 * 10 : null, 5
        );

        return `${this.stationId}>APRS,TCPIP*:@${timestamp}${lat}/${lon}_` +
            `${windDir}/${windSpeedMph}g${windGustMph}t${tempF}` +
            `r...p...P${rainSinceMidnightHundredths}h${humidity}b${pressureTenthsMb}`;
    }
}

function knotsToMph(knots) {
    if (knots == null) return null;
    return knots * 1.15078;
}

module.exports = CwopClient;
