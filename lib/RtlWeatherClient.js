/**
 * lib/RtlWeatherClient.js
 *
 * Spawns rtl_433 as a long-lived child process and parses its JSON stdout
 * stream for the Vevor-7in1 weather station, providing near-real-time
 * readings (~20s cadence, confirmed against the real hardware) that bypass
 * Tuya cloud's ~20-minute sync delay.
 *
 * Deliberately mirrors TuyaWeatherClient's interface (assign .onUpdate,
 * call .start()) so node_helper can wire either source the same way, and
 * so the two can run side by side during the fallback window in
 * node_helper.js's startWeatherStationClients().
 *
 * The exact command to spawn is configurable rather than hardcoded to a
 * bare `rtl_433` binary - the confirmed-working build during testing was
 * a recent Docker image (Debian's packaged rtl_433 is too old to have the
 * Vevor-7in1 decoder), so the actual invocation on the Pi may need to be
 * `docker run ... rtl_433 ...` rather than a plain binary on PATH. Set
 * RTL433_COMMAND / RTL433_ARGS in .env if the default doesn't match your
 * setup.
 */

const { spawn } = require("child_process");

const KNOTS_PER_KMH = 0.539957;

class RtlWeatherClient {
    /**
     * @param {string} command - executable to spawn (default: "rtl_433")
     * @param {string[]} args - args array (default: ["-f","915M","-F","json"])
     * @param {number|null} deviceId - Vevor-7in1's numeric "id" field, once
     *   known, to filter out any other 433/915MHz traffic in the area.
     *   Leave null to accept any Vevor-7in1 payload (fine for a single
     *   station; matters more once a neighbor's station is in range too).
     * @param {number} restartDelayMs - wait before respawning after the
     *   process exits (crash, USB hiccup, etc.)
     */
    constructor({ command = "rtl_433", args = ["-f", "915M", "-F", "json"], deviceId = null, restartDelayMs = 5000 } = {}) {
        this.command = command;
        this.args = args;
        this.deviceId = deviceId;
        this.restartDelayMs = restartDelayMs;
        this.onUpdate = null;
        this.proc = null;
        this.buffer = "";
        this.stopped = false;
    }

    start() {
        this.stopped = false;
        this._spawn();
    }

    stop() {
        this.stopped = true;
        if (this.proc) {
            this.proc.removeAllListeners("close");
            this.proc.kill();
            this.proc = null;
        }
    }

    _spawn() {
        console.log(`[Nexus rtl_433] Starting: ${this.command} ${this.args.join(" ")}`);
        this.proc = spawn(this.command, this.args);

        this.proc.stdout.on("data", (chunk) => this._handleChunk(chunk));

        this.proc.stderr.on("data", (chunk) => {
            // rtl_433 logs its own tuning/status info to stderr even when
            // perfectly healthy - just informational, not a failure signal.
            const text = chunk.toString().trim();
            if (text) console.log(`[Nexus rtl_433][stderr] ${text}`);
        });

        this.proc.on("close", (code) => {
            this.proc = null;
            if (this.stopped) return; // stop() was called deliberately - don't respawn
            console.warn(`[Nexus rtl_433] Process exited (code ${code}) - restarting in ${this.restartDelayMs}ms`);
            setTimeout(() => this._spawn(), this.restartDelayMs);
        });

        this.proc.on("error", (err) => {
            console.error(`[Nexus rtl_433] Failed to spawn "${this.command}": ${err.message} - check RTL433_COMMAND/RTL433_ARGS in .env`);
        });
    }

    _handleChunk(chunk) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
        // Last element may be a partial line - hold it for the next chunk.
        this.buffer = lines.pop();
        for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed) this._handleLine(trimmed);
        }
    }

    _handleLine(line) {
        let msg;
        try {
            msg = JSON.parse(line);
        } catch (err) {
            // rtl_433 occasionally writes non-JSON status lines to stdout
            // too, not just stderr - not every line is a reading, and
            // that's expected rather than an error.
            return;
        }

        if (msg.model !== "Vevor-7in1") return;
        if (this.deviceId != null && msg.id !== this.deviceId) return;

        const reading = {
            outdoorTempF: msg.temperature_C != null ? (msg.temperature_C * 9) / 5 + 32 : null,
            // rtl_433 only hears the outdoor sensor's own RF broadcast, not
            // the console's separate indoor reading - Tuya cloud remains
            // the only source for indoor temp/humidity.
            indoorTempF: null,
            outdoorHumidity: msg.humidity ?? null,
            indoorHumidity: null,
            pressureInHg: null,
            windSpeedKnots: msg.wind_avg_km_h != null ? msg.wind_avg_km_h * KNOTS_PER_KMH : null,
            windGustKnots: msg.wind_max_km_h != null ? msg.wind_max_km_h * KNOTS_PER_KMH : null,
            windDirDeg: msg.wind_dir_deg ?? null,
            rainMm: msg.rain_mm ?? null,
            lightIntensityKlux: msg.light_lux != null ? msg.light_lux / 1000 : null,
            uvIndex: msg.uvi ?? null,
            batteryStatus: msg.battery_ok === 1 ? "ok" : "low",
            sensorOnline: true,
            lastUpdated: Date.now()
        };

        if (this.onUpdate) this.onUpdate(reading);
    }
}

module.exports = RtlWeatherClient;
