// Jenix lock gateway — Phase 5: multi-lock Wi-Fi LAN REST API over BLE.
//
// The ESP32-S3 is a gateway for one or more BLE locks: it stores bound locks in
// NVS, scans for nearby locks, connects on demand (checking RSSI reachability),
// speaks the validated lock protocol itself, syncs the lock clock from NTP
// (the locks have no RTC), and exposes an authenticated REST API over Wi-Fi.
// A serial console configures Wi-Fi/locks and can exercise operations.

#include <Arduino.h>
#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <Preferences.h>
#include <WiFi.h>
#include <time.h>

#include "ble_lock.h"
#include "cloud.h"
#include "config.h"
#include "led.h"
#include "rest_api.h"

// 24x7 reliability: a dedicated software-watchdog task reboots the gateway if
// the main loop ever stalls (>WDT_TIMEOUT_MS); Wi-Fi auto-reconnects; a heap
// guard restarts before memory runs out. All persistent state is in NVS, so any
// reset recovers cleanly in seconds. (The brownout detector is left enabled so
// a power dip safely resets and recovers rather than running the chip unsafely;
// a stable 5V supply is the hardware requirement.)
static const uint32_t WDT_TIMEOUT_MS = 60000;
static const uint32_t MIN_FREE_HEAP = 15000;
static volatile uint32_t g_loopBeat = 0;

static void watchdogTask(void*) {
  for (;;) {
    if (g_loopBeat != 0 && (millis() - g_loopBeat) > WDT_TIMEOUT_MS) {
      ets_printf("# watchdog: loop stalled, restarting\n");
      esp_restart();
    }
    vTaskDelay(pdMS_TO_TICKS(5000));
  }
}

// OTA (ArduinoOTA / httpUpdate) writes only the app partition; NVS — which
// holds Wi-Fi, the API token, bound locks and cloud config — is a separate
// partition and is preserved across firmware updates. The partition table
// (default_16MB.csv) is kept stable across versions to guarantee this.

volatile bool g_wifiReconnect = false;
static String g_line;

