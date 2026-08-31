/**
 * lib/LightningSensorClient.js
 *
 * Spawns lightning_daemon.py (scripts/lightning/) as a long-lived child
 * process and parses its JSON stdout stream for AS3935 lightning sensor
 * events. Mirrors RtlWeatherClient.js's spawn/parse/restart-on-exit shape
 * on purpose - same problem (long-running subprocess emitting JSON lines,
 * needs to survive crashes/USB or GPIO hiccups without taking the whole
 * helper down), same shape of fix.
 *
 * The daemon itself does its own AS3935 calibration at startup and emits
 * one JSON object per line for each event: {"type":"ready"} once
 * calibration succeeds, then {"type":"lightning"|"disturber"|"noise", ...}
 * per IRQ. See scripts/lightning/lightning_daemon.py for the exact schema.
 */

const { spawn } = require("child_process");

class LightningSensorClient {
    /**
     * @param {string} command - executable to spawn (default: "python3")
     * @param {string[]} args - args array, e.g. [daemonPath, "--noise-floor", "7", ...]
     * @param {number} restartDelayMs - wait before respawning after the process exits
     */
    constructor({ command = "python3", args = [], restartDelayMs = 5000 } = {}) {
        this.command = command;
        this.args = args;
        this.restartDelayMs = restartDelayMs;
        // Fired once the daemon reports successful AS3935 calibration.
        this.onReady = null;
        // Fired for every {"type":"lightning",...} event.
        this.onStrike = null;
        // Fired for every {"type":"disturber",...} event.
        this.onDisturber = null;
        // Fired for every {"type":"noise",...} event.
        this.onNoise = null;
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
        console.log(`[Nexus Lightning] Starting: ${this.command} ${this.args.join(" ")}`);
        this.proc = spawn(this.command, this.args);

        this.proc.stdout.on("data", (chunk) => this._handleChunk(chunk));

        this.proc.stderr.on("data", (chunk) => {
            // The daemon logs calibration/status info to stderr, keeping
            // stdout pure JSON - same split as rtl_433's own stderr chatter.
            const text = chunk.toString().trim();
            if (text) console.log(`[Nexus Lightning][stderr] ${text}`);
        });

        this.proc.on("close", (code) => {
            this.proc = null;
            if (this.stopped) return; // stop() was called deliberately - don't respawn
            console.warn(`[Nexus Lightning] Process exited (code ${code}) - restarting in ${this.restartDelayMs}ms`);
            setTimeout(() => this._spawn(), this.restartDelayMs);
        });

        this.proc.on("error", (err) => {
            console.error(`[Nexus Lightning] Failed to spawn "${this.command}": ${err.message} - check LIGHTNING_SENSOR_COMMAND/LIGHTNING_SENSOR_ARGS in .env`);
        });
    }

    _handleChunk(chunk) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split("\n");
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
            return;
        }

        switch (msg.type) {
            case "ready":
                if (this.onReady) this.onReady(msg);
                break;
            case "lightning":
                if (this.onStrike) this.onStrike(msg);
                break;
            case "disturber":
                if (this.onDisturber) this.onDisturber(msg);
                break;
            case "noise":
                if (this.onNoise) this.onNoise(msg);
                break;
            default:
                break;
        }
    }
}

module.exports = LightningSensorClient;
