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

## Validated advertisement

A fresh application install captured the target advertisement before any saved lock data existed:

- advertised name prefix `Lck1_`, followed by the lock ID;
- RSSI ranged from approximately `-58` to `-42 dBm` while the phone was nearby;
- observed AD field types were flags `0x01`, complete 16-bit service UUIDs `0x03`, shortened name `0x08` and complete name `0x09`;
- no manufacturer-specific AD field `0xFF` was present for this firmware.

This is a live difference from the app's optional manufacturer-data parser. The ESP32 must accept a recognized name plus service UUID when manufacturer data is absent, while still applying an RSSI threshold and explicit lock-ID allowlist.

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

## Fresh-install onboarding

Uninstalling and reinstalling the mobile app cleared its local lock record but did not reset the physical lock. The fresh Add Device workflow was captured as follows:

1. Search discovered the `Lck1_...` advertisement and displayed the lock ID.
2. Confirming the lock sent an empty `0x13` login probe followed by `0x8B` get time, then displayed **Set connection password**.
3. Submitting the existing connection password sent `0x80` twice, then `0x82` get lock UID, `0x8A` set time and `0x12` set login key.
4. Every response returned error code zero, and the app saved the device locally.
5. The app returned to the lock dashboard in its normal disconnected state.

The `0x12` payload was the legacy decimal key plus a NUL terminator. Neither that key nor the entered password is included in public artifacts.

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

After the fresh install, the first physical unlock performed this additional sequence before `0x88`: `0xA3` returned zero users, `0xA4` created a default 60-byte general user, and `0xA3` read it back. The subsequent `0x88` acknowledgement returned error zero and the physical lock was confirmed to unlock. This explains why an app-generated unlock PIN/user record existed in the earlier capture.

Automated and manual press-and-hold Lock attempts produced the app's generic error. The isolated traces contained only scanning activity: no target GATT connection, ATT value or HAHA frame was present. The failure therefore occurred before login or command dispatch, not as a protocol error response. Other dashboard commands failed in the same state. A successful lock-action capture remains pending.

## Wrong-password re-provisioning rejection (error 33)

The Add Device **Set connection password** dialog was submitted with a deliberately wrong password on the already-bound lock, to confirm the lock's rejection behavior and the `33` error code against live hardware. The decoded transaction was:

| Step | Command | Live result |
| --- | --- | --- |
| 1 | `0x80` get-version | error 0 |
| 2 | `0x80` get-version | error 0 |
| 3 | `0x82` get-lock-uid | error 0 |
| 4 | `0x8A` set-time | **error 33** |

The app then displayed **Administrator authentication failed** and the flow stopped. The `0x12` set-login-key step that completes a successful provisioning was never reached, so no lock state changed.

Confirmed findings:

- Error code `33` is lock-generated and arrives as a normal flag-`0x07` acknowledgement, matching the Phase 1 error table.
- On an already-provisioned lock, re-provisioning through **Set connection password** is not an unconditional re-key: the lock authenticates the early `0x8A` set-time step against its stored credential and rejects a mismatched password.
- A wrong connection password is a safe no-op. The lock rejects before the login key is rewritten, so onboarding with the wrong password cannot lock out or alter the device.
- For the ESP32 bridge, `0x8A` set-time can return `33` during binding and must be treated as an authentication failure, not a clock error. Provisioning must surface error `33` as "wrong connection password" rather than retrying.

The submitted password and all derived key material are intentionally excluded from this public document.

## Factory-reset re-provisioning (clean binding)

After the wrong-password rejection above, the physical lock was factory-reset by the owner and re-provisioned from the app's Add Device flow. Selecting the reset lock showed a plain **Add device** confirmation (not the password prompt), confirming the lock was genuinely unbound. The captured provisioning was:

| Step | Command | Result |
| --- | --- | --- |
| 1-2 | `0x80` get-version (x2) | error 0 |
| 3 | `0x82` get-lock-uid | error 0 |
| 4 | `0x8A` set-time | error 0 |
| 5 | `0x12` set-login-key | error 0 |

The lock advertised the same lock ID after reset, so the hardware ID survives a factory reset; only the stored connection password and bindings are cleared. This is the positive counterpart to the error-33 case: on a truly unbound lock, `0x8A` set-time succeeds and `0x12` writes the new login key.

## Lock and unlock action values

Both the dashboard **Touch to Unlock** and **Hold to Lock** gestures were captured and physically confirmed (the lock opened, then locked). Both operations use the **same command `0x88`**, distinguished only by the first payload byte:

