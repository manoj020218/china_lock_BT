#include "rest_api.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <Update.h>
#include <WebServer.h>
#include <WiFi.h>
#include <time.h>

#include <algorithm>
#include <vector>

#include "ble_lock.h"
#include "cloud.h"
#include "config.h"
#include "eventlog.h"
#include "led.h"
#include "provision.h"
#include "netcheck.h"
#include "radio.h"
#include "version.h"

static WebServer server(80);

// ---- helpers -------------------------------------------------------------- //

static void sendJson(int code, JsonDocument& doc) {
  String body;
  serializeJson(doc, body);
  server.send(code, "application/json", body);
}

static void sendError(int code, const String& message) {
  if (code >= 500) ledEvent(LED_ERROR);
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = message;
  sendJson(code, doc);
}

static bool authorized() {
  String hdr = server.header("Authorization");
  if (g_cfg.apiToken.length() && hdr == ("Bearer " + g_cfg.apiToken)) return true;
  sendError(401, "unauthorized");
  return false;
}

static bool parseBody(JsonDocument& doc) {
  String b = server.arg("plain");
  if (b.length() == 0) return true;  // empty body is allowed
  return deserializeJson(doc, b) == DeserializationError::Ok;
}

static String pickLock(JsonDocument& body) {
  if (server.hasArg("lock")) return server.arg("lock");
  if (body["lock"].is<const char*>()) return String((const char*)body["lock"]);
  LockEntry* o = g_cfg.only();
  return o ? o->id : String("");
}

static bool timeValid() { return time(nullptr) > 1735689600; /* 2025-01-01 */ }

// ---- battery cache (low-battery alerts) ------------------------------------ //
// Updated whenever a lock's battery is read (app request, login clock check,
// or the periodic monitor below). Served at GET /api/alerts.
static const int LOW_BATTERY_PCT = 25;
struct BatteryRec { String lock; int pct = -1; float volts = 0; uint32_t at = 0; };
static std::vector<BatteryRec> s_batt;

static void batteryRecord(const String& lock, int pct, float volts) {
  for (auto& b : s_batt) {
    if (b.lock.equalsIgnoreCase(lock)) { b.pct = pct; b.volts = volts; b.at = (uint32_t)time(nullptr); return; }
  }
  BatteryRec b; b.lock = lock; b.pct = pct; b.volts = volts; b.at = (uint32_t)time(nullptr);
  s_batt.push_back(b);
}

// Set the lock clock from NTP on first connect or after a battery recovery.
static void maybeSyncClock(LockEntry* e) {
  int pct; float v;
  if (!g_lock.getBattery(pct, v)) return;
  batteryRecord(e->id, pct, v);
  int last = g_lock.lastBatteryPct();
  bool jump = (last < 0) || (pct >= 80 && (pct - last) >= 15);
  g_lock.setLastBatteryPct(pct);
  if (jump && timeValid()) {
    time_t local = time(nullptr) + (time_t)e->tzMinutes * 60;
    struct tm t;
    gmtime_r(&local, &t);
    g_lock.setTimeTo(t, e->tzMinutes);
  }
}

static bool ensureSession(const String& lockId, String& err) {
  if (lockId.length() == 0) { err = "no lock selected (bind one or pass ?lock=)"; return false; }
  LockEntry* e = g_cfg.find(lockId);
  if (!e) { err = "lock not bound: " + lockId; return false; }
  if (g_lock.isConnected() && !g_lock.currentLockId().equalsIgnoreCase(lockId)) {
    g_lock.disconnect();
  }
  if (!g_lock.isConnected()) {
    int st = g_lock.connectTo(lockId);
    if (st == BleLock::CONN_NOT_FOUND) {
      err = "lock not reachable: not advertising (out of range or asleep)";
      return false;
    }
    if (st == BleLock::CONN_WEAK) {
      err = "lock not reachable: weak signal (RSSI " + String(g_lock.lastRssi()) +
            " dBm, need >= " + String(g_lock.minRssi()) + "); command NOT sent";
      return false;
    }
    if (st != BleLock::CONN_OK) { err = "lock connect failed"; return false; }
  }
  bool freshLogin = false;
  if (!g_lock.authenticated() || !g_lock.currentLockId().equalsIgnoreCase(lockId)) {
    int ec = 0;
    if (!g_lock.login(e->password, lockId, ec)) { err = "login error " + String(ec); return false; }
    freshLogin = true;
  }
  if (freshLogin) maybeSyncClock(e);
  return true;
}

// ---- provisioning (SoftAP setup) ----------------------------------------- //
// A factory-fresh gateway (no Wi-Fi saved) is "open for setup": a client on the
// setup AP may provision it without a token and receives the token in reply.
// Once Wi-Fi is saved, changing it requires the bearer token.

static bool setupAllowed() { return openForSetup() || authorized(); }

static String htmlEscape(const String& in) {
  String o;
  for (char c : in) {
    if (c == '<') o += "&lt;";
    else if (c == '>') o += "&gt;";
    else if (c == '&') o += "&amp;";
    else if (c == '"') o += "&quot;";
    else o += c;
  }
  return o;
}

static void handleRoot() {
  String ip = WiFi.isConnected() ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
  String html =
      "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>Jenix Lock Gateway</title><style>body{font-family:system-ui;margin:24px;max-width:480px}"
      "input{width:100%;padding:10px;margin:6px 0;box-sizing:border-box}button{padding:10px 16px}</style></head><body>"
      "<h2>Jenix Lock Gateway</h2><p>IP: " + ip + " &middot; ID: " + deviceId() +
      " &middot; locks bound: " + String(g_cfg.locks.size()) + "</p>";
  if (openForSetup()) {
    html +=
        "<h3>Wi-Fi setup</h3><p>Easiest: use the Jenix Lock app &rarr; <b>Set up new gateway</b>.</p>"
        "<form method=POST action=/api/wifi>"
        "<input name=ssid placeholder='Wi-Fi name (SSID)'>"
        "<input name=pass placeholder='Wi-Fi password' type=password>"
        "<button type=submit>Save &amp; connect</button></form>";
  } else {
    html += "<p>Set up. Use the Jenix Lock app to operate locks. To set up again, press the "
            "RESET button 10 times.</p>";
  }
  html += "</body></html>";
  server.send(200, "text/html", html);
}

