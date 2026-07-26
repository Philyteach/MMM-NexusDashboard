/**
 * NexusRemote.ino
 *
 * Turns a "Cheap Yellow Display" (ESP32-2432S028R, resistive touch) into a
 * 4-button physical remote for MMM-NexusDashboard's workspace switcher.
 * Each box POSTs to MMM-Remote-Control's REST API, firing the exact same
 * NEXUS_SWITCH_WORKSPACE notification your custom_menu.json already uses.
 *
 * Hardware: ESP32-2432S028R ("CYD"), 320x240 ILI9341 + XPT2046 resistive touch
 * Libraries needed (Library Manager):
 *   - TFT_eSPI (Bodmer)          -- requires the User_Setup.h in this folder
 *   - XPT2046_Touchscreen (Paul Stoffregen)
 */

#include <SPI.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>
#include <WiFi.h>
#include <HTTPClient.h>
// ---------------- WiFi & MagicMirror settings ----------------
// See secrets.h.example - copy to secrets.h and fill in your real values.
#include "secrets.h"
// ---------------- Touch controller pins (separate SPI bus from display) ---
#define XPT2046_IRQ  36
#define XPT2046_MOSI 32
#define XPT2046_MISO 39
#define XPT2046_CLK  25
#define XPT2046_CS   33

SPIClass touchSPI(HSPI);
XPT2046_Touchscreen touch(XPT2046_CS, XPT2046_IRQ);
TFT_eSPI tft = TFT_eSPI();

// ---------------- Touch calibration (raw ADC values) ----------------
// These are typical starting values for this board, but resistive
// digitizers vary panel to panel. If your taps land on the wrong box
// (or nothing happens), open the Serial Monitor at 115200 baud -- the
// loop() below prints raw touch.getPoint() x/y every time you tap.
// Tap each corner of the screen, note the raw numbers, and adjust these
// four constants to match.
const int TOUCH_X_MIN = 200;
const int TOUCH_X_MAX = 3700;
const int TOUCH_Y_MIN = 240;
const int TOUCH_Y_MAX = 3800;

// ---------------- Screen layout: 2x2 grid of workspace buttons ----------
struct WorkspaceButton {
  const char* label;      // shown on screen
  const char* workspace;  // must match custom_menu.json's payload.workspace exactly
  uint16_t color;
  int x, y, w, h;
};

// 320x240 screen, 2x2 grid with a small gap between boxes
WorkspaceButton buttons[4] = {
  { "Home",     "Home",     TFT_BLUE,      0,   0, 160, 120 },
  { "Weather",  "Forecast", TFT_ORANGE,  160,   0, 160, 120 },
  { "Calendar", "Calendar", TFT_DARKGREEN, 0, 120, 160, 120 },
  { "Travel",   "Travel",   TFT_PURPLE,  160, 120, 160, 120 }
};

unsigned long lastTouchTime = 0;
const unsigned long DEBOUNCE_MS = 500;   // ignore repeat taps within this window
bool waitingForRelease = false;          // require lift-off before re-triggering

void drawButtons() {
  tft.fillScreen(TFT_BLACK);
  for (int i = 0; i < 4; i++) {
    WorkspaceButton &b = buttons[i];
    tft.fillRoundRect(b.x + 4, b.y + 4, b.w - 8, b.h - 8, 10, b.color);
    tft.drawRoundRect(b.x + 4, b.y + 4, b.w - 8, b.h - 8, 10, TFT_WHITE);
    tft.setTextColor(TFT_WHITE, b.color);
    tft.setTextDatum(MC_DATUM);
    tft.setTextSize(2);
    tft.drawString(b.label, b.x + b.w / 2, b.y + b.h / 2);
  }
}

// Brief white double-outline flash so a tap gives visible feedback
// immediately, even before the HTTP round-trip finishes.
void flashButton(int i) {
  WorkspaceButton &b = buttons[i];
  tft.drawRoundRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4, 12, TFT_WHITE);
  tft.drawRoundRect(b.x + 3, b.y + 3, b.w - 6, b.h - 6, 11, TFT_WHITE);
  delay(120);
  drawButtons();
}

void sendWorkspaceSwitch(const char* workspace) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[Nexus Remote] WiFi not connected, skipping request.");
    return;
  }

  HTTPClient http;
  String url = String("http://") + MM_HOST + ":" + String(MM_PORT) +
               "/api/notification/NEXUS_SWITCH_WORKSPACE";

  http.begin(url);
  http.addHeader("Content-Type", "application/json");

  // Mirrors custom_menu.json's payload shape exactly:
  // { "notification": "NEXUS_SWITCH_WORKSPACE", "payload": { "workspace": "Home" } }
  String body = String("{\"workspace\":\"") + workspace + "\"}";
  int code = http.POST(body);

  Serial.printf("[Nexus Remote] POST %s -> %d\n", url.c_str(), code);
  if (code > 0) {
    Serial.println(http.getString());
  } else {
    Serial.printf("[Nexus Remote] HTTP error: %s\n", http.errorToString(code).c_str());
  }
  http.end();
}

void setup() {
  Serial.begin(115200);

  // CYD backlight is on GPIO 21, active high
  pinMode(21, OUTPUT);
  digitalWrite(21, HIGH);

  tft.init();
  tft.setRotation(1);   // landscape; try 3 if the screen looks upside down
  drawButtons();

  touchSPI.begin(XPT2046_CLK, XPT2046_MISO, XPT2046_MOSI, XPT2046_CS);
  touch.begin(touchSPI);
  touch.setRotation(1); // keep in sync with tft.setRotation() above

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("[Nexus Remote] Connecting to WiFi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.println();
  Serial.print("[Nexus Remote] Connected, IP: ");
  Serial.println(WiFi.localIP());
}

void loop() {
  if (touch.touched()) {
    TS_Point p = touch.getPoint();
    // Uncomment while calibrating:
    // Serial.printf("raw x=%d y=%d\n", p.x, p.y);

    if (!waitingForRelease && millis() - lastTouchTime > DEBOUNCE_MS) {
      int sx = map(p.x, TOUCH_X_MIN, TOUCH_X_MAX, 0, 320);
      int sy = map(p.y, TOUCH_Y_MIN, TOUCH_Y_MAX, 0, 240);
      sx = constrain(sx, 0, 319);
      sy = constrain(sy, 0, 239);

      for (int i = 0; i < 4; i++) {
        WorkspaceButton &b = buttons[i];
        if (sx >= b.x && sx <= b.x + b.w && sy >= b.y && sy <= b.y + b.h) {
          Serial.printf("[Nexus Remote] Tapped: %s\n", b.label);
          flashButton(i);
          sendWorkspaceSwitch(b.workspace);
          lastTouchTime = millis();
          break;
        }
      }
    }
    waitingForRelease = true;
  } else {
    waitingForRelease = false;
  }
}
