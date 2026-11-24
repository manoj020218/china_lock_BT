"""Redacted frame logging.

By default, frame payloads are never printed in the clear, because they can
carry PINs, login keys, card IDs and other credentials. A frame is logged as
its direction, command name and a length + SHA-256 digest of the payload, the
same redaction style as ``tools/btsnoop_analyzer.py``.

Raw payloads are only shown when ``show_payloads=True`` is explicitly set
(CLI ``--show-payloads``), which must never be used for shared logs.
"""

from __future__ import annotations

import hashlib
import sys
from typing import Callable, Optional

from tools.protocol_codec import Frame
from .protocol import Cmd, error_name


def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:12]


def command_name(command: Optional[int]) -> str:
    if command is None:
        return "?"
    try:
        return Cmd(command).name.lower()
    except ValueError:
        return f"cmd_{command:#04x}"


def redact_payload(payload: bytes, *, show: bool = False) -> str:
    if not payload:
        return "<empty>"
    if show:
        return payload.hex(" ")
    return f"<redacted len={len(payload)} sha256={_digest(payload)}>"


def frame_line(
    *,
    sent: bool,
    command: Optional[int],
    error: Optional[int],
    payload: bytes,
    show: bool = False,
) -> str:
    direction = "TX" if sent else "RX"
    cmd = f"{command_name(command)}" + (f"(0x{command:02X})" if command is not None else "")
    err = "" if error in (None,) else f" error={error}({error_name(error)})"
    return f"{direction} {cmd}{err} {redact_payload(payload, show=show)}"


class FrameLogger:
    """Sink for redacted frame summaries.

    ``sink`` receives each formatted line; it defaults to stderr. Pass
    ``show_payloads=True`` only for local debugging you will not share.
    """

    def __init__(
        self,
        *,
        show_payloads: bool = False,
        sink: Optional[Callable[[str], None]] = None,
    ) -> None:
        self.show_payloads = show_payloads
        self._sink = sink or (lambda line: print(line, file=sys.stderr))

    def tx(self, command: int, payload: bytes) -> None:
        self._sink(
            frame_line(
                sent=True, command=command, error=None, payload=payload,
                show=self.show_payloads,
            )
        )

    def rx(self, frame: Frame) -> None:
        self._sink(
            frame_line(
                sent=False, command=frame.command, error=frame.error_code,
                payload=frame.payload, show=self.show_payloads,
            )
        )

    def event(self, message: str) -> None:
        self._sink(message)