// Browser form fallback (factory-fresh only; the app uses /api/provision).
static void handleWifiSet() {
  if (!setupAllowed()) return;
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  if (ssid.length() == 0) { sendError(400, "ssid required"); return; }
  if (!provisionBegin(ssid, pass)) { sendError(409, "already joining a network"); return; }
  server.send(200, "text/html",
              "<html><body style='font-family:system-ui;margin:24px'>Joining " + htmlEscape(ssid) +
                  " &hellip; Reconnect your phone to that Wi-Fi, then open http://" + mdnsHost() +
                  ".local or use the Jenix Lock app.</body></html>");
}

static void handleProvision() {
  if (!setupAllowed()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String ssid = req["ssid"].is<const char*>() ? String((const char*)req["ssid"]) : "";
  String pass = req["pass"].is<const char*>() ? String((const char*)req["pass"]) : "";
  if (ssid.length() == 0 || ssid.length() > 32) { sendError(400, "ssid required (max 32)"); return; }
  if (pass.length() > 63) { sendError(400, "password too long"); return; }
  if (!provisionBegin(ssid, pass)) { sendError(409, "already joining a network"); return; }
  JsonDocument doc;
  doc["ok"] = true;
  doc["device_id"] = deviceId();
  doc["token"] = g_cfg.apiToken;
  doc["hostname"] = mdnsHost() + ".local";
  doc["poll"] = "/api/provision/status";
  sendJson(200, doc);
}

static void handleProvisionStatus() {
  JsonDocument doc;
  doc["ok"] = true;
  doc["state"] = provisionStateName();
  doc["device_id"] = deviceId();
  doc["ssid"] = provisionSsid();
  if (provisionState() == PROV_CONNECTED) doc["ip"] = provisionIp();
  if (provisionState() == PROV_FAILED) doc["error"] = provisionError();
  sendJson(200, doc);
}

static void handleProvisionFinish() {
  if (!authorized()) return;
  provisionFinish();
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

static void handleWifiScan() {
  if (!setupAllowed()) return;
  int n = WiFi.scanNetworks(false, false);
  JsonDocument doc;
  doc["ok"] = true;
  JsonArray arr = doc["networks"].to<JsonArray>();
  std::vector<String> seen;
  // Strongest first; one entry per SSID; skip hidden networks.
  std::vector<int> idx;
  for (int i = 0; i < n; i++) idx.push_back(i);
  std::sort(idx.begin(), idx.end(), [](int a, int b) { return WiFi.RSSI(a) > WiFi.RSSI(b); });
  for (int i : idx) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0 || std::find(seen.begin(), seen.end(), ssid) != seen.end()) continue;
    seen.push_back(ssid);
    JsonObject o = arr.add<JsonObject>();
    o["ssid"] = ssid;
    o["rssi"] = WiFi.RSSI(i);
    o["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
    if (seen.size() >= 20) break;
  }
  WiFi.scanDelete();
  sendJson(200, doc);
}

// ---- API: status, locks, scan, bind --------------------------------------- //

static void handleHealth() {
  JsonDocument doc;
  doc["ok"] = true;
  doc["firmware"] = "jenix-gateway";
  doc["device_id"] = deviceId();
  doc["hostname"] = mdnsHost() + ".local";
  doc["wifi"] = WiFi.isConnected() ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
  doc["setup"] = openForSetup();             // factory-fresh: provision without a token
  if (WiFi.isConnected()) {                  // which access point we joined (repeater diagnostics)
    doc["wifi_bssid"] = WiFi.BSSIDstr();
    doc["wifi_channel"] = WiFi.channel();
    doc["wifi_rssi"] = WiFi.RSSI();
  }
  doc["fw_version"] = FW_VERSION;             // compared with the build bundled in the app
  doc["build"] = __DATE__ " " __TIME__;       // proves which firmware is running (OTA check)
  doc["uptime_s"] = millis() / 1000;
  doc["net_misses"] = netcheckMisses();       // self-check: consecutive router probe misses
  doc["net_recoveries"] = netcheckRecoveries();
  if (apActive()) doc["ap"] = apSsid();
  doc["ntp"] = timeValid();
  doc["locks"] = g_cfg.locks.size();
  doc["lock_connected"] = g_lock.isConnected();
  sendJson(200, doc);
}

static void handleLocks() {
  if (!authorized()) return;
  JsonDocument doc;
  doc["ok"] = true;
  JsonArray arr = doc["locks"].to<JsonArray>();
  for (auto& e : g_cfg.locks) {
    JsonObject o = arr.add<JsonObject>();
    o["lock_id"] = e.id;
    o["tz_minutes"] = e.tzMinutes;  // passwords are never returned
  }
  sendJson(200, doc);
}

static void handleScan() {
  if (!authorized()) return;
  std::vector<ScanHit> hits;
  g_lock.scanLocks(hits);
  JsonDocument doc;
  doc["ok"] = true;
  JsonArray arr = doc["locks"].to<JsonArray>();
  for (auto& h : hits) {
    JsonObject o = arr.add<JsonObject>();
    o["address"] = h.address;
    o["name"] = h.name;
    o["rssi"] = h.rssi;
  }
  sendJson(200, doc);
}

static void handleBind() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  if (!req["lock_id"].is<const char*>() || !req["password"].is<const char*>()) {
    sendError(400, "lock_id and password required"); return;
  }
  LockEntry e;
  e.id = String((const char*)req["lock_id"]);
  e.password = String((const char*)req["password"]);
  e.tzMinutes = req["tz_minutes"].is<int>() ? (int)req["tz_minutes"] : 0;
  if (req["set_password"] | false) {
    // New / factory-reset lock: this gateway CHOOSES its connection password.
    if (!timeValid()) { sendError(503, "gateway clock not synced yet (NTP); retry shortly"); return; }
    g_lock.disconnect();
    int st = g_lock.connectTo(e.id);
    if (st != BleLock::CONN_OK) {
      sendError(502, st == BleLock::CONN_WEAK ? "lock signal too weak" : "lock not reachable (touch the keypad to wake it)");
      return;
    }
    time_t local = time(nullptr) + (time_t)e.tzMinutes * 60;
    struct tm t; gmtime_r(&local, &t);
    int ec = -1;
    bool ok = g_lock.provisionPassword(e.password, e.id, t, e.tzMinutes, ec);
    g_lock.disconnect();
    if (!ok) {
      if (ec == 33 || ec == 19) sendError(409, "lock already has a connection password - choose 'already set up' and enter it");
      else sendError(502, "set password failed (error " + String(ec) + ")");
      return;
    }
  }
  g_cfg.upsert(e);
  JsonDocument doc; doc["ok"] = true; doc["lock_id"] = e.id; sendJson(200, doc);
}

