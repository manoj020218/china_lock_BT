"""HAHA/Jenix lock application protocol: request builders and response parsers.

This module is pure logic: it builds the ``(command, payload)`` pairs that the
BLE transport wraps into frames with :mod:`tools.protocol_codec`, and parses the
payloads that come back. It performs no I/O and holds no credentials, so it is
fully unit-testable offline.

Every value here was confirmed against the physical lock on firmware
``BK50D-V2.5`` during Phase 2 (see ``docs/live_validation.md``), unless a
comment marks it as static-only or unsampled.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import IntEnum
from typing import List, Optional, Tuple

Command = Tuple[int, bytes]  # (command_id, payload)


# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

class Cmd(IntEnum):
    """Command identifiers used by the client (validated subset)."""

    SET_LOGIN_KEY = 0x12
    ADMIN_LOGIN = 0x13
    GET_VERSION = 0x80
    REBOOT = 0x81
    GET_LOCK_UID = 0x82
    LOCK_ACTION = 0x88
    ASYNC_NOTIFICATION = 0x89
    SET_TIME = 0x8A
    GET_TIME = 0x8B
    GET_BATTERY = 0x8C
    SET_PARAMETER = 0x0E
    GET_PARAMETER = 0x0F
    GET_FREE_USER_ID = 0xA0
    GET_USER_COUNTS = 0xA1
    DELETE_USER = 0xA2
    GET_USERS = 0xA3
    SET_USER = 0xA4
    GET_ENROLLMENT_STATUS = 0xA8
    START_ENROLLMENT = 0xA9
    CANCEL_ENROLLMENT = 0xAA
    DELETE_CREDENTIAL = 0xAB
    RECORD_COUNT = 0xB2
    RECORD_BATCH = 0xB3


class LockAction(IntEnum):
    """First byte of a 0x88 lock-action payload (live-confirmed)."""

    LOCK = 0x00
    UNLOCK = 0x01


class EnrollType(IntEnum):
    """0xA9 enrollment type byte (live-confirmed for PIN/finger/card)."""

    FINGERPRINT = 1
    PIN = 2
    CARD = 3
    FACE = 4  # static-only; not sampled


class UnlockMode(IntEnum):
    """Record ``mode`` byte; mirrors the 0x80 capability bitmask."""

    FINGERPRINT = 0x01
    CARD = 0x02
    PIN = 0x04
    FACE = 0x08  # expected; not sampled


class UserGroup(IntEnum):
    """User-structure group byte at offset 26 (live-confirmed)."""

    ADMIN = 1
    GENERAL = 2


class Selector(IntEnum):
    """0x0E/0x0F system-parameter selectors (subset)."""

    VOLUME = 2
    BLE_ADVERTISING = 3
    LOCK_DELAY = 18  # overloaded: 1-byte auto-lock seconds OR 4-byte normally-open
    DOOR_DIRECTION = 21
    REMOTE_SENDER = 27
    LANGUAGE = 32


ERROR_CODES = {
    0: "success",
    19: "password error",
    26: "invalid parameters",
    33: "administrator authentication failed",
    129: "user storage full",
    132: "invalid command",
    133: "response timeout",
}

FACTORY_RESET_PAYLOAD = b"\x00\x00"  # 0x0E data reset (live-confirmed)

NAME_FIELD_LEN = 22
USER_STRUCT_LEN = 60
SCHEDULE_BLOCK_LEN = 12
UNUSED_CARD_ID = 0xFFFFFFFF
UNUSED_FINGER_ID = 0xFFFF
RECORD_ENTRY_LEN = 12
ALL_USERS_FILTER = 0  # record query user filter for "all users" (live-confirmed)

# Permanent (no restriction) schedule block, exactly as the app writes it.
PERMANENT_SCHEDULE = bytes.fromhex("000101630C1F0000173B7F00")


class LockError(Exception):
    """Raised when the lock returns a non-zero error code."""

    def __init__(self, code: int, context: str = "") -> None:
        self.code = code
        name = ERROR_CODES.get(code, "unknown error")
        msg = f"lock error {code} ({name})"
        if context:
            msg = f"{context}: {msg}"
        super().__init__(msg)


def error_name(code: Optional[int]) -> str:
    if code is None:
        return "none"
    return ERROR_CODES.get(code, "unknown error")


# --------------------------------------------------------------------------- #
# Small encode/decode helpers
# --------------------------------------------------------------------------- #

def _date_bytes(dt: datetime) -> bytes:
    """Encode a date as the lock's ``YY MM DD`` (YY = year - 2000)."""

    return bytes(((dt.year - 2000) & 0xFF, dt.month, dt.day))


