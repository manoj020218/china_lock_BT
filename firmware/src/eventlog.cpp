#include "eventlog.h"

#include <Preferences.h>
#include <time.h>

static const int CAP = 100;  // ~3 KB in NVS
static GwEvent s_ring[CAP];
static uint16_t s_head = 0;   // next write slot
static uint16_t s_count = 0;
static bool s_loaded = false;

static void load() {
  if (s_loaded) return;
  s_loaded = true;
  Preferences p;
  if (!p.begin("evlog", true)) return;
  size_t n = p.getBytesLength("ring");
  if (n == sizeof(s_ring)) {
    p.getBytes("ring", s_ring, sizeof(s_ring));
    s_head = p.getUShort("head", 0) % CAP;
    s_count = min<uint16_t>(p.getUShort("count", 0), CAP);
  }
  p.end();
}

static void persist() {
  Preferences p;
  if (!p.begin("evlog", false)) return;
  p.putBytes("ring", s_ring, sizeof(s_ring));
  p.putUShort("head", s_head);
  p.putUShort("count", s_count);
  p.end();
}

void eventLogAdd(const String& lockId, uint32_t user, bool unlock, bool ok, uint8_t source) {
  load();
  GwEvent& e = s_ring[s_head];
  memset(&e, 0, sizeof(e));
  time_t now = time(nullptr);
  e.epoch = now > 1735689600 ? (uint32_t)now : 0;  // only if NTP-synced
  e.user = user;
  e.action = unlock ? 1 : 0;
  e.ok = ok ? 1 : 0;
  e.source = source;
  strncpy(e.lock, lockId.c_str(), sizeof(e.lock) - 1);
  s_head = (s_head + 1) % CAP;
  if (s_count < CAP) s_count++;
  persist();
}

void eventLogQuery(const String& lockId, uint32_t sinceEpoch, std::vector<GwEvent>& out) {
  load();
  for (int i = 0; i < s_count; i++) {
    int idx = (s_head - 1 - i + CAP) % CAP;  // newest first
    const GwEvent& e = s_ring[idx];
    if (!lockId.equalsIgnoreCase(e.lock)) continue;
    if (e.epoch && e.epoch < sinceEpoch) continue;
    out.push_back(e);
  }
}