static void handleUnbind() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String id = req["lock_id"].is<const char*>() ? String((const char*)req["lock_id"]) : "";
  bool removed = g_cfg.remove(id);
  JsonDocument doc; doc["ok"] = removed; sendJson(removed ? 200 : 404, doc);
}

// ---- API: per-lock operations --------------------------------------------- //

static void handleVersion() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  VersionInfo v;
  if (!g_lock.getVersion(v)) { sendError(502, "version read failed"); return; }
  JsonDocument doc; doc["ok"] = true; doc["firmware"] = v.firmware;
  doc["command_version"] = v.commandVersion; doc["admin_exists"] = v.adminExists;
  sendJson(200, doc);
}

static void handleBattery() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  int pct; float volts;
  if (!g_lock.getBattery(pct, volts)) { sendError(502, "battery read failed"); return; }
  batteryRecord(g_lock.currentLockId(), pct, volts);
  JsonDocument doc; doc["ok"] = true; doc["percent"] = pct; doc["voltage"] = volts;
  sendJson(200, doc);
}

static void handleGetTime() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  struct tm t;
  if (!g_lock.getTime(t)) { sendError(502, "time read failed"); return; }
  char buf[32]; strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &t);
  JsonDocument doc; doc["ok"] = true; doc["time"] = buf; sendJson(200, doc);
}

