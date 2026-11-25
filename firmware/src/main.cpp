// Jenix lock bridge — Phase 5: Wi-Fi LAN REST API over a ported BLE lock stack.
//
// The ESP32-S3 connects to the lock over BLE (NimBLE), speaks the validated
// lock protocol itself (lock_protocol / ble_lock), and exposes an authenticated
// REST API over Wi-Fi (rest_api). A serial console configures Wi-Fi and the
// bound lock, and can exercise lock operations directly for testing without
// Wi-Fi. No secrets are compiled in; all config lives in NVS.

#include <Arduino.h>
#include <WiFi.h>

#include "ble_lock.h"
#include "config.h"
#include "rest_api.h"

static String g_line;

static void printHelp() {
  Serial.println(F("# commands:"));
  Serial.println(F("#   STATUS                 - wifi + lock config + connection"));
  Serial.println(F("#   TOKEN                  - print the REST API bearer token"));
  Serial.println(F("#   SETWIFI <ssid> <pass>  - save wifi creds and reconnect"));
  Serial.println(F("#   WIFI                   - reconnect wifi, print IP"));
  Serial.println(F("#   BIND <lockid> <pw> [tz]- bind the lock (password, tz minutes)"));
  Serial.println(F("#   CONNECT                - connect + login to the bound lock"));
  Serial.println(F("#   DISCONNECT             - drop the BLE connection"));
  Serial.println(F("#   VERSION|BATTERY|GETTIME- read operations"));
  Serial.println(F("#   UNLOCK <user> <pin>    - unlock (write)"));
  Serial.println(F("#   LOCK <user> <pin>      - lock (write)"));
  Serial.println(F("#   REBOOT                 - reboot the lock (write)"));
}

static void startWifi() {
  if (g_cfg.wifiConfigured()) {
    WiFi.mode(WIFI_STA);
    WiFi.begin(g_cfg.wifiSsid.c_str(), g_cfg.wifiPass.c_str());
    Serial.print(F("# wifi: connecting to "));
    Serial.println(g_cfg.wifiSsid);
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 12000) delay(200);
    if (WiFi.isConnected()) {
      Serial.print(F("# wifi: connected, IP "));
      Serial.println(WiFi.localIP());
      return;
    }
    Serial.println(F("# wifi: station failed, starting SoftAP"));
  }
  WiFi.mode(WIFI_AP);
  uint64_t mac = ESP.getEfuseMac();
  char ap[32];
  snprintf(ap, sizeof(ap), "JenixLock-%04X", (uint16_t)(mac & 0xFFFF));
  WiFi.softAP(ap);
  Serial.print(F("# wifi: SoftAP "));
  Serial.print(ap);
  Serial.print(F(" IP "));
  Serial.println(WiFi.softAPIP());
}

static bool ensure() {
  if (!g_cfg.lockConfigured()) { Serial.println(F("# ERR lock not bound")); return false; }
  if (!g_lock.isConnected() && !g_lock.connectTo(g_cfg.lockId)) {
    Serial.println(F("# ERR lock not found (awake?)"));
    return false;
  }
  if (!g_lock.authenticated()) {
    int e = 0;
    if (!g_lock.login(g_cfg.lockPassword, g_cfg.lockId, e)) {
      Serial.print(F("# ERR login error "));
      Serial.println(e);
      return false;
    }
  }
  return true;
}

