class WeatherFormatter {
  formatDaily(periods) {
    const dailyForecasts = [];
    const dayMap = new Map();

    periods.forEach(period => {
      let dayName = period.name;
      
      if (dayName.toLowerCase().includes("night")) {
        dayName = dayName.replace(/ night/i, "");
      }
      if (dayName.toLowerCase() === "tonight" || dayName.toLowerCase() === "this afternoon") {
        dayName = "Today";
      }

      if (!dayMap.has(dayName)) {
        dayMap.set(dayName, {
          day: dayName,
          high: null,
          low: null,
          icon: null,
          shortForecast: null
        });
      }

      const dayData = dayMap.get(dayName);

      if (period.isDaytime) {
        dayData.high = period.temperature;
        dayData.icon = period.icon; 
        dayData.shortForecast = period.shortForecast; 
      } else {
        dayData.low = period.temperature;
        if (!dayData.icon) dayData.icon = period.icon;
        if (!dayData.shortForecast) dayData.shortForecast = period.shortForecast;
      }
    });

    dayMap.forEach((value) => {
      if (value.high === null && value.low !== null) value.high = value.low;
      if (value.low === null && value.high !== null) value.low = value.high;
      dailyForecasts.push(value);
    });

    return dailyForecasts;
  }

  processAlerts(rawAlerts) {
    if (!rawAlerts || rawAlerts.length === 0) {
      console.log("[MMM-NexusWeather Formatter] No raw alerts found in payload.");
      return null;
    }

    let highestAlert = null;

    for (const alert of rawAlerts) {
      const props = alert.properties || {};
      const eventName = props.event || "";
      
      console.log(`[MMM-NexusWeather Formatter] Found active event: "${eventName}"`);
      
      const isWarning = eventName.toLowerCase().includes("warning") || eventName.toLowerCase().includes("flood");
      const isWatch = eventName.toLowerCase().includes("watch") || eventName.toLowerCase().includes("advisory");

      if (isWarning || isWatch) {
        const parsed = {
          title: eventName,
          type: isWarning ? "WARNING" : "WATCH",
          description: props.description || "",
          instruction: props.instruction || "Take necessary precautions."
        };

        if (isWarning) {
          highestAlert = parsed;
          break; 
        } else if (!highestAlert) {
          highestAlert = parsed;
        }
      }
    }

    return highestAlert;
  }
}

module.exports = new WeatherFormatter();
