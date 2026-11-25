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

## Stage 2 — Wi-Fi LAN REST API (next)

Add Wi-Fi + an authenticated REST API (lock/unlock, battery, users, records,
settings) on top of the BLE core, plus the no-RTC clock automation (set time on
bind; auto re-set after a battery-level recovery). The BLE command layer is
shared with Stage 1.
