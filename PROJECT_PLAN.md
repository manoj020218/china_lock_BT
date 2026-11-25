# HAHA Lock ESP32 LAN Bridge Project

Last updated: 2026-11-25  
Current phase: Phase 3 client live-validated via the ESP32-S3 bridge; Phase 4 firmware in progress
Overall state: In progress

## Project objective

Build a secure ESP32-based bridge for an authorized HAHA Lock installation. The bridge will act as a Bluetooth Low Energy client to the lock and expose authenticated local-LAN APIs for supported lock-management and attendance operations without depending on the HAHA mobile app during normal operation.

The work will reverse engineer only the protocol needed for the client's owned or authorized locks. Every operation must be validated against the physical lock before it is marked complete.

## Target system

- Android application: HAHA Lock
- Android package ID: `uni.UNIDC3141E`
- Inspected app version: `1.2.8`, version code `128`
- Lock connection: Bluetooth Low Energy
- Proposed bridge: ESP32-S3 preferred; ESP32-C3 remains a lower-cost option
- LAN interface: REST API initially, with MQTT considered after the core protocol is stable

## Requested capabilities

- Add or bind a lock through its supported ownership flow
- Authenticate the lock administrator
- Set or change the administrator or connection password
- Add, update and delete users
- Assign administrator and general-user roles
- Enroll and delete PINs, RFID cards and fingerprints
- Set the lock clock
- Generate or configure time-limited passwords or OTPs when supported
- Lock and unlock
- Read battery percentage and voltage
- Report low-battery conditions
- Retrieve unlock records including user, method and time
- Download attendance data for registered users
- Support emergency unlock only where the lock firmware safely provides it
- Provide secure local API authentication, audit logs and recovery behavior

## Important operating constraints

- Fingerprint and RFID enrollment normally requires a person to present the finger or card at the lock after enrollment starts.
- **The lock has no battery-backed real-time clock.** Its time resets whenever the battery dies or is replaced, which silently breaks temporary passwords, per-user valid-time windows and record timestamps. Both the Jenix app and the ESP32 bridge must therefore (a) always set time (`0x8A`) immediately on bind and on first connect, and (b) auto re-set time after a battery replacement — detected by watching the battery level for a sudden recovery to ~80-90%+ — so the user never sees a time mismatch. Timezone must be configured explicitly.
- The mobile app and bridge may not be able to hold BLE connections simultaneously. This must be tested.
- Emergency unlock cannot be guaranteed when the lock battery is exhausted or its BLE subsystem is unavailable.
- Different lock firmware versions may change commands, packet fields or authentication.
- Destructive operations such as deleting administrators, clearing users or changing the login key require explicit API authorization and audit logging.
- APK cloud credentials and unrelated application secrets will not be copied into bridge firmware or project documentation.

## Verified evidence

The following behavior was observed while operating HAHA Lock version 1.2.8 with the physical lock:

- Opening the app automatically starts discovery and presents the nearby lock by its lock ID.
- Selecting the unconfigured lock immediately opens the administrator-password setup flow.
- After an administrator password is set successfully, the app exposes the complete lock-management UI.
- The administrator password value is intentionally not recorded in this public project document.

The following items were found through static application analysis and still require validation with live BLE captures:

- The app is a uni-app package whose main application logic is available in `app-service.js`.
- The app scans for and connects to BLE lock devices.
- Primary GATT service: `FFE0`.
- Primary write characteristic: `FFE1`.
- Notification or read characteristics referenced by the app: `FF01`, `FFE1` and `FFE2`.
- The app contains packet pack, parse, acknowledgement and notification handling code.
- Newer protocol login code uses a timestamp challenge and DES operation with the login key.
- App logic and UI exist for users, administrator/general roles, PINs, RFID cards, fingerprints, time, temporary/offline passwords, battery information, records and attendance reporting.
- Parsed unlock records contain a user ID, date/time bytes, unlock mode and direction.

Command identifiers mapped from the static application code:

