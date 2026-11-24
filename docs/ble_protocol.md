# HAHA Lock BLE Protocol Static Analysis

Status: Phase 1 static analysis complete; live-lock validation pending
Source application: HAHA Lock Android `uni.UNIDC3141E`, version 1.2.8
Last updated: 2026-11-24

## Scope and confidence

This specification describes behavior independently reconstructed from the Android application bundle. Frame layout, command builders, response parsers and onboarding branches are high-confidence static findings. Values marked for live validation must not be used for destructive lock operations until they are confirmed in a controlled BLE capture.

No production password, lock ID, application secret or vendor source code is included here.

## Discovery and device identity

The app starts BLE discovery with duplicate results enabled and a one-second interval. Devices are retained when RSSI is greater than `-90 dBm` and the advertisement does not explicitly say bonding is unavailable.

Manufacturer data is interpreted as follows:

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 0 | 2 | Reserved ID, little-endian; expected value `0xA106` |
| 2 | 1 | Unknown/reserved |
| 3 | 1 | Bit 0 is the device-bonding flag |
| 4 | Remaining | Device ID, rendered as uppercase hexadecimal |

Recognized advertised-name prefixes are `Lck1`, `Lck2`, `Lock`, `Acc`, `Acc1` and `Acc2`, followed by an underscore and lock ID. `Vir` is the app's non-BLE virtual lock type.

If the advertised name lacks an underscore, the app derives a suffix from the BLE device address and appends it locally. This fallback needs live validation because Android may expose randomized addresses.

## GATT transport

| Purpose | UUID |
| --- | --- |
| Primary service | `0000FFE0-0000-1000-8000-00805F9B34FB` |
| Binary command write | `0000FFE1-0000-1000-8000-00805F9B34FB` |
| Binary command notification | `0000FFE1-0000-1000-8000-00805F9B34FB` |
| JSON command write/notification | `0000FF01-0000-1000-8000-00805F9B34FB` |
| MTU negotiation/read channel | `0000FFE2-0000-1000-8000-00805F9B34FB` |

The app initially assumes a 20-byte GATT value payload. On most Android locks it requests ATT MTU `131`, then uses a 128-byte value payload. For an older `BK...-V1...` firmware branch it leaves the payload at 20 bytes. iOS reads `FFE2`; text in the form `mtu:<number>` updates the payload size.

Writes use acknowledged GATT `write`, split into current-payload-size chunks. Command acknowledgement timeout is two seconds. The app serializes commands and enables notifications on `FF01`, `FFE1` and `FFE2` after connecting.

## Binary frame

All multi-byte integers in the command protocol are big-endian unless a field is explicitly marked otherwise.

### Command or notification frame

```text
Offset  Size  Field
0       2     Preamble EF 01
2       4     Device address
6       1     Flag
7       2     Length = payload length + 3
9       1     Command
10      N     Payload
10+N    2     Checksum
```

The checksum is the unsigned 16-bit sum of `flag`, both length bytes, `command` and every payload byte. The preamble and device address are excluded.

The initial device address is `0xFFFFFFFF`. The parser replaces it with the address returned by the lock, and later outgoing frames are patched with that address.

Example `getVersion` request using the initial address:

```text
EF 01 FF FF FF FF 01 00 03 80 00 84
```

`0x0084` is the sum of `01 00 03 80`.

### Flags and response layouts

| Flag | Layout after length | Meaning |
| ---: | --- | --- |
| `0x01` | command, payload, checksum | Outgoing command or incoming command notification |
| `0x05` | command, error, payload, checksum | Acknowledgement that repeats the command |
| `0x07` | error, payload, checksum | Acknowledgement whose command is inferred from the pending request |

Incoming command `0x89` is treated as an asynchronous registration/status notification.

The Android parser does not explicitly reject a bad checksum. The bridge implementation must validate it and reject malformed or oversized frames.

### Known error codes

| Code | Meaning |
| ---: | --- |
| `0` | Success |
| `19` | Password error |
| `26` | Invalid parameters |
| `33` | Administrator authentication failed |
| `129` | User storage full |
| `132` | Invalid command |
| `133` | Response timeout |

## Administrator password and login

The connection/administrator password is distinct from a user's door-unlock PIN.

The app converts a password into an eight-byte credential token:

1. Compute `MD5(password + lockId)` as uppercase hexadecimal.
2. Take hexadecimal characters 8 through 23, producing 16 hexadecimal characters or eight bytes.

The actual user-supplied password is therefore not sent as the login key, although it remains security-sensitive and must not be logged.

### Legacy protocol version

For command version zero, bytes 2 through 5 of the credential token are interpreted as a big-endian integer, masked with `0x7FFFFFFF`, and converted to a decimal ASCII login key. Command `0x13` sends that key directly.

### Newer protocol version

