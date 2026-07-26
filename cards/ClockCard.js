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
        
        // Start the clock tick loop
        this.updateTime();
        this.timer = setInterval(() => {
            this.updateTime();
        }, 1000);
    }

    updateTime() {
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

        this.updateDom();
    }

    suspend() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    resume() {
        if (!this.timer) {
            this.updateTime();
            this.timer = setInterval(() => {
                this.updateTime();
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
