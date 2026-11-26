#include "radio.h"

#include <NimBLEDevice.h>
#include <WiFi.h>

#include "config.h"

static bool s_stepped = false;

// Capped at "High": +21 dBm BLE (with Wi-Fi on) browned out this board even
// on a 5 V / 2 A adapter and left Wi-Fi half-connected (2026-11-26).
static const int WIFI_DBM_MAX = 15;
static const int BLE_DBM_MAX = 15;

bool radioValidWifi(int d) { return d == 8 || d == 11 || d == 13 || d == 15; }
bool radioValidBle(int d) { return d >= 0 && d <= BLE_DBM_MAX && d % 3 == 0; }
bool radioSteppedDown() { return s_stepped; }

void radioBoot() {
  // Clamp anything saved above the cap (older firmware allowed "Max").
  if (g_cfg.wifiDbm > WIFI_DBM_MAX) { g_cfg.wifiDbm = WIFI_DBM_MAX; g_cfg.save(); }
  if (g_cfg.bleDbm > BLE_DBM_MAX) { g_cfg.bleDbm = BLE_DBM_MAX; g_cfg.save(); }
  if (!radioValidWifi(g_cfg.wifiDbm)) g_cfg.wifiDbm = WIFI_DBM_DEFAULT;
  if (!radioValidBle(g_cfg.bleDbm)) g_cfg.bleDbm = BLE_DBM_DEFAULT;
  if (esp_reset_reason() != ESP_RST_BROWNOUT) return;
  // A brownout while running above the defaults: the supply can't feed the
  // radios at this power. Step down one notch each time until stable.
  bool changed = false;
  if (g_cfg.wifiDbm > WIFI_DBM_DEFAULT) {
    g_cfg.wifiDbm = g_cfg.wifiDbm >= 17 ? 15 : WIFI_DBM_DEFAULT;
    changed = true;
  }
  if (g_cfg.bleDbm > BLE_DBM_DEFAULT) {
    g_cfg.bleDbm = max(BLE_DBM_DEFAULT, g_cfg.bleDbm - 6);
    changed = true;
  }
  if (changed) {
    s_stepped = true;
    g_cfg.save();
    Serial.print(F("# radio: brownout -> stepped down to wifi="));
    Serial.print(g_cfg.wifiDbm);
    Serial.print(F(" dBm ble="));
    Serial.print(g_cfg.bleDbm);
    Serial.println(F(" dBm"));
  }
}

void radioApplyWifi() {
  wifi_power_t p;
  switch (g_cfg.wifiDbm) {
    case 8: p = WIFI_POWER_8_5dBm; break;
    case 13: p = WIFI_POWER_13dBm; break;
    case 15: p = WIFI_POWER_15dBm; break;
    case 17: p = WIFI_POWER_17dBm; break;
    case 19: p = WIFI_POWER_19_5dBm; break;
    default: p = WIFI_POWER_11dBm; break;
  }
  if (WiFi.getMode() != WIFI_OFF) WiFi.setTxPower(p);
}

void radioApplyBle() {
  // ESP32-S3 levels: ESP_PWR_LVL_N0 (=0 dBm) + one step per 3 dB up to P21.
  int lvl = (int)ESP_PWR_LVL_N0 + g_cfg.bleDbm / 3;
  if (lvl > (int)ESP_PWR_LVL_P21) lvl = (int)ESP_PWR_LVL_P21;
  NimBLEDevice::setPower((esp_power_level_t)lvl);
}