def encode_pin(pin: str) -> bytes:
    """Encode a numeric PIN as 8 bytes of hex nibbles padded with 0xF.

    The 60-byte user structure stores the PIN as hexadecimal nibbles padded to
    16 nibbles with ``F`` (e.g. ``"654321"`` -> ``65 43 21 FF FF FF FF FF``).
    """

    if not pin.isdigit():
        raise ValueError("PIN must be numeric")
    nibbles = pin + "F" * (16 - len(pin))
    if len(nibbles) != 16:
        raise ValueError("PIN too long (max 16 digits)")
    return bytes.fromhex(nibbles)


def decode_pin(raw: bytes) -> str:
    """Decode an 8-byte stored PIN back to its digit string (stops at 0xF)."""

    text = raw.hex().upper()
    digits = text.split("F")[0]
    return digits


# --------------------------------------------------------------------------- #
# Version / capabilities
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class VersionInfo:
    firmware: str
    lock_bonded: bool
    app_bonded: bool
    admin_exists: bool
    attendance_disabled: bool
    command_version: int
    capabilities: Optional[int]  # raw capability byte, if present

    @property
    def has_fingerprint(self) -> bool:
        return bool((self.capabilities or 0) & 0x01)

    @property
    def has_card(self) -> bool:
        return bool((self.capabilities or 0) & 0x02)

    @property
    def has_pin(self) -> bool:
        return bool((self.capabilities or 0) & 0x04)

    @property
    def has_face(self) -> bool:
        return bool((self.capabilities or 0) & 0x08)


def build_get_version() -> Command:
    return (int(Cmd.GET_VERSION), b"")


def parse_version(payload: bytes) -> VersionInfo:
    """Parse a 0x80 response: firmware string, NUL, flags byte, optional caps."""

    nul = payload.find(b"\x00")
    if nul < 0:
        raise ValueError("version response missing NUL terminator")
    firmware = payload[:nul].decode("ascii", errors="replace")
    rest = payload[nul + 1:]
    flags = rest[0] if rest else 0
    capabilities = rest[1] if len(rest) > 1 else None
    return VersionInfo(
        firmware=firmware,
        lock_bonded=bool(flags & 0x01),
        app_bonded=bool(flags & 0x02),
        admin_exists=bool(flags & 0x04),
        attendance_disabled=bool(flags & 0x08),
        command_version=(flags >> 4) & 0x0F,
        capabilities=capabilities,
    )


# --------------------------------------------------------------------------- #
# Authentication
# --------------------------------------------------------------------------- #

def build_login(login_key: str) -> Command:
    """Build a 0x13 admin-login request from an already-derived login key.

    An empty ``login_key`` is the app's bond-probe. For legacy (command
    version 0) firmware the key is the decimal-ASCII string from
    :func:`tools.protocol_codec.derive_login_key`.
    """

    return (int(Cmd.ADMIN_LOGIN), login_key.encode("ascii"))


def build_login_probe() -> Command:
    """Empty 0x13 login, used to probe bond state."""

    return (int(Cmd.ADMIN_LOGIN), b"")


def build_set_login_key(login_key: str) -> Command:
    """0x12 set-login-key: ASCII key followed by a NUL terminator."""

    return (int(Cmd.SET_LOGIN_KEY), login_key.encode("ascii") + b"\x00")


# --------------------------------------------------------------------------- #
# Battery / time
# --------------------------------------------------------------------------- #

def build_get_battery() -> Command:
    return (int(Cmd.GET_BATTERY), b"")


