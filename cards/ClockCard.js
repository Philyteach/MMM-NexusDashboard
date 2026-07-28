/**
 * cards/ClockCard.js
 * 
 * Elegant, high-contrast digital clock card for the Nexus Dashboard.
 */
class ClockCard extends NexusCard {
    start() {
        this.timeString = "";
        this.dateString = "";
        this.secondsString = "";

        // The very first render has to go through the normal
        // updateDom()/getDom()/render() flow (same as the original code
        // always did): domElement doesn't exist yet at this point in
        // start() - CardManager creates it moments from now via the
        // getDom() call it makes right after start() returns. Calling
        // render() directly here would hit a null domElement.
        this.computeTimeStrings();
        this.updateDom();

        // Every tick AFTER this first one goes through tick() below
        // instead, which only patches the specific text nodes that
        // change - domElement is guaranteed to exist by then. Rebuilding
        // the full innerHTML (including the badge slot AuroraCard/
        // WatchBadgeCard inject into) every single second was wiping out
        // any watch/aurora icons within a second of them appearing -
        // that's what patching instead of rebuilding fixes.
        this.timer = setInterval(() => {
            this.tick();
        }, 1000);
    }

    computeTimeStrings() {
        const now = new Date();

        // 1. Format Time (12-hour format with leading zeroes removed)
        let hours = now.getHours();
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12;
        hours = hours ? hours : 12; // '0' should be '12'

        const minutes = String(now.getMinutes()).padStart(2, "0");
        this.secondsString = String(now.getSeconds()).padStart(2, "0");
        this.timeString = `${hours}:${minutes} <span class="clock-ampm">${ampm}</span>`;
        // 2. Format Date (e.g., "Wednesday, July 15, 2026")
        const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
        this.dateString = now.toLocaleDateString('en-US', options);
    }

    tick() {
        this.computeTimeStrings();
        this.patchTimeDisplay();
    }

    /**
     * Updates just the text/markup that actually changes second-to-second,
     * without touching the rest of domElement's children - in particular,
     * never touches the badge slot, so anything WatchBadgeCard/AuroraCard
     * has injected into it stays put.
     */
    patchTimeDisplay() {
        if (!this.domElement) return;
        const timeEl = this.domElement.querySelector(".clock-time");
        const secondsEl = this.domElement.querySelector(".clock-seconds");
        const dateEl = this.domElement.querySelector(".clock-date");
        if (timeEl) timeEl.innerHTML = this.timeString;
        if (secondsEl) secondsEl.textContent = this.secondsString;
        if (dateEl) dateEl.textContent = this.dateString;
    }

    suspend() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
    resume() {
        if (!this.timer) {
            // domElement already exists at this point (this is a resume,
            // not the very first-ever start()) - tick() safely patches
            // text in place rather than forcing a full rebuild.
            this.tick();
            this.timer = setInterval(() => {
                this.tick();
            }, 1000);
        }
    }
    render() {
        this.domElement.className = "nexus-card nexus-clock-card";
        this.domElement.innerHTML = `
            <div class="clock-container">
                <div class="clock-time-wrapper">
                    <span class="clock-time">${this.timeString}</span>
                    <span class="clock-seconds">${this.secondsString}</span>
                </div>
                <div class="clock-date">${this.dateString}</div>
             <div class="nexus-badge-slot nexus-badge-slot--bottom-right" data-badge-target="clock"></div>
            </div>
        `;
    }
}
// Bind to registry
if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("ClockCard", ClockCard);
}
// Bind to global scope for CardManager lookup
window.ClockCard = ClockCard;