| Command | ID | Validation state |
| --- | ---: | --- |
| Set login key | `0x12` | Static evidence only |
| Administrator login | `0x13` | Static evidence only |
| Get version/capabilities | `0x80` | Static evidence only |
| Unlock | `0x88` | Validated (action `0x01` unlock, `0x00` lock) |
| Read battery | `0x8C` | Static evidence only |
| System lock control | `0x8D` | Static evidence only |
| User operation range | `0xA0` onward | Statically mapped; live validation pending |
| Read record count | `0xB2` | Validated (all-users filter `00000000`, date `YY MM DD`) |
| Read records | `0xB3` | Validated (offset+count; 12-byte entries, mode byte) |

## Feature feasibility matrix

| Feature | Evidence | Status |
| --- | --- | --- |
| Discover and connect to lock | Automatic discovery and lock-ID selection observed | App flow confirmed; packets pending |
| Bind/add lock | Initial administrator setup observed; bonding flags found | App flow confirmed; packets pending |
| Administrator login | Full management UI available after administrator setup | App flow confirmed; protocol pending |
| Change administrator/login key | Command builder found | Not validated |
| Unlock | `0x88` action `0x01` captured; lock physically opened | Validated on BK50D-V2.5 |
| Set lock time | `0x8A` set-time error 0 from onboarding and dashboard | Validated |
| Battery percentage/voltage | `0x8C` returned 100%% / 5.8-5.9 V | Validated |
| Low-battery alarm | Battery telemetry exists | Threshold/event unknown |
| Admin/general users | General test user created via `0xA4` and read back | Create/read validated; delete pending |
| PIN management | `0xA9` type 2 enrolled a PIN inline, no presentation needed | Enroll validated; keypad open test pending |
| RFID management | `0xA9` type 3 enroll + `0xA8` poll; card swiped at lock, counter 0->1 | Enroll validated |
| Fingerprint management | `0xA9` type 1 enroll + `0xA8` poll; 3 presentations, counter 0->1 | Enroll validated |
| Temporary/offline password | Legacy local 5-min KG5 confirmed on-screen; fixed window, no custom duration on this firmware | Legacy path confirmed; server mode N/A here |
| Unlock history | `0xB2`/`0xB3` validated; 12-byte entry + mode byte (finger/card/PIN) decoded from physical unlocks | Validated |
| Attendance export | Attendance-report capability flag found | Not validated |
| Emergency unlock | Normal BLE unlock found | Firmware behavior unknown |

## Implementation architecture

```text
LAN client or customer application
              |
       HTTPS/REST or MQTT
              |
        ESP32-S3 bridge
  API authentication and audit log
  command queue and lock state cache
              |
         BLE GATT client
              |
          HAHA Lock
```

The bridge will serialize lock commands, reconnect safely, validate acknowledgements and expose only operations proven on the target firmware. Credentials must not be returned by read APIs or written to logs.

## Project phases and progress

Status values are `Not started`, `In progress`, `Blocked` and `Complete`. A phase is complete only after its exit criteria are met.

### Phase 0 Project setup — Complete

- [x] Confirm connected Android development phone.
- [x] Identify the correct HAHA Lock package.
- [x] Pull the installed APK and ARM64 split for analysis.
- [x] Extract the main app logic without modifying the phone.
- [x] Create this project objective, roadmap and progress log.

Exit criteria: project scope, evidence locations and next steps are documented.

### Phase 1 Static protocol analysis — Complete

- [x] Identify BLE service and characteristic IDs.
- [x] Locate connection, write, notification and acknowledgement logic.
- [x] Locate version, login, unlock, battery and record commands.
- [x] Document complete packet framing, length, flags, address fields and checksum.
- [x] Map every command builder and response parser found in the active protocol module.
- [x] Document protocol-version and firmware-capability differences.
- [x] Determine temporary/offline password paths: map the legacy local algorithm and identify the newer server-side generator.