def parse_battery(payload: bytes) -> Tuple[int, float]:
    """Return ``(percent, voltage)``; voltage is byte 1 divided by ten."""

    if len(payload) < 2:
        raise ValueError("battery response too short")
    return payload[0], payload[1] / 10.0


def build_get_time() -> Command:
    return (int(Cmd.GET_TIME), b"")


def parse_time(payload: bytes) -> datetime:
    if len(payload) < 6:
        raise ValueError("time response too short")
    yy, mm, dd, hh, mi, ss = payload[:6]
    return datetime(2000 + yy, mm, dd, hh, mi, ss)


def build_set_time(dt: datetime, tz_offset_minutes: int) -> Command:
    """0x8A: ``YY MM DD hh mm ss`` plus a signed BE16 timezone offset in minutes."""

    body = bytes(
        ((dt.year - 2000) & 0xFF, dt.month, dt.day, dt.hour, dt.minute, dt.second)
    )
    tz = (tz_offset_minutes & 0xFFFF).to_bytes(2, "big")
    return (int(Cmd.SET_TIME), body + tz)


# --------------------------------------------------------------------------- #
# Lock / unlock
# --------------------------------------------------------------------------- #

def build_lock_action(action: LockAction, user_id: int, pin: str = "") -> Command:
    """0x88 lock action: action byte + user ID BE32 + ASCII PIN."""

    payload = bytes((int(action),)) + int(user_id).to_bytes(4, "big") + pin.encode("ascii")
    return (int(Cmd.LOCK_ACTION), payload)


def build_unlock(user_id: int, pin: str = "") -> Command:
    return build_lock_action(LockAction.UNLOCK, user_id, pin)


def build_lock(user_id: int, pin: str = "") -> Command:
    return build_lock_action(LockAction.LOCK, user_id, pin)


def build_reboot() -> Command:
    return (int(Cmd.REBOOT), b"")


def build_factory_reset() -> Command:
    """0x0E with ``00 00`` performs a destructive data reset (live-confirmed)."""

    return (int(Cmd.SET_PARAMETER), FACTORY_RESET_PAYLOAD)


# --------------------------------------------------------------------------- #
# Schedule block and user structure
# --------------------------------------------------------------------------- #

@dataclass
class ScheduleBlock:
    """The 12-byte validity block at offset 48 of a user structure."""

    start: Tuple[int, int, int] = (0, 1, 1)       # (YY, MM, DD)
    end: Tuple[int, int, int] = (99, 12, 31)      # (YY, MM, DD)
    daily_start: Tuple[int, int] = (0, 0)         # (hh, mm)
    daily_end: Tuple[int, int] = (23, 59)         # (hh, mm)
    weekday_flags: int = 0x7F
    reserved: int = 0x00

    def encode(self) -> bytes:
        return bytes(
            (
                self.start[0], self.start[1], self.start[2],
                self.end[0], self.end[1], self.end[2],
                self.daily_start[0], self.daily_start[1],
                self.daily_end[0], self.daily_end[1],
                self.weekday_flags & 0xFF,
                self.reserved & 0xFF,
            )
        )

    @classmethod
    def decode(cls, raw: bytes) -> "ScheduleBlock":
        if len(raw) != SCHEDULE_BLOCK_LEN:
            raise ValueError("schedule block must be 12 bytes")
        return cls(
            start=(raw[0], raw[1], raw[2]),
            end=(raw[3], raw[4], raw[5]),
            daily_start=(raw[6], raw[7]),
            daily_end=(raw[8], raw[9]),
            weekday_flags=raw[10],
            reserved=raw[11],
        )

    @classmethod
    def permanent(cls) -> "ScheduleBlock":
        return cls.decode(PERMANENT_SCHEDULE)


