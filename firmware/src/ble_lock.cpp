#include "ble_lock.h"

#include <NimBLEDevice.h>

#include "radio.h"

BleLock g_lock;

static const uint16_t SERVICE_FFE0 = 0xFFE0;
static const uint16_t CHAR_FFE1 = 0xFFE1;
static const size_t WRITE_CHUNK = 20;

static void notifyCB(NimBLERemoteCharacteristic*, uint8_t* data, size_t len, bool) {
  g_lock.onNotify(data, len);
}

void BleLock::onNotify(const uint8_t* data, size_t len) {
  _acc.insert(_acc.end(), data, data + len);
  // Drop bytes before a preamble, then emit the first complete frame.
  while (_acc.size() >= 2 && !(_acc[0] == lockproto::PREAMBLE0 && _acc[1] == lockproto::PREAMBLE1)) {
    _acc.erase(_acc.begin());
  }
  size_t frameSize = 0;
  if (lockproto::completeFrameSize(_acc.data(), _acc.size(), frameSize)) {
    _respBuf.assign(_acc.begin(), _acc.begin() + frameSize);
    _acc.erase(_acc.begin(), _acc.begin() + frameSize);
    if (_respSem) xSemaphoreGive(_respSem);
  }
}

bool BleLock::begin() {
  if (_respSem == nullptr) _respSem = xSemaphoreCreateBinary();
  NimBLEDevice::init("jenix-bridge");
  radioApplyBle();  // configured BLE TX power (radio.h)
  NimBLEDevice::setMTU(247);
  return true;
}

static bool matchArg(NimBLEAdvertisedDevice& d, const String& arg) {
  String a = arg; a.toLowerCase();
  String addr = String(d.getAddress().toString().c_str()); addr.toLowerCase();
  String name = String(d.getName().c_str()); name.toLowerCase();
  return addr == a || (name.length() && name.indexOf(a) >= 0);
}

// Stops the scan as soon as the wanted lock advertises, instead of always
// waiting the full scan window (saved ~3 s on every first connection).
class StopOnMatch : public NimBLEAdvertisedDeviceCallbacks {
 public:
  String target;
  void onResult(NimBLEAdvertisedDevice* d) override {
    if (target.length() && matchArg(*d, target)) NimBLEDevice::getScan()->stop();
  }
};
static StopOnMatch s_stopOnMatch;

int BleLock::connectTo(const String& ref) {
  if (isConnected()) return CONN_OK;
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  s_stopOnMatch.target = ref;
  scan->setAdvertisedDeviceCallbacks(&s_stopOnMatch, false);
  NimBLEScanResults results = scan->start(4, false);  // returns early on a match
  scan->setAdvertisedDeviceCallbacks(nullptr);
  s_stopOnMatch.target = "";
  NimBLEAdvertisedDevice chosen;
  bool found = false;
  for (int i = 0; i < results.getCount(); i++) {
    NimBLEAdvertisedDevice d = results.getDevice(i);
    if (matchArg(d, ref)) { chosen = d; found = true; break; }
  }
  if (!found) { scan->clearResults(); return CONN_NOT_FOUND; }

  // Reachability: reject a lock whose advertised signal is too weak, so the
  // caller knows the command would not reliably reach the lock.
  _lastRssi = chosen.getRSSI();
  if (_lastRssi < _minRssi) { scan->clearResults(); return CONN_WEAK; }
  scan->clearResults();

  NimBLEClient* client = (NimBLEClient*)_client;
  if (!client) {
    client = NimBLEDevice::createClient();
    client->setConnectTimeout(10);
    _client = client;
  }
  if (!client->connect(&chosen)) return CONN_FAILED;
  NimBLERemoteService* svc = client->getService(NimBLEUUID(SERVICE_FFE0));
  if (!svc) { client->disconnect(); return CONN_FAILED; }
  NimBLERemoteCharacteristic* ffe1 = svc->getCharacteristic(NimBLEUUID(CHAR_FFE1));
  if (!ffe1) { client->disconnect(); return CONN_FAILED; }
  _ffe1 = ffe1;
  if (ffe1->canNotify()) ffe1->subscribe(true, notifyCB);
  _sessionAddr = lockproto::INITIAL_ADDRESS;
  _authenticated = false;
  _acc.clear();
  return CONN_OK;
}

