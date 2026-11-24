# HAHA Lock ESP32 LAN Bridge Project

Last updated: 2026-11-24  
Current phase: Phase 2 controlled BLE capture
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
| Unlock | `0x88` | Static evidence only |
| Read battery | `0x8C` | Static evidence only |
| System lock control | `0x8D` | Static evidence only |
| User operation range | `0xA0` onward | Statically mapped; live validation pending |
| Read record count | `0xB2` | Static evidence only |
| Read records | `0xB3` | Static evidence only |

## Feature feasibility matrix

| Feature | Evidence | Status |
| --- | --- | --- |
| Discover and connect to lock | Automatic discovery and lock-ID selection observed | App flow confirmed; packets pending |
| Bind/add lock | Initial administrator setup observed; bonding flags found | App flow confirmed; packets pending |
| Administrator login | Full management UI available after administrator setup | App flow confirmed; protocol pending |
| Change administrator/login key | Command builder found | Not validated |
| Unlock | Command builder found | Not validated |
| Set lock time | App workflow found | Not validated |
| Battery percentage/voltage | Command and response parser found | Not validated |
| Low-battery alarm | Battery telemetry exists | Threshold/event unknown |
| Admin/general users | Role values and 60-byte user structure mapped | Static mapping complete; live validation pending |
| PIN management | Enrollment and storage format mapped | Static mapping complete; live validation pending |
| RFID management | Enrollment and storage format mapped | Static mapping complete; live validation pending |
| Fingerprint management | Enrollment and fingerprint commands mapped | Static mapping complete; live validation pending |
| Temporary/offline password | Legacy local algorithm mapped; newer mode is vendor-server generated | Partially feasible offline; live validation pending |
| Unlock history | Query, pagination and 12-byte record layout mapped | Static mapping complete; live validation pending |
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
- [ ] Capture automatic discovery and lock-ID selection.
- [ ] Capture initial administrator setup on a test or safely resettable lock without publishing credentials.
- [x] Record clean connect and administrator-login sessions.
- [x] Capture one operation at a time: version, battery, time and unlock.
- [ ] Capture user, PIN, RFID and fingerprint workflows using test identities.
- [ ] Capture record and attendance downloads.
- [ ] Compare live packets with the static command implementation.
- [x] Record lock model, firmware version and capability flags.

Exit criteria: captured request and response packets agree with the protocol specification for the target lock.

### Phase 3 Desktop protocol test client — Not started

- [ ] Implement BLE discovery and connection.
- [ ] Implement framing, checksum, acknowledgements and timeouts.
- [ ] Implement administrator authentication.
- [ ] Test read-only commands first.
- [ ] Test unlock and one reversible user-management operation.
- [ ] Add structured packet logging with credential redaction.

Exit criteria: the test client can reconnect and execute validated commands reliably without the HAHA app.

### Phase 4 ESP32 BLE firmware — Not started

- [ ] Select the final ESP32-C3 or ESP32-S3 board.
- [ ] Implement BLE scan, connect, discovery and notification handling.
- [ ] Port protocol framing and authentication.
- [ ] Add a serialized command queue and retry policy.
- [ ] Store lock identity and credentials securely.
- [ ] Add watchdog, reconnect and safe failure behavior.
- [ ] Add signed OTA update support.

Exit criteria: ESP32 performs all validated core lock commands reliably after restart and reconnect.

### Phase 5 Local LAN API — Not started

- [ ] Define versioned REST endpoints and response/error format.
- [ ] Add strong API authentication and role authorization.
- [ ] Implement lock status, battery, time and unlock endpoints.
- [ ] Implement user and credential-management endpoints.
- [ ] Implement records and attendance endpoints.
- [ ] Add rate limiting and confirmation rules for destructive operations.
- [ ] Add audit events without recording passwords or cryptographic keys.

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

## Progress update rules

After each work session:

1. Update the `Last updated`, `Current phase` and `Overall state` fields.
2. Mark checklist items only when evidence exists.
3. Add new protocol findings to `Verified evidence` and label untested findings clearly.
4. Record important architecture or security decisions in the relevant section.
5. Add a dated entry to `Progress log` describing completed work, blockers and the next action.
6. Never mark a phase complete until its exit criteria are satisfied.
