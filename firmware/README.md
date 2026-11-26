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

### Wi-Fi provisioning + discovery (`src/provision.cpp`)

If no Wi-Fi is configured the board starts a setup SoftAP `JenixLock-XXXX`
(`192.168.4.1`, XXXX = last 2 MAC bytes). The app's **Set up new gateway**
wizard provisions it — no IP or token typing:

1. Phone joins `JenixLock-XXXX`; app reads `GET /api/health` (`setup: true`,
   `device_id`).
2. `GET /api/wifi/scan` lists networks; `POST /api/provision {ssid, pass}`
   returns `{device_id, token}`. The gateway joins in AP+STA mode
   (non-blocking) and saves the credentials **only after a successful join**.
3. App polls `GET /api/provision/status` → `{state, ip}`
   (`connecting|connected|failed`, with `error` on failure), then calls
   `POST /api/provision/finish` (token) to close the AP (otherwise it closes
   180 s after joining).
4. Phone returns to home Wi-Fi; the app finds the gateway by `device_id`
   (probing `/api/health` on its /24) and re-finds it the same way if DHCP
   later changes the IP. mDNS: `jenixlock-xxxx.local`, service `_jenixlock._tcp`
   (TXT `id=<device_id>`).

Security: without a token, `/api/provision`, `/api/wifi` and `/api/wifi/scan`
work **only while factory-fresh** (no Wi-Fi saved). Afterwards they require the
bearer token.

Factory reset: press RESET **10 times, about once per second** (each boot
needs ~0.4 s to count a press; the count clears after 10 s without one). LED:
white blip per counted press, amber from the 5th, rapid purple when the reset
is accepted, then **slow purple blink = setup mode**. It clears only the
gateway (Wi-Fi, token, bound locks) — the locks' own users/fingerprints are
untouched. LED states: purple blink setup · red blink Wi-Fi lost · blue LAN
online · green cloud online.

Resilience: if the saved Wi-Fi can't be joined at boot, or drops for >3 min,
the setup AP opens too and the station retries every 30 s; the AP closes
once the station is back. `SETWIFI` still works over serial.

### REST API

All endpoints except `/api/health` require `Authorization: Bearer <token>`
(printed at boot and via `TOKEN`).

| Method + path | Body | Action |
| --- | --- | --- |
| `GET /api/health` | — | status, `device_id`, `hostname`, `setup` (no auth) |
| `GET /api/wifi/scan` | — | nearby Wi-Fi (setup or token) |
| `POST /api/provision` | `{ssid, pass}` | join Wi-Fi, returns `{device_id, token}` (setup or token) |
| `GET /api/provision/status` | — | `{state, ip?, error?}` (no auth) |
| `POST /api/provision/finish` | — | close the setup AP |
| `POST /api/bind` | `{lock_id, password, tz_minutes?, set_password?}` | bind; `set_password:true` sets the password on a new/reset lock (409 if already set up) |
| `POST /api/unbind` | `{lock_id}` | remove a lock |
| `GET /api/version` | — | firmware/version |
| `GET /api/battery` | — | percent + voltage |
| `GET /api/time` | — | lock clock |
| `POST /api/time` | `{year,month,day,hour,minute,second,tz_minutes}` | set clock |
| `POST /api/unlock` | `{user, pin}` | unlock; returns `auto_close_in` when gateway auto close is on |
| `POST /api/lock` | `{user, pin}` | lock (cancels a pending auto close) |
| `GET /api/users` | — | users with `fingers`, `card`, `pin`, `validity` |
| `POST /api/users/update` | `{user, name?, validity?}` | rename / set access window (`"permanent"` or dates+times+weekdays) |
| `GET /api/enroll/status` | — | `done` only after activity; `phase` |
| `GET /api/records?days=N` | — | lock log + gateway log merged (`source`, `action`, `ok`) |
| `GET /api/settings` | — | `auto_lock_s`, `app_auto_close_s`, `normally_open{…}` |
| `POST /api/settings/autolock` | `{seconds}` | lock's own re-lock delay (3–60; needs door magnet) |
| `POST /api/settings/app-autoclose` | `{seconds}` | gateway re-locks after app/cloud unlocks (0 = off, 3–300) |
| `POST /api/settings/normally-open` | `{start_minute,end_minute,weekday_mask}` or `{enabled:false}` | schedule / off |
| `GET /api/alerts`, `POST /api/alerts/check` | — | battery per lock, `low` below 25 % (checked every 6 h) |
| `GET /api/signal?lock=` | — | live BLE RSSI + gateway Wi-Fi RSSI |
| `GET /api/probe?lock=` | — | lock model + login protocol, no login |
| `GET/POST /api/radio` | `{wifi_dbm, ble_dbm}` | TX power (capped at 15 dBm; brownout step-down) |
| `GET /api/settings/raw?lock=&sel=` | — | raw lock parameters (diagnostic) |
| `POST /api/ota/upload` | multipart `firmware`, header `X-MD5` | install firmware from the app (CORS enabled here) |

Full client documentation: `docs/jenix-gateway-api.html`.

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

Gateway capabilities (firmware 1.2.5), validated on hardware unless noted:

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
- **Firmware updates from the app**: `src/version.h` holds `FW_VERSION`
  (reported as `fw_version`). The app bundles the build
  (`app/scripts/bundle-firmware.mjs`) and uploads it to `POST /api/ota/upload`;
  the gateway checks the ESP image magic and MD5 before activating it. Also
  ArduinoOTA over LAN (espota, password = API token) and `POST /api/ota {url}`
  (plain http). NVS (Wi-Fi, token, locks, cloud) is preserved across updates.
  **Release:** bump `FW_VERSION` → `pio run` → `pnpm build` in `app/`.
- **Battery monitor** (`rest_api.cpp`): measures each bound lock 2 min after boot
  and every 6 h, then disconnects to spare the lock battery; `/api/alerts`.
- **Gateway auto close**: per-lock `autoCloseSec` (NVS); after an unlock via the
  gateway it sends the lock command after that delay (retries twice). Works
  without a door magnet; keypad/finger/card opens rely on the lock's own auto-lock.
  *(Validated on hardware 2026-11-26: re-locked 10 s after an app unlock.)*
- **Gateway event log** (`eventlog.cpp`): NVS ring of the last 100 lock/unlock
  commands the gateway sent — the lock does not log app/BLE unlocks itself.
- **Network self-check** (`netcheck.cpp`): every minute flushes the ARP table,
  announces the gateway and probes the router (3 misses → Wi-Fi reconnect,
  6 → restart); announces every 10 s for 2 min after each Wi-Fi join (some
  routers black-hole a rejoined client for ~2 min otherwise).
- **Radio power** (`radio.cpp`): Wi-Fi 8–15 dBm, BLE 0–15 dBm (default 11 / 9),
  capped at "High" — +21 dBm BLE browned this board out even on 5 V / 2 A.
  After a brownout reset the power steps down automatically.
- **Faster connects**: the per-connection BLE scan stops as soon as the target
  lock advertises (~2 s cold connect instead of 6–10 s).
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
- **CORS headers (optional).** Only `/api/ota/upload` sends CORS headers (the app
  uploads firmware with XMLHttpRequest for progress). Other endpoints are called
  through Capacitor's native HTTP and need none. For a browser/PWA client, add
  the same `corsHeaders()` + `OPTIONS` handler to the other routes.
