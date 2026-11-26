// High-level BLE client for the lock: connect, login, and run commands.
#pragma once

#include <Arduino.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include <vector>

#include "lock_protocol.h"

struct VersionInfo {
  String firmware;
  uint8_t flags = 0;
  int commandVersion = 0;
  bool adminExists = false;
};

struct ScanHit {
  String address;
  String name;
  int rssi = 0;
};

class BleLock {
 public:
  enum ConnectStatus { CONN_OK = 0, CONN_NOT_FOUND = 1, CONN_WEAK = 2, CONN_FAILED = 3 };

  bool begin();                        // init NimBLE (call once)
  // Scan by name/addr, check RSSI reachability, connect and find FFE1.
  // Returns a ConnectStatus; the matched advertisement RSSI is in lastRssi().
  int connectTo(const String& ref);
  void disconnect();
  bool isConnected();

  int lastRssi() const { return _lastRssi; }
  // Live RSSI of the open connection (dBm), or 0 if not connected.
  int liveRssi();
  void setMinRssi(int dbm) { _minRssi = dbm; }
  int minRssi() const { return _minRssi; }

  // One serialized request; waits for the acknowledgement frame.
  // Returns true if a frame arrived (inspect resp.error for the lock status).
  bool command(uint8_t cmd, const uint8_t* payload, size_t len, bool useInitial,
               lockproto::Frame& resp, uint32_t timeoutMs = 4000);

  // High-level operations. Each returns true on a success (error 0) response.
  bool login(const String& password, const String& lockId, int& errOut);
  // Fresh/factory-reset lock: set its connection password (the "Set
  // connection password" flow: 0x80 x2, 0x82, 0x8A set-time, 0x12 set-login-key).
  // errOut 33 = the lock already has a different connection password.
  bool provisionPassword(const String& password, const String& lockId, const struct tm& local,
                         int tzMinutes, int& errOut);
  bool getVersion(VersionInfo& v);
  bool getBattery(int& pct, float& volts);
  bool getTime(struct tm& t);
  bool setTime(const struct tm& t, int tzMinutes);
  bool freeUserId(uint32_t& id);
  bool unlock(uint32_t userId, const String& pin);
  bool lockDoor(uint32_t userId, const String& pin);
  bool deleteUser(uint32_t userId);
  bool reboot();

  // Discovery
  bool scanLocks(std::vector<ScanHit>& out, int durationSec = 4);

  // Users
  // raw = the full 60-byte structure (kept for read-modify-write updates;
  // contains the PIN field, so never return it over the API).
  struct UserRec {
    uint32_t id; String name; int group;
    int fingers = 0; bool card = false; bool pin = false;
    uint8_t sched[12] = {0};
    uint8_t raw[60] = {0};
  };
  // Rewrite a user's name and/or 12-byte validity block (0xA4), then read back.
  bool updateUser(uint32_t id, const String* name, const uint8_t* sched, UserRec& out);
  bool listUsers(std::vector<UserRec>& out);
  String lastUserError;  // why listUsers failed (for the API error message)
  static String hexOf(const std::vector<uint8_t>& v);
  bool addUser(const String& name, int group, const String& pin, uint32_t& newId);

  // Credential enrollment (type: 1 finger, 2 pin, 3 card)
  bool enrollStart(int type, uint32_t user, const String& pin);
  int lastEnrollError = 0;  // lock error code of the last enrollStart (-1 = no answer)
  // Remove one credential type from a user (0xAB): 1 fingerprint, 2 PIN, 3 card.
  bool deleteCredential(uint32_t user, int type);
  bool enrollStatus(int& statusByte, int& payloadLen);
  bool cancelEnroll();

  // Records
  struct RecordRec { uint32_t user; String time; int mode; int direction; };
  bool readRecords(int year0, int mon0, int day0, int year1, int mon1, int day1,
                   std::vector<RecordRec>& out);

  // Settings
  bool getParameterRaw(int selector, std::vector<uint8_t>& out);
  bool setAutoLock(int seconds);
  bool setNormallyOpen(int weekdayMask, int startMin, int endMin);
  bool clearNormallyOpen();  // writes FF FF FF FF = no normally-open schedule
  bool factoryReset();

  // Set the lock clock to the given broken-down time (used with NTP).
  bool setTimeTo(const struct tm& t, int tzMinutes);

  bool authenticated() const { return _authenticated; }
  const String& currentLockId() const { return _currentLockId; }
  int lastBatteryPct() const { return _lastBattery; }
  void setLastBatteryPct(int v) { _lastBattery = v; }

  // Called from the BLE task by the notification callback.
  void onNotify(const uint8_t* data, size_t len);

 private:
  void* _client = nullptr;  // NimBLEClient*
  void* _ffe1 = nullptr;    // NimBLERemoteCharacteristic*
  uint32_t _sessionAddr = lockproto::INITIAL_ADDRESS;
  int _pendingCmd = -1;
  bool _authenticated = false;
  std::vector<uint8_t> _acc;
  std::vector<uint8_t> _respBuf;
  std::vector<uint8_t> _lastRaw;  // last frame received (diagnostics)
  SemaphoreHandle_t _respSem = nullptr;
  int _lastBattery = -1;
  int _lastRssi = 0;
  int _minRssi = -92;  // below this, the lock is treated as unreachable
  String _currentLockId;
};

extern BleLock g_lock;