| Gesture | Command | Action byte | Payload | Physical result |
| --- | --- | --- | --- | --- |
| Unlock | `0x88` | `0x01` | action(1) + user ID BE32 + 6-char ASCII PIN | Lock opened |
| Lock | `0x88` | `0x00` | action(1) + user ID BE32 + 6-char ASCII PIN | Lock closed |

Command `0x8D` (system lock control) was **not** used by the dashboard Lock/Unlock gestures. The earlier Phase 1 note that `0x88` carries a one-byte action is confirmed, and the two live action values are now known. Each gesture is preceded by a fresh connect, `0x80`, `0x13` login, `0x8C` battery, `0x8B` time and `0xA3` get-users; the user ID and PIN carried in the `0x88` payload come from the app's default general user and remain redacted.

## Temporary password (legacy 5-minute KG5)

The dashboard **Temporary password** screen on this firmware is the **legacy local 5-minute (KG5)** generator, not the newer server-side offline-password service:

- The screen requires an administrator password and shows a ring labelled with a fixed rolling window such as `18:00~18:05`.
- Tapping **Generate** produced a six-digit code **entirely on the phone**: no BLE frame and no network request accompanies generation. The lock re-derives the same code from its own clock, which is why the screen warns that the lock time must be set first.
- The validity is a **fixed five-minute slot**; this screen offers **no adjustable duration**. A custom-duration OTP is therefore not available through this path on `BK50D-V2.5`. The app's per-user **Valid time** option (see below) is the separate mechanism for time-bounding a credential.

The generated code is a live short-lived credential for the owner's lock and is intentionally excluded from this document.

## Add user and PIN enrollment

A reversible test user was created from **Users -> Add user** as a General (non-administrator) user, then given a password. The captured sequence, all error 0:

| Phase | Commands |
| --- | --- |
| Pre-add query | `0xA1` get-user-counts (16-byte response), `0xA3` get-users enumeration, `0xA0` get-free-user-id (4-byte response) |
| Create user | `0xA4` set-user (60-byte structure), then `0xA3` read-back (61-byte: count + structure) |
| Enroll PIN | `0xA9` start-enrollment, **type byte `2`**, 11-byte payload = type(1) + user ID BE32 + 6-char ASCII PIN |

Confirmed findings:

- The app queries `0xA0` get-free-user-id to choose the new user ID before writing `0xA4`.
- PIN/password enrollment is a **single `0xA9` call with the PIN inline** and returns success immediately; **no physical presentation at the lock is required** for a PIN, unlike fingerprint or card enrollment. The per-user password counter incremented from 0 to 1 after this call.
- The app reads the user back with `0xA3` immediately after `0xA4`, which the bridge should mirror to verify writes.

A test user **`TEST1` (ID 1, General)** with a test PIN now exists on the lock and should be deleted during cleanup (`0xA2` delete user or `0xAB` delete credential) once record/attendance validation is complete. The chosen test PIN is a throwaway value and is not recorded here.

## Fingerprint and card enrollment (polling model)

Fingerprint and RFID-card enrollment were captured with a person presenting the credential at the lock. Both differ from PIN enrollment: the `0xA9` payload carries **only type + user ID (5 bytes), no inline credential**, and the app then **polls `0xA8` get-enrollment-status** (~4 times/second) while the lock captures the physical credential.

| Credential | `0xA9` type byte | `0xA9` payload | Capture mechanism |
| --- | ---: | --- | --- |
| Fingerprint | `1` | type(1) + user ID BE32 | Lock scans finger; app polls `0xA8` until done (3 presentations observed) |
| PIN/password | `2` | type(1) + user ID BE32 + 6-char ASCII PIN | Sent inline; single call, no polling |
| RFID card | `3` | type(1) + user ID BE32 | Lock reads card; app polls `0xA8` until a card is swiped |

The `0xA8` status responses (all error 0, flag `0x07`) change shape as enrollment progresses:

- **Fingerprint:** a two-byte status cycled through several first-byte values during the three finger presentations, briefly returned a three-byte status (first byte `4`, interpreted as a progress/count update), then settled to a one-byte `0` idle/done status. Total capture spanned about nine seconds.
- **Card:** a one-byte status first-byte `5` (waiting), then a five-byte status first-byte `8` at the moment the card was swiped (the extra bytes carry the card UID and are redacted), then one-byte `0` done.

Both enrollments incremented the matching per-user counter from 0 to 1. The exact `0xA8` status-code enumeration needs more samples before names are assigned, but the transport model is confirmed: start enrollment, poll status, stop when the lock reports completion. The bridge must implement the same poll-until-complete loop with a cancel path (`0xAA`) and a timeout, because the finger/card is presented asynchronously by a person.

