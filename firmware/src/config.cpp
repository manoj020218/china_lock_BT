#include "config.h"

#include <ArduinoJson.h>
#include <Preferences.h>

LockConfigStore g_cfg;

static const char* NS = "jenixlock";

void LockConfigStore::load() {
  Preferences p;
  p.begin(NS, true);
  wifiSsid = p.getString("ssid", "");
  wifiPass = p.getString("wpass", "");
  apiToken = p.getString("token", "");
  String locksJson = p.getString("locks", "[]");
  cloudEnabled = p.getBool("cen", false);
  cloudHost = p.getString("chost", "");
  cloudPort = p.getInt("cport", 1883);
  cloudClientId = p.getString("ccid", "");
  cloudUser = p.getString("cuser", "");
  cloudPass = p.getString("cpass", "");
  p.end();

  locks.clear();
  JsonDocument doc;
  if (deserializeJson(doc, locksJson) == DeserializationError::Ok) {
    for (JsonObject o : doc.as<JsonArray>()) {
      LockEntry e;
      e.id = String((const char*)(o["id"] | ""));
      e.password = String((const char*)(o["pw"] | ""));
      e.tzMinutes = o["tz"] | 0;
      if (e.id.length()) locks.push_back(e);
    }
  }

  if (apiToken.length() == 0) {
    uint32_t a = esp_random(), b = esp_random();
    apiToken = String(a, HEX) + String(b, HEX);
    save();
  }
}

void LockConfigStore::save() {
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  for (auto& e : locks) {
    JsonObject o = arr.add<JsonObject>();
    o["id"] = e.id;
    o["pw"] = e.password;
    o["tz"] = e.tzMinutes;
  }
  String locksJson;
  serializeJson(doc, locksJson);

  Preferences p;
  p.begin(NS, false);
  p.putString("ssid", wifiSsid);
  p.putString("wpass", wifiPass);
  p.putString("token", apiToken);
  p.putString("locks", locksJson);
  p.putBool("cen", cloudEnabled);
  p.putString("chost", cloudHost);
  p.putInt("cport", cloudPort);
  p.putString("ccid", cloudClientId);
  p.putString("cuser", cloudUser);
  p.putString("cpass", cloudPass);
  p.end();
}

LockEntry* LockConfigStore::find(const String& id) {
  for (auto& e : locks) if (e.id.equalsIgnoreCase(id)) return &e;
  return nullptr;
}

void LockConfigStore::upsert(const LockEntry& e) {
  LockEntry* existing = find(e.id);
  if (existing) {
    existing->password = e.password;
    existing->tzMinutes = e.tzMinutes;
  } else {
    locks.push_back(e);
  }
  save();
}

bool LockConfigStore::remove(const String& id) {
  for (size_t i = 0; i < locks.size(); i++) {
    if (locks[i].id.equalsIgnoreCase(id)) {
      locks.erase(locks.begin() + i);
      save();
      return true;
    }
  }
  return false;
}

LockEntry* LockConfigStore::only() {
  return locks.size() == 1 ? &locks[0] : nullptr;
}
