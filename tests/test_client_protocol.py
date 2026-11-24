"""Offline unit tests for the Jenix client protocol layer.

These tests require no Bluetooth and no lock. They assert the request builders
and response parsers against values confirmed on firmware BK50D-V2.5 in Phase 2
(see docs/live_validation.md).
"""

from datetime import datetime

import pytest

from tools.protocol_codec import decode_frame, encode_command
from client import protocol as P
from client.auth import build_login_payload, login_key_for


# -- framing roundtrip ------------------------------------------------------ #

def test_command_frame_roundtrips_through_codec():
    cmd, payload = P.build_get_version()
    raw = encode_command(cmd, payload)
    frame = decode_frame(raw)
    assert frame.command == 0x80
    assert frame.payload == b""


def test_flag7_response_attaches_request_command():
    # Simulate a flag-7 battery acknowledgement (error 0, payload 100% / 5.9V).
    from tools.protocol_codec import checksum16

    payload = bytes((100, 59))  # percent, voltage*10
    # flag-7 layout after address: flag, length(=error+payload+checksum=N+3),
    # error, payload, checksum.
    checked = bytes((0x07,)) + (len(payload) + 3).to_bytes(2, "big") + bytes((0x00,)) + payload
    raw = b"\xEF\x01\x00\x00\x00\x01" + checked + checksum16(checked).to_bytes(2, "big")
    frame = decode_frame(raw, request_command=0x8C)
    assert frame.command == 0x8C
    assert frame.error_code == 0
    pct, volts = P.parse_battery(frame.payload)
    assert pct == 100
    assert volts == pytest.approx(5.9)


# -- version ---------------------------------------------------------------- #

def test_parse_version_legacy():
    payload = b"BK50D-V2.5\x00" + bytes((0x04, 0x07))  # admin exists, cv 0, caps finger+card+pin
    v = P.parse_version(payload)
    assert v.firmware == "BK50D-V2.5"
    assert v.command_version == 0
    assert v.admin_exists is True
    assert v.has_fingerprint and v.has_card and v.has_pin
    assert not v.has_face


# -- lock / unlock ---------------------------------------------------------- #

def test_unlock_and_lock_action_bytes():
    cmd, payload = P.build_unlock(1, "654321")
    assert cmd == 0x88
    assert payload[0] == P.LockAction.UNLOCK == 0x01
    assert payload[1:5] == (1).to_bytes(4, "big")
    assert payload[5:] == b"654321"

    _, lock_payload = P.build_lock(1)
    assert lock_payload[0] == P.LockAction.LOCK == 0x00


# -- user structure --------------------------------------------------------- #

def test_pin_encode_decode():
    assert P.encode_pin("654321").hex().upper() == "654321FFFFFFFFFF"
    assert P.decode_pin(P.encode_pin("654321")) == "654321"


def test_user_struct_roundtrip_general():
    user = P.User(user_id=1, name="TEST1", group=P.UserGroup.GENERAL, pin="654321")
    raw = user.encode()
    assert len(raw) == P.USER_STRUCT_LEN == 60
    assert raw[26] == P.UserGroup.GENERAL == 2
    back = P.User.decode(raw)
    assert back.user_id == 1
    assert back.name == "TEST1"
    assert back.group == P.UserGroup.GENERAL
    assert back.pin == "654321"


def test_user_struct_admin_group_byte():
    user = P.User(user_id=2, name="ADMIN2", group=P.UserGroup.ADMIN)
    raw = user.encode()
    assert raw[26] == P.UserGroup.ADMIN == 1


def test_permanent_schedule_matches_app_default():
    assert P.ScheduleBlock.permanent().encode() == P.PERMANENT_SCHEDULE
    assert P.PERMANENT_SCHEDULE.hex().upper() == "000101630C1F0000173B7F00"


def test_custom_schedule_block_decode():
    raw = bytes.fromhex("1a0b181a0b180000173bbe00")  # captured one-day custom window
    block = P.ScheduleBlock.decode(raw)
    assert block.start == (26, 11, 24)       # 2026-11-24
    assert block.end == (26, 11, 24)
    assert block.daily_start == (0, 0)
    assert block.daily_end == (23, 59)