static void handleLine(String line) {
  line.trim();
  if (!line.length()) return;
  int s1 = line.indexOf(' ');
  String cmd = s1 < 0 ? line : line.substring(0, s1);
  String rest = s1 < 0 ? "" : line.substring(s1 + 1);
  cmd.toUpperCase();

  if (cmd == "HELP") { printHelp(); return; }
  if (cmd == "STATUS") {
    Serial.print(F("# wifi="));
    Serial.print(WiFi.isConnected() ? WiFi.localIP().toString() : WiFi.softAPIP().toString());
    Serial.print(F(" lock_bound="));
    Serial.print(g_cfg.lockConfigured());
    Serial.print(F(" connected="));
    Serial.println(g_lock.isConnected());
    return;
  }
  if (cmd == "TOKEN") { Serial.print(F("# token=")); Serial.println(g_cfg.apiToken); return; }
  if (cmd == "SETWIFI") {
    int sp = rest.indexOf(' ');
    if (sp < 0) { Serial.println(F("# ERR usage: SETWIFI <ssid> <pass>")); return; }
    g_cfg.wifiSsid = rest.substring(0, sp);
    g_cfg.wifiPass = rest.substring(sp + 1);
    g_cfg.save();
    startWifi();
    return;
  }
  if (cmd == "WIFI") { startWifi(); return; }
  if (cmd == "BIND") {
    int sp = rest.indexOf(' ');
    if (sp < 0) { Serial.println(F("# ERR usage: BIND <lockid> <pw> [tz]")); return; }
    g_cfg.lockId = rest.substring(0, sp);
    String tail = rest.substring(sp + 1);
    int sp2 = tail.indexOf(' ');
    if (sp2 < 0) {
      g_cfg.lockPassword = tail;
    } else {
      g_cfg.lockPassword = tail.substring(0, sp2);
      g_cfg.tzMinutes = tail.substring(sp2 + 1).toInt();
    }
    g_cfg.save();
    Serial.println(F("# OK bound"));
    return;
  }
  if (cmd == "CONNECT") { Serial.println(ensure() ? F("# OK") : F("# FAIL")); return; }
  if (cmd == "DISCONNECT") { g_lock.disconnect(); Serial.println(F("# OK")); return; }
  if (cmd == "VERSION") {
    if (!ensure()) return;
    VersionInfo v;
    if (g_lock.getVersion(v)) {
      Serial.print(F("# version=")); Serial.print(v.firmware);
      Serial.print(F(" cmdver=")); Serial.println(v.commandVersion);
    } else Serial.println(F("# ERR"));
    return;
  }
  if (cmd == "BATTERY") {
    if (!ensure()) return;
    int pct; float v;
    if (g_lock.getBattery(pct, v)) {
      Serial.print(F("# battery=")); Serial.print(pct);
      Serial.print(F("% ")); Serial.print(v); Serial.println(F("V"));
    } else Serial.println(F("# ERR"));
    return;
  }
  if (cmd == "GETTIME") {
    if (!ensure()) return;
    struct tm t;
    if (g_lock.getTime(t)) {
      char buf[32]; strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &t);
      Serial.print(F("# time=")); Serial.println(buf);
    } else Serial.println(F("# ERR"));
    return;
  }
  if (cmd == "UNLOCK" || cmd == "LOCK") {
    if (!ensure()) return;
    int sp = rest.indexOf(' ');
    uint32_t user = (sp < 0 ? rest : rest.substring(0, sp)).toInt();
    String pin = sp < 0 ? "" : rest.substring(sp + 1);
    bool ok = (cmd == "UNLOCK") ? g_lock.unlock(user, pin) : g_lock.lockDoor(user, pin);
    Serial.println(ok ? F("# OK") : F("# ERR"));
    return;
  }
  if (cmd == "REBOOT") {
    if (!ensure()) return;
    Serial.println(g_lock.reboot() ? F("# OK") : F("# ERR"));
    return;
  }
  Serial.println(F("# ERR unknown command (HELP)"));
}

void setup() {
  Serial.begin(SERIAL_BRIDGE_BAUD);
  delay(200);
  g_cfg.load();
  g_lock.begin();
  startWifi();
  setupRestApi();
  Serial.println(F("# jenix-bridge Phase 5 (REST) ready"));
  Serial.print(F("# API token: ")); Serial.println(g_cfg.apiToken);
  Serial.println(F("READY"));
}

void loop() {
  handleRestApi();
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (g_line.length()) { handleLine(g_line); g_line = ""; }
    } else {
      g_line += c;
      if (g_line.length() > 300) g_line = "";
    }
  }
  delay(2);
}
