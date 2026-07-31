// TuyaWeatherClient.js
// Polls the Tuya Cloud API for live VEVOR (YT60311) weather station readings.
// Drop into your MMM-NexusDashboard module directory and require() it from node_helper.js.
//
// Requires in your module's config/.env (same pattern as your other secrets):
//   TUYA_CLIENT_ID=7kytncs3a9s97tfjgd7n
//   TUYA_CLIENT_SECRET=<your project secret, from the Authorization tab in the Tuya IoT console>
//   TUYA_DEVICE_ID=ebd2f0eae14511b3a9fib1
//   TUYA_BASE_URL=https://openapi.tuyaus.com   (US data center, based on your device's region)

const crypto = require("crypto");
// Uses Node's native global fetch (Node 18+) - matches the rest of this
// project's node_helper.js, which already migrated off node-fetch.

class TuyaWeatherClient {
  constructor({ clientId, clientSecret, deviceId, baseUrl, pollIntervalMs = 60000 }) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.deviceId = deviceId;
    this.baseUrl = baseUrl;
    this.pollIntervalMs = pollIntervalMs;

    this.accessToken = null;
    this.tokenExpiresAt = 0; // epoch ms
    this.latestReading = null;
    this.pollTimer = null;
    this.onUpdate = null; // set externally: (readingObj) => {...}
  }

  // Tuya's signing algorithm: HMAC-SHA256(stringToSign, secret) -> uppercase hex
  _sign(stringToSign) {
    return crypto
      .createHmac("sha256", this.clientSecret)
      .update(stringToSign, "utf8")
      .digest("hex")
      .toUpperCase();
  }

  _emptyBodyHash() {
    // SHA256 of an empty string, required in the string-to-sign for GET requests
    return crypto.createHash("sha256").update("", "utf8").digest("hex");
  }

  _buildStringToSign({ method, url, accessToken = "" }) {
    const contentHash = this._emptyBodyHash();
    const headersStr = ""; // no signed headers used here
    const t = Date.now().toString();
    const stringToSign = [method, contentHash, headersStr, url].join("\n");
    return { t, stringToSign };
  }

  async _request(path, { useToken = true } = {}) {
    const method = "GET";
    const { t, stringToSign } = this._buildStringToSign({ method, url: path });

    const accessTokenPart = useToken ? this.accessToken : "";
    const strToSign = this.clientId + accessTokenPart + t + stringToSign;
    const sign = this._sign(strToSign);

    const headers = {
      client_id: this.clientId,
      sign,
      t,
      sign_method: "HMAC-SHA256",
      "Content-Type": "application/json",
    };
    if (useToken) headers.access_token = this.accessToken;

    const res = await fetch(this.baseUrl + path, { method, headers });
    const json = await res.json();
    if (!json.success) {
      throw new Error(`Tuya API error [${path}]: ${JSON.stringify(json)}`);
    }
    return json.result;
  }

  async _refreshToken() {
    const result = await this._request("/v1.0/token?grant_type=1", { useToken: false });
    this.accessToken = result.access_token;
    // expire slightly early to avoid edge-of-window failures
    this.tokenExpiresAt = Date.now() + (result.expire_time - 60) * 1000;
  }

  async _ensureToken() {
    if (!this.accessToken || Date.now() >= this.tokenExpiresAt) {
      await this._refreshToken();
    }
  }

  // Converts the raw Tuya "properties" array into a friendly, unit-converted object.
  //
  // Calibration status (checked against the physical console display on 2026-07-30):
  //   - outdoorTempF / indoorTempF: CONFIRMED. Raw values are Celsius x10 regardless
  //     of the console's displayed unit setting. Indoor matched exactly (85.6°F);
  //     outdoor was within 0.3°F (minor timing gap between API pull and photo).
  //   - pressureInHg: raw value converts to ~29.77 inHg vs. the console's displayed
  //     "Rel Baro" of 29.97 inHg. The ~0.2 inHg gap is likely because the console
  //     applies a sea-level/elevation adjustment that the raw station-pressure dp
  //     doesn't include. Left unadjusted here — treat as station pressure, not
  //     sea-level pressure, until/unless an elevation correction is added.
  //   - rainfall: NOT wired up. Raw dp converts to ~0.86in, but the console's
  //     "Today" figure read 0.44in at the same time — roughly double, suggesting
  //     this dp is a cumulative/lifetime counter rather than a daily total (or
  //     measures something else entirely). Needs verifying against an actual rain
  //     event (watch which dp field moves in step with the console's "Today" value)
  //     before it's safe to surface on the dashboard.
  //   - windSpeedRaw / windGustRaw: scale unconfirmed — wind has been 0 (calm) in
  //     every reading so far. Compare a nonzero raw value against the console's
  //     knots display once there's actual wind, then convert here.
  _parseProperties(properties) {
    const byCode = {};
    for (const p of properties) byCode[p.code] = p.value;

    const cToF = (c) => (c * 9) / 5 + 32;
    const hpaToInHg = (hpa) => hpa * 0.02953;

    return {
      outdoorTempF: cToF(byCode.outdoor_temperature / 10),
      indoorTempF: cToF(byCode.indoor_temperature / 10),
      outdoorHumidity: byCode.outdoor_humidity,
      indoorHumidity: byCode.indoor_humidity,
      pressureInHg: hpaToInHg(byCode.indoor_pressure / 100), // station pressure, not sea-level-adjusted
      windSpeedRaw: byCode.wind_speed, // unconverted - scale not yet confirmed
      windGustRaw: byCode.wind_gust, // unconverted - scale not yet confirmed
      batteryStatus: byCode.outdoor_battery_status,
      sensorOnline: byCode.outdoor_online_status === "online",
      lastUpdated: Date.now(),
    };
  }

  async fetchStatus() {
    await this._ensureToken();
    // This device (category qxj) is on Tuya's newer Data Model
    // architecture - the legacy /v1.0/devices/{id}/status endpoint returns
    // a non-empty but unrelated set of fields for it (no weather codes at
    // all), which is why earlier polls succeeded with no error but parsed
    // out as NaN. /v2.0/cloud/thing/{id}/shadow/properties is the endpoint
    // that actually returned the real sensor codes when tested manually in
    // the Tuya API Explorer (confirmed by the dp_id/custom_name/type shape
    // of that response).
    const result = await this._request(`/v2.0/cloud/thing/${this.deviceId}/shadow/properties`, { useToken: true });
    const properties = result.properties || result;

    if (!Array.isArray(properties) || properties.length === 0) {
      // Empty/wrong-shaped response - most likely either a different
      // endpoint shape than expected, or the Cloud Project's authorized
      // API subscription doesn't actually cover this status endpoint for
      // this device (a "Read" device permission in the project doesn't by
      // itself guarantee every status API is subscribed/authorized).
      // Logging the raw response here instead of silently producing NaNs.
      console.warn("[TuyaWeatherClient] Empty/unexpected status response:", JSON.stringify(result));
    }

    const parsed = this._parseProperties(Array.isArray(properties) ? properties : []);
    this.latestReading = parsed;
    if (this.onUpdate) this.onUpdate(parsed);
    return parsed;
  }

  start() {
    this.fetchStatus().catch((err) => console.error("[TuyaWeatherClient] initial fetch failed:", err));
    this.pollTimer = setInterval(() => {
      this.fetchStatus().catch((err) => console.error("[TuyaWeatherClient] poll failed:", err));
    }, this.pollIntervalMs);
  }

  stop() {
    if (this.pollTimer) clearInterval(this.pollTimer);
  }
}

module.exports = TuyaWeatherClient;
