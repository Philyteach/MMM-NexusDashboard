/**
 * cards/CalendarCard.js
 *
 * Reusable calendar card fed by the core "calendar" module's CALENDAR_EVENTS
 * broadcast (see MMM-NexusDashboard.js notificationReceived).
 *
 * Renders:
 *   1. A month grid for the current month, each day cell showing up to 2
 *      event titles (plus a "+N more" indicator).
 *   2. A focused agenda below it, showing only Today's and Tomorrow's
 *      events with times, grouped under relative day headers.
 *
 * Note: MagicMirror's core calendar module only broadcasts events from "now"
 * forward, so days earlier in the current month will show as empty cells --
 * there's no historical event data to show even if something happened there.
 */
class CalendarCard extends NexusCard {
    start() {
        this.events = [];
    }

    // Safely receive broadcast calendar events
    updateState(events) {
        this.events = events || [];
        this.updateDom();
    }

    // ---------- date helpers ----------

    dateKey(date) {
        return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    }

    // "Today", "Tomorrow", or "Mon, Jul 20"
    formatDate(timestamp) {
        if (!timestamp) return "";
        try {
            const date = new Date(parseInt(timestamp));
            const now = new Date();

            const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const startOfEventDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const diffDays = Math.round((startOfEventDay - startOfToday) / 86400000);

            if (diffDays === 0) return "Today";
            if (diffDays === 1) return "Tomorrow";

            return date.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
        } catch (e) {
            console.error("[Nexus Calendar] Error parsing date:", e);
            return "";
        }
    }

    formatTime(timestamp) {
        if (!timestamp) return "";
        try {
            const date = new Date(parseInt(timestamp));
            return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        } catch (e) {
            console.error("[Nexus Calendar] Error parsing date:", e);
            return "";
        }
    }

    // Groups events by local calendar day: Map<"YYYY-M-D", event[]>, each
    // day's events sorted chronologically.
    groupEventsByDay() {
        const map = new Map();

        (this.events || []).forEach(event => {
            if (!event.startDate) return;
            const date = new Date(parseInt(event.startDate));
            const key = this.dateKey(date);
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(event);
        });

        map.forEach(list => list.sort((a, b) => parseInt(a.startDate) - parseInt(b.startDate)));
        return map;
    }

    // ---------- month grid ----------

    buildMonthCells(eventsByDay) {
        const now = new Date();
        const year = now.getFullYear();
        const month = now.getMonth();

        const firstOfMonth = new Date(year, month, 1);
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const startWeekday = firstOfMonth.getDay(); // 0 = Sunday

        const cells = [];

        // Leading blanks so day 1 lands in the correct weekday column
        for (let i = 0; i < startWeekday; i++) {
            cells.push(null);
        }

        for (let day = 1; day <= daysInMonth; day++) {
            const cellDate = new Date(year, month, day);
            const key = this.dateKey(cellDate);
            cells.push({
                day: day,
                isToday: cellDate.toDateString() === now.toDateString(),
                events: eventsByDay.get(key) || []
            });
        }

        // Trailing blanks to complete the final week
        while (cells.length % 7 !== 0) {
            cells.push(null);
        }

        return {
            cells: cells,
            monthLabel: now.toLocaleDateString([], { month: "long", year: "numeric" })
        };
    }

    renderMonthGrid(eventsByDay) {
        const built = this.buildMonthCells(eventsByDay);
        const weekdayLabels = ["S", "M", "T", "W", "T", "F", "S"];
        const maxChipsPerDay = 2;

        const weekdayHtml = weekdayLabels
            .map(w => `<div class="calendar-month-weekday">${w}</div>`)
            .join("");

        const cellsHtml = built.cells.map(cell => {
            if (!cell) {
                return `<div class="calendar-month-cell is-empty"></div>`;
            }

            const shown = cell.events.slice(0, maxChipsPerDay);
            const remaining = cell.events.length - shown.length;

            const chipsHtml = shown
                .map(ev => `<div class="calendar-month-event-chip">${ev.title || "Untitled"}</div>`)
                .join("") + (remaining > 0 ? `<div class="calendar-month-event-more">+${remaining} more</div>` : "");

            return `
                <div class="calendar-month-cell${cell.isToday ? " is-today" : ""}">
                    <div class="calendar-month-daynum">${cell.day}</div>
                    <div class="calendar-month-day-events">${chipsHtml}</div>
                </div>
            `;
        }).join("");

        return `
            <div class="calendar-month-label">${built.monthLabel}</div>
            <div class="calendar-month-grid">
                ${weekdayHtml}
                ${cellsHtml}
            </div>
        `;
    }

    // ---------- today/tomorrow agenda ----------

    renderAgendaSection() {
        const relevant = (this.events || [])
            .filter(event => {
                const label = this.formatDate(event.startDate);
                return label === "Today" || label === "Tomorrow";
            })
            .sort((a, b) => parseInt(a.startDate) - parseInt(b.startDate));

        if (relevant.length === 0) {
            return `
                <div class="calendar-agenda-header">Agenda</div>
                <div class="calendar-empty">
                    <span class="calendar-empty-icon">&#128197;</span>
                    <span>Nothing today or tomorrow</span>
                </div>
            `;
        }

        let currentGroupLabel = null;
        const itemsHtml = relevant.map(event => {
            const dayLabel = this.formatDate(event.startDate);
            const timeStr = event.fullDayEvent ? "All Day" : this.formatTime(event.startDate);

            let groupHeaderHtml = "";
            if (dayLabel !== currentGroupLabel) {
                currentGroupLabel = dayLabel;
                groupHeaderHtml = `<li class="calendar-agenda-day-label">${dayLabel}</li>`;
            }

            return `
                ${groupHeaderHtml}
                <li class="calendar-event-item">
                    <div class="event-meta">
                        <span class="event-time">${timeStr}</span>
                    </div>
                    <div class="event-title">${event.title || "Untitled Event"}</div>
                </li>
            `;
        }).join("");

        return `
            <div class="calendar-agenda-header">Agenda</div>
            <ul class="calendar-event-list">${itemsHtml}</ul>
        `;
    }

    render() {
        this.domElement.className = "nexus-card nexus-calendar-card";

        const eventsByDay = this.groupEventsByDay();
        const monthHtml = this.renderMonthGrid(eventsByDay);
        const agendaHtml = this.renderAgendaSection();

        this.domElement.innerHTML = `
            <div class="calendar-header">Calendar</div>
            ${monthHtml}
            ${agendaHtml}
        `;
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("CalendarCard", CalendarCard);
}
// Global registration (fallback lookup used by CardManager)
window.CalendarCard = CalendarCard;