void startWifi() {
  if (g_cfg.wifiConfigured()) {
    WiFi.mode(WIFI_STA);
    // Cap TX power to curb peak current (prevents brownout on marginal USB
    // supplies). 11 dBm is ample for a LAN gateway.
    WiFi.setTxPower(WIFI_POWER_11dBm);
    WiFi.begin(g_cfg.wifiSsid.c_str(), g_cfg.wifiPass.c_str());
    Serial.print(F("# wifi: connecting to "));
    Serial.println(g_cfg.wifiSsid);
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 12000) delay(200);
    if (WiFi.isConnected()) {
      Serial.print(F("# wifi: connected, IP "));
      Serial.println(WiFi.localIP());
      configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC; per-lock tz applied later
      if (MDNS.begin("jenixlock")) {
        MDNS.addService("http", "tcp", 80);
        Serial.println(F("# mdns: http://jenixlock.local"));
      }
      // LAN OTA (espota), authenticated with the API token.
      ArduinoOTA.setHostname("jenixlock");
      ArduinoOTA.setPassword(g_cfg.apiToken.c_str());
      ArduinoOTA.onStart([]() { Serial.println(F("# OTA start")); });
      ArduinoOTA.onEnd([]() { Serial.println(F("# OTA done")); });
      ArduinoOTA.begin();
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

static void printHelp() {
  Serial.println(F("# STATUS | TOKEN | SETWIFI <ssid> <pass> | WIFI | MINRSSI <dbm>"));
  Serial.println(F("# LOCKS | SCAN | BIND <lockid> <pw> [tz] | UNBIND <lockid>"));
  Serial.println(F("# CONNECT | DISCONNECT | VERSION | BATTERY | GETTIME"));
  Serial.println(F("# UNLOCK <user> <pin> | LOCK <user> <pin> | REBOOT"));
}

static LockEntry* ensureSerial() {
  LockEntry* e = g_cfg.only();
  if (!e) {
    if (g_cfg.locks.empty()) { Serial.println(F("# ERR no lock bound")); return nullptr; }
    e = &g_cfg.locks[0];
  }
  if (!g_lock.isConnected()) {
    int st = g_lock.connectTo(e->id);
    if (st == BleLock::CONN_WEAK) {
      Serial.print(F("# ERR not reachable: weak signal rssi="));
      Serial.println(g_lock.lastRssi());
      return nullptr;
    }
    if (st != BleLock::CONN_OK) { Serial.println(F("# ERR not reachable")); return nullptr; }
  }
  if (!g_lock.authenticated()) {
    int ec = 0;
    if (!g_lock.login(e->password, e->id, ec)) {
      Serial.print(F("# ERR login ")); Serial.println(ec); return nullptr;
    }
  }
  return e;
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
    Serial.print(F(" locks=")); Serial.print(g_cfg.locks.size());
    Serial.print(F(" connected=")); Serial.print(g_lock.isConnected());
    Serial.print(F(" minrssi=")); Serial.println(g_lock.minRssi());
    return;
  }
  if (cmd == "TOKEN") { Serial.print(F("# token=")); Serial.println(g_cfg.apiToken); return; }
  if (cmd == "MINRSSI") { g_lock.setMinRssi(rest.toInt()); Serial.println(F("# OK")); return; }
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
  if (cmd == "LOCKS") {
    for (auto& e : g_cfg.locks) { Serial.print(F("# lock ")); Serial.println(e.id); }
    Serial.print(F("# total ")); Serial.println(g_cfg.locks.size());
    return;
  }
  if (cmd == "SCAN") {
    std::vector<ScanHit> hits;
    g_lock.scanLocks(hits);
    for (auto& h : hits) {
      Serial.print(F("# ADV ")); Serial.print(h.address); Serial.print(' ');
      Serial.print(h.rssi); Serial.print(' '); Serial.println(h.name);
    }
    Serial.print(F("# SCANDONE ")); Serial.println(hits.size());
    return;
  }
  if (cmd == "BIND") {
    int sp = rest.indexOf(' ');
    if (sp < 0) { Serial.println(F("# ERR usage: BIND <lockid> <pw> [tz]")); return; }
    LockEntry e;
    e.id = rest.substring(0, sp);
    String tail = rest.substring(sp + 1);
    int sp2 = tail.indexOf(' ');
    if (sp2 < 0) { e.password = tail; }
    else { e.password = tail.substring(0, sp2); e.tzMinutes = tail.substring(sp2 + 1).toInt(); }
    g_cfg.upsert(e);
    Serial.println(F("# OK bound"));
    return;
  }
  if (cmd == "UNBIND") { Serial.println(g_cfg.remove(rest) ? F("# OK") : F("# ERR")); return; }
  if (cmd == "CONNECT") { Serial.println(ensureSerial() ? F("# OK") : F("# FAIL")); return; }
  if (cmd == "DISCONNECT") { g_lock.disconnect(); Serial.println(F("# OK")); return; }
  if (cmd == "VERSION") {
    if (!ensureSerial()) return;
    VersionInfo v;
    if (g_lock.getVersion(v)) { Serial.print(F("# version=")); Serial.println(v.firmware); }
    else Serial.println(F("# ERR"));
    return;
  }
  if (cmd == "BATTERY") {
    if (!ensureSerial()) return;
    int pct; float v;
    if (g_lock.getBattery(pct, v)) {
      Serial.print(F("# battery=")); Serial.print(pct); Serial.print(F("% "));
      Serial.print(v); Serial.println(F("V"));
    } else Serial.println(F("# ERR"));
    return;
  }
  if (cmd == "GETTIME") {
    if (!ensureSerial()) return;
    struct tm t;
    if (g_lock.getTime(t)) {
      char buf[32]; strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &t);
      Serial.print(F("# time=")); Serial.println(buf);
    } else Serial.println(F("# ERR"));
    return;
  }
  if (cmd == "UNLOCK" || cmd == "LOCK") {
    if (!ensureSerial()) return;
    int sp = rest.indexOf(' ');
    uint32_t user = (sp < 0 ? rest : rest.substring(0, sp)).toInt();
    String pin = sp < 0 ? "" : rest.substring(sp + 1);
    bool ok = (cmd == "UNLOCK") ? g_lock.unlock(user, pin) : g_lock.lockDoor(user, pin);
    Serial.println(ok ? F("# OK") : F("# ERR"));
    return;
  }
  if (cmd == "REBOOT") {
    if (!ensureSerial()) return;
    Serial.println(g_lock.reboot() ? F("# OK") : F("# ERR"));
    return;
  }
  Serial.println(F("# ERR unknown command (HELP)"));
}

