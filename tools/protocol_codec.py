"""Independent HAHA Lock BLE frame codec reconstructed during Phase 1.

This module performs no Bluetooth I/O and contains no real lock credentials.
It is intentionally limited to framing and credential-key derivation so it can
be used to inspect sanitized captures during the next project phase.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
from typing import Optional


PREAMBLE = b"\xEF\x01"
INITIAL_ADDRESS = 0xFFFFFFFF

FLAG_COMMAND = 0x01
FLAG_ACK_WITH_COMMAND = 0x05
FLAG_ACK_IMPLICIT_COMMAND = 0x07
SUPPORTED_FLAGS = {
    FLAG_COMMAND,
    FLAG_ACK_WITH_COMMAND,
    FLAG_ACK_IMPLICIT_COMMAND,
}

LOGIN_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"


class ProtocolError(ValueError):
    """Raised when a binary frame is incomplete or invalid."""


@dataclass(frozen=True)
class Frame:
    address: int
    flag: int
    command: Optional[int]
    error_code: Optional[int]
    payload: bytes
    raw: bytes


def checksum16(data: bytes) -> int:
    """Return the protocol's unsigned additive 16-bit checksum."""

    return sum(data) & 0xFFFF


def encode_command(command: int, payload: bytes = b"", address: int = INITIAL_ADDRESS) -> bytes:
    """Encode a flag-1 command frame."""

    if not 0 <= command <= 0xFF:
        raise ValueError("command must fit in one byte")
    if not 0 <= address <= 0xFFFFFFFF:
        raise ValueError("address must fit in four bytes")
    if len(payload) > 0xFFFC:
        raise ValueError("payload is too large")

    length = len(payload) + 3
    checked = bytes((FLAG_COMMAND,)) + length.to_bytes(2, "big") + bytes((command,)) + payload
    return PREAMBLE + address.to_bytes(4, "big") + checked + checksum16(checked).to_bytes(2, "big")


def expected_frame_size(data: bytes, start: int = 0) -> int:
    """Return total frame size from a preamble, or raise if the header is short."""

    if len(data) < start + 9:
        raise ProtocolError("incomplete frame header")
    if data[start : start + 2] != PREAMBLE:
        raise ProtocolError("preamble not found at start offset")
    declared_length = int.from_bytes(data[start + 7 : start + 9], "big")
    if declared_length < 3:
        raise ProtocolError("declared length is smaller than protocol overhead")
    return declared_length + 9


def decode_frame(
    data: bytes,
    *,
    request_command: Optional[int] = None,
    allow_leading_bytes: bool = False,
    max_frame_size: int = 4096,
) -> Frame:
    """Decode and checksum one complete frame.

    ``request_command`` is required to attach a command ID to a flag-7 response.
    The app infers that ID from its single pending request.
    """

    start = data.find(PREAMBLE) if allow_leading_bytes else 0
    if start < 0 or data[start : start + 2] != PREAMBLE:
        raise ProtocolError("frame preamble not found")

    size = expected_frame_size(data, start)
    if size > max_frame_size:
        raise ProtocolError("frame exceeds configured size limit")
    if len(data) < start + size:
        raise ProtocolError("incomplete frame")

    raw = data[start : start + size]
    flag = raw[6]
    if flag not in SUPPORTED_FLAGS:
        raise ProtocolError(f"unsupported frame flag 0x{flag:02X}")

    expected_checksum = int.from_bytes(raw[-2:], "big")
    actual_checksum = checksum16(raw[6:-2])
    if actual_checksum != expected_checksum:
        raise ProtocolError(
            f"checksum mismatch: expected 0x{expected_checksum:04X}, calculated 0x{actual_checksum:04X}"
        )

    address = int.from_bytes(raw[2:6], "big")
    if flag == FLAG_COMMAND:
        command = raw[9]
        error_code = None
        payload = raw[10:-2]
    elif flag == FLAG_ACK_WITH_COMMAND:
        if len(raw) < 13:
            raise ProtocolError("flag-5 acknowledgement is too short")
        command = raw[9]
        error_code = raw[10]
        payload = raw[11:-2]
    else:
        command = request_command
        error_code = raw[9]
        payload = raw[10:-2]

    return Frame(
        address=address,
        flag=flag,
        command=command,
        error_code=error_code,
        payload=payload,
        raw=raw,
    )


class FrameStreamDecoder:
    """Reassemble frames split across BLE notification chunks."""

    def __init__(self, *, max_frame_size: int = 4096) -> None:
        self._buffer = bytearray()
        self.max_frame_size = max_frame_size

    def feed(self, chunk: bytes, *, request_command: Optional[int] = None) -> list[Frame]:
        self._buffer.extend(chunk)
        frames: list[Frame] = []

        while True:
            start = self._buffer.find(PREAMBLE)
            if start < 0:
                # Retain a trailing 0xEF because the second preamble byte may
                # arrive in the next BLE notification chunk.
                if self._buffer.endswith(PREAMBLE[:1]):
                    self._buffer[:] = PREAMBLE[:1]
                else:
                    self._buffer.clear()
                break
            if start:
                del self._buffer[:start]
            if len(self._buffer) < 9:
                break

            size = expected_frame_size(self._buffer)
            if size > self.max_frame_size:
                del self._buffer[0]
                continue
            if len(self._buffer) < size:
                break

            candidate = bytes(self._buffer[:size])
            frame = decode_frame(
                candidate,
                request_command=request_command,
                max_frame_size=self.max_frame_size,
            )
            frames.append(frame)
            del self._buffer[:size]

        return frames


def derive_credential_token(password: str, lock_id: str) -> str:
    """Derive the app's 16-hex-character stored credential token."""

    digest = hashlib.md5((password + lock_id).encode("utf-8")).hexdigest().upper()
    return digest[8:24]


def derive_login_key(credential_token: str, command_version: int) -> str:
    """Derive the legacy decimal or newer eight-character login key."""

    try:
        token_bytes = bytes.fromhex(credential_token)
    except ValueError as exc:
        raise ValueError("credential token must be hexadecimal") from exc
    if len(token_bytes) != 8:
        raise ValueError("credential token must contain exactly eight bytes")

    if command_version == 0:
        value = int.from_bytes(token_bytes[2:6], "big") & 0x7FFFFFFF
        return str(value)
    return "".join(LOGIN_ALPHABET[value % 64] for value in token_bytes)
