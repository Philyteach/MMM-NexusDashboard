# MMM-NexusDashboard

A modern, card-based dashboard framework for [MagicMirror²](https://magicmirror.builders/), built around four full-screen "workspaces" you can switch between: a Home overview, a full weather command center, a full-page calendar, and a live commute/travel tracker. Built from scratch as a first programming project — not a fork of an existing module.

## Workspaces

### Home (default)

- **Clock** — current time
- **Weather** (compact) — current conditions sidebar, labeled High/Low depending on whether the active NWS period is daytime or nighttime
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