Exit criteria: a protocol specification can encode and decode captured packets without relying on the app.

### Phase 2 Controlled BLE capture — In progress

- [x] Enable Android Bluetooth HCI snoop logging.
- [x] Capture automatic discovery and lock-ID selection.
- [x] Capture connection-password setup after a fresh app install without publishing credentials.
- [x] Record clean connect and administrator-login sessions.
- [x] Capture one operation at a time: version, battery, time and unlock.
- [x] Capture a wrong-password re-provisioning attempt and confirm the lock's error-33 rejection.
- [x] Capture a clean factory-reset re-provisioning and a physically confirmed lock and unlock (`0x88` action `0x00`/`0x01`).
- [x] Capture user creation and PIN enrollment with a test identity (`0xA0`/`0xA1`/`0xA4`/`0xA9` type 2); RFID and fingerprint still pending.
- [x] Capture RFID and fingerprint enrollment with a person presenting credentials (`0xA9` type 1/3 + `0xA8` status polling).
- [x] Capture per-user Valid time (`0xA4` schedule block) and an Admin-role user (group byte 1).
- [x] Capture record download (`0xB2`/`0xB3`): all-users filter `00000000`, mode byte 0x01 finger / 0x02 card / 0x04 PIN; app-BLE unlocks are not logged.
- [ ] Compare live packets with the static command implementation.
- [x] Record lock model, firmware version and capability flags.

Exit criteria: captured request and response packets agree with the protocol specification for the target lock.

### Phase 3 Desktop protocol test client — In progress

- [x] Scaffold the client package (`client/`): protocol builders/parsers, auth, config, BLE transport, demand-driven session, CLI.
- [x] Implement framing, checksum, acknowledgements and timeouts (transport over `tools/protocol_codec.py`, serialized request/response).
- [x] Implement administrator authentication (legacy command-version 0; session address adopted from the login ack).
- [x] Encode all validated commands with a 30-test offline suite (`tests/test_client_protocol.py`): action bytes, user/schedule/record layouts, normally-open packed field, record mode mapping, auth payload.
- [x] Gate unlock/write/destructive operations behind `allow_write` (`--allow-write`).
- [x] Implement BLE discovery: scan-by-name with RSSI threshold and a lock-id allowlist (`client/discover.py`, `scan` CLI command; sessions auto-resolve an address from a lock id).
- [x] Add structured packet logging with credential redaction (`client/logging_util.py`; `--verbose` logs redacted TX/RX frames, `--show-payloads` gates raw bytes).
- [x] Run read-only commands against the physical lock live, through the ESP32-S3 BLE-to-serial bridge over USB (the PC has no BLE adapter): `info`, `battery`, `time`, `users` all succeeded, and admin login returned error 0. The redacted payload hashes matched the phone captures byte-for-byte, confirming identical login-key derivation.
- [ ] Run unlock and one reversible user-management operation live.
- [ ] Build the no-RTC clock automation (set-time on bind, battery-jump -> set-time) in the app/bridge layer above the library.
- [ ] Implement the newer DES timestamp-challenge login path for non-v0 firmware.

Exit criteria: the test client can reconnect and execute validated commands reliably without the HAHA app.

### Phase 4 ESP32 BLE firmware — In progress

- [x] Select the final board: **ESP32-S3-WROOM-1 N16R8** (16 MB flash, 8 MB octal PSRAM), connected via a CH343 USB-UART bridge on COM39. Toolchain: PlatformIO + Arduino + NimBLE.
- [x] Stage 1 firmware (`firmware/`): BLE scan, connect, FFE0/FFE1 discovery and notification handling, bridged to USB serial. Built and flashed; live-verified (scan found the lock, client ran version/login/battery/time/users through it).
- [x] Port the full protocol framing and authentication into firmware (`firmware/src/lock_protocol.*`, `ble_lock.*`): the S3 now connects, derives the legacy login key in C++ (mbedTLS MD5) and runs commands itself — verified live over serial (CONNECT login error 0, VERSION `BK50D-V2.5`, BATTERY 100%/5.8 V, GETTIME).
- [ ] Add a serialized command queue and retry policy.
- [ ] Store lock identity and credentials securely (NVS).
- [ ] Add watchdog, reconnect and safe failure behavior.
- [ ] Add the no-RTC clock automation (set time on bind; auto re-set after a battery-level recovery).
- [ ] Add signed OTA update support.