void BleLock::disconnect() {
  NimBLEClient* client = (NimBLEClient*)_client;
  if (client && client->isConnected()) {
    client->disconnect();
    // disconnect() is asynchronous: wait until the link is really down, or the
    // next connectTo() sees "still connected" and sends the next lock's login
    // over the old link (first command after switching locks timed out).
    uint32_t t0 = millis();
    while (client->isConnected() && millis() - t0 < 3000) delay(20);
  }
  _authenticated = false;
  _sessionAddr = lockproto::INITIAL_ADDRESS;
}

int BleLock::liveRssi() {
  NimBLEClient* client = (NimBLEClient*)_client;
  if (!client || !client->isConnected()) return 0;
  int r = client->getRssi();
  if (r < 0) _lastRssi = r;
  return r;
}

bool BleLock::isConnected() {
  NimBLEClient* client = (NimBLEClient*)_client;
  return client && client->isConnected();
}

bool BleLock::command(uint8_t cmd, const uint8_t* payload, size_t len, bool useInitial,
                      lockproto::Frame& resp, uint32_t timeoutMs) {
  NimBLERemoteCharacteristic* ffe1 = (NimBLERemoteCharacteristic*)_ffe1;
  if (!isConnected() || !ffe1) return false;
  uint32_t addr = useInitial ? lockproto::INITIAL_ADDRESS : _sessionAddr;
  std::vector<uint8_t> frame = lockproto::encodeCommand(cmd, payload, len, addr);

  xSemaphoreTake(_respSem, 0);  // clear any stale signal
  _pendingCmd = cmd;
  _acc.clear();
  for (size_t off = 0; off < frame.size(); off += WRITE_CHUNK) {
    size_t n = min(WRITE_CHUNK, frame.size() - off);
    if (!ffe1->writeValue(frame.data() + off, n, true)) return false;
  }
  // The lock can push unsolicited frames (e.g. a 0x89 event after a card or
  // fingerprint was presented). Skip anything that is not the reply to this
  // command and keep waiting, instead of failing the command.
  uint32_t t0 = millis();
  for (;;) {
    uint32_t el = millis() - t0;
    if (el >= timeoutMs) return false;
    if (xSemaphoreTake(_respSem, pdMS_TO_TICKS(timeoutMs - el)) != pdTRUE) return false;
    _lastRaw = _respBuf;
    lockproto::Frame f;
    if (!lockproto::decodeFrame(_respBuf.data(), _respBuf.size(), _pendingCmd, f)) {
      Serial.print(F("# ble: skipped undecodable frame ")); Serial.println(hexOf(_respBuf));
      continue;
    }
    if (f.flag == lockproto::FLAG_COMMAND || (f.flag == lockproto::FLAG_ACK_WITH_COMMAND && f.command != cmd)) {
      Serial.print(F("# ble: skipped unsolicited frame cmd 0x")); Serial.println(f.command, HEX);
      continue;
    }
    resp = f;
    return true;
  }
}

String BleLock::hexOf(const std::vector<uint8_t>& v) {
  String h; char b[4];
  for (auto x : v) { snprintf(b, sizeof(b), "%02x", x); h += b; }
  return h;
}

bool BleLock::login(const String& password, const String& lockId, int& errOut) {
  VersionInfo v;
  if (!getVersion(v)) { errOut = -1; return false; }
  String key = lockproto::legacyLoginKey(password, lockId);
  lockproto::Frame resp;
  if (!command(lockproto::CMD_ADMIN_LOGIN, (const uint8_t*)key.c_str(), key.length(),
               true, resp)) {
    errOut = -1;
    return false;
  }
  errOut = resp.error;
  if (resp.error != 0) return false;
  if (resp.address != 0 && resp.address != lockproto::INITIAL_ADDRESS) {
    _sessionAddr = resp.address;
  }
  _authenticated = true;
  _currentLockId = lockId;
  return true;
}