static void handleSetTime() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  String lockId = pickLock(req);
  if (!ensureSession(lockId, err)) { sendError(502, err); return; }
  LockEntry* e = g_cfg.find(lockId);
  int tz = (req["tz_minutes"].is<int>()) ? (int)req["tz_minutes"] : (e ? e->tzMinutes : 0);
  struct tm t = {};
  if (req["year"].is<int>()) {
    t.tm_year = (int)req["year"] - 1900;
    t.tm_mon = ((int)(req["month"] | 1)) - 1;
    t.tm_mday = req["day"] | 1;
    t.tm_hour = req["hour"] | 0;
    t.tm_min = req["minute"] | 0;
    t.tm_sec = req["second"] | 0;
  } else if (timeValid()) {
    time_t local = time(nullptr) + (time_t)tz * 60;
    gmtime_r(&local, &t);
  } else {
    sendError(400, "no time provided and NTP not synced"); return;
  }
  if (!g_lock.setTimeTo(t, tz)) { sendError(502, "set-time failed"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

// ---- gateway auto close ---------------------------------------------------- //
// After an unlock made through the gateway, send the lock command after the
// lock's autoCloseSec. Needs no door magnet (the lock command works anyway).
// Keypad / fingerprint / card opens don't pass through the gateway, so those
// still rely on the lock's own auto-lock (which waits for the door sensor).
struct PendingClose { String lock; uint32_t user = 0; String pin; uint32_t due = 0; bool active = false; int tries = 0; };
static PendingClose s_close;

void autoCloseSchedule(const String& lockId, uint32_t user, const String& pin) {
  LockEntry* e = g_cfg.find(lockId);
  if (!e || e->autoCloseSec <= 0) { s_close.active = false; return; }
  s_close.lock = lockId; s_close.user = user; s_close.pin = pin;
  s_close.due = millis() + (uint32_t)e->autoCloseSec * 1000UL;
  s_close.active = true; s_close.tries = 0;
}

void autoCloseCancel(const String& lockId) {
  if (s_close.active && s_close.lock.equalsIgnoreCase(lockId)) s_close.active = false;
}

static void autoCloseTick() {
  if (!s_close.active || (int32_t)(millis() - s_close.due) < 0) return;
  String err;
  bool ok = ensureSession(s_close.lock, err) && g_lock.lockDoor(s_close.user, s_close.pin);
  if (!ok && ++s_close.tries < 3) { s_close.due = millis() + 4000; return; }  // retry twice
  eventLogAdd(s_close.lock, s_close.user, false, ok, EV_SRC_AUTO);
  if (ok) ledEvent(LED_LOCK);
  Serial.print(F("# auto close ")); Serial.print(s_close.lock); Serial.println(ok ? F(" locked") : F(" FAILED"));
  s_close.active = false;
}

static void handleUnlock() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  uint32_t user = req["user"] | 0;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  bool ok = g_lock.unlock(user, pin);
  eventLogAdd(g_lock.currentLockId(), user, true, ok, EV_SRC_APP);
  if (!ok) { sendError(502, "unlock rejected"); return; }
  ledEvent(LED_UNLOCK);
  autoCloseSchedule(g_lock.currentLockId(), user, pin);
  JsonDocument doc; doc["ok"] = true;
  if (s_close.active) doc["auto_close_in"] = g_cfg.find(g_lock.currentLockId())->autoCloseSec;
  sendJson(200, doc);
}

static void handleLock() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  uint32_t user = req["user"] | 0;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  bool ok = g_lock.lockDoor(user, pin);
  eventLogAdd(g_lock.currentLockId(), user, false, ok, EV_SRC_APP);
  if (ok) autoCloseCancel(g_lock.currentLockId());  // locked by hand already
  if (!ok) { sendError(502, "lock rejected"); return; }
  ledEvent(LED_LOCK);
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

static void handleReboot() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  if (!g_lock.reboot()) { sendError(502, "reboot failed"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

// ---- API: users ----------------------------------------------------------- //

static void userJson(JsonObject o, const BleLock::UserRec& u);

static void handleUsersGet() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  std::vector<BleLock::UserRec> users;
  if (!g_lock.listUsers(users)) { sendError(502, "user read failed: " + g_lock.lastUserError); return; }
  JsonDocument doc; doc["ok"] = true;
  JsonArray arr = doc["users"].to<JsonArray>();
  for (auto& u : users) {
    JsonObject o = arr.add<JsonObject>();
    userJson(o, u);
  }
  sendJson(200, doc);
}

// Validity block (offset 48): start YY MM DD, end YY MM DD, daily start hh mm,
// daily end hh mm, weekday/flags byte, reserved. Permanent = 2000-01-01..2099-12-31.
static const uint8_t PERMANENT_SCHED[12] = {0x00,0x01,0x01,0x63,0x0C,0x1F,0x00,0x00,0x17,0x3B,0x7F,0x00};

static void userJson(JsonObject o, const BleLock::UserRec& u) {
  o["id"] = u.id; o["name"] = u.name;
  o["group"] = (u.group == 1) ? "admin" : "general";
  o["fingers"] = u.fingers; o["card"] = u.card; o["pin"] = u.pin;
  JsonObject v = o["validity"].to<JsonObject>();
  const uint8_t* b = u.sched;
  v["permanent"] = memcmp(b, PERMANENT_SCHED, 10) == 0;
  char buf[16];
  snprintf(buf, sizeof(buf), "20%02d-%02d-%02d", b[0], b[1], b[2]); v["start"] = buf;
  snprintf(buf, sizeof(buf), "20%02d-%02d-%02d", b[3], b[4], b[5]); v["end"] = buf;
  snprintf(buf, sizeof(buf), "%02d:%02d", b[6], b[7]); v["daily_start"] = buf;
  snprintf(buf, sizeof(buf), "%02d:%02d", b[8], b[9]); v["daily_end"] = buf;
  v["weekdays"] = b[10];
}

static bool parseDate(const char* s, int& y, int& m, int& d) {
  return s && sscanf(s, "%d-%d-%d", &y, &m, &d) == 3 && y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}
static bool parseHm(const char* s, int& h, int& mi) {
  return s && sscanf(s, "%d:%d", &h, &mi) == 2 && h >= 0 && h <= 23 && mi >= 0 && mi <= 59;
}

// POST /api/users/update {user, name?, validity?: "permanent" |
//   {start:"YYYY-MM-DD", end, daily_start:"HH:MM", daily_end, weekdays: 0..127}}
static void handleUsersUpdate() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  uint32_t user = req["user"] | 0;
  if (!user) { sendError(400, "user required"); return; }
  String name; const String* namePtr = nullptr;
  if (req["name"].is<const char*>()) {
    name = String((const char*)req["name"]);
    name.trim();
    if (name.length() == 0 || name.length() > 21) { sendError(400, "name must be 1-21 characters"); return; }
    namePtr = &name;
  }
  uint8_t sched[12]; const uint8_t* schedPtr = nullptr;
  if (req["validity"].is<const char*>() && String((const char*)req["validity"]) == "permanent") {
    memcpy(sched, PERMANENT_SCHED, 12); schedPtr = sched;
  } else if (req["validity"].is<JsonObject>()) {
    JsonObject v = req["validity"];
    int y0, m0, d0, y1, m1, d1, h0 = 0, i0 = 0, h1 = 23, i1 = 59;
    if (!parseDate(v["start"], y0, m0, d0) || !parseDate(v["end"], y1, m1, d1)) {
      sendError(400, "validity.start/end must be YYYY-MM-DD"); return;
    }
    if (v["daily_start"].is<const char*>() && !parseHm(v["daily_start"], h0, i0)) { sendError(400, "daily_start HH:MM"); return; }
    if (v["daily_end"].is<const char*>() && !parseHm(v["daily_end"], h1, i1)) { sendError(400, "daily_end HH:MM"); return; }
    int wd = v["weekdays"] | 0x7F;
    uint8_t b[12] = {(uint8_t)(y0 - 2000), (uint8_t)m0, (uint8_t)d0, (uint8_t)(y1 - 2000), (uint8_t)m1, (uint8_t)d1,
                     (uint8_t)h0, (uint8_t)i0, (uint8_t)h1, (uint8_t)i1, (uint8_t)(wd & 0xFF), 0x00};
    memcpy(sched, b, 12); schedPtr = sched;
  }
  if (!namePtr && !schedPtr) { sendError(400, "nothing to change (name and/or validity)"); return; }
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  BleLock::UserRec out;
  if (!g_lock.updateUser(user, namePtr, schedPtr, out)) { sendError(502, "update failed (user not found or lock refused)"); return; }
  JsonDocument doc; doc["ok"] = true;
  JsonObject o = doc["user"].to<JsonObject>();
  userJson(o, out);
  sendJson(200, doc);
}

static void handleUsersAdd() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  String name = req["name"].is<const char*>() ? String((const char*)req["name"]) : "User";
  int group = (req["group"].is<const char*>() &&
               String((const char*)req["group"]) == "admin") ? 1 : 2;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  uint32_t newId = 0;
  if (!g_lock.addUser(name, group, pin, newId)) { sendError(502, "add user failed"); return; }
  JsonDocument doc; doc["ok"] = true; doc["id"] = newId; sendJson(200, doc);
}