For a nonzero command version, each credential-token byte is reduced modulo 64 and mapped through:

```text
ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_
```

This produces the eight-character DES key used by login:

1. Create an eight-byte plaintext block containing Unix time as BE32 followed by its bitwise complement as BE32.
2. Encrypt the block with standard single-DES using the derived eight-character key.
3. Prefix the eight encrypted bytes with `0xD1`.
4. Send the nine-byte payload with command `0x13`.

Live capture must confirm the lock's accepted timestamp tolerance.

### Initial provisioning sequence

The reconstructed onboarding path is:

1. Discover and select the advertised lock ID.
2. Read version/capability information with `0x80`.
3. Probe bond state by attempting `0x13` with an empty key.
4. Derive the credential token and protocol-specific login key.
5. Authenticate with `0x13` where required.
6. Read the lock UID with `0x82`.
7. Set the lock clock with `0x8A`.
8. For a newly configured lock, store the new login key using `0x12`.
9. Save the credential token locally and enter the management UI.

This agrees with the observed app behavior: selecting an unconfigured lock immediately requests a new administrator password, then exposes the full management UI after setup.

## Version and capability response

Command `0x80` returns a firmware version string followed by a NUL byte and a flags byte.

Flags byte:

| Bits | Meaning |
| --- | --- |
| 0 | Lock bonded |
| 1 | App bonded |
| 2 | Administrator exists |
| 3 | Attendance-report capability is disabled when set |
| 4-7 | Command protocol version |

When present, the next byte reports unlock capabilities:

| Bit | Capability |
| ---: | --- |
| 0 | Fingerprint |
| 1 | RFID card |
| 2 | PIN/password |
| 3 | Face |
| 4 | Newer offline-password mode, when PIN support is also set |

## Command map

The payload column describes the app's static builder. Commands without a builder but with a parser are identified separately.

| ID | Name | Request payload |
| ---: | --- | --- |
| `0x0C` | Delete fingerprint | fingerprint ID BE16, constant `1` BE16 |
| `0x0E` | Set system parameter/reset | parameter selector and value; `00 00` performs data reset |
| `0x0F` | Get system parameter | optional one-byte selector |
| `0x12` | Set login key | ASCII key followed by NUL |
| `0x13` | Administrator login | legacy ASCII key, empty, or `D1` plus DES challenge |
| `0x14` | Physical reset/login state | action byte, optional ASCII data |
| `0x16` | Fingerprint information page | empty |
| `0x1F` | Get fingerprint index | one-byte index |
| `0x80` | Get version/capabilities | empty |
| `0x81` | Reboot | empty |
| `0x82` | Get flash/lock UID | optional data |
| `0x84` | Get flash partition info | partition selector |
| `0x85` | Erase flash | address BE32, length BE16 |
| `0x86` | Write flash | address BE32, up to 256 data bytes |
| `0x87` | Read flash | address BE32, length BE16 |
| `0x88` | Unlock/lock action | action byte (`0x01` unlock, `0x00` lock, live-confirmed), user ID BE32, ASCII unlock PIN |
| `0x89` | Asynchronous notification | incoming only in the observed flow |
| `0x8A` | Set time | YY MM DD hh mm ss, timezone offset minutes BE16 |
| `0x8B` | Get time | empty |
| `0x8C` | Get battery | empty |
| `0x8D` | System lock control | one-byte action |
| `0x8E` | Bond-device primitive | one-byte value; not used by the reconstructed main onboarding path |
| `0xA0` | Get free user ID | empty |
| `0xA1` | Get user counts | empty |
| `0xA2` | Delete complete user | user ID BE32 |
| `0xA3` | Get users | mode byte, user ID/cursor BE32 |
| `0xA4` | Set user | 60-byte user structure |
| `0xA5` | Fingerprint upload | fingerprint ID, offset and length as BE16 values |
| `0xA6` | Fingerprint download | fingerprint ID, offset, length as BE16, then data |
| `0xA8` | Get enrollment status | empty |
| `0xA9` | Start credential enrollment | type byte (1 fingerprint, 2 PIN, 3 card — live-confirmed), user ID BE32, ASCII PIN inline only for type 2; types 1/3 captured at the lock and read via `0xA8` polling |
| `0xAA` | Cancel enrollment | empty |
| `0xAB` | Delete one credential type | user ID BE32, type byte |
| `0xB2` | Query record count | user ID BE32, start YY MM DD, end YY MM DD |
| `0xB3` | Get record batch | zero-based offset BE32, count byte |

Response parsers also exist for `0x1D` fingerprint count and `0x8F` license information, but no direct request builder was found in the active command module.

## Users and credentials

Enrollment type values are:

| Value | Credential |
| ---: | --- |
| `1` | Fingerprint |
| `2` | PIN/password |
| `3` | RFID card |
| `4` | Face |

User group `1` is administrator and group `2` is general user.

