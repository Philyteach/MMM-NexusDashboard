/**
 * cards/TravelCard.js
 *
 * Commute/travel-time card, inspired by MMM-Traffic but built around two
 * fixed household commute windows plus dynamic drive times to anything on
 * today/tomorrow's calendar agenda that has a location.
 *
 * Two fixed tiles (COMMUTE_1 / COMMUTE_2 from .env) are always visible.
 * During each commute's configured window (e.g. 07:00-08:00), the tile
 * shows a "leave by" countdown instead of just a raw drive time. Below the
 * tiles, a scrolling list shows live drive time to any upcoming calendar
 * event location.
 *
 * Polls every 8 minutes (POLL_INTERVAL_MS) to stay comfortably inside the
 * Google Distance Matrix free tier (see project notes) — one request per
 * poll covers both commute destinations plus any agenda locations, since
 * Distance Matrix bills per origin*destination element, not per request.
 */
class TravelCard extends NexusCard {
    start() {
        this.results = {};       // destination string -> { durationSec, durationText, distanceText, status }
        this.lastError = null;
        this.pollTimer = null;
        this.predictions = {};   // location|startDate -> prediction object from node_helper's scheduler

        this.fetchTravelTimes();
        this.pollTimer = setInterval(() => this.fetchTravelTimes(), TravelCard.POLL_INTERVAL_MS);

        // Keep "leave by" countdowns and stale-tile styling moving between
        // polls without hitting the API again.
        this.tickTimer = setInterval(() => this.updateDom(), 30000);

        this.startIdleRevertTimer();
    }

    suspend() {
        if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
        if (this.tickTimer) { clearInterval(this.tickTimer); this.tickTimer = null; }
        this.clearIdleRevertTimer();
    }

    resume() {
        if (!this.pollTimer) {
            this.fetchTravelTimes();
            this.pollTimer = setInterval(() => this.fetchTravelTimes(), TravelCard.POLL_INTERVAL_MS);
        }
        if (!this.tickTimer) {
            this.tickTimer = setInterval(() => this.updateDom(), 30000);
        }
        this.startIdleRevertTimer();
    }

    // Nobody's expected to sit on the Travel workspace indefinitely - if
    // it's been left up for 20 minutes (2 poll cycles) with no one pressing
    // the remote again, drop back to Home rather than parking on a
    // single-purpose screen nobody's actively looking at.
    startIdleRevertTimer() {
        this.clearIdleRevertTimer();
        this.idleRevertTimer = setTimeout(() => {
            this.module.transitionWorkspace("Home", "Travel idle timeout (20 min)");
        }, TravelCard.IDLE_REVERT_MS);
    }

    clearIdleRevertTimer() {
        if (this.idleRevertTimer) {
            clearTimeout(this.idleRevertTimer);
            this.idleRevertTimer = null;
        }
    }

    // ---------- data fetching ----------

    fetchTravelTimes() {
        const agendaLocations = this.getAgendaLocations();
        this.module.sendSocketNotification("GET_TRAVEL_TIMES", {
            agendaLocations: agendaLocations
        });
    }

    // Pulls Today/Tomorrow event locations out of the same cached calendar
    // payload CalendarCard renders from (MMM-NexusDashboard.js caches the
    // core calendar module's broadcast on this.module.latestCalendarEvents).
    // Standard MagicMirror calendar events carry a "location" string field
    // straight from the ICS feed when present.
    getAgendaLocations() {
        const events = this.module.latestCalendarEvents || [];
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const startOfDayAfterTomorrow = new Date(startOfToday);
        startOfDayAfterTomorrow.setDate(startOfDayAfterTomorrow.getDate() + 2);

        const seen = new Set();
        const locations = [];

        events
            .filter(ev => ev.location && String(ev.location).trim().length > 0)
            .filter(ev => {
                if (!ev.startDate) return false;
                const eventDate = new Date(parseInt(ev.startDate));
                return eventDate >= startOfToday && eventDate < startOfDayAfterTomorrow;
            })
            .sort((a, b) => parseInt(a.startDate) - parseInt(b.startDate))
            .forEach(ev => {
                const loc = String(ev.location).trim();
                // Same location can appear on multiple events (e.g. school
                // pickup/dropoff) - only ask the API about it once.
                if (!seen.has(loc)) {
                    seen.add(loc);
                    locations.push({ location: loc, eventTitle: ev.title || "Event", startDate: ev.startDate });
                }
            });

        return locations;
    }

