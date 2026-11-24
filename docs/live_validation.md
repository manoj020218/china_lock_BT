# HAHA Lock Live Validation

Status: Phase 2 in progress
Target firmware: `BK50D-V2.5`
Last updated: 2026-11-24

## Capture policy

Live evidence is collected only from the authorized development phone and lock. Raw BTSnoop files, bug reports, screenshots, Bluetooth addresses, lock IDs, administrator material, unlock PINs, user records and other identifiers remain local under ignored paths. This document contains only sanitized findings suitable for the public repository.

## Validated GATT layout

The target's live primary-service discovery returned:

| Item | Live value |
| --- | --- |
| Lock service | UUID `FFE0`, handles `0x000B` through `0x0010` |
| Binary command characteristic | UUID `FFE1`, declaration `0x000C`, value `0x000D`, properties `0x18` |
| Auxiliary characteristic | UUID `FFE2`, declaration `0x000E`, value `0x000F`, properties `0x16` |
| FFE2 user-description descriptor | handle `0x0010`, UUID `2901` |

All observed HAHA requests were ATT Write Requests to `0x000D`. Responses were Handle Value Notifications from the same handle. The optional `FF01` JSON channel present in the app's static code was not exposed by this firmware.

No ATT MTU exchange was present in the captured discovery sequence, although a user response larger than the default 20-byte value payload was transported successfully. ESP32 testing must therefore discover the effective MTU and support L2CAP/notification reassembly rather than assume the app's preferred value.

## Validated binary protocol

A successful capture produced 360 checksum-valid HAHA frames. It confirmed:

- outgoing command flag `0x01`;
- response flag `0x07`, with the command inferred from the pending request;
- additive 16-bit checksum exactly as documented in Phase 1;
- initial protocol address `0xFFFFFFFF`;
- a session address assigned by the successful administrator-login response;
- a different assigned address after reconnect, so it must not be persisted as a stable lock identity;
- ATT write-response followed by the HAHA notification acknowledgement;
- all tested success responses used error code zero.

## Demand-driven connection lifecycle

The lock is not treated as an always-connected peripheral. The observed app behavior and trace support this lifecycle:

1. A user action requires a lock operation.
2. The app scans/connects when the lock is awake and advertising.
3. It reads version `0x80` and authenticates with `0x13`.
4. The login response supplies the current session address.
5. The app issues the requested operation and waits for its acknowledgement.
6. The connection may close after inactivity; the next action reconnects and authenticates again.

The ESP32 bridge must implement a serialized state machine around this lifecycle. A cached UI state is not proof that a command reached the lock. Each LAN API result must be based on a response from the current BLE session.

## Firmware and authentication

Command `0x80` returned firmware string `BK50D-V2.5`. Its trailing protocol flags select command version zero, so this target uses the legacy decimal-ASCII administrator login rather than the newer DES timestamp challenge.

The captured `0x13` request contained a ten-character decimal key. It matched the Phase 1 legacy derivation path. The actual key and all source credentials are intentionally omitted. Login succeeded and the response repeated the login string with a terminator while assigning the session address.

## Validated operations

| Command | Result | Sanitized finding |
| ---: | --- | --- |
| `0x80` version | Success | Firmware and legacy command version confirmed |
| `0x13` administrator login | Success | Legacy ASCII key and dynamic session address confirmed |
| `0x8C` battery | Success | Response was 100 percent and 5.9 V during the test |
| `0x8B` get time | Success | Six-byte `YY MM DD hh mm ss` response confirmed |
| `0x8A` set time | Success | Eight-byte calendar plus timezone-minutes payload confirmed |
| `0xA3` get one user | Success | Response was one count byte plus one 60-byte user structure |
| `0x88` lock action | Success | Action, user ID and six-digit PIN payload shape confirmed |

The phone was configured for `Etc/GMT-6`; the captured set-time request carried `360` timezone minutes as BE16. This validates the field interpretation but also means bridge timezone configuration must be explicit rather than copied from the development workstation.

The Set Time dialog polls `0x8B` about twice per second while open. This created most frames in the capture and should not be copied into the bridge design; a LAN API should read once unless the caller explicitly requests monitoring.

The `0xA3` response confirmed the 60-byte record size and field placement. The live user data is not retained in public test vectors.

## Pending live validation

- capture the lock's actual advertisement while it is awake;
- capture `0xB2` record count and `0xB3` record batches;
- safely create, read back and delete a test general user and PIN;
- capture RFID and fingerprint enrollment with a person presenting test credentials at the lock;
- map record mode/direction values after test unlock events exist;
- confirm idle timeout and reconnect timing;
- confirm behavior when the app and a second BLE client contend for the lock;
- test low-battery signaling only with a safe, controlled power condition;
- identify whether emergency behavior is a distinct firmware command or only normal unlock.