# -- enrollment ------------------------------------------------------------- #

def test_enrollment_payload_shapes():
    _, pin_payload = P.build_start_enrollment(P.EnrollType.PIN, 1, "654321")
    assert pin_payload[0] == P.EnrollType.PIN == 2
    assert len(pin_payload) == 11  # type + user id + 6-char pin

    _, finger_payload = P.build_start_enrollment(P.EnrollType.FINGERPRINT, 1)
    assert finger_payload[0] == P.EnrollType.FINGERPRINT == 1
    assert len(finger_payload) == 5  # type + user id, no inline credential

    _, card_payload = P.build_start_enrollment(P.EnrollType.CARD, 1)
    assert card_payload[0] == P.EnrollType.CARD == 3
    assert len(card_payload) == 5


# -- records ---------------------------------------------------------------- #

def test_record_count_all_users_filter_and_dates():
    cmd, payload = P.build_record_count(datetime(2026, 11, 24), datetime(2026, 11, 24))
    assert cmd == 0xB2
    assert payload[:4] == b"\x00\x00\x00\x00"           # all-users filter
    assert payload[4:7] == bytes((26, 11, 24))          # start YY MM DD
    assert payload[7:10] == bytes((26, 11, 24))         # end YY MM DD


def test_record_batch_request():
    cmd, payload = P.build_record_batch(0, 5)
    assert cmd == 0xB3
    assert payload == b"\x00\x00\x00\x00\x05"


def test_parse_record_batch_mode_mapping():
    # count + three 12-byte entries: PIN, fingerprint, card (as captured 19:12).
    entries = [
        (1, datetime(2026, 11, 24, 19, 12, 4), 0x04, 0x00),
        (1, datetime(2026, 11, 24, 19, 12, 9), 0x01, 0x00),
        (1, datetime(2026, 11, 24, 19, 12, 18), 0x02, 0x00),
    ]
    body = bytearray((len(entries),))
    for uid, ts, mode, direction in entries:
        body += uid.to_bytes(4, "big")
        body += bytes((ts.year - 2000, ts.month, ts.day, ts.hour, ts.minute, ts.second))
        body += bytes((mode, direction))
    records = P.parse_record_batch(bytes(body))
    assert [r.mode for r in records] == [0x04, 0x01, 0x02]
    assert records[0].mode_name == "pin"
    assert records[1].mode_name == "fingerprint"
    assert records[2].mode_name == "card"


# -- settings: normally-open packed field ----------------------------------- #

def test_normally_open_encode_matches_capture():
    # all days, 08:00-20:00  ->  0x1FE581E0 (captured 1F E5 81 E0)
    raw = P.encode_normally_open(0x7F, 8 * 60, 20 * 60)
    assert raw == bytes.fromhex("1FE581E0")


def test_normally_open_roundtrip():
    weekday, start_min, end_min = P.decode_normally_open(bytes.fromhex("1FE581E0"))
    assert weekday == 0x7F
    assert start_min == 8 * 60
    assert end_min == 20 * 60


def test_auto_lock_delay_payload():
    cmd, payload = P.build_set_auto_lock_delay(11)
    assert cmd == 0x0E
    assert payload == bytes((18, 11))  # selector 18, 11 seconds


def test_factory_reset_payload():
    cmd, payload = P.build_factory_reset()
    assert cmd == 0x0E
    assert payload == b"\x00\x00"


# -- auth ------------------------------------------------------------------- #

def test_legacy_login_payload_is_decimal_ascii():
    # Synthetic password/lock id (NOT a real credential); checks the shape only.
    payload = build_login_payload("000000", "TESTLOCKID", 0)
    assert payload.decode("ascii").isdigit()
    assert payload.decode("ascii") == login_key_for("000000", "TESTLOCKID", 0)


def test_newer_login_not_implemented():
    with pytest.raises(NotImplementedError):
        build_login_payload("000000", "TESTLOCKID", 1)
