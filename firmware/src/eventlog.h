// Gateway-side log of lock/unlock commands the gateway itself sent.
//
// The lock firmware does NOT record app/BLE-initiated unlocks (0x88) in its
// own log (live-validated: only keypad PIN / fingerprint / card opens are
// stored). So the gateway keeps its own ring of the actions it performed
// (from the app/REST, the cloud or the serial console) and /api/records merges
// it with the lock's log. Persisted in NVS so it survives reboots.
#pragma once

#include <Arduino.h>
#include <vector>

struct GwEvent {
  uint32_t epoch;     // UTC seconds (0 if the clock was not synced)
  uint32_t user;      // lock user id the command was sent as
  uint8_t action;     // 1 unlock, 0 lock
  uint8_t ok;         // 1 lock accepted the command
  uint8_t source;     // 0 app/REST, 1 cloud, 2 serial
  char lock[18];      // bound lock id
};

enum { EV_SRC_APP = 0, EV_SRC_CLOUD = 1, EV_SRC_SERIAL = 2, EV_SRC_AUTO = 3 };

void eventLogAdd(const String& lockId, uint32_t user, bool unlock, bool ok, uint8_t source);
// Events for `lockId` with epoch >= sinceEpoch (newest first).
void eventLogQuery(const String& lockId, uint32_t sinceEpoch, std::vector<GwEvent>& out);
