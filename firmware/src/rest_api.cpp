#include "rest_api.h"

#include <ArduinoJson.h>
#include <WebServer.h>
#include <WiFi.h>

#include "ble_lock.h"
#include "config.h"

static WebServer server(80);

static void sendJson(int code, JsonDocument& doc) {
  String body;
  serializeJson(doc, body);
  server.send(code, "application/json", body);
}

static void sendError(int code, const String& message) {
  JsonDocument doc;
  doc["ok"] = false;
  doc["error"] = message;
  sendJson(code, doc);
}

// Bearer-token auth. Returns true if authorized (or sends 401 and returns false).
static bool authorized() {
  String hdr = server.header("Authorization");
  String expected = "Bearer " + g_cfg.apiToken;
  if (g_cfg.apiToken.length() && hdr == expected) return true;
  sendError(401, "unauthorized");
  return false;
}

// Ensure a live, authenticated BLE session to the lock.
static bool ensureSession(String& err) {
  if (!g_cfg.lockConfigured()) { err = "lock not bound (POST /api/bind)"; return false; }
  if (!g_lock.isConnected()) {
    if (!g_lock.connectTo(g_cfg.lockId)) {
      err = "lock not found / connect failed (is it awake?)";
      return false;
    }
  }
  if (!g_lock.authenticated()) {
    int e = 0;
    if (!g_lock.login(g_cfg.lockPassword, g_cfg.lockId, e)) {
      err = "login failed (error " + String(e) + ")";
      return false;
    }
  }
  return true;
}

// ---- handlers ------------------------------------------------------------- //

static void handleHealth() {
  JsonDocument doc;
  doc["ok"] = true;
  doc["firmware"] = "jenix-bridge";
  doc["wifi"] = WiFi.isConnected() ? WiFi.localIP().toString()
                                   : WiFi.softAPIP().toString();
  doc["lock_configured"] = g_cfg.lockConfigured();
  doc["lock_connected"] = g_lock.isConnected();
  sendJson(200, doc);
}

static void handleBind() {
  if (!authorized()) return;
  JsonDocument req;
  if (deserializeJson(req, server.arg("plain"))) { sendError(400, "bad json"); return; }
  if (!req["lock_id"].is<const char*>() || !req["password"].is<const char*>()) {
    sendError(400, "lock_id and password required");
    return;
  }
  g_cfg.lockId = String((const char*)req["lock_id"]);
  g_cfg.lockPassword = String((const char*)req["password"]);
  if (req["tz_minutes"].is<int>()) g_cfg.tzMinutes = req["tz_minutes"];
  g_cfg.save();
  JsonDocument doc;
  doc["ok"] = true;
  doc["lock_id"] = g_cfg.lockId;
  sendJson(200, doc);
}

static void handleVersion() {
  if (!authorized()) return;
  String err;
  if (!ensureSession(err)) { sendError(502, err); return; }
  VersionInfo v;
  if (!g_lock.getVersion(v)) { sendError(502, "version read failed"); return; }
  JsonDocument doc;
  doc["ok"] = true;
  doc["firmware"] = v.firmware;
  doc["command_version"] = v.commandVersion;
  doc["admin_exists"] = v.adminExists;
  sendJson(200, doc);
}

static void handleBattery() {
  if (!authorized()) return;
  String err;
  if (!ensureSession(err)) { sendError(502, err); return; }
  int pct; float volts;
  if (!g_lock.getBattery(pct, volts)) { sendError(502, "battery read failed"); return; }
  JsonDocument doc;
  doc["ok"] = true;
  doc["percent"] = pct;
  doc["voltage"] = volts;
  sendJson(200, doc);
}

static void handleGetTime() {
  if (!authorized()) return;
  String err;
  if (!ensureSession(err)) { sendError(502, err); return; }
  struct tm t;
  if (!g_lock.getTime(t)) { sendError(502, "time read failed"); return; }
  char buf[32];
  strftime(buf, sizeof(buf), "%Y-%m-%d %H:%M:%S", &t);
  JsonDocument doc;
  doc["ok"] = true;
  doc["time"] = buf;
  sendJson(200, doc);
}

static void handleSetTime() {
  if (!authorized()) return;
  String err;
  if (!ensureSession(err)) { sendError(502, err); return; }
  JsonDocument req;
  deserializeJson(req, server.arg("plain"));  // optional body
  struct tm t = {};
  int tz = g_cfg.tzMinutes;
  if (req["epoch"].is<long>()) {
    time_t e = (time_t)(long)req["epoch"];
    localtime_r(&e, &t);
  } else {
    // default: no RTC on the board either, so require the fields
    t.tm_year = (req["year"].is<int>() ? (int)req["year"] : 2026) - 1900;
    t.tm_mon = (req["month"].is<int>() ? (int)req["month"] : 1) - 1;
    t.tm_mday = req["day"].is<int>() ? (int)req["day"] : 1;
    t.tm_hour = req["hour"].is<int>() ? (int)req["hour"] : 0;
    t.tm_min = req["minute"].is<int>() ? (int)req["minute"] : 0;
    t.tm_sec = req["second"].is<int>() ? (int)req["second"] : 0;
  }
  if (req["tz_minutes"].is<int>()) tz = req["tz_minutes"];
  if (!g_lock.setTime(t, tz)) { sendError(502, "set-time failed"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

static void handleUnlock() {
  if (!authorized()) return;
  String err;
  if (!ensureSession(err)) { sendError(502, err); return; }
  JsonDocument req;
  deserializeJson(req, server.arg("plain"));
  uint32_t user = req["user"].is<uint32_t>() ? (uint32_t)req["user"] : 0;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  if (!g_lock.unlock(user, pin)) { sendError(502, "unlock rejected"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

static void handleLock() {
  if (!authorized()) return;
  String err;
  if (!ensureSession(err)) { sendError(502, err); return; }
  JsonDocument req;
  deserializeJson(req, server.arg("plain"));
  uint32_t user = req["user"].is<uint32_t>() ? (uint32_t)req["user"] : 0;
  String pin = req["pin"].is<const char*>() ? String((const char*)req["pin"]) : "";
  if (!g_lock.lockDoor(user, pin)) { sendError(502, "lock rejected"); return; }
  JsonDocument doc; doc["ok"] = true; sendJson(200, doc);
}

void setupRestApi() {
  const char* headerKeys[] = {"Authorization"};
  server.collectHeaders(headerKeys, 1);

  server.on("/api/health", HTTP_GET, handleHealth);
  server.on("/api/bind", HTTP_POST, handleBind);
  server.on("/api/version", HTTP_GET, handleVersion);
  server.on("/api/battery", HTTP_GET, handleBattery);
  server.on("/api/time", HTTP_GET, handleGetTime);
  server.on("/api/time", HTTP_POST, handleSetTime);
  server.on("/api/unlock", HTTP_POST, handleUnlock);
  server.on("/api/lock", HTTP_POST, handleLock);
  server.onNotFound([]() { sendError(404, "not found"); });
  server.begin();
}

void handleRestApi() {
  server.handleClient();
}
