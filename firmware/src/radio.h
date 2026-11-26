// Adjustable radio transmit power (Wi-Fi and BLE), stored in NVS.
//
// Defaults are conservative (Wi-Fi 11 dBm, BLE +9 dBm) because full power
// browned out the board on a weak USB supply. With a solid 5 V / 2 A adapter
// they can be raised. If the gateway ever resets from a brownout while above
// the defaults, radioBoot() steps the power back down automatically.
#pragma once

#include <Arduino.h>

static const int WIFI_DBM_DEFAULT = 11;
static const int BLE_DBM_DEFAULT = 9;

bool radioValidWifi(int dbm);   // 8, 11, 13, 15 (capped at High)
bool radioValidBle(int dbm);    // 0, 3, 6, 9, 12, 15 (capped at High)

void radioBoot();               // after config load: brownout step-down
void radioApplyWifi();          // apply g_cfg.wifiDbm to the Wi-Fi driver
void radioApplyBle();           // apply g_cfg.bleDbm to NimBLE
bool radioSteppedDown();        // true if this boot reduced power after a brownout
