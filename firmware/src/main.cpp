// Jenix lock bridge — Stage 1: BLE-central <-> USB-serial bridge.
//
// The ESP32-S3 connects to the lock over BLE (service FFE0, characteristic
// FFE1) and relays raw GATT bytes to/from the PC over the USB-UART (CH343) at
// 115200 baud. The desktop client (client/serial_transport.py) speaks this
// line protocol and runs the full, already-validated lock protocol on top.
//
// Serial line protocol (newline-terminated ASCII):
//   PC -> ESP32:
//     PING                 -> PONG
//     SCAN                 -> ADV <addr> <rssi> <name> (0+), then SCANDONE <n>
//     CONNECT <id|addr>    -> CONNECTED <addr>  or  ERR <reason>
//     TX <hex>             -> writes bytes to FFE1; notifications arrive as RX
//     DISCONNECT           -> DISCONNECTED
//     STATUS               -> STATUS <connected|idle> [<addr>]
//   ESP32 -> PC (async):
//     RX <hex>             -> one FFE1 notification payload
//     EVT <text>           -> informational event
//     ERR <text>           -> error
//   Lines beginning with "# " are human-readable logs and can be ignored.

#include <Arduino.h>
#include <NimBLEDevice.h>

static const uint16_t SERVICE_FFE0 = 0xFFE0;
static const uint16_t CHAR_FFE1 = 0xFFE1;
static const size_t WRITE_CHUNK = 20;  // safe across all lock firmware

static NimBLEClient* g_client = nullptr;
static NimBLERemoteCharacteristic* g_ffe1 = nullptr;
static String g_lineBuf;

// ----- small helpers ------------------------------------------------------- //

static void logln(const String& s) { Serial.print("# "); Serial.println(s); }

static String toHex(const uint8_t* data, size_t len) {
  static const char* H = "0123456789abcdef";
  String out;
  out.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    out += H[data[i] >> 4];
    out += H[data[i] & 0x0F];
  }
  return out;
}

static int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

// Parse a hex string (optionally with spaces) into out[]; returns byte count or -1.
static int parseHex(const String& s, uint8_t* out, size_t maxLen) {
  size_t n = 0;
  int hi = -1;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == ' ' || c == '\t') continue;
    int v = hexNibble(c);
    if (v < 0) return -1;
    if (hi < 0) {
      hi = v;
    } else {
      if (n >= maxLen) return -1;
      out[n++] = (uint8_t)((hi << 4) | v);
      hi = -1;
    }
  }
  if (hi >= 0) return -1;  // odd number of nibbles
  return (int)n;
}

// ----- BLE callbacks ------------------------------------------------------- //

static void notifyCB(NimBLERemoteCharacteristic* /*chr*/, uint8_t* data,
                     size_t len, bool /*isNotify*/) {
  Serial.print("RX ");
  Serial.println(toHex(data, len));
}

class ClientCallbacks : public NimBLEClientCallbacks {
  void onDisconnect(NimBLEClient* /*c*/) override {
    g_ffe1 = nullptr;
    Serial.println("DISCONNECTED");
  }
};
static ClientCallbacks g_clientCbs;

// ----- commands ------------------------------------------------------------ //

static void cmdScan() {
  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  scan->setInterval(45);
  scan->setWindow(15);
  NimBLEScanResults results = scan->start(4, false);
  int shown = 0;
  for (int i = 0; i < results.getCount(); i++) {
    NimBLEAdvertisedDevice d = results.getDevice(i);
    String name = d.getName().c_str();
    bool hasFFE0 = d.isAdvertisingService(NimBLEUUID(SERVICE_FFE0));
    if (name.length() == 0 && !hasFFE0) continue;
    Serial.print("ADV ");
    Serial.print(d.getAddress().toString().c_str());
    Serial.print(' ');
    Serial.print(d.getRSSI());
    Serial.print(' ');
    Serial.println(name.length() ? name : String("(no-name)"));
    shown++;
  }
  scan->clearResults();
  Serial.print("SCANDONE ");
  Serial.println(shown);
}

static bool matchArg(NimBLEAdvertisedDevice& d, const String& arg) {
  String a = arg;
  a.toLowerCase();
  String addr = String(d.getAddress().toString().c_str());
  addr.toLowerCase();
  String name = String(d.getName().c_str());
  name.toLowerCase();
  return addr == a || (name.length() && name.indexOf(a) >= 0);
}