@dataclass
class User:
    """The 60-byte user structure."""

    user_id: int
    name: str = ""
    group: UserGroup = UserGroup.GENERAL
    department: int = 0
    card_id: int = UNUSED_CARD_ID
    finger_ids: Tuple[int, int, int, int] = (
        UNUSED_FINGER_ID, UNUSED_FINGER_ID, UNUSED_FINGER_ID, UNUSED_FINGER_ID,
    )
    pin: str = ""
    schedule: ScheduleBlock = field(default_factory=ScheduleBlock.permanent)

    def encode(self) -> bytes:
        name_bytes = self.name.encode("utf-8")[:NAME_FIELD_LEN]
        name_bytes = name_bytes.ljust(NAME_FIELD_LEN, b"\x00")
        out = bytearray()
        out += int(self.user_id).to_bytes(4, "big")
        out += name_bytes
        out += bytes((int(self.group), self.department & 0xFF))
        out += int(self.card_id).to_bytes(4, "big")
        for fid in self.finger_ids:
            out += int(fid).to_bytes(2, "big")
        out += encode_pin(self.pin) if self.pin else b"\xFF" * 8
        out += self.schedule.encode()
        if len(out) != USER_STRUCT_LEN:
            raise ValueError(f"user structure is {len(out)} bytes, expected 60")
        return bytes(out)

    @classmethod
    def decode(cls, raw: bytes) -> "User":
        if len(raw) != USER_STRUCT_LEN:
            raise ValueError("user structure must be 60 bytes")
        user_id = int.from_bytes(raw[0:4], "big")
        name = raw[4:26].split(b"\x00", 1)[0].decode("utf-8", errors="replace")
        group = UserGroup(raw[26]) if raw[26] in (1, 2) else raw[26]
        department = raw[27]
        card_id = int.from_bytes(raw[28:32], "big")
        finger_ids = tuple(
            int.from_bytes(raw[32 + i * 2: 34 + i * 2], "big") for i in range(4)
        )
        pin = decode_pin(raw[40:48])
        schedule = ScheduleBlock.decode(raw[48:60])
        return cls(
            user_id=user_id, name=name, group=group, department=department,
            card_id=card_id, finger_ids=finger_ids, pin=pin, schedule=schedule,
        )


def build_get_free_user_id() -> Command:
    return (int(Cmd.GET_FREE_USER_ID), b"")


def build_get_user_counts() -> Command:
    return (int(Cmd.GET_USER_COUNTS), b"")


def build_get_users(mode: int, user_id: int = 0) -> Command:
    """0xA3: mode byte + user ID / cursor BE32.

    mode 0 starts enumeration, 1 continues, 2 fetches one user.
    """

    return (int(Cmd.GET_USERS), bytes((mode & 0xFF,)) + int(user_id).to_bytes(4, "big"))


def parse_users_response(payload: bytes) -> List[User]:
    """Parse a 0xA3 response: one count byte then that many 60-byte users."""

    if not payload:
        return []
    count = payload[0]
    users: List[User] = []
    body = payload[1:]
    for i in range(count):
        chunk = body[i * USER_STRUCT_LEN:(i + 1) * USER_STRUCT_LEN]
        if len(chunk) < USER_STRUCT_LEN:
            break
        users.append(User.decode(chunk))
    return users


def build_set_user(user: User) -> Command:
    return (int(Cmd.SET_USER), user.encode())


def build_delete_user(user_id: int) -> Command:
    return (int(Cmd.DELETE_USER), int(user_id).to_bytes(4, "big"))


# --------------------------------------------------------------------------- #
# Credential enrollment
# --------------------------------------------------------------------------- #

def build_start_enrollment(
    enroll_type: EnrollType, user_id: int, pin: str = ""
) -> Command:
    """0xA9: type byte + user ID BE32 (+ ASCII PIN only for type 2)."""

    payload = bytes((int(enroll_type),)) + int(user_id).to_bytes(4, "big")
    if enroll_type == EnrollType.PIN:
        payload += pin.encode("ascii")
    return (int(Cmd.START_ENROLLMENT), payload)


def build_enrollment_status() -> Command:
    return (int(Cmd.GET_ENROLLMENT_STATUS), b"")


def build_cancel_enrollment() -> Command:
    return (int(Cmd.CANCEL_ENROLLMENT), b"")


