"""Offline tests for BLE name matching and redacted frame logging.

No Bluetooth required: the discovery matcher and the log formatter are pure.
"""

from tools.protocol_codec import Frame
from client.discover import (
    SERVICE_FFE0,
    extract_lock_id,
    matches_lock,
)
from client import logging_util as L


# -- discovery matcher ------------------------------------------------------ #

def test_extract_lock_id():
    assert extract_lock_id("Lck1_8F3EE684ECE3") == "8F3EE684ECE3"
    assert extract_lock_id("Lock") is None


def test_matches_recognized_lock():
    assert matches_lock("Lck1_8F3EE684ECE3", -47, [SERVICE_FFE0])


def test_rejects_virtual_and_unknown_prefix():
    assert not matches_lock("Vir_123456", -40, [])
    assert not matches_lock("RandomDevice", -40, [])


def test_rssi_threshold():
    assert not matches_lock("Lck1_ABC", -95, [], rssi_threshold=-90)
    assert matches_lock("Lck1_ABC", -80, [], rssi_threshold=-90)


def test_lock_id_allowlist():
    assert matches_lock("Lck1_8F3EE684ECE3", -47, [], lock_id="8f3ee684ece3")
    assert not matches_lock("Lck1_8F3EE684ECE3", -47, [], lock_id="DEADBEEF")


def test_require_service_filter():
    assert matches_lock("Lck1_ABC", -47, [SERVICE_FFE0], require_service=True)
    assert not matches_lock("Lck1_ABC", -47, [], require_service=True)


# -- redacted logging ------------------------------------------------------- #

def test_payload_redacted_by_default():
    out = L.redact_payload(b"\x01\x02\x03\x04\x05\x06")
    assert "len=6" in out
    assert "sha256=" in out
    assert "01 02 03" not in out  # raw bytes must not leak


def test_payload_shown_only_when_requested():
    assert L.redact_payload(b"\xAA\xBB", show=True) == "aa bb"
    assert L.redact_payload(b"") == "<empty>"


def test_command_name_known_and_unknown():
    assert L.command_name(0x88) == "lock_action"
    assert L.command_name(0xEE) == "cmd_0xee"


def test_frame_line_tx_and_rx():
    tx = L.frame_line(sent=True, command=0x88, error=None, payload=b"\x01\x02")
    assert tx.startswith("TX lock_action(0x88)")
    assert "sha256=" in tx

    rx = L.frame_line(sent=False, command=0x8A, error=33, payload=b"")
    assert rx.startswith("RX set_time(0x8A)")
    assert "error=33(administrator authentication failed)" in rx


def test_frame_logger_captures_lines():
    lines = []
    logger = L.FrameLogger(sink=lines.append)
    logger.tx(0x80, b"")
    logger.rx(Frame(address=1, flag=0x07, command=0x80, error_code=0, payload=b"x", raw=b""))
    logger.event("hello")
    assert lines[0].startswith("TX get_version(0x80)")
    assert lines[1].startswith("RX get_version(0x80)")
    assert lines[2] == "hello"