bool BleLock::provisionPassword(const String& password, const String& lockId,
                                const struct tm& t, int tzMinutes, int& errOut) {
  errOut = -1;
  lockproto::Frame r;
  // Mirrors the vendor app's captured onboarding sequence; all on the initial address.
  if (!command(lockproto::CMD_GET_VERSION, nullptr, 0, true, r)) return false;
  if (!command(lockproto::CMD_GET_VERSION, nullptr, 0, true, r)) return false;
  if (!command(lockproto::CMD_GET_UID, nullptr, 0, true, r)) return false;
  uint8_t tp[8];
  tp[0] = (uint8_t)(t.tm_year - 100); tp[1] = t.tm_mon + 1; tp[2] = t.tm_mday;
  tp[3] = t.tm_hour; tp[4] = t.tm_min; tp[5] = t.tm_sec;
  uint16_t tz = (uint16_t)(tzMinutes & 0xFFFF);
  tp[6] = (tz >> 8) & 0xFF; tp[7] = tz & 0xFF;
  if (!command(lockproto::CMD_SET_TIME, tp, 8, true, r)) return false;
  // 33 here = already provisioned with another password (safe no-op, live-validated).
  if (r.error != 0) { errOut = r.error; return false; }
  String key = lockproto::legacyLoginKey(password, lockId);
  std::vector<uint8_t> kp((const uint8_t*)key.c_str(), (const uint8_t*)key.c_str() + key.length());
  kp.push_back(0);
  if (!command(lockproto::CMD_SET_LOGIN_KEY, kp.data(), kp.size(), true, r)) return false;
  errOut = r.error;
  return r.error == 0;
}

bool BleLock::updateUser(uint32_t id, const String* name, const uint8_t* sched, UserRec& out) {
  std::vector<UserRec> users;
  if (!listUsers(users)) return false;
  UserRec* cur = nullptr;
  for (auto& u : users) if (u.id == id) { cur = &u; break; }
  if (!cur) return false;
  uint8_t buf[60];
  memcpy(buf, cur->raw, 60);
  if (name) {
    for (int i = 0; i < 22; i++) buf[4 + i] = i < (int)name->length() ? (uint8_t)(*name)[i] : 0x00;
  }
  if (sched) memcpy(&buf[48], sched, 12);
  lockproto::Frame r;
  if (!command(lockproto::CMD_SET_USER, buf, 60, false, r) || r.error != 0) return false;
  users.clear();
  if (!listUsers(users)) return false;
  for (auto& u : users) if (u.id == id) { out = u; return true; }
  return false;
}

bool BleLock::setTimeTo(const struct tm& t, int tzMinutes) {
  return setTime(t, tzMinutes);
}

bool BleLock::getVersion(VersionInfo& v) {
  lockproto::Frame resp;
  if (!command(lockproto::CMD_GET_VERSION, nullptr, 0, !_authenticated, resp)) return false;
  if (resp.error != 0 && resp.error != -1) return false;
  const auto& p = resp.payload;
  int nul = -1;
  for (size_t i = 0; i < p.size(); i++) if (p[i] == 0) { nul = i; break; }
  if (nul < 0) return false;
  v.firmware = String((const char*)p.data()).substring(0, nul);
  uint8_t flags = (nul + 1 < (int)p.size()) ? p[nul + 1] : 0;
  v.flags = flags;
  v.commandVersion = (flags >> 4) & 0x0F;
  v.adminExists = flags & 0x04;
  return true;
}

bool BleLock::getBattery(int& pct, float& volts) {
  lockproto::Frame resp;
  if (!command(lockproto::CMD_GET_BATTERY, nullptr, 0, false, resp)) return false;
  if (resp.error != 0 || resp.payload.size() < 2) return false;
  pct = resp.payload[0];
  volts = resp.payload[1] / 10.0f;
  return true;
}