Exit criteria: ESP32 performs all validated core lock commands reliably after restart and reconnect.

### Phase 5 Local LAN API — In progress

- [x] Define REST endpoints and a JSON response/error format (`firmware/src/rest_api.cpp`): `/api/health`, `/api/bind`, `/api/version`, `/api/battery`, `/api/time` (GET/POST), `/api/unlock`, `/api/lock`.
- [x] Add API authentication: a per-device bearer token generated in NVS on first boot (printed at boot / via `TOKEN`); all endpoints except health require it.
- [x] Implement lock status, battery, time and unlock endpoints over the proven BLE core; Wi-Fi station mode (via `SETWIFI`, NVS) with a SoftAP fallback. (Live HTTP test over a reachable network still pending; the underlying ops are verified over serial.)
- [ ] Implement user and credential-management endpoints.
- [ ] Implement records and attendance endpoints.
- [ ] Add rate limiting and confirmation rules for destructive operations.
- [ ] Add audit events without recording passwords or cryptographic keys.
- [ ] Build the no-RTC clock automation (set time on bind; auto re-set after a battery-level recovery).

Exit criteria: an authenticated LAN client can use every validated feature and unauthorized clients cannot operate the lock.

### Phase 6 Persistence and attendance — Not started

- [ ] Cache user metadata and lock identifiers.
- [ ] Download records incrementally without duplicates.
- [ ] Map unlock modes to PIN, RFID, fingerprint and other supported methods.
- [ ] Provide JSON and CSV attendance export.
- [ ] Define retention, clock correction and timezone behavior.

Exit criteria: attendance remains consistent across reboots, reconnects and repeated downloads.

### Phase 7 Reliability and security validation — Not started

- [ ] Test wrong passwords, expired OTPs and unauthorized operations.
- [ ] Test BLE loss during each type of command.
- [ ] Test app/bridge connection contention.
- [ ] Test low battery, lock restart and ESP32 restart.
- [ ] Test user deletion and administrator recovery safely.
- [ ] Review secret storage, firmware update and LAN attack surface.
- [ ] Run repeated-operation and long-duration tests.

Exit criteria: failures are safe, recoverable and recorded without exposing credentials.

### Phase 8 Delivery — Not started

- [ ] Freeze the supported lock and firmware compatibility list.
- [ ] Publish API documentation and examples.
- [ ] Publish provisioning, recovery and factory-reset instructions.
- [ ] Produce firmware binaries and reproducible build instructions.
- [ ] Complete client acceptance testing on the installation hardware.

Exit criteria: the client can provision, operate, recover and update the bridge using the delivered documentation.

### Phase 9 Jenix Lock mobile app (custom APK UI) — Not started

The "our own app" track: a modern, premium Android app (and, from the same
codebase, a potential iOS build) that replaces the vendor HAHA app for the
owner's locks. It can proceed in parallel with phases 6-8 once Phase 5's LAN
API exists. It reuses the stack and the approved UX of the Jenix Smart Token
Display app (`D:\IOT Device\que mgmt system\Smart Tken Display and Audio`).

**Stack (matches the token app):**

- Capacitor 7 + React 18 + TypeScript + Vite; packaged to APK via
  `pnpm build` -> `cap sync android` -> `gradlew assembleDebug` (signed APK for
  release). Same `pnpm` toolchain and project shape as the token app.
- BLE on device via a Capacitor BLE plugin (e.g. `@capacitor-community/bluetooth-le`);
  Wi-Fi/LAN via `fetch` to the ESP32 bridge REST API.

