"""Extract HAHA Lock protocol frames from an Android BTSnoop capture.

Raw captures can contain device identifiers, credentials, and unrelated phone
traffic.  This tool therefore prints redacted payload summaries by default.
Use ``--show-payloads`` only for authorized local analysis; never commit that
output or the source capture.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
from pathlib import Path
import struct
from typing import Iterable, Iterator, Optional

from tools.protocol_codec import Frame, FrameStreamDecoder, ProtocolError


BTSNOOP_MAGIC = b"btsnoop\x00"
BTSNOOP_DATALINK_HCI_UART_H4 = 1002
BTSNOOP_UNIX_EPOCH_DELTA_US = 0x00DCDDB30F2F8000

H4_EVENT = 0x04
H4_ACL = 0x02
HCI_EVENT_LE_META = 0x3E
LE_ADVERTISING_REPORT = 0x02
LE_EXTENDED_ADVERTISING_REPORT = 0x0D
L2CAP_CID_ATT = 0x0004

ATT_OPERATIONS_WITH_HANDLE = {
    0x12: "write-request",
    0x1B: "notification",
    0x1D: "indication",
    0x52: "write-command",
    0xD2: "signed-write-command",
}

COMMAND_NAMES = {
    0x0C: "delete-fingerprint",
    0x0E: "set-parameter",
    0x0F: "get-parameter",
    0x12: "set-login-key",
    0x13: "admin-login",
    0x14: "login-state",
    0x16: "fingerprint-info",
    0x1F: "fingerprint-index",
    0x80: "get-version",
    0x81: "reboot",
    0x82: "get-lock-uid",
    0x84: "partition-info",
    0x85: "erase-flash",
    0x86: "write-flash",
    0x87: "read-flash",
    0x88: "lock-action",
    0x89: "async-notification",
    0x8A: "set-time",
    0x8B: "get-time",
    0x8C: "get-battery",
    0x8D: "system-lock",
    0x8E: "bond-device",
    0xA0: "get-free-user-id",
    0xA1: "get-user-counts",
    0xA2: "delete-user",
    0xA3: "get-users",
    0xA4: "set-user",
    0xA5: "fingerprint-upload",
    0xA6: "fingerprint-download",
    0xA8: "enrollment-status",
    0xA9: "start-enrollment",
    0xAA: "cancel-enrollment",
    0xAB: "delete-credential",
    0xB2: "record-count",
    0xB3: "record-batch",
}


class BtsnoopError(ValueError):
    """Raised when a BTSnoop file is malformed or unsupported."""


@dataclass(frozen=True)
class SnoopRecord:
    timestamp: datetime
    sent: bool
    data: bytes


@dataclass(frozen=True)
class AttValue:
    timestamp: datetime
    sent: bool
    connection_handle: int
    operation: str
    attribute_handle: int
    value: bytes


@dataclass(frozen=True)
class L2capPdu:
    timestamp: datetime
    sent: bool
    connection_handle: int
    channel_id: int
    payload: bytes


@dataclass(frozen=True)
class Advertisement:
    timestamp: datetime
    address: bytes
    rssi: int
    name: Optional[str]
    manufacturer_data: tuple[bytes, ...]
    ad_types: tuple[int, ...]


@dataclass(frozen=True)
class DecodedHahaFrame:
    timestamp: datetime
    sent: bool
    connection_handle: int
    attribute_handle: int
    operation: str
    frame: Frame


def _timestamp_from_btsnoop(value: int) -> datetime:
    unix_us = value - BTSNOOP_UNIX_EPOCH_DELTA_US
    return datetime.fromtimestamp(unix_us / 1_000_000, tz=timezone.utc)


def read_btsnoop(path: Path) -> Iterator[SnoopRecord]:
    with path.open("rb") as source:
        header = source.read(16)
        if len(header) != 16 or header[:8] != BTSNOOP_MAGIC:
            raise BtsnoopError("not a BTSnoop file")
        version, datalink = struct.unpack(">II", header[8:])
        if version != 1:
            raise BtsnoopError(f"unsupported BTSnoop version {version}")
        if datalink != BTSNOOP_DATALINK_HCI_UART_H4:
            raise BtsnoopError(f"unsupported BTSnoop datalink {datalink}")

        while True:
            record_header = source.read(24)
            if not record_header:
                return
            if len(record_header) != 24:
                raise BtsnoopError("truncated BTSnoop record header")
            original_len, included_len, flags, _drops, timestamp = struct.unpack(
                ">IIIIQ", record_header
            )
            if included_len > original_len:
                raise BtsnoopError("included packet length exceeds original length")
            packet = source.read(included_len)
            if len(packet) != included_len:
                raise BtsnoopError("truncated BTSnoop packet")
            yield SnoopRecord(
                timestamp=_timestamp_from_btsnoop(timestamp),
                sent=(flags & 1) == 0,
                data=packet,
            )


def _signed_byte(value: int) -> int:
    return value - 256 if value >= 128 else value


def _advertising_fields(
    data: bytes,
) -> tuple[Optional[str], tuple[bytes, ...], tuple[int, ...]]:
    name: Optional[str] = None
    manufacturer: list[bytes] = []
    ad_types: list[int] = []
    offset = 0
    while offset < len(data):
        size = data[offset]
        if size == 0:
            break
        end = offset + 1 + size
        if end > len(data) or size < 1:
            break
        field_type = data[offset + 1]
        field_value = data[offset + 2 : end]
        ad_types.append(field_type)
        if field_type in (0x08, 0x09):
            name = field_value.decode("utf-8", errors="replace")
        elif field_type == 0xFF:
            manufacturer.append(field_value)
        offset = end
    return name, tuple(manufacturer), tuple(ad_types)


def iter_advertisements(records: Iterable[SnoopRecord]) -> Iterator[Advertisement]:
    for record in records:
        packet = record.data
        if len(packet) < 5 or packet[0] != H4_EVENT or packet[1] != HCI_EVENT_LE_META:
            continue
        params = packet[3 : 3 + packet[2]]
        if len(params) < 2:
            continue
        subevent = params[0]
        count = params[1]
        offset = 2

        if subevent == LE_ADVERTISING_REPORT:
            for _ in range(count):
                if offset + 10 > len(params):
                    break
                address = params[offset + 2 : offset + 8]
                data_len = params[offset + 8]
                data_start = offset + 9
                data_end = data_start + data_len
                if data_end >= len(params):
                    break
                name, manufacturer, ad_types = _advertising_fields(params[data_start:data_end])
                yield Advertisement(
                    timestamp=record.timestamp,
                    address=address,
                    rssi=_signed_byte(params[data_end]),
                    name=name,
                    manufacturer_data=manufacturer,
                    ad_types=ad_types,
                )
                offset = data_end + 1
        elif subevent == LE_EXTENDED_ADVERTISING_REPORT:
            for _ in range(count):
                if offset + 24 > len(params):
                    break
                address = params[offset + 3 : offset + 9]
                rssi = _signed_byte(params[offset + 13])
                data_len = params[offset + 23]
                data_start = offset + 24
                data_end = data_start + data_len
                if data_end > len(params):
                    break
                name, manufacturer, ad_types = _advertising_fields(params[data_start:data_end])
                yield Advertisement(
                    timestamp=record.timestamp,
                    address=address,
                    rssi=rssi,
                    name=name,
                    manufacturer_data=manufacturer,
                    ad_types=ad_types,
                )
                offset = data_end


def iter_l2cap_pdus(records: Iterable[SnoopRecord]) -> Iterator[L2capPdu]:
    pending: dict[tuple[bool, int], tuple[int, int, bytearray, datetime]] = {}

    for record in records:
        packet = record.data
        if len(packet) < 9 or packet[0] != H4_ACL:
            continue
        handle_flags = int.from_bytes(packet[1:3], "little")
        handle = handle_flags & 0x0FFF
        packet_boundary = (handle_flags >> 12) & 0x03
        acl_len = int.from_bytes(packet[3:5], "little")
        acl_data = packet[5 : 5 + acl_len]
        if len(acl_data) != acl_len:
            continue
        key = (record.sent, handle)

        if packet_boundary == 1:
            state = pending.get(key)
            if state is None:
                continue
            expected, cid, assembled, started = state
            assembled.extend(acl_data)
        else:
            if len(acl_data) < 4:
                continue
            expected = int.from_bytes(acl_data[0:2], "little")
            cid = int.from_bytes(acl_data[2:4], "little")
            assembled = bytearray(acl_data[4:])
            started = record.timestamp

        if len(assembled) < expected:
            pending[key] = (expected, cid, assembled, started)
            continue
        pending.pop(key, None)
        yield L2capPdu(
            timestamp=started,
            sent=record.sent,
            connection_handle=handle,
            channel_id=cid,
            payload=bytes(assembled[:expected]),
        )


def iter_att_values(records: Iterable[SnoopRecord]) -> Iterator[AttValue]:
    for pdu in iter_l2cap_pdus(records):
        if pdu.channel_id != L2CAP_CID_ATT:
            continue
        att = pdu.payload
        if len(att) < 3 or att[0] not in ATT_OPERATIONS_WITH_HANDLE:
            continue
        yield AttValue(
            timestamp=pdu.timestamp,
            sent=pdu.sent,
            connection_handle=pdu.connection_handle,
            operation=ATT_OPERATIONS_WITH_HANDLE[att[0]],
            attribute_handle=int.from_bytes(att[1:3], "little"),
            value=att[3:],
        )


def iter_haha_frames(values: Iterable[AttValue]) -> Iterator[DecodedHahaFrame]:
    decoders: dict[tuple[bool, int, int], FrameStreamDecoder] = {}
    pending_commands: dict[int, int] = {}
    for value in values:
        key = (value.sent, value.connection_handle, value.attribute_handle)
        decoder = decoders.setdefault(key, FrameStreamDecoder())
        try:
            frames = decoder.feed(
                value.value,
                request_command=pending_commands.get(value.connection_handle),
            )
        except ProtocolError:
            decoders[key] = FrameStreamDecoder()
            continue
        for frame in frames:
            if value.sent and frame.flag == 0x01 and frame.command is not None:
                pending_commands[value.connection_handle] = frame.command
            elif not value.sent and frame.flag in (0x05, 0x07):
                pending_commands.pop(value.connection_handle, None)
            yield DecodedHahaFrame(
                timestamp=value.timestamp,
                sent=value.sent,
                connection_handle=value.connection_handle,
                attribute_handle=value.attribute_handle,
                operation=value.operation,
                frame=frame,
            )


def _digest(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()[:12]


def _redacted_name(name: Optional[str]) -> str:
    if not name:
        return "<none>"
    prefix = name.split("_", 1)[0]
    return f"{prefix}_<sha256:{_digest(name.encode('utf-8'))}>"


def _payload_summary(frame: Frame, show_payloads: bool) -> str:
    if show_payloads:
        return frame.payload.hex().upper() or "<empty>"
    if not frame.payload:
        return "<empty>"
    if frame.command == 0x8C and len(frame.payload) >= 2:
        return f"battery={frame.payload[0]}% voltage={frame.payload[1] / 10:.1f}V"
    return f"<redacted len={len(frame.payload)} sha256={_digest(frame.payload)}>"


def analyze(path: Path, *, show_payloads: bool = False) -> str:
    records = list(read_btsnoop(path))
    advertisements = list(iter_advertisements(records))
    att_values = list(iter_att_values(records))
    frames = list(iter_haha_frames(att_values))

    lines = [
        f"records={len(records)} advertisements={len(advertisements)} "
        f"att_values={len(att_values)} haha_frames={len(frames)}"
    ]
    recognized_prefixes = {"Lck1", "Lck2", "Lock", "Acc", "Acc1", "Acc2"}
    names_by_address = {
        adv.address: adv.name
        for adv in advertisements
        if adv.name and adv.name.split("_", 1)[0] in recognized_prefixes
    }
    for address, name in names_by_address.items():
        related = [adv for adv in advertisements if adv.address == address]
        manufacturer_items = {
            item for adv in related for item in adv.manufacturer_data
        }
        manufacturer = ",".join(
            f"len={len(item)} sha256={_digest(item)}"
            for item in sorted(manufacturer_items)
        ) or "none"
        ad_types = sorted({field_type for adv in related for field_type in adv.ad_types})
        rssi_values = [adv.rssi for adv in related]
        lines.append(
            f"advertisement name={_redacted_name(name)} reports={len(related)} "
            f"rssi={min(rssi_values)}..{max(rssi_values)} "
            f"ad_types={','.join(f'0x{value:02X}' for value in ad_types) or 'none'} "
            f"manufacturer={manufacturer}"
        )

    for item in frames:
        frame = item.frame
        command = "unknown" if frame.command is None else COMMAND_NAMES.get(frame.command, "unknown")
        command_id = "none" if frame.command is None else f"0x{frame.command:02X}"
        direction = "host->controller" if item.sent else "controller->host"
        lines.append(
            " ".join(
                (
                    item.timestamp.isoformat(),
                    direction,
                    item.operation,
                    f"att=0x{item.attribute_handle:04X}",
                    f"flag=0x{frame.flag:02X}",
                    f"command={command_id}({command})",
                    f"error={frame.error_code}",
                    f"payload={_payload_summary(frame, show_payloads)}",
                )
            )
        )
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path)
    parser.add_argument(
        "--show-payloads",
        action="store_true",
        help="show raw authorized payloads; output is unsafe to publish",
    )
    args = parser.parse_args()
    print(analyze(args.capture, show_payloads=args.show_payloads))


if __name__ == "__main__":
    main()