bool BleLock::getTime(struct tm& t) {
  lockproto::Frame resp;
  if (!command(lockproto::CMD_GET_TIME, nullptr, 0, false, resp)) return false;
  if (resp.error != 0 || resp.payload.size() < 6) return false;
  const auto& p = resp.payload;
  t = {};
  t.tm_year = 100 + p[0];  // years since 1900
  t.tm_mon = p[1] - 1;
  t.tm_mday = p[2];
  t.tm_hour = p[3];
  t.tm_min = p[4];
  t.tm_sec = p[5];
  return true;
}

bool BleLock::setTime(const struct tm& t, int tzMinutes) {
  uint8_t p[8];
  p[0] = (uint8_t)(t.tm_year - 100);
  p[1] = t.tm_mon + 1;
  p[2] = t.tm_mday;
  p[3] = t.tm_hour;
  p[4] = t.tm_min;
  p[5] = t.tm_sec;
  uint16_t tz = (uint16_t)(tzMinutes & 0xFFFF);
  p[6] = (tz >> 8) & 0xFF;
  p[7] = tz & 0xFF;
  lockproto::Frame resp;
  if (!command(lockproto::CMD_SET_TIME, p, 8, false, resp)) return false;
  return resp.error == 0;
}

bool BleLock::freeUserId(uint32_t& id) {
  lockproto::Frame resp;
  if (!command(lockproto::CMD_GET_FREE_USER_ID, nullptr, 0, false, resp)) return false;
  if (resp.error != 0 || resp.payload.size() < 4) return false;
  id = ((uint32_t)resp.payload[0] << 24) | ((uint32_t)resp.payload[1] << 16) |
       ((uint32_t)resp.payload[2] << 8) | resp.payload[3];
  return true;
}

static bool lockActionCmd(BleLock& self, uint8_t action, uint32_t userId,
                          const String& pin) {
  std::vector<uint8_t> p;
  p.push_back(action);
  p.push_back((userId >> 24) & 0xFF);
  p.push_back((userId >> 16) & 0xFF);
  p.push_back((userId >> 8) & 0xFF);
  p.push_back(userId & 0xFF);
  for (size_t i = 0; i < pin.length(); i++) p.push_back((uint8_t)pin[i]);
  lockproto::Frame resp;
  if (!self.command(lockproto::CMD_LOCK_ACTION, p.data(), p.size(), false, resp)) return false;
  return resp.error == 0;
}

bool BleLock::unlock(uint32_t userId, const String& pin) {
  return lockActionCmd(*this, lockproto::ACTION_UNLOCK, userId, pin);
}

bool BleLock::lockDoor(uint32_t userId, const String& pin) {
  return lockActionCmd(*this, lockproto::ACTION_LOCK, userId, pin);
}

bool BleLock::deleteUser(uint32_t userId) {
  uint8_t p[4] = {(uint8_t)(userId >> 24), (uint8_t)(userId >> 16),
                  (uint8_t)(userId >> 8), (uint8_t)userId};
  lockproto::Frame resp;
  if (!command(lockproto::CMD_DELETE_USER, p, 4, false, resp)) return false;
  return resp.error == 0;
}

bool BleLock::reboot() {
  lockproto::Frame resp;
  if (!command(lockproto::CMD_REBOOT, nullptr, 0, false, resp)) return false;
  return resp.error == 0;
}

// ---- discovery ------------------------------------------------------------ //

