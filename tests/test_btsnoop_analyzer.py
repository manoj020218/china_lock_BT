from datetime import datetime, timezone
from pathlib import Path
import struct
import tempfile
import unittest

from tools.btsnoop_analyzer import (
    BTSNOOP_UNIX_EPOCH_DELTA_US,
    AttValue,
    SnoopRecord,
    iter_advertisements,
    iter_att_values,
    iter_haha_frames,
    read_btsnoop,
)
from tools.protocol_codec import (
    FLAG_ACK_IMPLICIT_COMMAND,
    checksum16,
    encode_command,
)


CAPTURE_TIME = datetime(2026, 11, 24, 12, 0, tzinfo=timezone.utc)
CONNECTION_HANDLE = 0x000B
ATTRIBUTE_HANDLE = 0x0025


def make_response(flag: int, body: bytes, address: int = 0x01020304) -> bytes:
    length = len(body) + 2
    checked = bytes((flag,)) + length.to_bytes(2, "big") + body
    return (
        b"\xEF\x01"
        + address.to_bytes(4, "big")
        + checked
        + checksum16(checked).to_bytes(2, "big")
    )


def acl_att_record(*, sent: bool, opcode: int, value: bytes) -> SnoopRecord:
    att = bytes((opcode,)) + ATTRIBUTE_HANDLE.to_bytes(2, "little") + value
    l2cap = len(att).to_bytes(2, "little") + b"\x04\x00" + att
    handle_flags = CONNECTION_HANDLE | (2 << 12)
    h4 = (
        b"\x02"
        + handle_flags.to_bytes(2, "little")
        + len(l2cap).to_bytes(2, "little")
        + l2cap
    )
    return SnoopRecord(timestamp=CAPTURE_TIME, sent=sent, data=h4)


class BtsnoopAnalyzerTests(unittest.TestCase):
    def test_legacy_advertisement_fields(self) -> None:
        name = b"Lck1_DEMO"
        advertising_data = (
            b"\x02\x01\x06"
            + bytes((len(name) + 1, 0x09))
            + name
            + b"\x05\xFF\x06\xA1\x00\x01"
        )
        params = (
            b"\x02\x01\x00\x00"
            + b"\x01\x02\x03\x04\x05\x06"
            + bytes((len(advertising_data),))
            + advertising_data
            + b"\xD8"
        )
        packet = b"\x04\x3E" + bytes((len(params),)) + params
        record = SnoopRecord(timestamp=CAPTURE_TIME, sent=False, data=packet)

        advertisements = list(iter_advertisements((record,)))
        self.assertEqual(len(advertisements), 1)
        self.assertEqual(advertisements[0].name, "Lck1_DEMO")
        self.assertEqual(advertisements[0].rssi, -40)
        self.assertEqual(advertisements[0].ad_types, (0x01, 0x09, 0xFF))
        self.assertEqual(advertisements[0].manufacturer_data, (b"\x06\xA1\x00\x01",))

    def test_read_btsnoop_record(self) -> None:
        packet = b"\x04\x0E\x01\x00"
        unix_us = int(CAPTURE_TIME.timestamp() * 1_000_000)
        timestamp = unix_us + BTSNOOP_UNIX_EPOCH_DELTA_US
        content = (
            b"btsnoop\x00"
            + struct.pack(">II", 1, 1002)
            + struct.pack(">IIIIQ", len(packet), len(packet), 0, 0, timestamp)
            + packet
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "capture.log"
            path.write_bytes(content)
            records = list(read_btsnoop(path))
        self.assertEqual(len(records), 1)
        self.assertTrue(records[0].sent)
        self.assertEqual(records[0].timestamp, CAPTURE_TIME)
        self.assertEqual(records[0].data, packet)

    def test_att_extraction_and_implicit_ack_correlation(self) -> None:
        request = acl_att_record(sent=True, opcode=0x12, value=encode_command(0x8C))
        response_bytes = make_response(FLAG_ACK_IMPLICIT_COMMAND, b"\x00\x64\x25")
        response = acl_att_record(sent=False, opcode=0x1B, value=response_bytes)

        values = list(iter_att_values((request, response)))
        self.assertEqual(len(values), 2)
        self.assertEqual(values[0].attribute_handle, ATTRIBUTE_HANDLE)
        self.assertEqual(values[0].value, encode_command(0x8C))

        frames = list(iter_haha_frames(values))
        self.assertEqual(len(frames), 2)
        self.assertEqual(frames[0].frame.command, 0x8C)
        self.assertEqual(frames[1].frame.command, 0x8C)
        self.assertEqual(frames[1].frame.error_code, 0)
        self.assertEqual(frames[1].frame.payload, b"\x64\x25")

    def test_att_value_dataclass_is_stable(self) -> None:
        value = AttValue(
            timestamp=CAPTURE_TIME,
            sent=True,
            connection_handle=CONNECTION_HANDLE,
            operation="write-request",
            attribute_handle=ATTRIBUTE_HANDLE,
            value=b"data",
        )
        self.assertEqual(value.value, b"data")


if __name__ == "__main__":
    unittest.main()