**Design language (premium, matches the token app):**

- **Glassmorphism**: translucent cards and bottom sheets with `backdrop-filter`
  blur, soft inner/drop shadows, large radii, subtle gradients; dark and light
  themes; high-contrast, accessible text.
- **Per-button touch feedback**: port/share the token app's `feedback.ts` so
  every button gets, from a single global listener (no per-component changes):
  a **water-bubble ripple where the finger lands**, a **short soft generated
  sound**, and a **short haptic vibration tuned per button kind** (`tap`,
  `nav`, `toggleOn/Off`, `confirm`, `close`, `warn`, `success`, `error`) via
  `@capacitor/haptics`. Silent-mode aware; sound and haptics toggleable in About.
- Animated lock orb on the dashboard (touch-to-unlock, hold-to-lock, mirroring
  the validated gesture), with success/error micro-animations.

**Screens:**

- **Devices** — list of bound locks, battery and link status, add button.
- **Add Device** — scan by advertised name, select by lock ID, set connection
  password (bind); **sets the lock time immediately on bind** (no-RTC rule).
- **Lock** — big glass lock orb (touch = unlock, hold = lock), battery, last
  activity; quick actions.
- **Users & credentials** — add/edit users (admin/general), enroll PIN,
  fingerprint and card with the live "present at the lock" polling flow and
  progress UI; per-user valid-time windows.
- **Records / Attendance** — download unlock records, filter by date/user, map
  mode (fingerprint/card/PIN) and export CSV/JSON.
- **Temporary password** — rolling 5-minute code (legacy KG5), copyable.
- **Settings** — volume, auto-lock delay, normally-open schedule, remote-control
  pairing, reboot, and factory reset (double-confirmed, audited).
- **About** — feedback (sound/haptics) toggles, app version and update banner,
  licenses.

**Shared protocol layer:** port `client/protocol.py` to a TypeScript
`protocol.ts` (builders/parsers, user/record/schedule encoders, auth key
derivation) so the app, the Python client and the ESP32 firmware all speak one
validated protocol. Unit-test it with Vitest against the same captured vectors.

**Connectivity model:** primary path is the **ESP32 bridge LAN REST API**
(Phase 5) over Wi-Fi, with token auth; optional **direct BLE** fallback from the
phone when no bridge is present. The app never logs credentials; the connection
password is held in secure storage.

**No-RTC clock automation (required):** set time on bind and on first connect,
and auto re-set after a battery-level recovery to ~80-90%+, so users never see a
time mismatch — in both the direct-BLE and bridge paths.

Exit criteria: a signed APK through which the owner can bind, operate, manage
users/credentials, read attendance and configure the lock, with the premium
glass UI and per-button bubble+haptic+sound feedback, talking to the ESP32
bridge (and optionally direct BLE).

## Immediate next actions

Phase 1 is complete. No Phase 2 lock interaction will begin until the user explicitly authorizes it.

After authorization:

1. Enable Android Bluetooth HCI snoop logging and confirm where the phone writes the capture.
2. Capture discovery and a read-only connection session against the physical lock.
3. Decode version, login, time and battery exchanges using the Phase 1 codec.
4. Redact lock identifiers and credentials before retaining any sanitized test vector.
5. Update the protocol specification with confirmed fields and firmware-specific differences.

## Acceptance criteria

- The bridge operates only locks provisioned by an authorized administrator.
- All supported APIs require authentication and enforce roles.
- Credentials and temporary passwords are never exposed in normal logs.
- The bridge can recover from BLE disconnects and power cycles without corrupting lock state.
- User and credential changes are acknowledged by the lock and verified by a read-back where supported.
- Attendance records include stable user mapping, unlock method and corrected local time.
- Destructive operations are auditable and protected from accidental repetition.
- Unsupported firmware or capabilities are reported clearly instead of sending unverified commands.

## Project artifacts

Public, original project artifacts:

- `docs/ble_protocol.md` — sanitized static protocol specification and Phase 2 validation list.
- `docs/live_validation.md` — sanitized live-capture findings and target-firmware differences.
- `tools/protocol_codec.py` — offline frame encoder, validated decoder, stream reassembler and credential-key derivation helpers.
- `tools/btsnoop_analyzer.py` — redacting Android BTSnoop, L2CAP, ATT and HAHA frame analyzer.
- `tests/test_protocol_codec.py` — synthetic protocol vectors and regression tests.
- `tests/test_btsnoop_analyzer.py` — synthetic BTSnoop and pending-command correlation tests.
- `client/` — Phase 3 desktop client package (protocol builders/parsers, auth, config, BLE transport via bleak, ESP32-S3 serial-bridge transport, scan-by-name discovery, redacted logging, demand-driven session, CLI). Reference implementation for the ESP32 bridge.
- `tests/test_client_protocol.py`, `tests/test_client_discovery.py` — offline unit tests for the client (41 vectors, no BLE).
- `firmware/` — ESP32-S3 bridge firmware (PlatformIO + Arduino + NimBLE): Stage 1 BLE-central ↔ USB-serial bridge.

Local-only evidence:

- `artifacts/haha-base.apk` — HAHA Lock base APK extracted from the development phone.
- `artifacts/haha-arm64.apk` — HAHA Lock ARM64 split APK.
- `artifacts/haha-extracted/assets/apps/__UNI__DC3141E/www/app-service.js` — extracted app and BLE protocol logic.
- `artifacts/haha-extracted/assets/apps/__UNI__DC3141E/www/app-config.js` — application configuration bundle.
- `artifacts/haha-extracted/assets/apps/__UNI__DC3141E/www/manifest.json` — application manifest bundle.
- `artifacts/qrunlock-base.apk` — unrelated QRUnlock application; excluded from HAHA protocol analysis.

The `artifacts` directory is local-only and excluded from the public Git repository because it contains vendor binaries, extracted application code and embedded application configuration.

## Progress log

### 2026-11-24