bool BleLock::scanLocks(std::vector<ScanHit>& out, int durationSec) {
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  NimBLEScanResults results = scan->start(durationSec, false);
  for (int i = 0; i < results.getCount(); i++) {
    NimBLEAdvertisedDevice d = results.getDevice(i);
    String name = String(d.getName().c_str());
    bool ffe0 = d.isAdvertisingService(NimBLEUUID((uint16_t)0xFFE0));
    bool nameMatch = name.startsWith("Lck") || name.startsWith("Lock") ||
                     name.startsWith("Acc");
    if (!nameMatch && !ffe0) continue;
    ScanHit h;
    h.address = String(d.getAddress().toString().c_str());
    h.name = name;
    h.rssi = d.getRSSI();
    out.push_back(h);
  }
  scan->clearResults();
  return true;
}

// ---- users ---------------------------------------------------------------- //

static void appendBE32(std::vector<uint8_t>& v, uint32_t x) {
  v.push_back((x >> 24) & 0xFF); v.push_back((x >> 16) & 0xFF);
  v.push_back((x >> 8) & 0xFF); v.push_back(x & 0xFF);
}

static uint8_t hexNib(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  return 0xF;
}

static void encodePinField(std::vector<uint8_t>& out, const String& pin) {
  // 8 bytes of hex nibbles padded with 0xF, or all 0xFF if empty.
  if (pin.length() == 0) { for (int i = 0; i < 8; i++) out.push_back(0xFF); return; }
  String nib = pin;
  while (nib.length() < 16) nib += 'F';
  for (int i = 0; i < 16; i += 2)
    out.push_back((hexNib(nib[i]) << 4) | hexNib(nib[i + 1]));
}

static std::vector<uint8_t> encodeUser(uint32_t id, const String& name, int group,
                                       const String& pin) {
  std::vector<uint8_t> u;
  appendBE32(u, id);
  for (int i = 0; i < 22; i++) u.push_back(i < (int)name.length() ? name[i] : 0x00);
  u.push_back((uint8_t)group);   // 26 group
  u.push_back(0x00);             // 27 department
  appendBE32(u, 0xFFFFFFFF);     // 28-31 card id (unused)
  for (int i = 0; i < 4; i++) { u.push_back(0xFF); u.push_back(0xFF); }  // 32-39 fingers
  encodePinField(u, pin);        // 40-47 pin
  const uint8_t sched[12] = {0x00,0x01,0x01,0x63,0x0C,0x1F,0x00,0x00,0x17,0x3B,0x7F,0x00};
  for (int i = 0; i < 12; i++) u.push_back(sched[i]);  // 48-59 permanent schedule
  return u;  // 60 bytes
}

bool BleLock::listUsers(std::vector<UserRec>& out) {
  auto parse = [&](const lockproto::Frame& r) -> int {
    const auto& p = r.payload;
    if (p.empty()) return 0;
    int count = p[0];
    for (int i = 0; i < count; i++) {
      size_t off = 1 + i * 60;
      if (off + 60 > p.size()) break;
      UserRec u;
      u.id = ((uint32_t)p[off] << 24) | ((uint32_t)p[off+1] << 16) |
             ((uint32_t)p[off+2] << 8) | p[off+3];
      String nm;
      for (int j = 0; j < 22; j++) { char c = p[off+4+j]; if (!c) break; nm += c; }
      u.name = nm;
      u.group = p[off+26];
      memcpy(u.raw, &p[off], 60);
      uint32_t card = ((uint32_t)p[off+28] << 24) | ((uint32_t)p[off+29] << 16) |
                      ((uint32_t)p[off+30] << 8) | p[off+31];
      u.card = card != 0xFFFFFFFF && card != 0;
      for (int k = 0; k < 4; k++) {
        uint16_t f = ((uint16_t)p[off+32+k*2] << 8) | p[off+33+k*2];
        if (f != 0xFFFF) u.fingers++;
      }
      u.pin = p[off+40] != 0xFF && p[off+40] != 0x00;  // hex-nibble PIN padded with F
      memcpy(u.sched, &p[off+48], 12);
      bool dup = false;
      for (auto& x : out) if (x.id == u.id) { dup = true; break; }
      if (!dup) out.push_back(u);
    }
    return count;
  };
  // Same request as the vendor app: getUser(0, 1) starts the enumeration,
  // then getUser(1, 1) pages on (docs/ble_protocol.md). Value 0 worked on
  // some lock states but a BK50D stopped answering it entirely.
  uint8_t q0[5] = {0, 0, 0, 0, 1};
  lockproto::Frame r;
  lastUserError = "";
  if (!command(lockproto::CMD_GET_USERS, q0, 5, false, r, 8000)) {
    lastUserError = "no/garbled answer from lock (last frame " + hexOf(_lastRaw) + ")";
    Serial.print(F("# users: ")); Serial.println(lastUserError);
    return false;
  }
  if (r.error != 0) {
    lastUserError = "lock error " + String(r.error) + ", payload " + String(r.payload.size()) + " bytes";
    Serial.print(F("# users: ")); Serial.println(lastUserError);
    return false;
  }
  Serial.print(F("# users: first page ")); Serial.print(r.payload.size()); Serial.println(F(" bytes"));
  int n = parse(r);
  int guard = 0;
  while (n > 0 && guard++ < 512) {
    uint8_t q1[5] = {1, 0, 0, 0, 1};
    if (!command(lockproto::CMD_GET_USERS, q1, 5, false, r, 8000) || r.error != 0) break;
    size_t before = out.size();
    n = parse(r);
    if (out.size() == before) break;  // no progress
  }
  return true;
}

