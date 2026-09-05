// LightningNode.ino
// ESP32 (plain ESP-WROOM-32) + AS3935 lightning sensor node
// Reads strikes over SPI, publishes events to MQTT for MMM-NexusDashboard to consume.
//
// Wiring (VSPI default pins):
//   AS3935 VCC  -> 3.3V
//   AS3935 GND  -> GND
//   AS3935 SI   -> GND   (forces SPI mode)
//   AS3935 CS   -> GPIO5
//   AS3935 MOSI -> GPIO23
//   AS3935 MISO -> GPIO19
//   AS3935 SCL  -> GPIO18   (functions as SCLK in SPI mode)
//   AS3935 IRQ  -> GPIO4    (any free GPIO; avoid strapping pins 0/2/12/15)
//
// Libraries needed (Arduino Library Manager):
//   - PubSubClient (Nick O'Leary)
//   - RPi_AS3935-style AS3935 lib -> use "SparkFun AS3935 Lightning Detector" (works fine on ESP32 SPI)
//
// Copy secrets.h.example -> secrets.h and fill in real values (gitignored, matches NexusRemote.ino convention)

#include <SPI.h>
#include <WiFi.h>
#include <PubSubClient.h>
#include <SparkFun_AS3935.h>
#include "secrets.h"   // defines WIFI_SSID, WIFI_PASSWORD, MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASSWORD, NODE_NAME

// These aren't defined in the library header itself - only in its example
// sketches - so we define them here to match what readInterruptReg() returns.
#define LIGHTNING_INT   0x08
#define DISTURBER_INT   0x04
#define NOISE_INT       0x01

// ---- Pin config ----
#define AS3935_CS_PIN   5
#define AS3935_IRQ_PIN  4
#define INDOORS         false   // attic install -> outdoor profile is closer to reality than "indoors"

// ---- MQTT topics ----
// e.g. NODE_NAME = "attic" or "school-office"
String topicEvent  = String("nexus/lightning/") + NODE_NAME + "/event";
String topicStatus = String("nexus/lightning/") + NODE_NAME + "/status";

SparkFun_AS3935 lightning;
WiFiClient espClient;
PubSubClient mqtt(espClient);

volatile bool irqTriggered = false;

void IRAM_ATTR handleIrq() {
  irqTriggered = true;
}

void connectWiFi() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" connected, IP: " + WiFi.localIP().toString());
}

void connectMQTT() {
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  while (!mqtt.connected()) {
    Serial.print("Connecting to MQTT...");
    String clientId = String("lightning-") + NODE_NAME;
    // Last Will: if this node drops off unexpectedly, broker marks it offline
    if (mqtt.connect(clientId.c_str(), MQTT_USER, MQTT_PASSWORD,
                      topicStatus.c_str(), 1, true, "offline")) {
      Serial.println(" connected");
      mqtt.publish(topicStatus.c_str(), "online", true);
    } else {
      Serial.print(" failed, rc="); Serial.println(mqtt.state());
      delay(2000);
    }
  }
}

void publishEvent(const char* type, int distanceKm = -1, long energy = -1) {
  // Small hand-built JSON to avoid pulling in ArduinoJson for 2-3 fields
  String payload = String("{\"type\":\"") + type + "\"";
  payload += String(",\"node\":\"") + NODE_NAME + "\"";
  if (distanceKm >= 0) payload += ",\"distance_km\":" + String(distanceKm);
  if (energy >= 0)     payload += ",\"energy\":" + String(energy);
  payload += ",\"millis\":" + String(millis());
  payload += "}";

  mqtt.publish(topicEvent.c_str(), payload.c_str());
  Serial.println("Published: " + payload);
}

void setup() {
  Serial.begin(115200);
  delay(500);

  pinMode(AS3935_IRQ_PIN, INPUT);
  attachInterrupt(digitalPinToInterrupt(AS3935_IRQ_PIN), handleIrq, RISING);

  SPI.begin();
  if (!lightning.beginSPI(AS3935_CS_PIN)) {
    Serial.println("AS3935 not found - check wiring");
    while (1) delay(1000);
  }
  Serial.println("AS3935 found");

  lightning.setIndoorOutdoor(INDOORS ? INDOOR : OUTDOOR);

  // Auto-tune the antenna capacitor. Watches internal oscillator on IRQ pin briefly.
  // Run once here; re-run manually later if readings seem consistently off.
  Serial.println("Calibrating antenna tuning...");
  lightning.calibrateOsc();

  connectWiFi();
  connectMQTT();
}

void loop() {
  if (!mqtt.connected()) {
    connectMQTT();
  }
  mqtt.loop();

  if (irqTriggered) {
    irqTriggered = false;
    delay(3);  // datasheet: brief settle time before reading interrupt register

    int intVal = lightning.readInterruptReg();

    if (intVal == NOISE_INT) {
      publishEvent("noise");
    } else if (intVal == DISTURBER_INT) {
      publishEvent("disturber");
    } else if (intVal == LIGHTNING_INT) {
      int distance = lightning.distanceToStorm();
      long energy = lightning.lightningEnergy();
      publishEvent("lightning", distance, energy);
    }
  }

  // Periodic heartbeat so the Pi side can detect a silently-dead node
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat > 60000) {
    lastHeartbeat = millis();
    mqtt.publish(topicStatus.c_str(), "online", true);
  }
}