    // Called by MMM-NexusDashboard.js socketNotificationReceived on
    // "TRAVEL_TIMES_DATA" / "TRAVEL_TIMES_ERROR".
    updateState(payload, error) {
        if (error) {
            this.lastError = error;
        } else {
            this.lastError = null;
            this.results = payload || {};
        }
        this.updateDom();
    }

    // Called by MMM-NexusDashboard.js on "TRAVEL_PREDICTIONS_DATA" - the
    // full predictions map from node_helper's background scheduler
    // (baseline + refined leave-by readings for upcoming appointments).
    updatePredictions(payload) {
        this.predictions = payload || {};
        this.updateDom();
    }

    // Matches an agenda item back to its prediction entry using the same
    // location|startDate key the scheduler builds server-side.
    getPredictionFor(location, eventStartDate) {
        const key = `${location}|${eventStartDate}`;
        return this.predictions[key] || null;
    }

    // ---------- commute window helpers ----------

    // Reads COMMUTE_1_* / COMMUTE_2_* out of the same env bag ForecastCard
    // etc. read LATITUDE/LONGITUDE from.
    getCommuteConfigs() {
        const cm = this.configManager;
        const configs = [];
        [1, 2].forEach(n => {
            const label = cm.getEnv(`COMMUTE_${n}_LABEL`);
            const dest = cm.getEnv(`COMMUTE_${n}_DEST`);
            if (label && dest) {
                configs.push({
                    label: label,
                    destination: dest,
                    windowStart: cm.getEnv(`COMMUTE_${n}_WINDOW_START`, "00:00"),
                    windowEnd: cm.getEnv(`COMMUTE_${n}_WINDOW_END`, "00:00")
                });
            }
        });
        return configs;
    }

    parseWindowTime(hhmm, referenceDate) {
        const [h, m] = (hhmm || "00:00").split(":").map(Number);
        const d = new Date(referenceDate);
        d.setHours(h || 0, m || 0, 0, 0);
        return d;
    }

    // Returns null outside the window, otherwise { minutesLeft, driveMinutes, bufferMinutes, urgent }
    getLeaveByStatus(commuteConfig, durationSec) {
        const now = new Date();
        const winStart = this.parseWindowTime(commuteConfig.windowStart, now);
        const winEnd = this.parseWindowTime(commuteConfig.windowEnd, now);

        if (now < winStart || now > winEnd || durationSec == null) return null;

        const minutesLeft = Math.round((winEnd - now) / 60000);
        const driveMinutes = Math.round(durationSec / 60);
        const bufferMinutes = minutesLeft - driveMinutes;

        return {
            minutesLeft: minutesLeft,
            driveMinutes: driveMinutes,
            bufferMinutes: bufferMinutes,
            urgent: bufferMinutes < 10
        };
    }

    // ---------- rendering ----------

    renderCommuteTile(commuteConfig) {
        const result = this.results[commuteConfig.destination];
        const durationText = result?.durationText;
        const durationSec = result?.durationSec;
        const leaveBy = this.getLeaveByStatus(commuteConfig, durationSec);

        let statusHtml;
        if (!result) {
            statusHtml = `<div class="travel-tile-loading">Fetching...</div>`;
        } else {
            const trafficHtml = this.renderTrafficBadge(result);
            const tollHtml = result.tollText
                ? `<div class="travel-tile-toll">${result.tollText}</div>`
                : "";
            const distanceHtml = result.distanceText
                ? `<div class="travel-tile-distance">${result.distanceText}</div>`
                : "";

            if (leaveBy) {
                const urgencyClass = leaveBy.urgent ? "is-urgent" : "is-ok";
                statusHtml = `
                    <div class="travel-tile-drivetime">${durationText}</div>
                    ${trafficHtml}
                    ${distanceHtml}
                    ${tollHtml}
                    <div class="travel-tile-leaveby ${urgencyClass}">
                        ${leaveBy.bufferMinutes > 0
                            ? `Leave within ${leaveBy.bufferMinutes} min`
                            : `Leave now`}
                    </div>
                `;
            } else {
                statusHtml = `
                    <div class="travel-tile-drivetime">${durationText}</div>
                    ${trafficHtml}
                    ${distanceHtml}
                    ${tollHtml}
                `;
            }
        }

        return `
            <div class="travel-commute-tile">
                <div class="travel-tile-label">${commuteConfig.label}</div>
                ${statusHtml}
            </div>
        `;
    }