// Factory reset by pressing the onboard RESET (EN) button ~10 times in a row.
// A counter in NVS increments each boot and self-clears after a stable boot, so
// normal reboots never trigger it. This clears only the S3 config, not the lock.
static void checkResetButton() {
  // Only a clean power-on / external (button) reset counts toward the factory
  // reset. Brownouts, panics and watchdog resets must NOT, or a fault loop
  // would wipe the config.
  esp_reset_reason_t rr = esp_reset_reason();
  if (rr != ESP_RST_POWERON && rr != ESP_RST_EXT) return;
  Preferences sys;
  sys.begin("sys", false);
  int rc = sys.getInt("rc", 0) + 1;
  sys.putInt("rc", rc);
  sys.end();
  Serial.print(F("# reset-press count: ")); Serial.println(rc);
  if (rc >= 10) {
    Serial.println(F("# FACTORY RESET (10x reset button): clearing S3 config"));
    Preferences p; p.begin("jenixlock", false); p.clear(); p.end();
    Preferences s2; s2.begin("sys", false); s2.putInt("rc", 0); s2.end();
    delay(200);
    ESP.restart();
  }
}

void setup() {
  Serial.begin(SERIAL_BRIDGE_BAUD);
  delay(200);
  Serial.print(F("# reset reason: ")); Serial.println((int)esp_reset_reason());
  ledSetup();
  checkResetButton();
  g_cfg.load();
  g_lock.begin();
  WiFi.persistent(false);
  WiFi.setAutoReconnect(true);
  startWifi();
  setupRestApi();
  cloudSetup();

  // Software watchdog: an independent task reboots the gateway if the main loop
  // ever stalls past WDT_TIMEOUT_MS. All state is in NVS, so recovery is clean.
  g_loopBeat = millis();
  xTaskCreatePinnedToCore(watchdogTask, "wdt", 2048, nullptr,
                          configMAX_PRIORITIES - 1, nullptr, 0);

  Serial.println(F("# jenix-gateway Phase 5 (multi-lock REST + cloud + OTA) ready"));
  Serial.print(F("# API token: ")); Serial.println(g_cfg.apiToken);
  Serial.println(F("READY"));
}

static void reliabilityTick() {
  // Clear the reset-press counter once the gateway has run stably for a bit.
  static bool rcCleared = false;
  if (!rcCleared && millis() > 5000) {
    rcCleared = true;
    Preferences s; s.begin("sys", false); s.putInt("rc", 0); s.end();
  }
  static uint32_t last = 0;
  if (millis() - last < 15000) return;
  last = millis();
  // Wi-Fi auto-recovery (station mode only).
  if (g_cfg.wifiConfigured() && WiFi.getMode() != WIFI_AP && !WiFi.isConnected()) {
    Serial.println(F("# wifi dropped, reconnecting"));
    WiFi.reconnect();
  }
  // Heap guard: restart cleanly before memory exhaustion (config is in NVS).
  if (ESP.getFreeHeap() < MIN_FREE_HEAP) {
    Serial.println(F("# low heap, restarting"));
    delay(100);
    ESP.restart();
  }
}

void loop() {
  g_loopBeat = millis();
  if (g_wifiReconnect) { g_wifiReconnect = false; startWifi(); }
  ArduinoOTA.handle();
  handleRestApi();
  cloudLoop();
  ledTick();
  reliabilityTick();
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
