#include "ble_lock.h"

#include <NimBLEDevice.h>

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
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  NimBLEDevice::setMTU(247);
  return true;
}

static bool matchArg(NimBLEAdvertisedDevice& d, const String& arg) {
  String a = arg; a.toLowerCase();
  String addr = String(d.getAddress().toString().c_str()); addr.toLowerCase();
  String name = String(d.getName().c_str()); name.toLowerCase();
  return addr == a || (name.length() && name.indexOf(a) >= 0);
}

bool BleLock::connectTo(const String& ref) {
  if (isConnected()) return true;
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  NimBLEScanResults results = scan->start(4, false);
  NimBLEAdvertisedDevice chosen;
  bool found = false;
  for (int i = 0; i < results.getCount(); i++) {
    NimBLEAdvertisedDevice d = results.getDevice(i);
    if (matchArg(d, ref)) { chosen = d; found = true; break; }
  }
  scan->clearResults();
  if (!found) return false;

  NimBLEClient* client = (NimBLEClient*)_client;
  if (!client) {
    client = NimBLEDevice::createClient();
    client->setConnectTimeout(10);
    _client = client;
  }
  if (!client->connect(&chosen)) return false;
  NimBLERemoteService* svc = client->getService(NimBLEUUID(SERVICE_FFE0));
  if (!svc) { client->disconnect(); return false; }
  NimBLERemoteCharacteristic* ffe1 = svc->getCharacteristic(NimBLEUUID(CHAR_FFE1));
  if (!ffe1) { client->disconnect(); return false; }
  _ffe1 = ffe1;
  if (ffe1->canNotify()) ffe1->subscribe(true, notifyCB);
  _sessionAddr = lockproto::INITIAL_ADDRESS;
  _authenticated = false;
  _acc.clear();
  return true;
}

void BleLock::disconnect() {
  NimBLEClient* client = (NimBLEClient*)_client;
  if (client && client->isConnected()) client->disconnect();
  _authenticated = false;
  _sessionAddr = lockproto::INITIAL_ADDRESS;
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
  if (xSemaphoreTake(_respSem, pdMS_TO_TICKS(timeoutMs)) != pdTRUE) return false;
  return lockproto::decodeFrame(_respBuf.data(), _respBuf.size(), _pendingCmd, resp);
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
  return true;
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
