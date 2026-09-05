/**
 * lib/LightningMqttClient.js
 *
 * Subscribes to MQTT topics published by one or more ESP32 "LightningNode"
 * units (arduino/LightningNode/LightningNode.ino - not yet checked into
 * this repo) that each carry a physically remote AS3935 sensor. Every node
 * publishes to "<prefix>/<node>/event" (one JSON object per IRQ) and
 * "<prefix>/<node>/status" (a heartbeat/LWT proving that node is alive).
 *
 * Replaces the earlier spawn-a-local-daemon approach (see git history for
 * lib/LightningSensorClient.js and scripts/lightning/) now that the sensor
 * lives on its own ESP32 instead of the Pi's SPI pins - the whole point was
 * to get it away from the Pi/TV's own RF noise. Same spirit as
 * RtlWeatherClient.js (long-lived stream of JSON events, needs to survive
 * hiccups without taking the helper down), different transport - there's no
 * "process exited" signal over MQTT, so staleness is judged from how long
 * it's been since a node's last message instead (see staleMs).
 *
 * Event JSON, per arduino/LightningNode/LightningNode.ino:
 * {"type":"lightning"|"disturber"|"noise", "node": string,
 * "distance_km": number (0-63, only present for "lightning"), "energy":
 * number (only present for "lightning"), "millis": device uptime}. Note
 * this is NOT the same shape the old Python daemon used - there's no "ts"
 * field (the ESP32 has no RTC, "millis" is just uptime and useless as a
 * timestamp), so events are stamped with Date.now() at receipt time here
 * instead. distance_km of 63 is the AS3935's "out of range/overhead"
 * sentinel (datasheet register value 0x3F) - normalized to null below so
 * LightningStrikeCard.js doesn't render a bogus "~63km away".
 *
 * Status payload, per the same firmware: a bare retained "online" string
 * republished every 60s, or "offline" via MQTT's Last Will (published by
 * the broker itself if the node disconnects without warning). A JSON
 * {"online": false} form is also accepted defensively; anything else
 * landing on a /status topic is treated as "online" - a message arriving
 * at all is proof of life, regardless of exact shape.
 */

const mqtt = require("mqtt");

class LightningMqttClient {
    /**
     * @param {string} url - broker URL, e.g. "mqtt://server1:1883"
     * @param {string} topicPrefix - default "nexus/lightning"
     * @param {string} [username] / [password] - optional broker auth
     * @param {number} staleMs - no message from a node for this long marks it offline.
     *   Default 150000 (150s) is 2.5x the firmware's confirmed 60s heartbeat interval -
     *   tolerates one missed heartbeat without flapping a node offline.
     */
    constructor({ url, topicPrefix = "nexus/lightning", username, password, staleMs = 150000 } = {}) {
        this.url = url;
        this.topicPrefix = topicPrefix;
        this.username = username;
        this.password = password;
        this.staleMs = staleMs;

        // Fired the first time any node is ever heard from (mirrors the old
        // daemon's "ready" event - lets node_helper flip sensorConfirmed).
        this.onReady = null;
        // Fired for every {"type":"lightning",...} event, any node.
        this.onStrike = null;
        // Fired for every {"type":"disturber"|"noise",...} event, any node.
        this.onNoise = null;
        // Fired whenever a node transitions online <-> offline.
        this.onNodeStatus = null;

        this.client = null;
        this.nodes = {}; // nodeName -> { online, lastSeenAt }
        this.staleTimer = null;
        this._everReady = false;
    }

    start() {
        this.client = mqtt.connect(this.url, {
            username: this.username || undefined,
            password: this.password || undefined,
            reconnectPeriod: 5000
        });

        this.client.on("connect", () => {
            console.log(`[Nexus Lightning] Connected to MQTT broker ${this.url}`);
            this.client.subscribe(`${this.topicPrefix}/+/event`);
            this.client.subscribe(`${this.topicPrefix}/+/status`);
        });

        this.client.on("reconnect", () => {
            console.warn(`[Nexus Lightning] Reconnecting to MQTT broker ${this.url}...`);
        });

        this.client.on("error", (err) => {
            console.error(`[Nexus Lightning] MQTT error: ${err.message}`);
        });

        this.client.on("message", (topic, payload) => this._handleMessage(topic, payload));

        this.staleTimer = setInterval(() => this._checkStale(), 15000);
    }

    stop() {
        if (this.staleTimer) {
            clearInterval(this.staleTimer);
            this.staleTimer = null;
        }
        if (this.client) {
            this.client.end(true);
            this.client = null;
        }
    }

    _nodeNameFromTopic(topic) {
        // "<prefix>/<node>/event" -> "<node>" (prefix itself may contain slashes)
        const parts = topic.split("/");
        return parts[parts.length - 2];
    }

    _markSeen(nodeName) {
        const wasOnline = this.nodes[nodeName] ? this.nodes[nodeName].online : false;
        this.nodes[nodeName] = { online: true, lastSeenAt: Date.now() };

        if (!this._everReady) {
            this._everReady = true;
            if (this.onReady) this.onReady();
        }
        if (!wasOnline && this.onNodeStatus) this.onNodeStatus(nodeName, true);
    }

    _handleMessage(topic, payloadBuf) {
        const nodeName = this._nodeNameFromTopic(topic);
        const text = payloadBuf.toString().trim();

        if (topic.endsWith("/status")) {
            let online = true;
            if (text === "offline") {
                online = false;
            } else {
                try {
                    const parsed = JSON.parse(text);
                    if (parsed && parsed.online === false) online = false;
                } catch (err) {
                    // Not JSON and not the literal string "offline" - treat as alive.
                }
            }

            if (online) {
                this._markSeen(nodeName);
            } else if (this.nodes[nodeName] === undefined || this.nodes[nodeName].online) {
                this.nodes[nodeName] = { online: false, lastSeenAt: Date.now() };
                if (this.onNodeStatus) this.onNodeStatus(nodeName, false);
            }
            return;
        }

        if (topic.endsWith("/event")) {
            let msg;
            try {
                msg = JSON.parse(text);
            } catch (err) {
                console.warn(`[Nexus Lightning] Ignoring malformed event from "${nodeName}": ${text}`);
                return;
            }
            this._markSeen(nodeName);

            if (msg.type === "lightning") {
                if (this.onStrike) {
                    const distanceKm = (msg.distance_km === undefined || msg.distance_km === 63) ? null : msg.distance_km;
                    this.onStrike({
                        node: nodeName,
                        distance_km: distanceKm,
                        energy: msg.energy,
                        ts: Date.now()
                    });
                }
            } else if (msg.type === "disturber" || msg.type === "noise") {
                if (this.onNoise) this.onNoise({ node: nodeName, type: msg.type, ts: Date.now() });
            }
        }
    }

    _checkStale() {
        const now = Date.now();
        for (const [nodeName, state] of Object.entries(this.nodes)) {
            if (state.online && now - state.lastSeenAt > this.staleMs) {
                state.online = false;
                console.warn(`[Nexus Lightning] Node "${nodeName}" gone stale (no message in ${this.staleMs}ms)`);
                if (this.onNodeStatus) this.onNodeStatus(nodeName, false);
            }
        }
    }
}

module.exports = LightningMqttClient;