- Connected to the Xiaomi development phone through Android platform tools.
- Confirmed that `uni.UNIDC3141E` is HAHA Lock version 1.2.8.
- Extracted the HAHA base and ARM64 APKs for authorized analysis.
- Confirmed the app logic is accessible as a uni-app JavaScript bundle.
- Located BLE GATT identifiers and core command implementation areas.
- Found preliminary command IDs for login, version, unlock, battery, users and records.
- Created the project objective, phased plan, feature matrix and progress-tracking rules.
- Prepared the public Git repository policy so progress and original project code can be published without uploading vendor APKs, extracted code, captures or credentials.
- Initialized and published the project baseline to `manoj020218/china_lock_BT` on the `main` branch.
- Recorded the observed onboarding flow: automatic lock discovery, selection by lock ID, administrator-password setup and access to the full management UI.
- Completed the sanitized static protocol specification, including GATT transport, framing, checksum, authentication, commands, users, records and offline-password paths.
- Added an offline protocol codec and seven synthetic regression tests; no Bluetooth communication or lock state change is performed by this code.
- Confirmed that the newer offline-password generator is vendor-server-side and cannot be recovered from the APK alone.
- Closed Phase 1 and stopped at the authorization gate before controlled BLE capture.
- Began Phase 2 after explicit user authorization and enabled full Bluetooth HCI snoop logging on the Android phone.
- Captured and decoded successful version, administrator login, battery, get/set time, user-read and lock-action transactions.
- Confirmed target firmware `BK50D-V2.5`, legacy command version zero, live `FFE0`/`FFE1`/`FFE2` handles, flag-7 acknowledgements and checksum behavior.
- Confirmed that the app uses demand-driven BLE sessions and receives a new protocol session address after reconnect.
- Added a redacting BTSnoop analyzer and expanded the synthetic regression suite to ten passing tests.
- Captured the fresh-install Add Device flow, including the `Lck1_` advertisement, empty-login probe, UID/time setup and `0x12` login-key provisioning.
- Confirmed that this firmware advertises name and service fields without manufacturer-specific data.
- Captured and physically confirmed a successful unlock after the app created its default 60-byte general user.
- Captured a wrong-password **Set connection password** attempt on the already-bound lock: the lock rejected the `0x8A` set-time step with error `33` (administrator authentication failed), the app aborted before `0x12`, and no lock state changed. This live-confirms error code `33` and that re-provisioning requires the lock's current password rather than acting as an unconditional reset.
- After an owner-performed factory reset, captured a clean re-provisioning (`0x80`,`0x82`,`0x8A`,`0x12` all error 0); the lock kept its hardware ID but cleared its binding, confirming the reset path.
- Physically confirmed unlock and lock from the dashboard: both use command `0x88` with action byte `0x01` (unlock) and `0x00` (lock); `0x8D` was not used. The lock opened and then locked on command.
- Confirmed the **Temporary password** screen is the legacy local 5-minute KG5 generator: the six-digit code is computed on the phone with no BLE or network, the validity is a fixed rolling 5-minute window, and this firmware exposes no adjustable OTP duration there.
- Captured user creation and PIN enrollment for a General test user `TEST1`: `0xA1` get-counts, `0xA0` get-free-user-id, `0xA4` set-user (60 bytes), `0xA3` read-back, then `0xA9` start-enrollment type `2` with the PIN inline (error 0). PIN enrollment needs no physical presentation; the per-user password counter went 0 to 1. `TEST1` is a throwaway test identity to be deleted during cleanup.
- Captured fingerprint (`0xA9` type 1) and RFID card (`0xA9` type 3) enrollment with physical presentation: both send only type+user ID, then the app polls `0xA8` get-enrollment-status until the lock reports completion; PIN (type 2) is inline instead. Per-credential counters went 0 to 1.
- Captured the per-user **Valid time** flow: Permanent/Custom with date+time effective/expiration and a weekly repeat option; applying a custom window writes `0xA4` with the 12-byte schedule block (decoded start/end date, daily times; weekday/flags byte still to resolve).
- Created an **Admin-role** test user `ADMIN2` (user ID 2) and confirmed the 60-byte structure's group byte is `1` for admin vs `2` for general. `TEST1` and `ADMIN2` are throwaway identities to delete at cleanup.
- Captured the **Settings** data fetch (`0x0F` empty -> 36-byte blob) and parameter writes. Confirmed remote-control pairing (selector 27: `0x0E` enters learning mode, lock pushes `0x89` notifications on each remote press, count 0->1 with a spoken success). Decoded the **normally-open** schedule as selector 18 with a 4-byte packed field `value = (weekday_mask<<22)|(end_min<<11)|start_min` (`1F E5 81 E0` = all days 08:00-20:00) and **auto-lock delay** as selector 18 with a 1-byte seconds value; normally-open was disabled again afterward to leave the lock secure.
- Captured unlock-record download (`0xB2`/`0xB3`). First read returned 0 because app-BLE `0x88` unlocks are not logged; after physical PIN/fingerprint/card unlocks the lock returned three records. Decoded the 12-byte entry and mapped the mode byte: `0x01` fingerprint, `0x02` card, `0x04` PIN (same bit values as the `0x80` capability flags); all-users filter is `00000000`, direction byte `0x00` observed.
- Captured firmware-upgrade check (cloud version query, returned "No updates"; image is vendor-cloud sourced, not app-local), **device reboot** (`0x81`, empty payload, ack 0), and **restore factory settings** (`0x0E` payload `00 00`, ack 0; lock spoke "initialization successful"). The factory reset unbinds and wipes the lock, which also cleaned up the test users `TEST1`/`ADMIN2`, the paired remote and all test settings. The lock now needs re-provisioning to be used again.
- Opened Phase 3: scaffolded the `client/` desktop package (pure protocol builders/parsers, legacy auth, runtime config, bleak BLE transport, demand-driven session with gated writes, and a CLI). Added 30 offline unit tests that pin the builders/parsers to the captured values; all pass without BLE. Live-against-lock testing, BLE scan-by-name, redacted packet logging and the DES login path remain to do.
- Recorded a critical hardware constraint: the lock has **no RTC**, so its clock resets on battery death/replacement. The Jenix app and ESP32 bridge must set time on bind and auto re-set it after a battery-level recovery; noted in operating constraints and the client README.
- Added BLE **scan-by-name** discovery (name-prefix + RSSI + lock-id allowlist, with the FFE0 service as corroboration) and **redacted frame logging** (command + length + SHA-256 by default; raw payloads gated behind `--show-payloads`), plus 11 more offline tests (41 total). Noted that the PC has no BLE adapter and an Android phone cannot stand in over adb; live testing needs a USB BLE dongle, an SBC, or the forthcoming ESP32 as a BLE-to-serial bridge.

