# HAHA Lock ESP32 LAN Bridge

This repository tracks development of an ESP32 bridge for an authorized HAHA Lock installation. The bridge is intended to communicate with the lock over Bluetooth Low Energy and expose authenticated APIs on the local LAN.

The current work is focused on documenting and validating the BLE protocol used by the Android app `uni.UNIDC3141E`. See [PROJECT_PLAN.md](PROJECT_PLAN.md) for objectives, verified findings, phase status, acceptance criteria and the dated progress log.

## Current status

- Project setup is complete.
- Static BLE protocol analysis is in progress.
- GATT service `FFE0` and characteristics `FFE1`, `FF01` and `FFE2` have been identified in the app logic.
- Live command validation against the physical lock has not started.

## Repository policy

Vendor APKs, extracted vendor source, Bluetooth captures and credentials are intentionally excluded from this public repository. Only original project code, sanitized protocol documentation and test data suitable for public release will be committed.

This project is for locks owned by, or tested with explicit authorization from, the system owner.
