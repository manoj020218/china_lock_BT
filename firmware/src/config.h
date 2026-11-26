// Persistent configuration in NVS (Preferences). No secrets are compiled in.
// Supports multiple bound locks on one gateway.
#pragma once

#include <Arduino.h>
#include <vector>

struct LockEntry {
  String id;
  String password;
  int tzMinutes = 0;
  // Gateway auto close: re-lock this many seconds after an app/cloud unlock
  // (0 = off). Works without a door magnet; set via /api/settings/app-autoclose.
  int autoCloseSec = 0;
};

struct LockConfigStore {
  String wifiSsid;
  String wifiPass;
  String apiToken;              // bearer token for the REST API
  int wifiDbm = 11;             // Wi-Fi TX power (see radio.h)
  int bleDbm = 9;               // BLE TX power
  std::vector<LockEntry> locks;

  // Optional cloud (MQTT) link. The broker/cloud is the client's; the gateway
  // only needs where to connect and how to identify itself.
  bool cloudEnabled = false;
  String cloudHost;
  int cloudPort = 1883;
  String cloudClientId;
  String cloudUser;
  String cloudPass;

  void load();
  void save();

  bool wifiConfigured() const { return wifiSsid.length() > 0; }

  LockEntry* find(const String& id);      // nullptr if not bound
  void upsert(const LockEntry& e);        // add or update by id
  bool remove(const String& id);          // true if removed
  LockEntry* only();                      // the single lock if exactly one, else nullptr
};

extern LockConfigStore g_cfg;