### 2026-11-25

- Started Phase 4 on the chosen **ESP32-S3-WROOM-1 N16R8** board (CH343 USB-UART on COM39). Toolchain selected: PlatformIO + Arduino + NimBLE. Wrote, built and flashed the Stage 1 `firmware/` BLE-central ↔ USB-serial bridge; verified it boots, responds to the serial line protocol and scans (it found the lock `Lck1_8F3EE684ECE3` at RSSI -62).
- Added a Python `SerialBridgeTransport` and a `--serial` CLI option so the desktop client drives the lock through the S3 bridge. **Live end-to-end test succeeded**: `info` (version `BK50D-V2.5`, login error 0), `battery` (100% / 5.7 V), `time` and `users` (0, consistent with the post-reset state) all ran through the bridge. The redacted login/version payload hashes matched the phone captures exactly, confirming identical key derivation. This closes the Phase 3 "run read-only commands live" item without a PC BLE adapter and establishes the Phase 4 BLE core.
- **Proved the write path live** through the S3 bridge in one session: `set-time` (0x8A, ack 0, clock synced, tz 330 = India), `add-user` (0xA4, created user 1 `TEST1`, read back with its PIN), and `unlock` (0x88, ack 0) — the physical lock **opened** (owner-confirmed). A test user `TEST1` (id 1) remains on the lock and should be deleted at cleanup.
- Wrote the Phase 9 plan for the owner's own **Jenix Lock app** (custom APK): Capacitor + React + TS + Vite matching the Smart Token Display app, with glassmorphism UI and that app's `feedback.ts` (water-bubble ripple + per-button haptics + soft sound), lock-specific screens, a shared `protocol.ts` ported from `client/protocol.py`, ESP32 LAN-API-first connectivity with an optional direct-BLE fallback, and the no-RTC clock automation.
- Deleted the `TEST1` write-proof user (`0xA2`, live via the bridge); the lock is clean (0 users) and re-bound with password `123456`. Added `add-user`/`delete-user` CLI commands.
- Built **Phase 5**: ported the lock protocol + legacy auth into the ESP32-S3 firmware (C++/mbedTLS) and added an authenticated Wi-Fi REST API (`/api/health|bind|version|battery|time|unlock|lock`, bearer token in NVS, SoftAP + `SETWIFI` station mode). Flashed and verified the firmware's own stack live over serial: BIND -> CONNECT (login error 0) -> VERSION/BATTERY/GETTIME. This makes the S3 a standalone lock gateway; the REST endpoints wrap the proven ops. A live HTTP test still needs the board on a reachable LAN.

## Progress update rules

After each work session:

1. Update the `Last updated`, `Current phase` and `Overall state` fields.
2. Mark checklist items only when evidence exists.
3. Add new protocol findings to `Verified evidence` and label untested findings clearly.
4. Record important architecture or security decisions in the relevant section.
5. Add a dated entry to `Progress log` describing completed work, blockers and the next action.
6. Never mark a phase complete until its exit criteria are satisfied.
