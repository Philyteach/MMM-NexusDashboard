class WeatherCache {
  constructor(ttlInMinutes = 15) {
    this.ttl = ttlInMinutes * 60 * 1000;
    this.cache = null;
    this.lastFetch = null;
  }

  get() {
    if (!this.cache || !this.lastFetch) return null;
    const now = Date.now();
    if (now - this.lastFetch > this.ttl) {
      return null; // Cache expired
    }
    return this.cache;
  }

  set(data) {
    this.cache = data;
    this.lastFetch = Date.now();
  }

  clear() {
    this.cache = null;
    this.lastFetch = null;
  }
}

module.exports = WeatherCache;