## Per-user validity (Valid time) and role encoding

The per-user **Valid time** screen offers **Permanent** or **Custom**. Custom exposes an **Effective time** and **Expiration time** (each a date plus a time), and a **repeat** toggle that reveals a weekly schedule: effective/expiration dates, a daily **Start time** and **End time** (with "less than the start time means the end of the next day" for overnight windows) and per-weekday selectors (SUN-SAT).

Applying a Custom window writes the whole user with `0xA4` set-user (error 0); validity lives in the **12-byte schedule block at offset 48** of the 60-byte user structure. Two live blocks were decoded:

| Case | Schedule block (hex) | Meaning |
| --- | --- | --- |
| Permanent (default) | `00 01 01 63 0c 1f 00 00 17 3b 7f 00` | start 2000-01-01, end 2099-12-31, daily 00:00-23:59, weekday byte `0x7f` |
| Custom one-shot (today) | `1a 0b 18 1a 0b 18 00 00 17 3b be 00` | start 2026-11-24, end 2026-11-24, daily 00:00-23:59, weekday byte `0xbe` |

Field layout confirmed: bytes 0-2 start date `YY MM DD`, bytes 3-5 end date `YY MM DD`, bytes 6-7 daily start `hh mm`, bytes 8-9 daily end `hh mm`, byte 10 weekday/flags, byte 11 reserved (`0x00`). `0x1a 0x0b 0x18` decodes to year 2026, month 11, day 24. The weekday/flags byte differs between permanent (`0x7f`, all days) and the one-shot custom window (`0xbe`); its exact bit meaning for non-repeating windows needs the repeat-on capture to resolve and should not be assumed yet.

**Role encoding** was confirmed by creating an Admin user `ADMIN2`: its `0xA4` carried **group byte `1`** at offset 26 (administrator), whereas the General user `TEST1` carried group byte `2`. The app calls `0xA0` get-free-user-id first and the new user received ID `2`. `ADMIN2` is also a throwaway test identity to delete at cleanup.

## Settings fetch, remote control, normally-open and auto-lock

The **Settings** screen fetches all lock configuration over BLE and exposes parameter writes. Captured behavior:

### Bulk and per-parameter reads

- `0x0F` get-parameter with an **empty payload** returned a **36-byte blob** carrying the full settings set in one response.
- `0x0F` get-parameter with a **1-byte selector** returned that parameter only (for example selector `18` returned a 9-byte group).

### Remote control pairing (selector 27)

| Step | Frame | Meaning |
| --- | --- | --- |
| Query | `0x0F` get-parameter selector `27` | Reads the paired-remote count |
| Enter learning | `0x0E` set-parameter selector `27` (2-byte) | Puts the lock into remote-learning mode (app shows "Please press the remote control") |
| Press event | `0x89` async-notification, first byte `4` (9-byte, incoming) | Lock pushes this when it receives a remote RF press |
| Poll | repeated `0x0F` selector `27` (~1/s) | App watches the count until it increments |

The lock also gives a spoken "successful" prompt on a valid pairing. In this capture the app dialog stayed open (ready to add more remotes) while the count advanced from 0 to 1 after Return. The bridge should model remote pairing as: enter learning mode, then watch for `0x89` events and/or poll the count, with a user-driven timeout.

### Normally-open time period (selector 18, 4-byte packed)

Applying a normally-open window (`08:00 ~ 20:00`, all weekdays) sent `0x0E` set-parameter selector `18` with a **4-byte packed 32-bit field** `1F E5 81 E0`. The field decodes exactly as:

```
value = (weekday_mask << 22) | (end_minute_of_day << 11) | start_minute_of_day
0x1FE581E0 = (0x7F << 22) | (1200 << 11) | 480   # all days, 20:00, 08:00
```

- bits 0-10: start minutes-of-day (480 = 08:00)
- bits 11-21: end minutes-of-day (1200 = 20:00)
- bits 22-28: weekday bitmask (`0x7F` = all seven days)

The dialog also offers an **all day** option and per-weekday toggles. This normally-open mode holds the lock unlocked across the window (press-and-hold `0` at the keypad to manually lock), which is a standing security state; the test window was disabled again after capture so the lock was left secured.

### Auto-lock delay (selector 18, 1-byte)

Changing Auto lock delay from 5 to 11 seconds sent `0x0E` set-parameter selector `18` with a **1-byte value** `0B` (11). Selector `18` is therefore **overloaded and distinguished by payload length**: a 1-byte write sets the auto-lock delay in seconds, a 4-byte write sets the normally-open packed schedule. Gate-magnetic delay stayed at 2 seconds. All writes returned error 0.

