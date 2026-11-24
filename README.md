# HAHA Lock ESP32 LAN Bridge

This repository tracks development of an ESP32 bridge for an authorized HAHA Lock installation. The bridge is intended to communicate with the lock over Bluetooth Low Energy and expose authenticated APIs on the local LAN.

The project is reconstructing and validating the BLE protocol used by the Android app `uni.UNIDC3141E`. See [PROJECT_PLAN.md](PROJECT_PLAN.md) for objectives and phase status, [docs/ble_protocol.md](docs/ble_protocol.md) for the static protocol specification, and [docs/live_validation.md](docs/live_validation.md) for sanitized physical-lock findings.

## Current status

- Project setup is complete.
- Phase 1 static BLE protocol analysis is complete and Phase 2 live validation is in progress.
- GATT transport, frame format, checksum, authentication, command builders, user data and record formats are documented.
- An offline Python codec and synthetic regression tests are included.
- Version, administrator login, battery, time, one user read and a lock action have been validated on firmware `BK50D-V2.5`.
- Raw Bluetooth captures and all identifiers or credentials remain local-only.

## Repository policy

Vendor APKs, extracted vendor source, Bluetooth captures and credentials are intentionally excluded from this public repository. Only original project code, sanitized protocol documentation and test data suitable for public release will be committed.

This project is for locks owned by, or tested with explicit authorization from, the system owner.
