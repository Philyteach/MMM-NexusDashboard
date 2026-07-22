/**
 * cards/ImmichCard.js
 * 
 * Beautiful self-hosted slideshow card streaming privately from your Immich server.
 */

class ImmichCard extends NexusCard {
    start() {
        this.photoIds = [];
        this.currentIndex = 0;
        this.slideshowTimer = null;

        // Ask helper for our photos on launch
        this.fetchPhotos();
        
        // Refresh the photo list every hour
        this.refreshTimer = setInterval(() => {
            this.fetchPhotos();
        }, 3600000);
    }

    fetchPhotos() {
        this.module.sendSocketNotification("GET_IMMICH_PHOTOS");
    }

    updateState(photoIds) {
        this.photoIds = photoIds;
        this.currentIndex = 0;
        this.updateDom();
        this.startSlideshow();
    }

    startSlideshow() {
        if (this.slideshowTimer) clearInterval(this.slideshowTimer);
        if (this.photoIds.length === 0) return;

        // Change photo every 30 seconds
        this.slideshowTimer = setInterval(() => {
            this.transitionPhoto();
        }, 30000); 
    }

    transitionPhoto() {
        const imgElement = this.domElement.querySelector(".immich-photo");
        if (!imgElement || this.photoIds.length <= 1) return;

        this.currentIndex = (this.currentIndex + 1) % this.photoIds.length;
        
        // Trigger fade out
        imgElement.style.opacity = 0;

        setTimeout(() => {
            // Swap source to our secure proxy endpoint
            imgElement.src = `/nexus-immich-proxy/${this.photoIds[this.currentIndex]}`;
            
            // Fade back in when loaded
            imgElement.onload = () => {
                imgElement.style.opacity = 1;
            };
        }, 1000); // Wait 1 second for fade animation
    }

    suspend() {
        if (this.slideshowTimer) {
            clearInterval(this.slideshowTimer);
            this.slideshowTimer = null;
        }
    }

    resume() {
        this.startSlideshow();
    }

    render() {
        this.domElement.className = "nexus-card nexus-immich-card";

        if (this.photoIds.length === 0) {
            this.domElement.innerHTML = `
                <div class="immich-fallback">
                    <span class="immich-fallback-icon">🖼️</span>
                    <div>Connecting to Immich...</div>
                </div>
            `;
            return;
        }

        const initialSrc = `/nexus-immich-proxy/${this.photoIds[this.currentIndex]}`;
        this.domElement.innerHTML = `
            <div class="immich-container">
                <img class="immich-photo" src="${initialSrc}" alt="Immich Memories" />
                <div class="immich-vignette"></div>
            </div>
        `;
    }
}

if (window.MMM_NexusDashboard_CardManager) {
    window.MMM_NexusDashboard_CardManager.registerCard("ImmichCard", ImmichCard);
}
window.ImmichCard = ImmichCard;
