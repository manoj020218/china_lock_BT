# Jenix Lock desktop client (Phase 3)

A Python client for the HAHA/Jenix BLE lock, built on the protocol validated in
Phases 1–2 (`docs/ble_protocol.md`, `docs/live_validation.md`). It drives the
physical lock from a PC without the vendor app, and is the reference
implementation the ESP32-C3 bridge firmware (Phase 4) will port.

## Layout

| Module | Responsibility | Needs BLE? |
| --- | --- | --- |
| `client/protocol.py` | Request builders + response parsers + models. Pure logic. | no |
| `client/auth.py` | Admin login-key derivation (legacy v0 implemented). | no |
| `client/config.py` | Load lock id / address / password (env, file, args). | no |
| `client/transport.py` | BLE I/O via `bleak`: connect, chunk, reassemble. | yes |
| `client/session.py` | Demand-driven session; write ops gated. | yes |
| `client/cli.py` | Command-line interface. | yes |

The pure-logic modules have no `bleak` dependency and are covered by
`tests/test_client_protocol.py`, which runs offline with no lock.

## Critical: the lock has no RTC clock

**The lock has no battery-backed real-time clock.** Its time resets when the
battery dies or is replaced, which silently breaks temporary passwords,
per-user valid-time windows and record timestamps. Any production client built
on this library — the Jenix app and the ESP32 bridge alike — **must**:

1. **Set time (`0x8A`) immediately on bind and on first connect.**
2. **Auto re-set time after a battery replacement**, detected by watching the
   battery level for a sudden recovery to ~80–90 %+, so the user never sees a
   time mismatch.
3. Configure timezone explicitly (the lock stores a signed tz-minutes field).

This scaffold exposes `set_time()` and `battery()`; the set-on-bind and
battery-jump automation belongs in the app/bridge layer above it.

## Configuration

Secrets are never committed. Provide them by any of:

```bash
# environment variables
export JENIX_LOCK_ID=...        # lock id (hex)
export JENIX_LOCK_ADDRESS=...   # BLE MAC / platform address
export JENIX_LOCK_PASSWORD=...  # connection password
```

or copy `client/jenix.config.example.json` to `jenix.config.json`
(git-ignored) and fill it in, or pass `--lock-id/--address/--password`.

## Usage

```bash
pip install -r client/requirements.txt

# discover nearby locks by advertised name (no login needed)
python -m client.cli scan
python -m client.cli --lock-id 8F3EE684ECE3 scan   # filter to one lock id

# read-only (safe) commands  (--address optional: a --lock-id triggers a scan)
python -m client.cli info
python -m client.cli battery
python -m client.cli time
python -m client.cli users
python -m client.cli records --days 7
python -m client.cli settings            # full settings blob
python -m client.cli settings --selector 27

# state-changing commands require --allow-write
python -m client.cli --allow-write unlock --user 1 --pin 654321
python -m client.cli --allow-write set-time --tz-minutes 360
python -m client.cli --allow-write set-auto-lock --seconds 5
```

Without `--allow-write`, any unlock/write/reboot/reset is refused before it
touches the lock.

Add `--verbose` to any command to log redacted TX/RX frames to stderr
(command name + payload length + SHA-256; raw bytes are never printed). Only
`--show-payloads` prints raw payloads, which can contain credentials — never
share such logs.

### Transport note (BLE adapter)

`bleak` drives the host machine's own Bluetooth radio. A PC without a BLE
adapter cannot use an Android phone's Bluetooth over adb. Options: a cheap USB
BLE dongle, a Linux SBC (e.g. Raspberry Pi) as the test host, or the ESP32-S3
BLE-to-serial bridge below. The scan/connect code here is adapter-agnostic.

### Driving the lock through the ESP32-S3 bridge (`--serial`)

If the PC has no BLE adapter, flash the Stage 1 firmware in `firmware/` to the
ESP32-S3 and pass `--serial <PORT>`. The client then runs the exact same
protocol, but the ESP32-S3 is the BLE radio (connected over USB):

```bash
pip install pyserial
python -m client.cli --serial COM39 --lock-id 8F3EE684ECE3 scan
JENIX_LOCK_ID=8F3EE684ECE3 JENIX_LOCK_PASSWORD=... \
  python -m client.cli --serial COM39 --verbose info
```

The `--lock-id` tells the bridge which advertised lock to connect to. This path
is live-validated (version, login, battery, time, users).

## Tests

```bash
python -m pytest tests/ -q
```

The protocol tests assert builders and parsers against values captured from the
physical lock (action bytes, user/record/schedule layouts, the normally-open
packed field, record mode mapping). No Bluetooth required.