bool BleLock::addUser(const String& name, int group, const String& pin, uint32_t& newId) {
  if (!freeUserId(newId)) return false;
  std::vector<uint8_t> u = encodeUser(newId, name, group, pin);
  lockproto::Frame r;
  if (!command(lockproto::CMD_SET_USER, u.data(), u.size(), false, r) || r.error != 0) return false;
  if (pin.length()) {
    std::vector<uint8_t> e;
    e.push_back(2);
    appendBE32(e, newId);
    for (size_t i = 0; i < pin.length(); i++) e.push_back((uint8_t)pin[i]);
    command(lockproto::CMD_START_ENROLLMENT, e.data(), e.size(), false, r);
  }
  return true;
}

// ---- enrollment ----------------------------------------------------------- //

bool BleLock::enrollStart(int type, uint32_t user, const String& pin) {
  std::vector<uint8_t> e;
  e.push_back((uint8_t)type);
  appendBE32(e, user);
  if (type == 2) for (size_t i = 0; i < pin.length(); i++) e.push_back((uint8_t)pin[i]);
  lockproto::Frame r;
  if (!command(lockproto::CMD_START_ENROLLMENT, e.data(), e.size(), false, r)) { lastEnrollError = -1; return false; }
  lastEnrollError = r.error;
  return r.error == 0;
}

bool BleLock::deleteCredential(uint32_t user, int type) {
  std::vector<uint8_t> p;
  appendBE32(p, user);
  p.push_back((uint8_t)type);
  lockproto::Frame r;
  if (!command(lockproto::CMD_DELETE_CREDENTIAL, p.data(), p.size(), false, r)) return false;
  return r.error == 0;
}

bool BleLock::enrollStatus(int& statusByte, int& payloadLen) {
  lockproto::Frame r;
  if (!command(lockproto::CMD_GET_ENROLLMENT_STATUS, nullptr, 0, false, r)) return false;
  if (r.error != 0) return false;
  statusByte = r.payload.empty() ? -1 : r.payload[0];
  payloadLen = r.payload.size();
  return true;
}

bool BleLock::cancelEnroll() {
  lockproto::Frame r;
  if (!command(lockproto::CMD_CANCEL_ENROLLMENT, nullptr, 0, false, r)) return false;
  return r.error == 0;
}

// ---- records -------------------------------------------------------------- //

