# HAHA Lock ESP32 LAN Bridge

This repository tracks development of an ESP32 bridge for an authorized HAHA Lock installation. The bridge is intended to communicate with the lock over Bluetooth Low Energy and expose authenticated APIs on the local LAN.

The project is reconstructing and validating the BLE protocol used by the Android app `uni.UNIDC3141E`. See [PROJECT_PLAN.md](PROJECT_PLAN.md) for objectives, verified findings, phase status, acceptance criteria and the dated progress log, and [docs/ble_protocol.md](docs/ble_protocol.md) for the sanitized protocol specification.

## Current status

- Project setup is complete.
- Phase 1 static BLE protocol analysis is complete.
- GATT transport, frame format, checksum, authentication, command builders, user data and record formats are documented.
- An offline Python codec and synthetic regression tests are included.
- Live command validation against the physical lock has not started.
- Phase 2 controlled BLE capture requires explicit user authorization.

## Repository policy

Vendor APKs, extracted vendor source, Bluetooth captures and credentials are intentionally excluded from this public repository. Only original project code, sanitized protocol documentation and test data suitable for public release will be committed.

This project is for locks owned by, or tested with explicit authorization from, the system owner.
