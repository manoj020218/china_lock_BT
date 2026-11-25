#include "led.h"

#include <Arduino.h>
#include <WiFi.h>

#include "ble_lock.h"
#include "cloud.h"

#ifndef RGB_LED_PIN
#define RGB_LED_PIN 48  // onboard WS2812 on most ESP32-S3-WROOM dev boards
#endif

static int s_kind = LED_NONE;
static uint32_t s_eventStart = 0;
static uint32_t s_eventLen = 0;

static uint8_t s_r = 1, s_g = 1, s_b = 1;  // force first write

static inline void setColor(uint8_t r, uint8_t g, uint8_t b) {
  if (r == s_r && g == s_g && b == s_b) return;  // only drive on change
  s_r = r; s_g = g; s_b = b;
  neopixelWrite(RGB_LED_PIN, r, g, b);
}

void ledSetup() { setColor(0, 0, 0); }

void ledEvent(int kind) {
  s_kind = kind;
  s_eventStart = millis();
  s_eventLen = (kind == LED_UNLOCK) ? 700 : (kind == LED_LOCK) ? 350
               : (kind == LED_ERROR) ? 700 : 250;
}

// Returns true and renders if a transient command flash is active.
static bool renderEvent(uint32_t now) {
  if (s_kind == LED_NONE) return false;
  uint32_t t = now - s_eventStart;
  if (t >= s_eventLen) { s_kind = LED_NONE; return false; }
  switch (s_kind) {
    case LED_UNLOCK: {  // double bright-green flash
      bool on = (t < 150) || (t >= 300 && t < 450);
      setColor(0, on ? 160 : 0, 0);
      return true;
    }
    case LED_LOCK: {    // single amber flash
      setColor(t < 250 ? 160 : 0, t < 250 ? 70 : 0, 0);
      return true;
    }
    case LED_OK: {      // single white blip
      setColor(t < 150 ? 120 : 0, t < 150 ? 120 : 0, t < 150 ? 120 : 0);
      return true;
    }
    case LED_ERROR: {   // triple red flash
      bool on = ((t / 110) % 2) == 0;
      setColor(on ? 170 : 0, 0, 0);
      return true;
    }
  }
  return false;
}

void ledTick() {
  uint32_t now = millis();
  if (renderEvent(now)) return;

  bool apMode = (WiFi.getMode() == WIFI_AP);
  bool wifi = WiFi.isConnected();
  bool cloud = cloudConnected();
  bool slow = ((now / 700) % 2) == 0;  // ~0.7s blink phase

  if (apMode) {                 // needs setup: purple blink
    setColor(slow ? 60 : 0, 0, slow ? 60 : 0);
  } else if (!wifi) {           // wifi fault: red blink
    setColor(slow ? 70 : 0, 0, 0);
  } else if (cloud) {           // fully online: green steady (dim)
    setColor(0, 40, 0);
  } else {                      // LAN online: blue steady (dim)
    setColor(0, 0, 50);
  }
}