static void handleUsersDelete() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  uint32_t user = req["user"] | 0;
  if (!g_lock.deleteUser(user)) { sendError(502, "delete failed"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

// ---- API: enrollment ------------------------------------------------------ //

static bool s_enrollActive = false;

static void handleEnrollStart() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  int type = req["type"] | 0;  // 1 finger, 2 pin, 3 card
  uint32_t user = req["user"] | 0;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  if (type < 1 || type > 3) { sendError(400, "type must be 1(finger) 2(pin) 3(card)"); return; }
  // A PIN change on a user who already has one works directly (validated).
  // Never delete the old PIN first: if the new one is then refused (e.g.
  // duplicate) the user would be left without any PIN.
  if (!g_lock.enrollStart(type, user, pin)) {
    int ec = g_lock.lastEnrollError;
    if (type == 2 && ec == 26) {
      // Deliberately neutral: saying "used by another user" would let someone
      // discover other users' PINs by trial.
      sendError(409, "this PIN can't be used - please choose a different PIN");
    } else {
      sendError(502, "enroll start failed (lock error " + String(ec) + ")");
    }
    return;
  }
  s_enrollActive = false;
  JsonDocument doc; doc["ok"] = true;
  doc["poll"] = (type != 2);  // finger/card need status polling
  sendJson(200, doc);
}

static void handleEnrollStatus() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  int status, len;
  if (!g_lock.enrollStatus(status, len)) { sendError(502, "enroll status failed"); return; }
  // The lock reports 0 when idle too, so "done" only counts after it has shown
  // activity (finger: multi-byte progress; card: 5 waiting -> 8 read).
  bool idle = (status == 0 && len <= 1);
  if (!idle) s_enrollActive = true;
  JsonDocument doc; doc["ok"] = true; doc["status"] = status; doc["payload_len"] = len;
  doc["done"] = idle && s_enrollActive;
  doc["phase"] = idle ? (s_enrollActive ? "done" : "waiting")
               : (status == 8 ? "card_read" : status == 5 ? "waiting_card" : status == 4 ? "progress" : "capturing");
  sendJson(200, doc);
}

static void handleEnrollCancel() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  g_lock.cancelEnroll();
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

// ---- API: records --------------------------------------------------------- //

static void handleRecords() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String lockId = pickLock(req);
  LockEntry* le = g_cfg.find(lockId);
  if (!le) { sendError(400, "lock not bound: " + lockId); return; }
  int days = server.hasArg("days") ? server.arg("days").toInt() : 7;
  if (days < 1) days = 1;
  const time_t tzOff = (time_t)le->tzMinutes * 60;

  // The lock stamps records in its LOCAL time, so the window is computed in
  // the lock's time zone (a UTC window dropped early-morning IST records).
  int y0 = 2000, m0 = 1, d0 = 1, y1 = 2099, m1 = 12, d1 = 31;
  uint32_t since = 0;
  if (timeValid()) {
    time_t end = time(nullptr);
    time_t start = end - (time_t)(days - 1) * 86400;
    time_t ls = start + tzOff, lend = end + tzOff;
    struct tm ts, te;
    gmtime_r(&ls, &ts); gmtime_r(&lend, &te);
    y0 = ts.tm_year + 1900; m0 = ts.tm_mon + 1; d0 = ts.tm_mday;
    y1 = te.tm_year + 1900; m1 = te.tm_mon + 1; d1 = te.tm_mday;
    // Local midnight at the start of the window, back in UTC.
    ts.tm_hour = ts.tm_min = ts.tm_sec = 0;
    since = (uint32_t)(mktime(&ts) - tzOff);  // TZ is UTC on the gateway
  }

  struct Row { String time; uint32_t user; String mode; int modeByte; int dir;
               const char* source; const char* action; bool ok; };
  std::vector<Row> rows;

  // 1. The lock's own log: physical opens (PIN / fingerprint / card).
  String err;
  bool lockOk = ensureSession(lockId, err);
  if (lockOk) {
    std::vector<BleLock::RecordRec> recs;
    if (g_lock.readRecords(y0, m0, d0, y1, m1, d1, recs)) {
      for (auto& r : recs) {
        const char* mode = r.mode == 1 ? "fingerprint" : r.mode == 2 ? "card"
                           : r.mode == 4 ? "pin" : "other";
        rows.push_back({r.time, r.user, mode, r.mode, r.direction, "lock", "unlock", true});
      }
    } else { lockOk = false; err = "record read failed"; }
  }

  // 2. Commands this gateway sent (the lock does not log app/BLE unlocks).
  std::vector<GwEvent> evs;
  eventLogQuery(lockId, since, evs);
  for (auto& e : evs) {
    String t = "unknown time";
    if (e.epoch) {
      time_t lt = (time_t)e.epoch + tzOff;
      struct tm tm; gmtime_r(&lt, &tm);
      char buf[24]; strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &tm);
      t = buf;
    }
    const char* src = e.source == EV_SRC_CLOUD ? "cloud" : e.source == EV_SRC_SERIAL ? "serial"
                    : e.source == EV_SRC_AUTO ? "auto" : "app";
    rows.push_back({t, e.user, src, -1, -1, src, e.action ? "unlock" : "lock", e.ok != 0});
  }

  // Newest first ("YYYY-MM-DD HH:MM:SS" sorts lexicographically).
  std::sort(rows.begin(), rows.end(), [](const Row& a, const Row& b) { return a.time > b.time; });

  JsonDocument doc;
  doc["ok"] = true;
  doc["count"] = (int)rows.size();
  if (!lockOk) { doc["lock_unreachable"] = true; doc["lock_error"] = err; }
  JsonArray arr = doc["records"].to<JsonArray>();
  for (auto& r : rows) {
    JsonObject o = arr.add<JsonObject>();
    o["user"] = r.user; o["time"] = r.time; o["mode"] = r.mode;
    if (r.modeByte >= 0) { o["mode_byte"] = r.modeByte; o["direction"] = r.dir; }
    o["source"] = r.source; o["action"] = r.action; o["ok"] = r.ok;
  }
  sendJson(200, doc);
}

// ---- API: settings -------------------------------------------------------- //

// POST /api/settings/app-autoclose {seconds: 0 | 3..300} - gateway auto close.
static void handleAppAutoClose() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  LockEntry* e = g_cfg.find(pickLock(req));
  if (!e) { sendError(400, "lock not bound"); return; }
  int sec = req["seconds"] | -1;
  if (sec != 0 && (sec < 3 || sec > 300)) { sendError(400, "seconds must be 0 (off) or 3-300"); return; }
  e->autoCloseSec = sec;
  g_cfg.save();
  if (sec == 0) autoCloseCancel(e->id);
  JsonDocument doc; doc["ok"] = true; doc["app_auto_close_s"] = sec; sendJson(200, doc);
}

