#include "provision.h"

#include <ArduinoOTA.h>
#include <ESPmDNS.h>
#include <WiFi.h>
#include <time.h>

#include "config.h"
#include "radio.h"

// Timings (ms).
static const uint32_t JOIN_TIMEOUT_MS = 25000;     // provisioning join attempt
static const uint32_t AP_GRACE_MS = 180000;        // keep AP after a join so the app can read the IP
static const uint32_t FINISH_DELAY_MS = 3000;      // after /api/provision/finish
static const uint32_t RETRY_MS = 30000;            // fallback: retry saved Wi-Fi this often
static const uint32_t LOST_TO_AP_MS = 180000;      // STA down this long -> open setup AP too

static ProvState s_state = PROV_IDLE;
static String s_ssid, s_pass, s_ip, s_err;
static bool s_pendingStart = false;
static uint32_t s_t0 = 0;
static uint32_t s_apCloseAt = 0;
static uint32_t s_lastRetry = 0;
static uint32_t s_lostAt = 0;
static uint32_t s_lastReconnect = 0;
static bool s_servicesUp = false;

static void macBytes(uint8_t m[6]) {
  uint64_t e = ESP.getEfuseMac();  // base MAC == Wi-Fi STA MAC on the S3
  for (int i = 0; i < 6; i++) m[i] = (uint8_t)(e >> (8 * i));
}

String deviceId() {
  uint8_t m[6]; macBytes(m);
  char buf[13];
  snprintf(buf, sizeof(buf), "%02X%02X%02X%02X%02X%02X", m[0], m[1], m[2], m[3], m[4], m[5]);
  return String(buf);
}

String apSsid() {
  uint8_t m[6]; macBytes(m);
  char buf[24];
  snprintf(buf, sizeof(buf), "JenixLock-%02X%02X", m[4], m[5]);
  return String(buf);
}

String mdnsHost() {
  uint8_t m[6]; macBytes(m);
  char buf[24];
  snprintf(buf, sizeof(buf), "jenixlock-%02x%02x", m[4], m[5]);
  return String(buf);
}

bool apActive() { return (WiFi.getMode() & WIFI_AP) != 0; }
bool openForSetup() { return !g_cfg.wifiConfigured(); }

ProvState provisionState() { return s_state; }
const char* provisionStateName() {
  switch (s_state) {
    case PROV_CONNECTING: return "connecting";
    case PROV_CONNECTED: return "connected";
    case PROV_FAILED: return "failed";
    default: return "idle";
  }
}
String provisionIp() { return s_ip; }
String provisionSsid() { return s_ssid; }
String provisionError() { return s_err; }

// mDNS, NTP and LAN OTA: once per boot, after the first station join.
// Join the STRONGEST access point with our SSID, not the first one to answer
// (the Arduino default). With a router + same-name repeater on one channel,
// "first found" made the gateway land on a random side after every restart;
// the phone roams to the strongest AP, so matching that keeps them together.
static void preferStrongestAp() {
  WiFi.setScanMethod(WIFI_ALL_CHANNEL_SCAN);
  WiFi.setSortMethod(WIFI_CONNECT_AP_BY_SIGNAL);
}

static void startServices() {
  configTime(0, 0, "pool.ntp.org", "time.google.com");  // UTC; per-lock tz applied later
  if (s_servicesUp) return;
  s_servicesUp = true;
  String host = mdnsHost();
  if (MDNS.begin(host.c_str())) {
    MDNS.addService("http", "tcp", 80);
    MDNS.addService("jenixlock", "tcp", 80);
    MDNS.addServiceTxt("jenixlock", "tcp", "id", deviceId());
    Serial.print(F("# mdns: http://")); Serial.print(host); Serial.println(F(".local"));
  }
  ArduinoOTA.setHostname(host.c_str());
  ArduinoOTA.setPassword(g_cfg.apiToken.c_str());
  ArduinoOTA.onStart([]() { Serial.println(F("# OTA start")); });
  ArduinoOTA.onEnd([]() { Serial.println(F("# OTA done")); });
  ArduinoOTA.begin();
}

static void startAp() {
  if (!(WiFi.getMode() & WIFI_AP)) {
    WiFi.mode((WiFi.getMode() & WIFI_STA) ? WIFI_AP_STA : WIFI_AP);
  }
  // Configured TX power (default 11 dBm): full-power AP start browned out a
  // weak USB supply (reset-reason-9 loop right after factory reset).
  radioApplyWifi();
  String ap = apSsid();
  WiFi.softAP(ap.c_str());
  radioApplyWifi();
  Serial.print(F("# wifi: setup AP ")); Serial.print(ap);
  Serial.print(F(" IP ")); Serial.println(WiFi.softAPIP());
}

static void closeAp() {
  WiFi.softAPdisconnect(true);
  WiFi.mode(WIFI_STA);
  radioApplyWifi();
  s_apCloseAt = 0;
  if (s_state == PROV_CONNECTED) s_state = PROV_IDLE;
  Serial.println(F("# wifi: setup AP closed"));
}