bool BleLock::readRecords(int y0, int mo0, int d0, int y1, int mo1, int d1,
                          std::vector<RecordRec>& out) {
  std::vector<uint8_t> q;
  appendBE32(q, 0);  // all-users filter
  q.push_back((uint8_t)(y0 - 2000)); q.push_back((uint8_t)mo0); q.push_back((uint8_t)d0);
  q.push_back((uint8_t)(y1 - 2000)); q.push_back((uint8_t)mo1); q.push_back((uint8_t)d1);
  lockproto::Frame r;
  if (!command(lockproto::CMD_RECORD_COUNT, q.data(), q.size(), false, r) || r.error != 0) return false;
  uint32_t total = r.payload.size() >= 4
      ? (((uint32_t)r.payload[0] << 24) | ((uint32_t)r.payload[1] << 16) |
         ((uint32_t)r.payload[2] << 8) | r.payload[3]) : 0;
  uint32_t off = 0;
  int guard = 0;
  while (off < total && guard++ < 2000) {
    std::vector<uint8_t> b;
    appendBE32(b, off);
    b.push_back(5);
    if (!command(lockproto::CMD_RECORD_BATCH, b.data(), b.size(), false, r) || r.error != 0) break;
    const auto& p = r.payload;
    if (p.empty()) break;
    int cnt = p[0];
    if (cnt == 0) break;
    for (int i = 0; i < cnt; i++) {
      size_t e = 1 + i * 12;
      if (e + 12 > p.size()) break;
      RecordRec rec;
      rec.user = ((uint32_t)p[e] << 24) | ((uint32_t)p[e+1] << 16) |
                 ((uint32_t)p[e+2] << 8) | p[e+3];
      char buf[32];
      snprintf(buf, sizeof(buf), "20%02d-%02d-%02d %02d:%02d:%02d",
               p[e+4], p[e+5], p[e+6], p[e+7], p[e+8], p[e+9]);
      rec.time = buf;
      rec.mode = p[e+10];
      rec.direction = p[e+11];
      out.push_back(rec);
      off++;
    }
  }
  return true;
}

// ---- settings ------------------------------------------------------------- //

bool BleLock::getParameterRaw(int selector, std::vector<uint8_t>& out) {
  lockproto::Frame r;
  bool ok;
  if (selector < 0) {
    ok = command(lockproto::CMD_GET_PARAMETER, nullptr, 0, false, r);
  } else {
    uint8_t s = (uint8_t)selector;
    ok = command(lockproto::CMD_GET_PARAMETER, &s, 1, false, r);
  }
  if (!ok || r.error != 0) return false;
  out = r.payload;
  return true;
}

bool BleLock::setAutoLock(int seconds) {
  uint8_t p[2] = {lockproto::SELECTOR_LOCK_DELAY, (uint8_t)seconds};
  lockproto::Frame r;
  if (!command(lockproto::CMD_SET_PARAMETER, p, 2, false, r)) return false;
  return r.error == 0;
}

bool BleLock::clearNormallyOpen() {
  uint8_t p[5] = {lockproto::SELECTOR_LOCK_DELAY, 0xFF, 0xFF, 0xFF, 0xFF};
  lockproto::Frame r;
  if (!command(lockproto::CMD_SET_PARAMETER, p, 5, false, r)) return false;
  return r.error == 0;
}

bool BleLock::setNormallyOpen(int weekdayMask, int startMin, int endMin) {
  uint32_t v = (((uint32_t)(weekdayMask & 0x7F)) << 22) |
               (((uint32_t)(endMin & 0x7FF)) << 11) | (startMin & 0x7FF);
  uint8_t p[5] = {lockproto::SELECTOR_LOCK_DELAY,
                  (uint8_t)(v >> 24), (uint8_t)(v >> 16), (uint8_t)(v >> 8), (uint8_t)v};
  lockproto::Frame r;
  if (!command(lockproto::CMD_SET_PARAMETER, p, 5, false, r)) return false;
  return r.error == 0;
}

bool BleLock::factoryReset() {
  uint8_t p[2] = {0x00, 0x00};
  lockproto::Frame r;
  if (!command(lockproto::CMD_SET_PARAMETER, p, 2, false, r)) return false;
  return r.error == 0;
}
