# Jenix lock bridge firmware (ESP32-S3)

PlatformIO + Arduino + NimBLE firmware for the **ESP32-S3-WROOM-1 N16R8**
(16 MB flash, 8 MB octal PSRAM). Board USB is a **CH343 UART bridge** (not
native USB), so flashing/logging use the serial port (COM39 on the dev PC).

## Stage 1 — BLE ↔ USB-serial bridge (this firmware)

The board scans/connects to the lock (service `FFE0`, characteristic `FFE1`)
and relays raw GATT bytes to/from the PC over USB serial. The desktop client's
`SerialTransport` speaks this protocol and runs the full validated lock
protocol through the board — which is how we live-test without a PC BLE adapter.

Line protocol (115200 baud, newline-terminated ASCII):

| PC → board | Board → PC |
| --- | --- |
| `PING` | `PONG` |
| `SCAN` | `ADV <addr> <rssi> <name>` ×N, then `SCANDONE <n>` |
| `CONNECT <id\|addr>` | `CONNECTED <addr>` or `ERR <reason>` |
| `TX <hex>` | (writes to FFE1; notifications return as `RX <hex>`) |
| `DISCONNECT` | `DISCONNECTED` |
| `STATUS` | `STATUS connected <addr>` / `STATUS idle` |

Lines starting with `# ` are human-readable logs.

## Build & flash

```bash
cd firmware
pio run                               # build (first run downloads the toolchain)
pio run -t upload --upload-port COM39 # flash
pio device monitor -p COM39 -b 115200 # watch logs
```

## Stage 2 — Wi-Fi LAN REST API (current)

The firmware now speaks the lock protocol itself (`lock_protocol` + `ble_lock`,
ported from `client/`) and exposes an authenticated REST API over Wi-Fi
(`rest_api`). Config lives in NVS; no secrets are compiled in. The serial
console configures Wi-Fi and the bound lock and can exercise operations
directly for testing.

### Serial console (115200 baud)

```
STATUS                  wifi + lock config + connection
TOKEN                   print the REST API bearer token
SETWIFI <ssid> <pass>   save wifi creds, reconnect (station mode)
WIFI                    reconnect wifi, print IP
BIND <lockid> <pw> [tz] bind the lock (stored in NVS)
CONNECT | DISCONNECT    BLE session to the bound lock
VERSION | BATTERY | GETTIME
UNLOCK <user> <pin> | LOCK <user> <pin> | REBOOT
```

If no Wi-Fi is configured the board starts a SoftAP `JenixLock-XXXX`
(`192.168.4.1`); `SETWIFI` switches it to your LAN.

### REST API

All endpoints except `/api/health` require `Authorization: Bearer <token>`
(printed at boot and via `TOKEN`).

| Method + path | Body | Action |
| --- | --- | --- |
| `GET /api/health` | — | status (no auth) |
| `POST /api/bind` | `{lock_id, password, tz_minutes?}` | bind the lock |
| `GET /api/version` | — | firmware/version |
| `GET /api/battery` | — | percent + voltage |
| `GET /api/time` | — | lock clock |
| `POST /api/time` | `{year,month,day,hour,minute,second,tz_minutes}` | set clock |
| `POST /api/unlock` | `{user, pin}` | unlock |
| `POST /api/lock` | `{user, pin}` | lock |

Example (board on your LAN at `192.168.1.50`):

```bash
curl -H "Authorization: Bearer $TOKEN" http://192.168.1.50/api/battery
curl -X POST -H "Authorization: Bearer $TOKEN" \
     -d '{"user":1,"pin":"135790"}' http://192.168.1.50/api/unlock
```

Verified live over serial: BIND -> CONNECT (C++ login-key derivation, error 0)
-> VERSION (`BK50D-V2.5`) -> BATTERY (100% / 5.8 V) -> GETTIME. The REST layer
wraps these same proven operations; a live HTTP test needs the board on a
reachable network (SoftAP or `SETWIFI`).

## Still to do

- No-RTC clock automation (set time on bind; auto re-set after a battery-level
  recovery), users/records/settings endpoints, a serialized command queue with
  retries, reconnect/watchdog, and signed OTA.