## Unlock records (0xB2 / 0xB3) and mode mapping

Record download was validated end to end. A first query returned zero records even though the app had performed several unlocks, because **app-initiated BLE unlocks (`0x88`) are not written to the record log** on this firmware. Only physical credential unlocks at the lock create records. After unlocking once each with PIN, fingerprint and card at the lock, the query returned three records.

Request and response layout confirmed:

- `0xB2` record-count request (10 bytes): `user_filter BE32` + `start YY MM DD` + `end YY MM DD`. The **all-users filter is `00 00 00 00`** and dates are `YY MM DD`. Response is a BE32 count (`00 00 00 03` = 3).
- `0xB3` record-batch request (5 bytes): `offset BE32` + `count byte` (the app requests `05` per batch). Response is a one-byte count followed by 12-byte entries.
- 12-byte entry: `user ID BE32` + `YY MM DD hh mm ss` + `mode byte` + `direction byte`.

The unlock-mode byte was mapped by correlating decoded entries with the app's on-screen labels:

| Mode byte | Credential | Note |
| ---: | --- | --- |
| `0x01` | Fingerprint | matches `0x80` capability bit 0 |
| `0x02` | RFID card | matches capability bit 1 |
| `0x04` | PIN/password | matches capability bit 2 |
| `0x08` | Face (expected) | capability bit 3; not sampled |

So the mode byte reuses the same credential bit values as the `0x80` capability flags. The **direction byte was `0x00`** on all three unlock entries; other direction values (and a remote-unlock mode value) still need samples. Records are keyed to the lock-internal user ID, so the bridge must keep its own user-ID-to-identity mapping, and should download with the `00000000` all-users filter and page through `0xB3` by offset.

## Firmware upgrade source (cloud, not app-local)

The **Firmware upgrade** screen reads the current BLE firmware (`BK50D-V2.5`, from `0x80`) and offers **Detect new firmware**. Tapping it performs a **remote server (cloud) version check** over the phone's network connection, not a BLE operation; in this test it returned **"No updates."** The firmware image is therefore **sourced from the vendor's cloud**, not from app-local storage: when an update exists the app downloads it from the server and then writes it to the lock over BLE using the flash primitives (`0x85` erase, `0x86` write-flash, `0x87` read-flash). No flash was performed in this test. For the ESP32 bridge, firmware distribution for the lock is a vendor-cloud dependency; the bridge's own OTA (project Phase 4) is independent of the lock's firmware channel.

## Device reboot (0x81)

The Settings **Device reboot** action (with an "Device reboot ?" confirmation) sent command **`0x81` with an empty payload**; the lock acknowledged with error 0 (flag `0x07`) and then restarted. This is a clean, non-destructive restart: the binding, users and settings are preserved. The bridge can expose a reboot as a single `0x81` call but should expect the BLE session to drop immediately afterward and require a reconnect.

## Restore factory settings (0x0E `00 00`)

The Settings **Restore factory settings** action (with a "Restore factory settings ?" confirmation) sent command **`0x0E` set-parameter with payload `00 00`** and received error 0; the lock then reinitialized and announced "initialization successful." This matches the Phase 1 static note that `0x0E` with `00 00` performs a data reset. The reset is **destructive and unbinds the lock**: the connection password/binding, all users and credentials (PIN, fingerprint, card), the paired remote and all settings are cleared, and the lock must be re-provisioned through the Add Device flow before it can be used again. The hardware lock ID survives the reset. The bridge must treat this as a privileged, audited, confirmation-gated operation and expect to re-provision afterward.

A full 36-byte settings blob was also captured from the `0x0F` empty read just before the reset; field-by-field decoding of that blob (beyond the already-decoded auto-lock, normally-open, language `en` and remote-count entries) is left for a future pass.

## Pending live validation

- capture the `0xAB` / `0xA2` credential-and-user delete path (not yet sampled; the test identities were removed by the factory reset instead);
- sample additional record values: the direction byte for lock/inward events, a face-unlock mode (`0x08`), and a remote-unlock mode value;
- resolve the weekday/flags byte of the one-shot per-user valid-time block (`0xbe`) with a repeat-on capture;
- fully decode the 36-byte `0x0F` settings blob field by field;
- confirm idle timeout and reconnect timing;
- confirm behavior when the app and a second BLE client contend for the lock;
- test low-battery signaling only with a safe, controlled power condition;
- identify whether emergency behavior is a distinct firmware command or only normal unlock.