// GET /api/settings/raw?lock=<id>[&sel=<n>] - raw lock parameters as hex
// (all = 36-byte blob; sel=18 = auto-lock / normally-open group). Diagnostic.
// GET /api/settings?lock=<id> - auto-lock delay + normally-open schedule.
// Selector-18 group: [2] auto-lock seconds, [5..8] packed schedule (BE):
// (weekday_mask << 22) | (end_min << 11) | start_min; FFFFFFFF or mask 0 = off.
static void handleSettingsGet() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  std::vector<uint8_t> g;
  if (!g_lock.getParameterRaw(18, g) || g.size() < 9) { sendError(502, "settings read failed"); return; }
  uint32_t v = ((uint32_t)g[5] << 24) | ((uint32_t)g[6] << 16) | ((uint32_t)g[7] << 8) | g[8];
  int mask = (v >> 22) & 0x7F, endMin = (v >> 11) & 0x7FF, startMin = v & 0x7FF;
  bool on = v != 0xFFFFFFFF && mask != 0;
  JsonDocument doc;
  doc["ok"] = true;
  doc["auto_lock_s"] = g[2];
  LockEntry* le = g_cfg.find(g_lock.currentLockId());
  doc["app_auto_close_s"] = le ? le->autoCloseSec : 0;
  JsonObject no = doc["normally_open"].to<JsonObject>();
  no["enabled"] = on;
  no["start_minute"] = on ? startMin : 0;
  no["end_minute"] = on ? endMin : 0;
  no["weekday_mask"] = on ? mask : 0;
  sendJson(200, doc);
}

static void handleSettingsRaw() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  auto hex = [](const std::vector<uint8_t>& v) {
    String h; char b[4];
    for (auto x : v) { snprintf(b, sizeof(b), "%02x", x); h += b; }
    return h;
  };
  JsonDocument doc; doc["ok"] = true;
  std::vector<uint8_t> all, sel;
  if (g_lock.getParameterRaw(-1, all)) doc["all"] = hex(all);
  int s = server.hasArg("sel") ? server.arg("sel").toInt() : 18;
  if (g_lock.getParameterRaw(s, sel)) { doc["sel"] = s; doc["sel_hex"] = hex(sel); }
  sendJson(200, doc);
}

