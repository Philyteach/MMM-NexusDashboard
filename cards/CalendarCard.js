/**
 * cards/CalendarCard.js
 *
 * Reusable calendar card fed by the core "calendar" module's CALENDAR_EVENTS
 * broadcast (see MMM-NexusDashboard.js notificationReceived).
 *
 * Renders:
 *   1. A month grid for the current month, each day cell showing up to 2
 *      events with start time + title (plus a "+N more" indicator).
 *      Full-day events show just the title, no time.
 *   2. A focused agenda below it, showing only Today's and Tomorrow's
 *      events with times, grouped under relative day headers.
 *
 * Note: MagicMirror's core calendar module only broadcasts events from "now"
 * forward, so days earlier in the current month will show as empty cells --
 * there's no historical event data to show even if something happened there.
 *
 * Clicking an event chip/row opens a full-detail modal (title, time,
 * location, description). Clicking a day cell's "+N more" opens a day-list
 * popup of that day's events, each of which routes to the same detail
 * modal. Modals are appended to document.body rather than domElement,
 * since render() does a full innerHTML replace on every calendar refresh
 * and would otherwise wipe out an open modal.
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

    // Compact time for month grid chips, e.g. "9:00" / "2:30" -- no AM/PM,
    // to save space in the small cells.
    formatTimeCompact(timestamp) {
        if (!timestamp) return "";
        try {
            const date = new Date(parseInt(timestamp));
            return date
                .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
                .replace(/\s?[AP]M$/i, "");
        } catch (e) {
            console.error("[Nexus Calendar] Error parsing date:", e);
            return "";
        }
    }

    // Full date + time range for the detail modal, e.g. "Wednesday, August 12 · 3:00 PM – 4:00 PM"
    formatEventRange(event) {
        if (!event.startDate) return "";
        try {
            const start = new Date(parseInt(event.startDate));
            const end = event.endDate ? new Date(parseInt(event.endDate)) : null;
            const startDateStr = start.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
            const sameDay = !end || end.toDateString() === start.toDateString();

            if (event.fullDayEvent) {
                if (!sameDay) {
                    const endDateStr = end.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
                    return `${startDateStr} – ${endDateStr} · All Day`;
                }
                return `${startDateStr} · All Day`;
            }

            const startTimeStr = this.formatTime(event.startDate);
            if (sameDay) {
                return end ? `${startDateStr} · ${startTimeStr} – ${this.formatTime(event.endDate)}` : `${startDateStr} · ${startTimeStr}`;
            }

            const endDateStr = end.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
            return `${startDateStr} ${startTimeStr} – ${endDateStr} ${this.formatTime(event.endDate)}`;
        } catch (e) {
            console.error("[Nexus Calendar] Error formatting event range:", e);
            return "";
        }
    }

    // Escapes text pulled from ICS feeds (title/location/description) before
    // it's interpolated into innerHTML -- that data is untrusted.
    escapeHtml(str) {
        if (str === undefined || str === null || str === false) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
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
                key: key,
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
                .map(ev => {
                    const timeStr = ev.fullDayEvent ? "" : this.formatTimeCompact(ev.startDate);
                    const timeHtml = timeStr ? `<span class="calendar-month-event-time">${this.escapeHtml(timeStr)}</span>` : "";
                    return `<div class="calendar-month-event-chip" data-event-idx="${this.events.indexOf(ev)}">${timeHtml}${this.escapeHtml(ev.title || "Untitled")}</div>`;
                })
                .join("") + (remaining > 0 ? `<div class="calendar-month-event-more" data-day-key="${cell.key}">+${remaining} more</div>` : "");

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
                <li class="calendar-event-item" data-event-idx="${this.events.indexOf(event)}">
                    <div class="event-meta">
                        <span class="event-time">${this.escapeHtml(timeStr)}</span>
                    </div>
                    <div class="event-title">${this.escapeHtml(event.title || "Untitled Event")}</div>
                </li>
            `;
        }).join("");

        return `
            <div class="calendar-agenda-header">Agenda</div>
            <ul class="calendar-event-list">${itemsHtml}</ul>
        `;
    }

    render() {
        this.domElement.className = "nexus-card nexus-calendar-card nexus-no-shrink";

        const eventsByDay = this.groupEventsByDay();
        this.eventsByDay = eventsByDay; // cached for the "+N more" day-list click handler
        const monthHtml = this.renderMonthGrid(eventsByDay);
        const agendaHtml = this.renderAgendaSection();

        this.domElement.innerHTML = `
            <div class="calendar-header">Calendar</div>
            ${monthHtml}
            ${agendaHtml}
        `;

        // domElement itself persists across renders (only its innerHTML is
        // replaced above), so this only needs to be bound once ever.
        if (!this.clickBound) {
            this.domElement.addEventListener("click", this.handleCardClick.bind(this));
            this.clickBound = true;
        }
    }

    // ---------- click handling / detail modal ----------

    handleCardClick(e) {
        const chip = e.target.closest("[data-event-idx]");
        if (chip) {
            const event = this.events[parseInt(chip.getAttribute("data-event-idx"), 10)];
            if (event) this.openEventDetail(event);
            return;
        }

        const moreLink = e.target.closest("[data-day-key]");
        if (moreLink) {
            const dayEvents = (this.eventsByDay && this.eventsByDay.get(moreLink.getAttribute("data-day-key"))) || [];
            if (dayEvents.length > 0) {
                this.openDayList(this.formatDate(dayEvents[0].startDate), dayEvents);
            }
        }
    }

    buildEventDetailHtml(event) {
        const title = this.escapeHtml(event.title || "Untitled Event");
        const calendarName = this.escapeHtml(event.calendarName || "");
        const color = this.escapeHtml(event.color || "#0088ff");
        const range = this.escapeHtml(this.formatEventRange(event));
        const location = this.escapeHtml(event.location || "");
        const description = this.escapeHtml(event.description || "");
        const recurringBadge = event.recurringEvent ? `<span class="calendar-modal-badge">Recurring</span>` : "";

        return `
            <div class="calendar-event-modal">
                <button class="calendar-modal-close" aria-label="Close">&times;</button>
                ${calendarName ? `
                    <div class="calendar-modal-calendar">
                        <span class="calendar-modal-dot" style="background:${color}"></span>${calendarName}
                    </div>
                ` : ""}
                <div class="calendar-modal-title">${title}${recurringBadge}</div>
                <div class="calendar-modal-range">${range}</div>
                ${location ? `<div class="calendar-modal-row"><span class="calendar-modal-icon">&#128205;</span>${location}</div>` : ""}
                ${description ? `<div class="calendar-modal-description">${description}</div>` : ""}
            </div>
        `;
    }

    buildDayListHtml(dayLabel, dayEvents) {
        const rows = dayEvents.map(ev => {
            const timeStr = ev.fullDayEvent ? "All Day" : this.formatTime(ev.startDate);
            return `
                <li class="calendar-daylist-item" data-event-idx="${this.events.indexOf(ev)}">
                    <span class="event-time">${this.escapeHtml(timeStr)}</span>
                    <span class="event-title">${this.escapeHtml(ev.title || "Untitled Event")}</span>
                </li>
            `;
        }).join("");

        return `
            <div class="calendar-event-modal calendar-daylist-modal">
                <button class="calendar-modal-close" aria-label="Close">&times;</button>
                <div class="calendar-modal-title">${this.escapeHtml(dayLabel)}</div>
                <ul class="calendar-daylist">${rows}</ul>
            </div>
        `;
    }

    openEventDetail(event) {
        this.showModal(this.buildEventDetailHtml(event));
    }

    openDayList(dayLabel, dayEvents) {
        this.showModal(this.buildDayListHtml(dayLabel, dayEvents));
    }

    // Single-instance modal host, appended to document.body so it survives
    // the card's own innerHTML replacement on the next calendar refresh.
    // Handles backdrop-click-to-close, the X button, Escape, a 20s
    // auto-dismiss safety net, and routing day-list row clicks back into
    // openEventDetail (via the same data-event-idx delegation).
    showModal(innerHtml) {
        this.closeModal();

        const backdrop = document.createElement("div");
        backdrop.className = "calendar-modal-backdrop";
        backdrop.innerHTML = innerHtml;

        backdrop.addEventListener("click", (e) => {
            if (e.target === backdrop) {
                this.closeModal();
                return;
            }
            if (e.target.closest(".calendar-modal-close")) {
                this.closeModal();
                return;
            }
            const row = e.target.closest("[data-event-idx]");
            if (row) {
                const event = this.events[parseInt(row.getAttribute("data-event-idx"), 10)];
                if (event) this.openEventDetail(event);
            }
        });

        document.body.appendChild(backdrop);
        this.modalBackdrop = backdrop;

        this.modalKeyHandler = (e) => {
            if (e.key === "Escape") this.closeModal();
        };
        document.addEventListener("keydown", this.modalKeyHandler);

        this.modalTimer = setTimeout(() => this.closeModal(), 20000);
    }

    closeModal() {
        if (this.modalTimer) {
            clearTimeout(this.modalTimer);
            this.modalTimer = null;
        }
        if (this.modalKeyHandler) {
            document.removeEventListener("keydown", this.modalKeyHandler);
            this.modalKeyHandler = null;
        }
        if (this.modalBackdrop) {
            this.modalBackdrop.remove();
            this.modalBackdrop = null;
        }
    }
}

// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("CalendarCard", CalendarCard);
}
// Global registration (fallback lookup used by CardManager)
window.CalendarCard = CalendarCard;