    // Turns trafficCondition + trafficDeltaMinutes into a colored badge like
    // "Heavy · +12 min vs normal". Returns "" if we don't have enough data
    // yet (e.g. first poll hasn't landed) rather than showing a blank badge.
    renderTrafficBadge(result) {
        if (!result || !result.trafficCondition) return "";

        const labels = { light: "Light", moderate: "Moderate", heavy: "Heavy" };
        const label = labels[result.trafficCondition] || result.trafficCondition;
        const deltaText = result.trafficDeltaMinutes > 0
            ? `+${result.trafficDeltaMinutes} min vs normal`
            : "at normal pace";
        const estimateTag = result.isEstimate ? ` <span class="travel-estimate-tag">(estimate)</span>` : "";

        return `
            <div class="travel-traffic-badge is-${result.trafficCondition}">
                ${label} <span class="travel-traffic-delta">· ${deltaText}</span>${estimateTag}
            </div>
        `;
    }

    renderAgendaLocations() {
        const agendaLocations = this.getAgendaLocations();

        if (agendaLocations.length === 0) {
            return `
                <div class="travel-agenda-header">Upcoming Stops</div>
                <div class="travel-empty">No locations on today/tomorrow's agenda</div>
            `;
        }

        const itemsHtml = agendaLocations.map(item => {
            const result = this.results[item.location];
            const durationText = result?.durationText || "...";
            const distanceText = result?.distanceText || "";
            const trafficHtml = result ? this.renderTrafficBadge(result) : "";
            const tollText = result?.tollText || "";
            const prediction = this.getPredictionFor(item.location, item.startDate);
            const leaveByHtml = this.renderPredictedLeaveBy(prediction);
            return `
                <li class="travel-agenda-item">
                    <div class="travel-agenda-title">${item.eventTitle}</div>
                    <div class="travel-agenda-meta">
                        <span class="travel-agenda-duration">${durationText}</span>
                        ${distanceText ? `<span class="travel-agenda-distance">${distanceText}</span>` : ""}
                        ${tollText ? `<span class="travel-agenda-toll">${tollText}</span>` : ""}
                    </div>
                    ${trafficHtml}
                    ${leaveByHtml}
                </li>
            `;
        }).join("");

        return `
            <div class="travel-agenda-header">Upcoming Stops</div>
            <ul class="travel-agenda-list">${itemsHtml}</ul>
        `;
    }

    // Shows the scheduler's suggested leave-by time once a refined reading
    // has landed. Before that, shows nothing if there's no prediction yet
    // (the appointment is more than ~24h out) or a quiet "estimating..."
    // note once a baseline exists but the day-of refined check hasn't fired
    // yet - avoids implying a real number is coming before it actually is.
    renderPredictedLeaveBy(prediction) {
        if (!prediction) return "";

        if (prediction.suggestedLeaveTime) {
            const leaveTime = new Date(prediction.suggestedLeaveTime);
            const timeText = leaveTime.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
            return `<div class="travel-predicted-leaveby">Suggested leave time: ${timeText}</div>`;
        }

        if (prediction.baselineDurationSec != null) {
            return `<div class="travel-predicted-pending">Refining leave time closer to departure...</div>`;
        }

        return "";
    }

    render() {
        this.domElement.className = "nexus-card nexus-travel-card";

        const commuteConfigs = this.getCommuteConfigs();
        const tilesHtml = commuteConfigs.map(c => this.renderCommuteTile(c)).join("");
        const agendaHtml = this.renderAgendaLocations();
        const errorHtml = this.lastError
            ? `<div class="travel-error">Travel data unavailable: ${this.lastError}</div>`
            : "";

        this.domElement.innerHTML = `
            <div class="travel-header">Travel</div>
            <div class="travel-commute-tiles">${tilesHtml}</div>
            ${errorHtml}
            <div class="travel-agenda-section">${agendaHtml}</div>
        `;
    }
}

// 8 minutes - see file header for the free-tier math this is based on.
TravelCard.POLL_INTERVAL_MS = 8 * 60 * 1000;

// 20 minutes (2 poll cycles) - auto-revert to Home if nobody's touched the
// remote in that window, so Travel doesn't just sit there indefinitely.
TravelCard.IDLE_REVERT_MS = 20 * 60 * 1000;

if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("TravelCard", TravelCard);
}
window.TravelCard = TravelCard;