static void handleAutoLock() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  int seconds = req["seconds"] | 5;
  if (!g_lock.setAutoLock(seconds)) { sendError(502, "set auto-lock failed"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

static void handleNormallyOpen() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  bool ok;
  if (req["enabled"].is<bool>() && !(bool)req["enabled"]) {
    ok = g_lock.clearNormallyOpen();  // schedule off
  } else {
    int start = req["start_minute"] | 0;
    int end = req["end_minute"] | 0;
    int mask = req["weekday_mask"] | 0x7F;
    if (start < 0 || start > 1439 || end < 0 || end > 1439 || (mask & 0x7F) == 0) {
      sendError(400, "start/end 0-1439 minutes and at least one weekday required"); return;
    }
    ok = g_lock.setNormallyOpen(mask, start, end);
  }
  if (!ok) { sendError(502, "set normally-open failed"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

static void handleFactoryReset() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  if (!(req["confirm"].is<const char*>() &&
        String((const char*)req["confirm"]) == "RESET")) {
    sendError(400, "factory reset requires {\"confirm\":\"RESET\"}"); return;
  }
  String err;
  String lockId = pickLock(req);
  if (!ensureSession(lockId, err)) { sendError(502, err); return; }
  if (!g_lock.factoryReset()) { sendError(502, "factory reset failed"); return; }
  g_cfg.remove(lockId);  // the lock is now unbound
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

// ---- cloud config --------------------------------------------------------- //

static void handleCloudGet() {
  if (!authorized()) return;
  JsonDocument doc;
  doc["ok"] = true;
  doc["enabled"] = g_cfg.cloudEnabled;
  doc["host"] = g_cfg.cloudHost;
  doc["port"] = g_cfg.cloudPort;
  doc["client_id"] = g_cfg.cloudClientId;
  doc["connected"] = cloudConnected();   // passwords are never returned
  sendJson(200, doc);
}

static void handleCloudSet() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  if (req["host"].is<const char*>()) g_cfg.cloudHost = String((const char*)req["host"]);
  if (req["port"].is<int>()) g_cfg.cloudPort = (int)req["port"];
  if (req["client_id"].is<const char*>()) g_cfg.cloudClientId = String((const char*)req["client_id"]);
  if (req["user"].is<const char*>()) g_cfg.cloudUser = String((const char*)req["user"]);
  if (req["pass"].is<const char*>()) g_cfg.cloudPass = String((const char*)req["pass"]);
  if (req["enabled"].is<bool>()) g_cfg.cloudEnabled = (bool)req["enabled"];
  g_cfg.save();
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

// ---- radio power + lock probe ------------------------------------------- //

// GET/POST /api/radio {wifi_dbm: 8|11|13|15|17|19, ble_dbm: 0..21 step 3}
static void handleRadio() {
  if (!authorized()) return;
  if (server.method() == HTTP_POST) {
    JsonDocument req;
    if (!parseBody(req)) { sendError(400, "bad json"); return; }
    if (req["wifi_dbm"].is<int>()) {
      int d = req["wifi_dbm"];
      if (!radioValidWifi(d)) { sendError(400, "wifi_dbm must be 8, 11, 13 or 15"); return; }
      g_cfg.wifiDbm = d;
    }
    if (req["ble_dbm"].is<int>()) {
      int d = req["ble_dbm"];
      if (!radioValidBle(d)) { sendError(400, "ble_dbm must be 0-15 in steps of 3"); return; }
      g_cfg.bleDbm = d;
    }
    g_cfg.save();
    radioApplyWifi();
    radioApplyBle();
  }
  JsonDocument doc;
  doc["ok"] = true;
  doc["wifi_dbm"] = g_cfg.wifiDbm;
  doc["ble_dbm"] = g_cfg.bleDbm;
  doc["wifi_rssi"] = WiFi.isConnected() ? WiFi.RSSI() : 0;   // gateway <- router signal
  doc["stepped_down"] = radioSteppedDown();                     // brownout auto step-down this boot
  doc["reset_reason"] = (int)esp_reset_reason();
  sendJson(200, doc);
}

// GET /api/signal?lock=<id> - live Bluetooth signal of the gateway<->lock link
// (connects if needed, no command is sent) plus the gateway's own Wi-Fi signal.
static void handleSignal() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String id = pickLock(req);
  String err;
  JsonDocument doc;
  doc["ok"] = true;
  doc["wifi_rssi"] = WiFi.isConnected() ? WiFi.RSSI() : 0;
  doc["min_rssi"] = g_lock.minRssi();
  if (ensureSession(id, err)) {
    doc["connected"] = true;
    doc["ble_rssi"] = g_lock.liveRssi();
  } else {
    doc["connected"] = false;
    doc["ble_rssi"] = 0;  // never report another lock's signal for this one
    doc["error"] = err;
  }
  sendJson(200, doc);
}

// GET /api/probe?lock=<id> - connect WITHOUT logging in and read the lock's
// version block: tells a fresh lock from one already set up (admin_exists),
// and flags newer login protocols (command_version > 0) this gateway can't use.
static void handleProbe() {
  if (!authorized()) return;
  String id = server.arg("lock");
  if (id.length() == 0) { sendError(400, "lock required"); return; }
  g_lock.disconnect();
  int st = g_lock.connectTo(id);
  if (st != BleLock::CONN_OK) {
    sendError(502, st == BleLock::CONN_WEAK ? "lock signal too weak (RSSI " + String(g_lock.lastRssi()) + ")"
                                            : "lock not reachable (touch the keypad to wake it)");
    return;
  }
  VersionInfo v;
  bool ok = g_lock.getVersion(v);
  int rssi = g_lock.lastRssi();
  g_lock.disconnect();
  if (!ok) { sendError(502, "lock did not answer the version request"); return; }
  JsonDocument doc;
  doc["ok"] = true;
  doc["firmware"] = v.firmware;
  doc["command_version"] = v.commandVersion;
  doc["admin_exists"] = v.adminExists;
  doc["flags"] = v.flags;
  doc["rssi"] = rssi;
  doc["supported"] = v.commandVersion == 0;  // legacy login only, for now
  doc["bound_here"] = g_cfg.find(id) != nullptr;
  sendJson(200, doc);
}

// ---- low-battery monitor --------------------------------------------------- //
// The gateway is always on, so it measures each bound lock's battery itself:
// 2 min after boot, then every 6 h (one short BLE session per lock; the link
// is closed afterwards to spare the lock's batteries).
static const uint32_t BATT_FIRST_MS = 120000;
static const uint32_t BATT_EVERY_MS = 6UL * 3600UL * 1000UL;
static uint32_t s_battLast = 0;
static bool s_battDone = false;

static void measureAllBatteries() {
  for (auto& e : g_cfg.locks) {
    String err;
    if (!ensureSession(e.id, err)) continue;  // out of range / asleep: try next round
    int pct; float v;
    if (g_lock.getBattery(pct, v)) batteryRecord(e.id, pct, v);
    g_lock.disconnect();
  }
}

static void batteryMonitorTick() {
  uint32_t now = millis();
  if (!s_battDone) {
    if (now < BATT_FIRST_MS) return;
  } else if (now - s_battLast < BATT_EVERY_MS) {
    return;
  }
  s_battDone = true;
  s_battLast = now;
  if (g_cfg.locks.empty()) return;
  Serial.println(F("# battery monitor: measuring locks"));
  measureAllBatteries();
}

static void alertsJson(JsonDocument& doc) {
  doc["ok"] = true;
  doc["threshold"] = LOW_BATTERY_PCT;
  JsonArray arr = doc["locks"].to<JsonArray>();
  for (auto& e : g_cfg.locks) {
    JsonObject o = arr.add<JsonObject>();
    o["lock_id"] = e.id;
    int pct = -1; float v = 0; uint32_t at = 0;
    for (auto& b : s_batt) if (b.lock.equalsIgnoreCase(e.id)) { pct = b.pct; v = b.volts; at = b.at; }
    o["battery"] = pct;
    o["voltage"] = v;
    o["checked_at"] = at;
    o["low"] = pct >= 0 && pct < LOW_BATTERY_PCT;
  }
}

// GET /api/alerts - last measured battery per bound lock (low = below 25 %).
static void handleAlerts() {
  if (!authorized()) return;
  JsonDocument doc;
  alertsJson(doc);
  sendJson(200, doc);
}

// POST /api/alerts/check - measure every lock now (blocks ~10 s per lock).
static void handleAlertsCheck() {
  if (!authorized()) return;
  measureAllBatteries();
  s_battDone = true;
  s_battLast = millis();
  JsonDocument doc;
  alertsJson(doc);
  sendJson(200, doc);
}

// ---- OTA (pull from a URL, e.g. a VPS) ------------------------------------ //
// Writes only the app partition; NVS (Wi-Fi, token, locks, cloud) is preserved.

// ---- OTA upload from the app ----------------------------------------------- //
// POST /api/ota/upload (multipart, field "firmware"), bearer token required.
// The app bundles the latest gateway build and uploads it straight from the
// phone - no URL or PC needed. Optional header X-MD5 (hex) is verified before
// the new image is activated; a bad or partial upload leaves the running
// firmware untouched. Writes only the app partition: NVS (Wi-Fi, token,
// locks) is preserved. CORS is enabled here because the app's web view sends
// this with XMLHttpRequest for upload progress.
static bool s_otaAuthed = false;
static bool s_otaFirst = true;
static String s_otaError;

static void corsHeaders() {
  server.sendHeader("Access-Control-Allow-Origin", "*");
  server.sendHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  server.sendHeader("Access-Control-Allow-Headers", "Authorization, X-MD5, Content-Type");
  server.sendHeader("Access-Control-Max-Age", "600");
}

static void handleOtaUploadOptions() {
  corsHeaders();
  server.send(204);
}

static void handleOtaUploadChunk() {
  HTTPUpload& up = server.upload();
  if (up.status == UPLOAD_FILE_START) {
    String hdr = server.header("Authorization");
    s_otaAuthed = g_cfg.apiToken.length() && hdr == ("Bearer " + g_cfg.apiToken);
    s_otaError = "";
    if (!s_otaAuthed) { s_otaError = "unauthorized"; return; }
    s_otaFirst = true;
    Serial.print(F("# OTA upload start: ")); Serial.println(up.filename);
    g_lock.disconnect();  // free the radio/CPU while flashing
    ledEvent(LED_OK);
    if (!Update.begin(UPDATE_SIZE_UNKNOWN, U_FLASH)) { s_otaError = Update.errorString(); return; }
    String md5 = server.header("X-MD5");
    if (md5.length() == 32) Update.setMD5(md5.c_str());
  } else if (up.status == UPLOAD_FILE_WRITE) {
    if (!s_otaAuthed || s_otaError.length()) return;
    if (s_otaFirst && up.currentSize > 0 && up.buf[0] != 0xE9) {  // ESP image magic
      s_otaError = "not an ESP32 firmware image";
      Update.abort();
      return;
    }
    s_otaFirst = false;
    if (Update.write(up.buf, up.currentSize) != up.currentSize) s_otaError = Update.errorString();
  } else if (up.status == UPLOAD_FILE_END) {
    if (!s_otaAuthed || s_otaError.length()) return;
    if (!Update.end(true)) s_otaError = Update.errorString();  // checks size + MD5
    else { Serial.print(F("# OTA upload done: ")); Serial.println(up.totalSize); }
  } else if (up.status == UPLOAD_FILE_ABORTED) {
    Update.abort();
    s_otaError = "upload aborted";
  }
}

static void handleOtaUploadDone() {
  corsHeaders();
  if (!s_otaAuthed) { sendError(401, "unauthorized"); return; }
  if (s_otaError.length() || !Update.isFinished()) {
    sendError(400, "firmware update failed: " + (s_otaError.length() ? s_otaError : String("incomplete upload")));
    return;
  }
  JsonDocument doc;
  doc["ok"] = true;
  doc["message"] = "firmware installed; the gateway restarts now";
  sendJson(200, doc);
  delay(500);
  ESP.restart();
}

static void handleOtaPull() {
  if (!authorized()) return;
  JsonDocument req;
  if (!parseBody(req)) { sendError(400, "bad json"); return; }
  String url = req["url"].is<const char*>() ? String((const char*)req["url"]) : "";
  if (url.length() == 0) { sendError(400, "url required"); return; }

  JsonDocument doc;
  doc["ok"] = true;
  doc["message"] = "downloading firmware; the gateway will reboot on success";
  sendJson(200, doc);
  delay(100);

  WiFiClient client;
  httpUpdate.rebootOnUpdate(true);  // config in NVS survives
  t_httpUpdate_return r = httpUpdate.update(client, url);
  // Only reached on failure (success reboots):
  Serial.print(F("# OTA pull failed: "));
  Serial.println(httpUpdate.getLastErrorString());
}

// ---- registration --------------------------------------------------------- //

void setupRestApi() {
  const char* headerKeys[] = {"Authorization", "X-MD5"};
  server.collectHeaders(headerKeys, 2);

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/wifi", HTTP_POST, handleWifiSet);
  server.on("/api/wifi/scan", HTTP_GET, handleWifiScan);
  server.on("/api/provision", HTTP_POST, handleProvision);
  server.on("/api/provision/status", HTTP_GET, handleProvisionStatus);
  server.on("/api/provision/finish", HTTP_POST, handleProvisionFinish);

  server.on("/api/health", HTTP_GET, handleHealth);
  server.on("/api/locks", HTTP_GET, handleLocks);
  server.on("/api/scan", HTTP_GET, handleScan);
  server.on("/api/bind", HTTP_POST, handleBind);
  server.on("/api/unbind", HTTP_POST, handleUnbind);

  server.on("/api/version", HTTP_GET, handleVersion);
  server.on("/api/battery", HTTP_GET, handleBattery);
  server.on("/api/time", HTTP_GET, handleGetTime);
  server.on("/api/time", HTTP_POST, handleSetTime);
  server.on("/api/unlock", HTTP_POST, handleUnlock);
  server.on("/api/lock", HTTP_POST, handleLock);
  server.on("/api/reboot", HTTP_POST, handleReboot);

  server.on("/api/users", HTTP_GET, handleUsersGet);
  server.on("/api/users", HTTP_POST, handleUsersAdd);
  server.on("/api/users/delete", HTTP_POST, handleUsersDelete);
  server.on("/api/users/update", HTTP_POST, handleUsersUpdate);

  server.on("/api/enroll", HTTP_POST, handleEnrollStart);
  server.on("/api/enroll/status", HTTP_GET, handleEnrollStatus);
  server.on("/api/enroll/cancel", HTTP_POST, handleEnrollCancel);

  server.on("/api/records", HTTP_GET, handleRecords);

  server.on("/api/settings/autolock", HTTP_POST, handleAutoLock);
  server.on("/api/settings/raw", HTTP_GET, handleSettingsRaw);
  server.on("/api/settings", HTTP_GET, handleSettingsGet);
  server.on("/api/settings/app-autoclose", HTTP_POST, handleAppAutoClose);
  server.on("/api/settings/normally-open", HTTP_POST, handleNormallyOpen);
  server.on("/api/settings/factory-reset", HTTP_POST, handleFactoryReset);

  server.on("/api/cloud", HTTP_GET, handleCloudGet);
  server.on("/api/cloud", HTTP_POST, handleCloudSet);
  server.on("/api/ota", HTTP_POST, handleOtaPull);
  server.on("/api/ota/upload", HTTP_OPTIONS, handleOtaUploadOptions);
  server.on("/api/ota/upload", HTTP_POST, handleOtaUploadDone, handleOtaUploadChunk);
  server.on("/api/radio", HTTP_GET, handleRadio);
  server.on("/api/radio", HTTP_POST, handleRadio);
  server.on("/api/probe", HTTP_GET, handleProbe);
  server.on("/api/signal", HTTP_GET, handleSignal);
  server.on("/api/alerts", HTTP_GET, handleAlerts);
  server.on("/api/alerts/check", HTTP_POST, handleAlertsCheck);

  server.onNotFound([]() { sendError(404, "not found"); });
  server.begin();
}

void handleRestApi() {
  server.handleClient();
  autoCloseTick();
  batteryMonitorTick();
}
