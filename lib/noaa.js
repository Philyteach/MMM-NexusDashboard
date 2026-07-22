const fetch = require("node-fetch");
const formatter = require("./formatter");

class NOAA {
  constructor() {
    this.headers = { "User-Agent": "(MMM-NexusWeather, contact: github-project)" };
    
    this.debugLedger = {
      points: "PENDING",       
      forecast: "PENDING",     
      hourly: "PENDING",       
      station: "UNKNOWN",      
      current: "PENDING",      
      formatter: "PENDING",    
      socket: "PENDING",       
      lastCacheTime: null      
    };
  }

  getDebugLedger() {
    if (!this.debugLedger.lastCacheTime) return { ...this.debugLedger, cacheAge: "No Cache" };
    
    const ageMs = Date.now() - this.debugLedger.lastCacheTime;
    const minutes = Math.floor(ageMs / 60000);
    const seconds = Math.floor((ageMs % 60000) / 1000);
    
    return {
      ...this.debugLedger,
      cacheAge: `${minutes}m ${seconds}s`
    };
  }

  async getWeather(lat, lon) {
    try {
      const pointsUrl = `https://api.weather.gov/points/${lat},${lon}`;
      const pointsResponse = await fetch(pointsUrl, { headers: this.headers });
      
      if (!pointsResponse.ok) {
        this.debugLedger.points = "FAILED";
        throw new Error(`Points API status error: ${pointsResponse.status}`);
      }
      
      const pointsData = await pointsResponse.json();
      this.debugLedger.points = "OK";

      const forecastUrl = pointsData.properties.forecast;
      const forecastHourlyUrl = pointsData.properties.forecastHourly;
      const observationStationsUrl = pointsData.properties.observationStations;

      const forecastZoneUrl = pointsData.properties.forecastZone;
      const countyZoneUrl = pointsData.properties.county;
      const zones = [];
      if (forecastZoneUrl) zones.push(forecastZoneUrl.split("/").pop()); 
      if (countyZoneUrl) zones.push(countyZoneUrl.split("/").pop());   
      
      const alertsUrl = zones.length 
        ? `https://api.weather.gov/alerts/active?zone=${zones.join(",")}` 
        : `https://api.weather.gov/alerts/active?point=${lat},${lon}`;

      const [forecastRes, hourlyRes, alertsRes] = await Promise.all([
        fetch(forecastUrl, { headers: this.headers }).then(r => { this.debugLedger.forecast = r.ok ? "OK" : "FAILED"; return r; }),
        fetch(forecastHourlyUrl, { headers: this.headers }).then(r => { this.debugLedger.hourly = r.ok ? "OK" : "FAILED"; return r; }),
        fetch(alertsUrl, { headers: this.headers })
      ]);

      let currentConditionsData = null;
      try {
        const stationsRes = await fetch(observationStationsUrl, { headers: this.headers });
        if (stationsRes.ok) {
          const stationsData = await stationsRes.json();
          const primaryStationUrl = stationsData.features[0]?.id;
          if (primaryStationUrl) {
            this.debugLedger.station = primaryStationUrl.split("/").pop(); 
            
            const currentRes = await fetch(`${primaryStationUrl}/observations/latest`, { headers: this.headers });
            if (currentRes.ok) {
              currentConditionsData = await currentRes.json();
              this.debugLedger.current = "OK";
            } else {
              this.debugLedger.current = "FAILED";
            }
          }
        }
      } catch (e) {
        this.debugLedger.current = "ERROR"; 
      }

      if (!forecastRes.ok || !hourlyRes.ok) {
        throw new Error("Core structural data stream ingestion interrupted.");
      }

      const forecastData = await forecastRes.json();
      const hourlyData = await hourlyRes.json();
      const alertsData = await alertsRes.json();

      try {
        const payload = this.formatWeatherData(forecastData, hourlyData, alertsData, currentConditionsData);
        this.debugLedger.formatter = "OK";
        this.debugLedger.lastCacheTime = Date.now(); 
        return payload;
      } catch (err) {
        this.debugLedger.formatter = "FAILED";
        throw err;
      }
    } catch (error) {
      console.error("[MMM-NexusWeather Debugger Engine] Exception caught:", error.message);
      throw error;
    }
  }

  formatWeatherData(forecast, hourly, alerts, currentObs) {
    const hourlyPeriods = hourly.properties.periods;
    const rawPeriods = forecast.properties.periods;
    const alertFeatures = alerts.features || [];

    let currentTemp = hourlyPeriods[0].temperature;
    let currentUnit = hourlyPeriods[0].temperatureUnit;
    let shortForecastText = hourlyPeriods[0].shortForecast;
    let currentIcon = hourlyPeriods[0].icon;

    if (currentObs && currentObs.properties) {
      const prop = currentObs.properties;
      if (prop.temperature && prop.temperature.value !== null) {
        currentTemp = Math.round((prop.temperature.value * 9) / 5 + 32); 
        currentUnit = "F";
      }
      if (prop.textDescription) shortForecastText = prop.textDescription; 
      if (prop.icon) currentIcon = prop.icon;                             
    }

    return {
      current: {
        temperature: currentTemp,
        temperatureUnit: currentUnit,
        shortForecast: shortForecastText,
        icon: currentIcon,
        windSpeed: hourlyPeriods[0].windSpeed,
        windDirection: hourlyPeriods[0].windDirection
      },
      forecast: formatter.formatDaily(rawPeriods),       
      activeAlert: formatter.processAlerts(alertFeatures) 
    };
  }
}

module.exports = new NOAA();