def build_delete_credential(user_id: int, cred_type: EnrollType) -> Command:
    """0xAB: user ID BE32 + type byte (static-only; not yet live-sampled)."""

    return (
        int(Cmd.DELETE_CREDENTIAL),
        int(user_id).to_bytes(4, "big") + bytes((int(cred_type),)),
    )


# --------------------------------------------------------------------------- #
# Records
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Record:
    user_id: int
    timestamp: datetime
    mode: int
    direction: int

    @property
    def mode_name(self) -> str:
        try:
            return UnlockMode(self.mode).name.lower()
        except ValueError:
            return f"mode_{self.mode:#04x}"


def build_record_count(
    start: datetime, end: datetime, user_filter: int = ALL_USERS_FILTER
) -> Command:
    """0xB2: user filter BE32 + start ``YY MM DD`` + end ``YY MM DD``."""

    payload = int(user_filter).to_bytes(4, "big") + _date_bytes(start) + _date_bytes(end)
    return (int(Cmd.RECORD_COUNT), payload)


def parse_record_count(payload: bytes) -> int:
    if len(payload) < 4:
        raise ValueError("record count response too short")
    return int.from_bytes(payload[:4], "big")


def build_record_batch(offset: int, count: int = 5) -> Command:
    """0xB3: zero-based offset BE32 + count byte (app uses 5 per batch)."""

    return (int(Cmd.RECORD_BATCH), int(offset).to_bytes(4, "big") + bytes((count & 0xFF,)))


def parse_record_batch(payload: bytes) -> List[Record]:
    """Parse a 0xB3 response: count byte then 12-byte entries."""

    if not payload:
        return []
    count = payload[0]
    records: List[Record] = []
    body = payload[1:]
    for i in range(count):
        e = body[i * RECORD_ENTRY_LEN:(i + 1) * RECORD_ENTRY_LEN]
        if len(e) < RECORD_ENTRY_LEN:
            break
        user_id = int.from_bytes(e[0:4], "big")
        try:
            ts = datetime(2000 + e[4], e[5], e[6], e[7], e[8], e[9])
        except ValueError:
            continue
        records.append(Record(user_id=user_id, timestamp=ts, mode=e[10], direction=e[11]))
    return records


# --------------------------------------------------------------------------- #
# Settings parameters
# --------------------------------------------------------------------------- #

def build_get_parameter(selector: Optional[int] = None) -> Command:
    """0x0F: empty returns the full settings blob; a selector returns one group."""

    payload = b"" if selector is None else bytes((selector & 0xFF,))
    return (int(Cmd.GET_PARAMETER), payload)


def build_set_auto_lock_delay(seconds: int) -> Command:
    """0x0E selector 18 with a one-byte seconds value (live-confirmed)."""

    return (int(Cmd.SET_PARAMETER), bytes((int(Selector.LOCK_DELAY), seconds & 0xFF)))


def encode_normally_open(weekday_mask: int, start_minute: int, end_minute: int) -> bytes:
    """Pack the normally-open 32-bit field (live-confirmed).

    ``value = (weekday_mask << 22) | (end_minute << 11) | start_minute``
    """

    value = ((weekday_mask & 0x7F) << 22) | ((end_minute & 0x7FF) << 11) | (start_minute & 0x7FF)
    return value.to_bytes(4, "big")


def decode_normally_open(raw: bytes) -> Tuple[int, int, int]:
    """Return ``(weekday_mask, start_minute, end_minute)`` from the 4-byte field."""

    if len(raw) != 4:
        raise ValueError("normally-open field must be 4 bytes")
    value = int.from_bytes(raw, "big")
    start_minute = value & 0x7FF
    end_minute = (value >> 11) & 0x7FF
    weekday_mask = (value >> 22) & 0x7F
    return weekday_mask, start_minute, end_minute


def build_set_normally_open(
    weekday_mask: int, start_minute: int, end_minute: int
) -> Command:
    """0x0E selector 18 with the 4-byte packed schedule (live-confirmed)."""

    return (
        int(Cmd.SET_PARAMETER),
        bytes((int(Selector.LOCK_DELAY),)) + encode_normally_open(
            weekday_mask, start_minute, end_minute
        ),
    )