static void cmdConnect(const String& arg) {
  if (arg.length() == 0) { Serial.println("ERR connect needs an id or address"); return; }
  if (g_client && g_client->isConnected()) {
    Serial.println("ERR already connected (DISCONNECT first)");
    return;
  }

  NimBLEScan* scan = NimBLEDevice::getScan();
  scan->setActiveScan(true);
  NimBLEScanResults results = scan->start(4, false);

  NimBLEAdvertisedDevice chosen;
  bool found = false;
  for (int i = 0; i < results.getCount(); i++) {
    NimBLEAdvertisedDevice d = results.getDevice(i);
    if (matchArg(d, arg)) { chosen = d; found = true; break; }
  }
  scan->clearResults();
  if (!found) { Serial.println("ERR lock not found in scan"); return; }

  if (!g_client) {
    g_client = NimBLEDevice::createClient();
    g_client->setClientCallbacks(&g_clientCbs, false);
    g_client->setConnectTimeout(10);
  }
  if (!g_client->connect(&chosen)) {
    Serial.println("ERR BLE connect failed");
    return;
  }
  NimBLERemoteService* svc = g_client->getService(NimBLEUUID(SERVICE_FFE0));
  if (!svc) { Serial.println("ERR FFE0 service not found"); g_client->disconnect(); return; }
  g_ffe1 = svc->getCharacteristic(NimBLEUUID(CHAR_FFE1));
  if (!g_ffe1) { Serial.println("ERR FFE1 characteristic not found"); g_client->disconnect(); return; }
  if (g_ffe1->canNotify()) {
    g_ffe1->subscribe(true, notifyCB);
  }
  Serial.print("CONNECTED ");
  Serial.println(chosen.getAddress().toString().c_str());
}

static void cmdTx(const String& hex) {
  if (!g_client || !g_client->isConnected() || !g_ffe1) {
    Serial.println("ERR not connected");
    return;
  }
  static uint8_t buf[600];
  int len = parseHex(hex, buf, sizeof(buf));
  if (len < 0) { Serial.println("ERR bad hex"); return; }
  for (int off = 0; off < len; off += WRITE_CHUNK) {
    size_t n = min((size_t)WRITE_CHUNK, (size_t)(len - off));
    if (!g_ffe1->writeValue(buf + off, n, true)) {
      Serial.println("ERR write failed");
      return;
    }
  }
}

static void cmdDisconnect() {
  if (g_client && g_client->isConnected()) {
    g_client->disconnect();  // onDisconnect emits DISCONNECTED
  } else {
    Serial.println("DISCONNECTED");
  }
}

static void cmdStatus() {
  if (g_client && g_client->isConnected()) {
    Serial.print("STATUS connected ");
    Serial.println(g_client->getPeerAddress().toString().c_str());
  } else {
    Serial.println("STATUS idle");
  }
}

static void handleLine(String line) {
  line.trim();
  if (line.length() == 0) return;
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String arg = sp < 0 ? String("") : line.substring(sp + 1);
  cmd.toUpperCase();

  if (cmd == "PING") Serial.println("PONG");
  else if (cmd == "SCAN") cmdScan();
  else if (cmd == "CONNECT") cmdConnect(arg);
  else if (cmd == "TX") cmdTx(arg);
  else if (cmd == "DISCONNECT") cmdDisconnect();
  else if (cmd == "STATUS") cmdStatus();
  else Serial.println("ERR unknown command");
}

// ----- Arduino entry points ------------------------------------------------ //

void setup() {
  Serial.begin(SERIAL_BRIDGE_BAUD);
  delay(200);
  NimBLEDevice::init("jenix-bridge");
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  NimBLEDevice::setMTU(247);
  g_lineBuf.reserve(1024);
  Serial.println("EVT jenix-bridge ready");
  Serial.println("READY");
}

void loop() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (g_lineBuf.length()) {
        handleLine(g_lineBuf);
        g_lineBuf = "";
      }
    } else {
      g_lineBuf += c;
      if (g_lineBuf.length() > 2000) g_lineBuf = "";  // overflow guard
    }
  }
  delay(2);
}
