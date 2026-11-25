#include "rest_api.h"

#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <HTTPUpdate.h>
#include <WebServer.h>
#include <WiFi.h>
#include <time.h>

#include "ble_lock.h"
#include "cloud.h"
#include "config.h"
#include "led.h"

extern volatile bool g_wifiReconnect;  // set to trigger a reconnect in main's loop

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

// Set the lock clock from NTP on first connect or after a battery recovery.
static void maybeSyncClock(LockEntry* e) {
  int pct; float v;
  if (!g_lock.getBattery(pct, v)) return;
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

// ---- provisioning page (served in SoftAP and on the LAN) ------------------ //

static void handleRoot() {
  String ip = WiFi.isConnected() ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
  String html =
      "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
      "<title>Jenix Lock Gateway</title><style>body{font-family:system-ui;margin:24px;max-width:480px}"
      "input{width:100%;padding:10px;margin:6px 0;box-sizing:border-box}button{padding:10px 16px}</style></head><body>"
      "<h2>Jenix Lock Gateway</h2><p>IP: " + ip + " &middot; locks bound: " + String(g_cfg.locks.size()) + "</p>"
      "<h3>Wi-Fi setup</h3><form method=POST action=/api/wifi>"
      "<input name=ssid placeholder='Wi-Fi name (SSID)'>"
      "<input name=pass placeholder='Wi-Fi password' type=password>"
      "<button type=submit>Save &amp; connect</button></form>"
      "<p style='color:#666;font-size:13px'>After saving, the gateway joins your Wi-Fi. "
      "Use the app or the REST API (bearer token) to add and operate locks.</p></body></html>";
  server.send(200, "text/html", html);
}

static void handleWifiSet() {
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  if (ssid.length() == 0) { sendError(400, "ssid required"); return; }
  g_cfg.wifiSsid = ssid;
  g_cfg.wifiPass = pass;
  g_cfg.save();
  server.send(200, "text/html",
              "<html><body style='font-family:system-ui;margin:24px'>Saved. Connecting to " +
                  ssid + " ... check your router for the new IP.</body></html>");
  g_wifiReconnect = true;
}

// ---- API: status, locks, scan, bind --------------------------------------- //

static void handleHealth() {
  JsonDocument doc;
  doc["ok"] = true;
  doc["firmware"] = "jenix-gateway";
  doc["wifi"] = WiFi.isConnected() ? WiFi.localIP().toString() : WiFi.softAPIP().toString();
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

static void handleUnlock() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  uint32_t user = req["user"] | 0;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  if (!g_lock.unlock(user, pin)) { sendError(502, "unlock rejected"); return; }
  ledEvent(LED_UNLOCK);
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

static void handleLock() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  uint32_t user = req["user"] | 0;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  if (!g_lock.lockDoor(user, pin)) { sendError(502, "lock rejected"); return; }
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

static void handleUsersGet() {
  if (!authorized()) return;
  JsonDocument req; parseBody(req);
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  std::vector<BleLock::UserRec> users;
  if (!g_lock.listUsers(users)) { sendError(502, "user read failed"); return; }
  JsonDocument doc; doc["ok"] = true;
  JsonArray arr = doc["users"].to<JsonArray>();
  for (auto& u : users) {
    JsonObject o = arr.add<JsonObject>();
    o["id"] = u.id; o["name"] = u.name;
    o["group"] = (u.group == 1) ? "admin" : "general";
  }
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
  if (!g_lock.enrollStart(type, user, pin)) { sendError(502, "enroll start failed"); return; }
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
  JsonDocument doc; doc["ok"] = true; doc["status"] = status; doc["payload_len"] = len;
  doc["done"] = (status == 0 && len <= 1);
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
  String err;
  if (!ensureSession(pickLock(req), err)) { sendError(502, err); return; }
  int days = server.hasArg("days") ? server.arg("days").toInt() : 7;
  if (days < 1) days = 1;
  int y0 = 2000, m0 = 1, d0 = 1, y1 = 2099, m1 = 12, d1 = 31;
  if (timeValid()) {
    time_t end = time(nullptr);
    time_t start = end - (time_t)(days - 1) * 86400;
    struct tm ts, te;
    gmtime_r(&start, &ts); gmtime_r(&end, &te);
    y0 = ts.tm_year + 1900; m0 = ts.tm_mon + 1; d0 = ts.tm_mday;
    y1 = te.tm_year + 1900; m1 = te.tm_mon + 1; d1 = te.tm_mday;
  }
  std::vector<BleLock::RecordRec> recs;
  if (!g_lock.readRecords(y0, m0, d0, y1, m1, d1, recs)) { sendError(502, "record read failed"); return; }
  JsonDocument doc; doc["ok"] = true; doc["count"] = (int)recs.size();
  JsonArray arr = doc["records"].to<JsonArray>();
  for (auto& r : recs) {
    JsonObject o = arr.add<JsonObject>();
    o["user"] = r.user; o["time"] = r.time;
    const char* mode = r.mode == 1 ? "fingerprint" : r.mode == 2 ? "card"
                       : r.mode == 4 ? "pin" : "other";
    o["mode"] = mode; o["mode_byte"] = r.mode; o["direction"] = r.direction;
  }
  sendJson(200, doc);
}

// ---- API: settings -------------------------------------------------------- //

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
  int mask = req["weekday_mask"] | 0x7F;
  int startMin = req["start_minute"] | 0;
  int endMin = req["end_minute"] | 1439;
  if (!g_lock.setNormallyOpen(mask, startMin, endMin)) { sendError(502, "set normally-open failed"); return; }
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

// ---- OTA (pull from a URL, e.g. a VPS) ------------------------------------ //
// Writes only the app partition; NVS (Wi-Fi, token, locks, cloud) is preserved.

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
  const char* headerKeys[] = {"Authorization"};
  server.collectHeaders(headerKeys, 1);

  server.on("/", HTTP_GET, handleRoot);
  server.on("/api/wifi", HTTP_POST, handleWifiSet);

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

  server.on("/api/enroll", HTTP_POST, handleEnrollStart);
  server.on("/api/enroll/status", HTTP_GET, handleEnrollStatus);
  server.on("/api/enroll/cancel", HTTP_POST, handleEnrollCancel);

  server.on("/api/records", HTTP_GET, handleRecords);

  server.on("/api/settings/autolock", HTTP_POST, handleAutoLock);
  server.on("/api/settings/normally-open", HTTP_POST, handleNormallyOpen);
  server.on("/api/settings/factory-reset", HTTP_POST, handleFactoryReset);

  server.on("/api/cloud", HTTP_GET, handleCloudGet);
  server.on("/api/cloud", HTTP_POST, handleCloudSet);
  server.on("/api/ota", HTTP_POST, handleOtaPull);

  server.onNotFound([]() { sendError(404, "not found"); });
  server.begin();
}

void handleRestApi() {
  server.handleClient();
}
