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

### Full feature set (Phase 5)

Gateway capabilities, all validated on hardware:

- **Multi-lock**: one gateway manages several locks. `GET /api/locks`, `GET /api/scan`
  (discover nearby locks by name + RSSI), `POST /api/bind` / `POST /api/unbind`.
  Operation endpoints take `?lock=<id>` (or default to the only bound lock).
- **Operations**: `version`, `battery`, `time` (GET/POST), `unlock`, `lock`,
  `reboot`; `users` (GET/POST add / `users/delete`); credential enrollment
  (`enroll` + `enroll/status` + `enroll/cancel`); `records?days=N`; settings
  (`settings/autolock`, `settings/normally-open`, `settings/factory-reset`).
- **Reachability**: before every command the gateway checks the lock's advertised
  RSSI; if it is below the threshold it returns a clear *"not reachable (weak
  signal)"* error and does **not** send the command, so a caller always knows
  whether a command actually reached the lock.
- **No-RTC clock automation**: the gateway gets real time over **NTP** and pushes
  it to a lock on first connect and after a battery-level recovery (locks have no
  RTC).
- **Cloud (optional, MQTT)**: `GET/POST /api/cloud` configures a broker
  (`host/port/client_id/user/pass/enabled`). On connect the gateway publishes a
  retained online status (with an LWT offline message), heartbeats every 30 s
  (`jenix/<id>/heartbeat`), and serves commands on `jenix/<id>/cmd` with replies
  on `.../resp`. The broker/cloud app is the client's responsibility.
- **OTA without serial**: ArduinoOTA over LAN (espota, password = API token) and
  `POST /api/ota {url}` to pull firmware from a URL/VPS. NVS (Wi-Fi, token,
  locks, cloud) is preserved across updates.
- **24x7 reliability**: a software watchdog reboots on a loop stall, Wi-Fi
  auto-reconnects, a heap guard restarts before memory exhaustion, and the
  brownout detector stays enabled (Wi-Fi TX power is capped to avoid false
  brownouts on marginal supplies). All state is in NVS, so any reset recovers in
  seconds.
- **Factory reset in the field**: press the onboard RESET button ~10 times to
  clear the gateway's own NVS config (fault resets like brownout/panic do not
  count). This never touches the lock's data.
- **Status LED (WS2812, GPIO48)**: purple blink = needs Wi-Fi setup; red blink =
  Wi-Fi fault; blue = online (LAN); green = fully online (cloud); unlock = double
  green flash; lock = single amber flash; error/unreachable = triple red flash.

## Still to do

- Signed OTA images, TLS for cloud MQTT, per-user role authorization on the API,
  rate limiting, and an audit log.
