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
  //   - windSpeedKnots / windGustKnots: CONFIRMED via the device's own Data
  //     Model schema (Tuya's Query Things Data Model API for this product,
  //     modelId e1mq9b1o) - wind_speed and wind_gust are both declared as
  //     unit "kph" with scale 1 (raw / 10 = km/h), independent of whatever
  //     unit the console is set to *display* (it's set to knots here, same
  //     "declared unit != display unit" trap that applied to temperature).
  //     Converted here to knots (raw / 10 * 0.539957) to match the display
  //     unit rather than leaving it in km/h.
  //   - lightIntensityKlux: CONFIRMED via the same schema - declared unit
  //     klux, scale 2 (raw / 100), matching the earlier photo-comparison guess.
  //   - uvIndex: CONFIRMED unscaled (scale 0) via the same schema.
  //   - rainfall: schema confirms unit mm, scale 2 (raw / 100) - but even at
  //     the correct scale this still doesn't match the console's "Today"
  //     figure from the 2026-07-30 comparison (~2.19mm vs. 0.44in/~11mm
  //     shown that day), so the scale wasn't the problem - this field
  //     tracks something other than "today's total" and remains excluded.
  //   - lastUpdated: NOW uses the real sensor timestamps rather than
  //     Date.now(). Each dp in the raw properties array carries its own
  //     `time` field (a standard Unix millisecond timestamp, e.g.
  //     1785451247922 - directly usable with `new Date(time)`, no decoding
  //     needed) marking when THAT specific value last actually changed on
  //     Tuya's side, independent of when we happened to poll. Using
  //     Date.now() here was measuring "did our HTTP call succeed," not "is
  //     this a fresh reading" - a solar-powered outdoor sensor that's gone
  //     quiet (dead battery, WiFi dropout, buried under leaves, etc.) would
  //     still produce a 200 OK with the same stale cached value forever,
  //     and the old code would have called that "fresh" on every single
  //     poll. Taking the max `time` across the fields we actually consume
  //     gives the true "most recent moment any sensor we care about
  //     changed," since different dps update independently (seconds apart
  //     from each other in every raw dump captured so far).
  _parseProperties(properties) {
    const byCode = {};
    const byTime = {};
    for (const p of properties) {
      byCode[p.code] = p.value;
      byTime[p.code] = p.time;
    }

    const cToF = (c) => (c * 9) / 5 + 32;
    const hpaToInHg = (hpa) => hpa * 0.02953;
    const kphToKnots = (kph) => kph * 0.539957;

    // Only the fields this reading actually surfaces - not every dp in the
    // payload (e.g. unit-setting enums, unused channel probes) - so a
    // field we don't display doesn't skew the freshness picture.
    const consumedCodes = [
      "outdoor_temperature", "indoor_temperature",
      "outdoor_humidity", "indoor_humidity",
      "indoor_pressure", "wind_speed", "wind_gust",
      "light_intensity", "uvi"
    ];
    const sensorTimes = consumedCodes
      .map(code => byTime[code])
      .filter(t => t != null);
    const lastSensorUpdate = sensorTimes.length > 0 ? Math.max(...sensorTimes) : null;

    return {
      outdoorTempF: cToF(byCode.outdoor_temperature / 10),
      indoorTempF: cToF(byCode.indoor_temperature / 10),
      outdoorHumidity: byCode.outdoor_humidity,
      indoorHumidity: byCode.indoor_humidity,
      pressureInHg: hpaToInHg(byCode.indoor_pressure / 100), // station pressure, not sea-level-adjusted
      windSpeedKnots: byCode.wind_speed != null ? kphToKnots(byCode.wind_speed / 10) : null,
      windGustKnots: byCode.wind_gust != null ? kphToKnots(byCode.wind_gust / 10) : null,
      lightIntensityKlux: byCode.light_intensity != null ? byCode.light_intensity / 100 : null,
      uvIndex: byCode.uvi ?? null,
      batteryStatus: byCode.outdoor_battery_status,
      sensorOnline: byCode.outdoor_online_status === "online",
      lastUpdated: lastSensorUpdate ?? Date.now(), // fallback only if the payload had none of the expected fields at all
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