void wifiStart() {
  s_pendingStart = false;
  s_apCloseAt = 0;
  s_lostAt = 0;
  if (s_state == PROV_CONNECTING) s_state = PROV_IDLE;

  if (g_cfg.wifiConfigured()) {
    if (apActive()) WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_STA);
    // Cap TX power to curb peak current (prevents brownout on marginal USB
    // supplies). 11 dBm is ample for a LAN gateway.
    radioApplyWifi();
    WiFi.setAutoReconnect(true);
    preferStrongestAp();
    WiFi.begin(g_cfg.wifiSsid.c_str(), g_cfg.wifiPass.c_str());
    Serial.print(F("# wifi: connecting to ")); Serial.println(g_cfg.wifiSsid);
    uint32_t t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < 25000) delay(200);  // full scan for the strongest AP takes longer
    if (WiFi.isConnected()) {
      Serial.print(F("# wifi: connected, IP ")); Serial.println(WiFi.localIP());
      startServices();
      return;
    }
    // Saved network unreachable (router off, password changed): open the
    // setup AP too, and keep retrying the saved network in the background.
    Serial.println(F("# wifi: station failed, setup AP + background retry"));
    WiFi.setAutoReconnect(false);  // a scanning station destabilises the AP; retry on a timer
    WiFi.mode(WIFI_AP_STA);
    startAp();
    s_lastRetry = millis();
    return;
  }
  WiFi.mode(WIFI_AP);
  startAp();
}

bool provisionBegin(const String& ssid, const String& pass) {
  if (s_state == PROV_CONNECTING || s_pendingStart) return false;
  s_ssid = ssid;
  s_pass = pass;
  s_ip = "";
  s_err = "";
  s_pendingStart = true;  // started from wifiTick, after the HTTP reply is sent
  return true;
}

void provisionFinish() {
  if (apActive() && WiFi.isConnected()) s_apCloseAt = millis() + FINISH_DELAY_MS;
}

static void tickProvisioning() {
  if (s_pendingStart) {
    s_pendingStart = false;
    WiFi.setAutoReconnect(false);
    bool hadAp = apActive();
    WiFi.mode(WIFI_AP_STA);  // keep the AP up so the phone can read the result
    if (!hadAp) startAp();
    WiFi.disconnect(false, false);
    delay(100);
    preferStrongestAp();
    WiFi.begin(s_ssid.c_str(), s_pass.c_str());
    s_state = PROV_CONNECTING;
    s_t0 = millis();
    Serial.print(F("# provision: joining ")); Serial.println(s_ssid);
    return;
  }
  if (s_state != PROV_CONNECTING) return;

  wl_status_t st = WiFi.status();
  uint32_t el = millis() - s_t0;
  if (st == WL_CONNECTED) {
    s_ip = WiFi.localIP().toString();
    g_cfg.wifiSsid = s_ssid;  // saved only after a successful join
    g_cfg.wifiPass = s_pass;
    g_cfg.save();
    s_pass = "";
    s_state = PROV_CONNECTED;
    WiFi.setAutoReconnect(true);
    startServices();
    s_apCloseAt = millis() + AP_GRACE_MS;
    s_lostAt = 0;
    Serial.print(F("# provision: connected, IP ")); Serial.println(s_ip);
    return;
  }
  bool failed = false;
  if (st == WL_CONNECT_FAILED && el > 3000) { failed = true; s_err = "wrong Wi-Fi password"; }
  else if (st == WL_NO_SSID_AVAIL && el > 10000) { failed = true; s_err = "Wi-Fi network not found"; }
  else if (el > JOIN_TIMEOUT_MS) { failed = true; s_err = "could not join (check the password and 2.4 GHz)"; }
  if (failed) {
    WiFi.disconnect(false, false);
    s_pass = "";
    s_state = PROV_FAILED;
    s_lastRetry = millis();
    Serial.print(F("# provision: failed: ")); Serial.println(s_err);
  }
}

void wifiTick() {
  tickProvisioning();
  if (s_state == PROV_CONNECTING || s_pendingStart) return;

  uint32_t now = millis();
  bool sta = WiFi.isConnected();

  // Close the setup AP once the station is up and the grace period ends.
  if (apActive() && sta && g_cfg.wifiConfigured()) {
    if (s_apCloseAt == 0) {
      // Recovered in the background (router came back): start services, close soon.
      startServices();
      s_apCloseAt = now + 60000;
      Serial.print(F("# wifi: station recovered, IP ")); Serial.println(WiFi.localIP());
    } else if ((int32_t)(now - s_apCloseAt) >= 0) {
      closeAp();
    }
    return;
  }

  if (!g_cfg.wifiConfigured()) return;  // factory-fresh: AP only, wait for the app

  if (apActive()) {
    // Fallback: retry the saved network on a timer.
    if (!sta && now - s_lastRetry > RETRY_MS) {
      s_lastRetry = now;
      preferStrongestAp();
      WiFi.begin(g_cfg.wifiSsid.c_str(), g_cfg.wifiPass.c_str());
    }
    return;
  }

  // Station only.
  if (sta) { s_lostAt = 0; return; }
  if (s_lostAt == 0) s_lostAt = now;
  if (now - s_lastReconnect > 15000) {
    s_lastReconnect = now;
    Serial.println(F("# wifi dropped, reconnecting"));
    WiFi.reconnect();
  }
  if (now - s_lostAt > LOST_TO_AP_MS) {
    Serial.println(F("# wifi: down too long, opening setup AP"));
    WiFi.setAutoReconnect(false);
    WiFi.mode(WIFI_AP_STA);
    startAp();
    s_lastRetry = now;
    s_lostAt = 0;
  }
}