The 60-byte user structure is:

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 0 | 4 | User ID BE32 |
| 4 | 22 | UTF-8 name, fixed field |
| 26 | 1 | Group |
| 27 | 1 | Department ID |
| 28 | 4 | RFID card ID BE32; unused is `0xFFFFFFFF` |
| 32 | 8 | Four fingerprint IDs as BE16; unused entries are `0xFFFF` |
| 40 | 8 | PIN encoded as hexadecimal nibbles and padded with `F` |
| 48 | 12 | Validity and schedule block |

The schedule block contains start and end dates, optional daily start/end times, weekday bits and a reserved byte. The permanent default is `00 01 01 63 0C 1F 00 00 17 3B 7F 00`. Live-confirmed layout: bytes 0-2 start `YY MM DD`, bytes 3-5 end `YY MM DD`, bytes 6-7 daily start `hh mm`, bytes 8-9 daily end `hh mm`, byte 10 weekday/flags, byte 11 reserved. A captured one-day custom window (2026-11-24) was `1A 0B 18 1A 0B 18 00 00 17 3B BE 00`.

`getUser(0, 1)` starts sequential enumeration. The app continues with `getUser(1, 1)` until the response returns no users. `getUser(2, userId)` retrieves one user.

## Battery, time and records

Battery response `0x8C` uses byte 0 as percentage and byte 1 divided by ten as voltage.

The app sets time using local calendar fields and a signed timezone offset in minutes. The get-time path currently consumes only the first six calendar bytes.

Record query `0xB2` supports a user filter and date range. A missing user filter is sent as the caller-provided value; the UI must define the all-users value during live validation. Missing dates default to `2000-01-01` and `2099-12-31`.

Record batches from `0xB3` begin with a count byte followed by 12-byte entries:

| Offset | Size | Meaning |
| ---: | ---: | --- |
| 0 | 4 | User ID BE32 |
| 4 | 6 | YY MM DD hh mm ss |
| 10 | 1 | Unlock mode |
| 11 | 1 | Direction |

The app requests five entries per batch. Unlock-mode and direction enumerations require live samples before names are assigned.

## Temporary and offline passwords

Two implementations exist.

### Legacy five-minute password

The legacy page uses a local `KG5` algorithm:

1. Format local time as `yyMMddHHmm`.
2. Round the final minute digit down to `0` or `5` and append six zero digits, yielding a 16-hex-character block.
3. Pad or truncate the supplied administrator string to eight characters.
4. DES-encrypt the eight-byte time block with that string as the key.
5. Interpret encrypted bytes 5 through 7 as a 24-bit number, reduce modulo `1,000,000`, and zero-pad to six digits.

The UI rotates this password every five minutes. Live validation must determine which administrator string the target firmware expects.

### Newer offline-password service

When capability bit 4 is present, the app does not contain the generator. It calls a vendor cloud function with:

- lock ID;
- password type: `one`, `time`, `emptyOne` or `emptyAll`;
- derived login key;
- optional password being cleared;
- start and end timestamps.

Because the generator is server-side, its algorithm cannot be recovered through APK static analysis. A local replacement will require authorized black-box test vectors or firmware-level evidence in a later phase.

## Settings selectors

Known selector indexes include volume `2`, BLE advertising `3`, card wakeup `8`, IR wakeup `9`, Wi-Fi `10`, IR distance `11`, door debounce `17`, lock delay `18`, door direction `21`, motor power `22`, remote sender `27`, sleep `28`, maximum retry count `29`, retry lock time `30` and tamper alarm `31`. Language uses selector `32`. A normally-open schedule is encoded through selector `18` in a packed 32-bit field by a dedicated builder branch.

Live-confirmed selector behavior on `BK50D-V2.5`:

- `0x0F` get-parameter with empty payload returns a 36-byte blob of all settings; with a one-byte selector it returns just that parameter.
- Selector `18` is overloaded by `0x0E` payload length: a **one-byte** value sets the auto-lock delay in seconds; a **four-byte** value sets the normally-open packed schedule `value = (weekday_mask << 22) | (end_minute << 11) | start_minute` (captured `1F E5 81 E0` = all days, 08:00-20:00).
- Selector `27` is remote-sender: `0x0F` reads the paired count, `0x0E` enters learning mode, and the lock then pushes a `0x89` async-notification (first byte `4`) on each remote RF press.

## Phase 2 validation list

Live capture must confirm:

- advertisement bytes and actual name prefix;
- device-address assignment after the first response;
- checksum behavior on requests and responses;
- target command version and DES timestamp tolerance;
- exact provisioning branch used by the physical lock;
- unlock action values and the all-users record filter;
- record mode and direction enumerations;
- lock-specific enrollment prompts and credential-delete type values;
- support for battery alarms, emergency behavior and concurrent BLE connections.
