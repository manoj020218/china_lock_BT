#include "cloud.h"

#include <ArduinoJson.h>
#include <PubSubClient.h>
#include <WiFi.h>

#include "ble_lock.h"
#include "config.h"
#include "eventlog.h"
#include "rest_api.h"

static WiFiClient net;
static PubSubClient mqtt(net);
static String base;
static uint32_t lastBeat = 0;
static uint32_t lastTry = 0;

static String deviceId() {
  if (g_cfg.cloudClientId.length()) return g_cfg.cloudClientId;
  uint64_t mac = ESP.getEfuseMac();
  char b[20];
  snprintf(b, sizeof(b), "jenix-%04X", (uint16_t)(mac & 0xFFFF));
  return String(b);
}

static bool ensureLock(const String& lockId, String& err) {
  LockEntry* e = g_cfg.find(lockId);
  if (!e) { err = "lock not bound"; return false; }
  if (g_lock.isConnected() && !g_lock.currentLockId().equalsIgnoreCase(lockId)) g_lock.disconnect();
  if (!g_lock.isConnected()) {
    int st = g_lock.connectTo(lockId);
    if (st == BleLock::CONN_WEAK) { err = "not reachable (weak signal)"; return false; }
    if (st != BleLock::CONN_OK) { err = "not reachable"; return false; }
  }
  if (!g_lock.authenticated()) {
    int ec = 0;
    if (!g_lock.login(e->password, lockId, ec)) { err = "login error " + String(ec); return false; }
  }
  return true;
}

static void publishHeartbeat() {
  if (!mqtt.connected()) return;
  JsonDocument d;
  d["device"] = deviceId();
  d["uptime"] = (uint32_t)(millis() / 1000);
  d["rssi"] = WiFi.RSSI();
  d["heap"] = ESP.getFreeHeap();
  d["locks"] = g_cfg.locks.size();
  String s; serializeJson(d, s);
  mqtt.publish((base + "/heartbeat").c_str(), s.c_str());
}

static String strOr(JsonVariant v, const char* dflt) {
  return v.is<const char*>() ? String((const char*)v) : String(dflt);
}

static void onMessage(char* /*topic*/, byte* payload, unsigned int len) {
  JsonDocument cmd;
  if (deserializeJson(cmd, payload, len)) return;
  String op = strOr(cmd["op"], "");
  String id = strOr(cmd["id"], "");
  String lockId = cmd["lock"].is<const char*>() ? String((const char*)cmd["lock"])
                  : (g_cfg.only() ? g_cfg.only()->id : String(""));

  JsonDocument resp;
  resp["id"] = id;
  resp["op"] = op;

  if (op == "status") {
    resp["ok"] = true;
    resp["online"] = true;
    resp["locks"] = g_cfg.locks.size();
  } else {
    String err;
    if (!ensureLock(lockId, err)) {
      resp["ok"] = false;
      resp["error"] = err;
    } else if (op == "unlock") {
      resp["ok"] = g_lock.unlock(cmd["user"] | 0, strOr(cmd["pin"], ""));
      eventLogAdd(g_lock.currentLockId(), cmd["user"] | 0, true, resp["ok"] | false, EV_SRC_CLOUD);
      if (resp["ok"] | false) autoCloseSchedule(g_lock.currentLockId(), cmd["user"] | 0, strOr(cmd["pin"], ""));
    } else if (op == "lock") {
      resp["ok"] = g_lock.lockDoor(cmd["user"] | 0, strOr(cmd["pin"], ""));
      eventLogAdd(g_lock.currentLockId(), cmd["user"] | 0, false, resp["ok"] | false, EV_SRC_CLOUD);
    } else if (op == "battery") {
      int p; float v;
      if (g_lock.getBattery(p, v)) { resp["ok"] = true; resp["percent"] = p; resp["voltage"] = v; }
      else resp["ok"] = false;
    } else {
      resp["ok"] = false;
      resp["error"] = "unknown op";
    }
  }
  String s; serializeJson(resp, s);
  mqtt.publish((base + "/resp").c_str(), s.c_str());
}

static void connectCloud() {
  if (!g_cfg.cloudEnabled || g_cfg.cloudHost.length() == 0 || !WiFi.isConnected()) return;
  if (millis() - lastTry < 5000) return;  // backoff
  lastTry = millis();

  mqtt.setServer(g_cfg.cloudHost.c_str(), g_cfg.cloudPort);
  mqtt.setBufferSize(1024);
  mqtt.setCallback(onMessage);
  base = "jenix/" + deviceId();
  String statusTopic = base + "/status";

  bool ok;
  const char* willMsg = "{\"online\":false}";
  if (g_cfg.cloudUser.length()) {
    ok = mqtt.connect(deviceId().c_str(), g_cfg.cloudUser.c_str(), g_cfg.cloudPass.c_str(),
                      statusTopic.c_str(), 0, true, willMsg);
  } else {
    ok = mqtt.connect(deviceId().c_str(), nullptr, nullptr,
                      statusTopic.c_str(), 0, true, willMsg);
  }
  if (ok) {
    // Handshake: retained online status, subscribe to commands, first heartbeat.
    JsonDocument d;
    d["online"] = true;
    d["device"] = deviceId();
    d["fw"] = "jenix-gateway";
    d["locks"] = g_cfg.locks.size();
    String s; serializeJson(d, s);
    mqtt.publish(statusTopic.c_str(), s.c_str(), true);
    mqtt.subscribe((base + "/cmd").c_str());
    publishHeartbeat();
    Serial.println(F("# cloud: connected"));
  }
}

void cloudSetup() { /* lazy connect in cloudLoop */ }

void cloudLoop() {
  if (!g_cfg.cloudEnabled) return;
  if (!mqtt.connected()) {
    connectCloud();
  } else {
    mqtt.loop();
    if (millis() - lastBeat > 30000) { lastBeat = millis(); publishHeartbeat(); }
  }
}

bool cloudConnected() { return mqtt.connected(); }
