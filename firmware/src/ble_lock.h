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

class BleLock {
 public:
  bool begin();                        // init NimBLE (call once)
  bool connectTo(const String& ref);   // scan by name/addr, connect, find FFE1
  void disconnect();
  bool isConnected();

  // One serialized request; waits for the acknowledgement frame.
  // Returns true if a frame arrived (inspect resp.error for the lock status).
  bool command(uint8_t cmd, const uint8_t* payload, size_t len, bool useInitial,
               lockproto::Frame& resp, uint32_t timeoutMs = 4000);

  // High-level operations. Each returns true on a success (error 0) response.
  bool login(const String& password, const String& lockId, int& errOut);
  bool getVersion(VersionInfo& v);
  bool getBattery(int& pct, float& volts);
  bool getTime(struct tm& t);
  bool setTime(const struct tm& t, int tzMinutes);
  bool freeUserId(uint32_t& id);
  bool unlock(uint32_t userId, const String& pin);
  bool lockDoor(uint32_t userId, const String& pin);
  bool deleteUser(uint32_t userId);
  bool reboot();

  bool authenticated() const { return _authenticated; }

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
  SemaphoreHandle_t _respSem = nullptr;
};

extern BleLock g_lock;
