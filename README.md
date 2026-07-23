# MMM-NexusDashboard

A modern, card-based dashboard framework for [MagicMirror²](https://magicmirror.builders/), built around four full-screen "workspaces" you can switch between: a Home overview, a full weather command center, a full-page calendar, and a live commute/travel tracker. Built from scratch as a first programming project — not a fork of an existing module.

## Workspaces

### Home (default)
- **Clock** — current time
- **Weather** (compact) — current conditions sidebar
- **Calendar** (compact) — upcoming events sidebar
- **Immich slideshow** — rotating photos pulled from a self-hosted [Immich](https://immich.app/) server

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

## Navigation

Workspace switching happens over the standard MagicMirror notification bus (`NEXUS_SWITCH_WORKSPACE`, payload `{ workspace: "Travel" }`), which means any of these can trigger it:
- **MMM-Remote-Control**'s web UI (`http://<pi-ip>:8080/remote.html`) — see `custom_menu.json` setup below
- A future physical remote (planned: an ESP32-based touchscreen "CYD" device)
- Anything else on the MagicMirror notification bus

## Setup

### 1. Install
```bash
cd ~/MagicMirror/modules
git clone <this-repo-url> MMM-NexusDashboard
cd MMM-NexusDashboard
npm install
```
Requires Node 18+ (native `fetch()` — no `node-fetch` dependency needed).

### 2. Configure environment
```bash
cp config/.env.example config/.env
```
Fill in `config/.env` with real values. **This file is gitignored — never commit it.** What each section needs:

| Section | Required for |
|---|---|
| `LATITUDE` / `LONGITUDE` | Weather/Forecast cards (NWS + USNO astronomy) |
| `CALENDAR_URL` | Calendar card (read by the top-level MagicMirror `config.js`, not this module directly — see below) |
| `IMMICH_URL` / `IMMICH_API_KEY` / `IMMICH_ALBUM_ID` | Home screen photo slideshow |
| `GOOGLE_MAPS_API_KEY` / `HOME_ADDRESS` | Travel card |
| `COMMUTE_1_*` / `COMMUTE_2_*` | Travel card's two commute tiles |

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
```javascript
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
```bash
pm2 restart mm
```

## Architecture notes
- Cards self-register via a `CardManager` and follow a `start()`/`suspend()`/`resume()` lifecycle — cards on an inactive workspace stop their own polling/timers entirely rather than running in the background.
- Workspace layout (grid columns/rows, which cards go where) is defined in `config/modes.json`.
- `node_helper.js` handles all outbound API calls (NWS, USNO, Immich, Google Routes) and secrets — the front-end never touches API keys directly.
- The Travel card's predictive leave-time scheduler runs independently of card visibility (in `node_helper.js`, not tied to `TravelCard.js`'s lifecycle), since it needs to capture a reading the evening before an appointment regardless of whether anyone's looking at the mirror. Predictions persist to `config/travel.json` (gitignored) so a restart mid-cycle doesn't lose a captured baseline.

## Known limitations / things to watch
- The Travel card's traffic-condition thresholds (Light ≤5% over normal, Moderate ≤25%, Heavy beyond that) are a starting point, not a Google-provided standard — worth tuning after watching it against real commutes.
- Google's Routes API requires a real future-ish timestamp if you ever add `departureTime` back in — omitting it (current behavior) avoids a race condition where a client-generated "now" timestamp arrives at Google already in the past.
