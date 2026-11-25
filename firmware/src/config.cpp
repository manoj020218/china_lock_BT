#include "config.h"

#include <Preferences.h>

LockConfigStore g_cfg;

static const char* NS = "jenixlock";

void LockConfigStore::load() {
  Preferences p;
  p.begin(NS, true);
  wifiSsid = p.getString("ssid", "");
  wifiPass = p.getString("wpass", "");
  lockId = p.getString("lid", "");
  lockPassword = p.getString("lpw", "");
  apiToken = p.getString("token", "");
  tzMinutes = p.getInt("tz", 0);
  p.end();
  if (apiToken.length() == 0) {
    // Generate a random default token on first boot so the API is never open.
    uint32_t a = esp_random(), b = esp_random();
    apiToken = String(a, HEX) + String(b, HEX);
    save();
  }
}

void LockConfigStore::save() {
  Preferences p;
  p.begin(NS, false);
  p.putString("ssid", wifiSsid);
  p.putString("wpass", wifiPass);
  p.putString("lid", lockId);
  p.putString("lpw", lockPassword);
  p.putString("token", apiToken);
  p.putInt("tz", tzMinutes);
  p.end();
}
