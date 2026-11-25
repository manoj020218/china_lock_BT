// Persistent configuration in NVS (Preferences). No secrets are compiled in.
#pragma once

#include <Arduino.h>

struct LockConfigStore {
  String wifiSsid;
  String wifiPass;
  String lockId;
  String lockPassword;
  String apiToken;      // bearer token for the REST API
  int tzMinutes = 0;    // timezone offset for set-time

  void load();
  void save();
  bool wifiConfigured() const { return wifiSsid.length() > 0; }
  bool lockConfigured() const { return lockId.length() > 0 && lockPassword.length() > 0; }
};

extern LockConfigStore g_cfg;
