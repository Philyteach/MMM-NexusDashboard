# MMM-NexusDashboard

A modern, card-based dashboard framework for [MagicMirror²](https://magicmirror.builders/), built around four full-screen "workspaces" you can switch between: a Home overview, a full weather command center, a full-page calendar, and a live commute/travel tracker. Built from scratch as a first programming project — not a fork of an existing module.

## Workspaces

### Home (default)

- **Clock** — current time
- **Weather** (compact) — current conditions sidebar, labeled High/Low depending on whether the active NWS period is daytime or nighttime, plus a live "Right Now" panel (temp/feels-like/wind + an outfit-suggestion mascot) sourced from a physical weather station — see [Weather Station](#weather-station-right-now-panel) and [Mascot Weather Character](#mascot-weather-character) below
- **Calendar** (compact) — upcoming events sidebar
- **Immich slideshow** — rotating photos pulled from a self-hosted [Immich](https://immich.app/) server
- **Aurora badge** (conditional) — a small icon that appears in the Clock tile's unused corner space when geomagnetic activity makes aurora visibility plausible at your latitude. Invisible the rest of the time. See [Aurora Borealis Tracker](#aurora-borealis-tracker) below.

### Forecast

Full-screen weather command center: multi-day forecast strip, wind/humidity/precip/dewpoint, and moon phase + illumination + rise/set times (from the US Naval Observatory astronomy API). Shares the same NWS-backed data feed as the Home weather card.

### Calendar

Full month-grid view of the connected Google Calendar (ICS feed).

### Travel

Live commute tracking, built on Google's Routes API (`computeRouteMatrix`):

- Two fixed commute tiles (e.g. each person's drive to work), each showing live drive time and a **"leave by"** countdown during that person's configured morning window
- Automatic **traffic condition badge** (Light/Moderate/Heavy) with a "+X min vs normal" delta — computed from the same API call, no extra requests
- **Toll cost estimates** where routes cross toll roads — also free from the same batched call
- Drive time + distance to any upcoming calendar event that has a location set
- **Predictive leave-time**: for an appointment ~24 hours out, the backend captures one baseline drive-time reading the day before, then refines it with a fresh reading closer to departure to suggest an actual leave-by time on the agenda
- Polls only while this workspace is on screen (stops entirely when you switch away), and auto-reverts to Home after 20 minutes idle so it doesn't just sit there
- Poll interval and thresholds are tuned to comfortably stay within Google's free monthly tier — see comments in `node_helper.js` for the math

### Weather (emergency auto-switch)

Not manually navigated to — the dashboard automatically switches here on a critical NWS alert (e.g. tornado warning), showing live radar + full alert instructions, and can trigger a hardware TV-wake/chime/announcement sequence. Reverts to Home automatically once the alert clears.

## Aurora Borealis Tracker

A lightweight, non-intrusive aurora alert that lives as a small badge icon rather than a dedicated workspace — most nights it shows nothing at all.

**How it works — a two-tier, cost-conscious poll:**

1. Every 15 minutes, `node_helper.js` checks NOAA's [Planetary K-index feed](https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json) — a single lightweight number (0–9) indicating current geomagnetic activity.
2. If Kp is below a configurable threshold (default `6`, tuned for mid-latitude visibility), nothing else happens — no further requests, no badge.
3. If Kp crosses the threshold, only *then* does it fetch NOAA's much heavier [OVATION Aurora model](https://services.swpc.noaa.gov/json/ovation_aurora_latest.json) — a full probability grid — and extracts the value nearest your configured `LATITUDE`/`LONGITUDE`.
4. If the local probability is non-zero, the badge appears; the frontend also has access to the actual percentage if you want to surface it elsewhere.

This cascading design means the expensive grid fetch only ever happens on nights where it could plausibly matter — the common case (calm night, low Kp) costs one small JSON request every 15 minutes and nothing more.

**The badge-slot pattern:** rather than giving Aurora its own grid tile, it docks into a small reusable "slot" — a `.nexus-badge-slot` div with a `data-badge-target` attribute — that any card can opt into by adding one line of markup and `position: relative` to its own container. The Clock card hosts the first one (it has unused corner space), but the pattern is intentionally generic: any future pop-up indicator can target any card by name via config, with zero coupling between the host card and whatever badges dock into it. See `css/badges.css` and `cards/AuroraCard.js`.

**Config:** add `AURORA_KP_THRESHOLD` to your `.env` (defaults to `6` if omitted) — see the setup table below.

## Weather Station (Right Now panel)

The Home workspace's compact Weather card includes a "Right Now" panel — current outdoor temp, feels-like, a wind label, and the outfit-suggestion mascot (see [Mascot Weather Character](#mascot-weather-character) below) — sourced from a physical VEVOR (YT60311) weather station. This is a separate data path from the NWS forecast that powers the rest of the Weather/Forecast cards.

Two sources feed it, arbitrated in `node_helper.js`'s `startWeatherStationClients()`:

- **Tuya Cloud API** (`lib/TuyaWeatherClient.js`) — the original integration. Polls Tuya's cloud roughly once a minute, but the station itself only syncs to Tuya's cloud every ~20 minutes, so that's the real freshness ceiling regardless of poll rate.
- **rtl_433** (`lib/RtlWeatherClient.js`) — now the preferred source, and what replaced Tuya-only operation. An RTL-SDR USB dongle listens directly to the station's own 915MHz RF broadcast and decodes it locally with [rtl_433](https://github.com/merbanan/rtl_433), giving ~20-second-cadence readings with no cloud round-trip at all. It only hears the outdoor sensor's own broadcast, though — indoor temp/humidity and barometric pressure aren't part of that RF packet, so those two fields stay sourced from whatever Tuya last reported, merged in rather than left null.

Both clients start at boot; whichever reports first wins. If rtl_433 proves itself within a 2-minute grace window, Tuya keeps polling (harmless, low resource use) but stops being written into the shared station cache. If rtl_433 never reports in that window (dongle unplugged, `rtl_433` not installed, etc.), the dashboard just stays on Tuya indefinitely — degraded but working data beats none.

**Hardware:** an RTL-SDR USB dongle (any RTL2832U-based one), positioned within RF range of the VEVOR outdoor sensor.

**Installation gotcha — kernel driver conflict:** Linux's `dvb_usb_rtl28xxu` driver auto-loads for RTL2832U dongles (it assumes they're DVB-T TV tuners) and claims the device before `rtl_433`/librtlsdr ever gets a chance to open it. Symptoms are a `usb_claim_interface error` or "no supported devices found" from `rtl_433` even though the dongle shows up fine in `lsusb`. Fix is to blacklist the DVB driver so it never grabs the device:

```
echo "blacklist dvb_usb_rtl28xxu" | sudo tee /etc/modprobe.d/blacklist-rtl.conf
sudo rmmod dvb_usb_rtl28xxu   # or just reboot
```

Unplug/replug the dongle (or reboot) afterward, then confirm `rtl_433 -f 915M -F json` prints decoded JSON lines in a terminal on its own before expecting the module to pick it up.

**Config (`.env`):**

| Variable | Purpose |
|---|---|
| `RTL433_COMMAND` | Executable to spawn (default `rtl_433`). Override if your build isn't a bare binary on `PATH` — e.g. Debian's packaged `rtl_433` is too old to include the Vevor-7in1 decoder, so a `docker run ...` wrapper may be needed instead. |
| `RTL433_ARGS` | Full space-separated args, overriding the default (`-f <RTL433_FREQUENCY> -F json`) entirely. Use this for a non-default invocation (e.g. the `docker run ... rtl_433 ...` case above) — it replaces the whole default array, so set this instead of (not in addition to) `RTL433_FREQUENCY`. |
| `RTL433_FREQUENCY` | Radio frequency to tune to (default `915M`, the VEVOR station's band). Ignored if `RTL433_ARGS` is set. |
| `RTL433_DEVICE_ID` | The Vevor-7in1 decoder's numeric `id` field, once known, to filter out other 433/915MHz traffic in range. Optional — leave unset to accept any Vevor-7in1 payload (fine for a single station; matters once a neighbor's station is in range too). |

Tuya's own vars (`TUYA_CLIENT_ID`, `TUYA_CLIENT_SECRET`, `TUYA_DEVICE_ID`, plus optional `TUYA_BASE_URL`/`TUYA_POLL_INTERVAL_MS`) are still required if you want the Tuya fallback path to work at all — see `lib/TuyaWeatherClient.js`'s header comment for where to find each value in the Tuya IoT console.

## Mascot Weather Character

The Right Now panel's outfit-suggestion mascot — a cartoon kid dressed for the current feels-like temperature — is entirely image-driven. `WeatherCard.js` just computes a filename from current conditions and drops it into an `<img>` tag; no code changes are needed to reskin it, only new PNGs.

**Why the images aren't in the repo:** the original set is personalized cartoon portraits of specific real kids, generated with Google's Gemini image model ("Nano Banana") from a reference photo — personal images, not something to publish. `assets/icons/mascot/*.png` is gitignored accordingly. Anyone else running this module needs to supply their own set before the mascot will render; until then, the `<img>` just 404s quietly (no crash) and the panel falls back to showing the plain forecast summary text instead.

**How the filename is picked** (`cards/WeatherCard.js`):

- `outfitBand(feelsLikeF)` maps the computed feels-like temperature to one of four bands: `heavy_coat` (<35°F), `jacket` (<55°F), `light_layer` (<70°F), `tshirt` (≥70°F).
- If there's a meaningful rain chance in the "sweater weather" range, the band is overridden to a `rainy_day` look instead.
- `getMascotChild()` alternates between two characters (`girl`/`boy`) on a rotating hourly schedule, so the same kid isn't on screen forever.
- `resolveMascotFilename(band, isRainy, child)` combines those into the filename it expects to find in `assets/icons/mascot/`.

**Filenames the code looks for** — exactly these 10, flat inside `assets/icons/mascot/` (no subfolders):

```
heavy_coat.png    heavy_coat_boy.png
jacket.png        jacket_boy.png
light_layer.png   light_layer_boy.png
tshirt.png        tshirt_boy.png
rainy_day.png     rainy_day_boy.png
```

No suffix = the "girl" character; `_boy` = the other. One image per band per character — no additional pose/size variants.

**Generating your own set:** any image model that can hold a consistent cartoon character across multiple prompts will work; this set was made with Gemini/Nano Banana. Rough approach:

1. Start from a clear reference photo of the kid (or an invented character, if you'd rather not use a real photo).
2. Settle on a consistent character/style description you're happy repeating verbatim, e.g. *"Cartoon illustration of [description], simple flat-color style, standing, full body, transparent background."*
3. For each of the 5 outfits, re-prompt with that same description plus the outfit — e.g. *"...wearing a heavy winter coat, hat, and mittens, standing in the snow"*, *"...wearing a light t-shirt and shorts on a sunny day"*, *"...wearing a rain jacket and rain boots, holding an umbrella"*. Keeping the character description and style wording identical each time is what keeps the kid recognizable across all five.
4. Repeat the same 5 prompts with the other character's description for the `_boy` set.
5. Export each as a transparent-background PNG and drop all 10 into `assets/icons/mascot/`, named exactly as listed above.

Only want one character, no daily alternation? Skip generating the `_boy` set and hardcode `getMascotChild()` to always `return "girl";` — the `_boy` filenames are only ever requested when that function returns `"boy"`.

## Navigation

Workspace switching happens over the standard MagicMirror notification bus (`NEXUS_SWITCH_WORKSPACE`, payload `{ workspace: "Travel" }`), which means any of these can trigger it:

- **MMM-Remote-Control**'s web UI (`http://<pi-ip>:8080/remote.html`) — see `custom_menu.json` setup below
- A physical touchscreen remote — see [Physical Remote (CYD)](#physical-remote-cyd) below
- Anything else on the MagicMirror notification bus

## Physical Remote (CYD)

A dedicated hardware remote built on a "Cheap Yellow Display" (ESP32-2432S028R) — a $10-15 ESP32 dev board with an integrated 320x240 touchscreen. Firmware lives at `arduino/NexusRemote/NexusRemote.ino`.

It draws a 2x2 grid of workspace buttons (Home / Weather / Calendar / Travel by default) and, on tap, POSTs directly to MMM-Remote-Control's REST API — firing the exact same `NEXUS_SWITCH_WORKSPACE` notification your `custom_menu.json` menu already uses. No new backend code needed; it's just another client on the existing notification bus.

**Setup:**

1. Install the [Arduino IDE](https://www.arduino.cc/en/software), add ESP32 board support, and install the `TFT_eSPI` (Bodmer) and `XPT2046_Touchscreen` (Paul Stoffregen) libraries via Library Manager.
2. `TFT_eSPI` requires a board-specific `User_Setup.h` for the CYD's display wiring — see `arduino/NexusRemote/README.md` (or the CYD community wiki) for the exact pin config.
3. Copy `arduino/NexusRemote/secrets.h.example` to `arduino/NexusRemote/secrets.h` and fill in your WiFi credentials and your Pi's static IP. **`secrets.h` is gitignored — never commit it.**
4. Flash to the board, open Serial Monitor at 115200 baud to confirm it connects to WiFi and prints its IP.
5. Tap a button — you should see your MagicMirror switch workspaces immediately, plus a POST response logged in Serial Monitor.

**Touch calibration:** resistive touch panels vary slightly board to board. If taps land in the wrong spot (or don't register), uncomment the raw coordinate `Serial.printf` in `loop()`, tap each corner of the screen, and adjust the `TOUCH_X_MIN/MAX`/`TOUCH_Y_MIN/MAX` constants near the top of the file to match.

**Adding more buttons:** the button grid is just an array of `WorkspaceButton` structs (label, target workspace, color, and x/y/w/h position) — adding a 5th, 6th, etc. button (and adjusting the grid math, or switching to a 3x2/scrollable layout) is a matter of extending that array and the `drawButtons()`/hit-test loop, not restructuring the firmware. The `workspace` string just needs to match a value your `custom_menu.json`/`NEXUS_SWITCH_WORKSPACE` handler already recognizes.

## Setup

### 1. Install

```
cd ~/MagicMirror/modules
git clone <this-repo-url> MMM-NexusDashboard
cd MMM-NexusDashboard
npm install
```

Requires Node 18+ (native `fetch()` — no `node-fetch` dependency needed).

### 2. Configure environment

```
cp config/.env.example config/.env
```

Fill in `config/.env` with real values. **This file is gitignored — never commit it.** What each section needs:

| Section | Required for |
|---|---|
| `LATITUDE` / `LONGITUDE` | Weather/Forecast cards (NWS + USNO astronomy), and the Aurora tracker's local probability lookup |
| `CALENDAR_URL` | Calendar card (read by the top-level MagicMirror `config.js`, not this module directly — see below) |
| `IMMICH_URL` / `IMMICH_API_KEY` / `IMMICH_ALBUM_ID` | Home screen photo slideshow |
| `GOOGLE_MAPS_API_KEY` / `HOME_ADDRESS` | Travel card |
| `COMMUTE_1_*` / `COMMUTE_2_*` | Travel card's two commute tiles |
| `AURORA_KP_THRESHOLD` | Aurora badge sensitivity (optional — defaults to `6` if omitted) |
| `TUYA_CLIENT_ID` / `TUYA_CLIENT_SECRET` / `TUYA_DEVICE_ID` / `TUYA_BASE_URL` | Weather station "Right Now" panel — Tuya Cloud source (see [Weather Station](#weather-station-right-now-panel)) |
| `RTL433_COMMAND` / `RTL433_ARGS` / `RTL433_FREQUENCY` / `RTL433_DEVICE_ID` | Weather station "Right Now" panel — rtl_433 source, the preferred/faster path (optional — see [Weather Station](#weather-station-right-now-panel)) |

### 3. Google Cloud setup (for the Travel card)

1. Create/select a project at [console.cloud.google.com](https://console.cloud.google.com)
2. Enable billing on the project (Google's free monthly element allowance covers normal household use — see cost notes in `node_helper.js`)
3. Enable the **Routes API** (APIs & Services → Library) — *not* the legacy Distance Matrix API
4. Create an API key (Credentials → Create Credentials → API key)
5. Restrict the key to the Routes API only (API restrictions)
6. Set a daily element quota cap (Routes API page → Quotas & System Limits) as a safety net against runaway usage
7. Optional but recommended: set a billing budget alert (Billing → Budgets & alerts)

### 4. Top-level MagicMirror `config.js`

This module reads its own `.env`, but the **calendar** module and `customMenu` path are configured in your main MagicMirror `config.js`, not inside this module. Example:

```js
const fs = require("fs");
const path = require("path");

function loadNexusEnv() {
    if (typeof require === "undefined") return {}; // browser context (remote.html) - skip
    const fs = require("fs");
    const path = require("path");
    const envPath = path.join(process.cwd(), "modules", "MMM-NexusDashboard", "config", ".env");
    const vars = {};
    if (!fs.existsSync(envPath)) return vars;
    fs.readFileSync(envPath, "utf-8").split("\n").forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#")) {
            const idx = trimmed.indexOf("=");
            if (idx > -1) {
                const key = trimmed.slice(0, idx).trim();
                let value = trimmed.slice(idx + 1).trim();
                if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                    value = value.slice(1, -1);
                }
                vars[key] = value;
            }
        }
    });
    return vars;
}
const nexusEnv = loadNexusEnv();

let config = {
    modules: [
        { module: "MMM-NexusDashboard", position: "fullscreen_above", config: {} },
        { module: "MMM-Remote-Control", position: "bottom_left", config: { customMenu: "custom_menu.json" } },
        {
            module: "calendar",
            config: {
                broadcastEvents: true,
                maximumEntries: 100,
                maximumNumberOfDays: 45,
                fade: false,
                calendars: [{ url: nexusEnv.CALENDAR_URL }]
            }
        }
    ]
};
if (typeof module !== "undefined") { module.exports = config; }
```

**Important:** `config.js` is loaded in two different environments — normally by Node.js, but also loaded directly as a browser `<script>` by MMM-Remote-Control's `remote.html` (to read `config.address`/`config.port`). The `typeof require === "undefined"` guard above is required, or the browser load will crash before `config` is ever defined.

### 5. Remote control menu

Copy `custom_menu.json` from this repo into your MagicMirror's top-level `config/` folder (same level as `config.js` — not inside this module). This gives `remote.html` a "Nexus Workspaces" menu to switch between Home/Forecast/Calendar/Travel.

### 6. Restart

```
pm2 restart mm
```

## Architecture notes

- Cards self-register via a `CardManager` and follow a `start()`/`suspend()`/`resume()` lifecycle — cards on an inactive workspace stop their own polling/timers entirely rather than running in the background.
- Workspace layout (grid columns/rows, which cards go where) is defined in `config/modes.json`.
- `node_helper.js` handles all outbound API calls (NWS, USNO, Immich, Google Routes, NOAA space weather) and secrets — the front-end never touches API keys directly.
- The Travel card's predictive leave-time scheduler runs independently of card visibility (in `node_helper.js`, not tied to `TravelCard.js`'s lifecycle), since it needs to capture a reading the evening before an appointment regardless of whether anyone's looking at the mirror. Predictions persist to `config/travel.json` (gitignored) so a restart mid-cycle doesn't lose a captured baseline.
- The Aurora tracker follows the same "runs independently of screen state" philosophy — its Kp/OVATION poll lives in `node_helper.js` and updates a module-level cache (`this.auroraCache`) that's replayed to `AuroraCard` on both initial load and every workspace switch, so the badge is always current even if the card was just instantiated.
- **Badge-slot pattern**: a small, reusable way to surface a compact indicator inside another card's tile without any coupling between the two. A host card opts in with `position: relative` plus an empty `<div class="nexus-badge-slot ..." data-badge-target="name">`; anything wanting to render into that slot just does `document.querySelector('[data-badge-target="name"]')` and writes into it. No shared state, no host-card code changes needed per badge. Currently used by Aurora targeting the Clock card; designed to support additional badges/targets later.

## Known limitations / things to watch

- The Travel card's traffic-condition thresholds (Light ≤5% over normal, Moderate ≤25%, Heavy beyond that) are a starting point, not a Google-provided standard — worth tuning after watching it against real commutes.
- Google's Routes API requires a real future-ish timestamp if you ever add `departureTime` back in — omitting it (current behavior) avoids a race condition where a client-generated "now" timestamp arrives at Google already in the past.
- NOAA's space weather JSON feeds (`noaa-planetary-k-index.json`) have changed shape before (a March 2026 format change moved from header-row-plus-array-rows to plain keyed objects) — if the Aurora badge silently stops updating, check whether NOAA's response shape changed again before assuming the poll logic is broken.

## License

MIT — see [LICENSE](LICENSE).
