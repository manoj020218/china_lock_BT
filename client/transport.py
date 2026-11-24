"""BLE transport for the Jenix lock client, using bleak.

This is the only module that performs Bluetooth I/O. It is imported lazily by
the session layer so that the pure-protocol code and its tests never require
``bleak`` or a Bluetooth adapter.

Transport responsibilities:

* connect to the lock's GATT server and subscribe to notifications on FFE1,
* chunk outgoing frames to the negotiated value size,
* reassemble notification chunks into frames with
  :class:`tools.protocol_codec.FrameStreamDecoder`,
* serialize commands (one in flight) and match each response, attaching the
  pending command id to flag-7 acknowledgements,
* surface unsolicited 0x89 notifications to an optional callback.
"""

from __future__ import annotations

import asyncio
from typing import Callable, Optional

from tools.protocol_codec import (
    FLAG_COMMAND,
    Frame,
    FrameStreamDecoder,
    encode_command,
)
from .protocol import Cmd

# Primary binary command + notification characteristic (service FFE0).
CHAR_FFE1 = "0000ffe1-0000-1000-8000-00805f9b34fb"


class TransportError(Exception):
    """Raised for connection or response-timeout failures."""


class BleTransport:
    def __init__(
        self,
        address: str,
        *,
        payload_size: int = 20,
        timeout: float = 5.0,
        char_uuid: str = CHAR_FFE1,
        on_notification: Optional[Callable[[Frame], None]] = None,
        frame_logger=None,
    ) -> None:
        self.address = address
        self.payload_size = payload_size
        self.timeout = timeout
        self.char_uuid = char_uuid
        self.on_notification = on_notification
        self.frame_logger = frame_logger

        self._client = None  # bleak.BleakClient, created in connect()
        self._decoder = FrameStreamDecoder()
        self._pending_command: Optional[int] = None
        self._response: "Optional[asyncio.Future[Frame]]" = None
        self._lock = asyncio.Lock()

    # -- connection ------------------------------------------------------- #

    async def connect(self) -> None:
        try:
            from bleak import BleakClient
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise TransportError(
                "bleak is required for BLE I/O; install it with 'pip install bleak'"
            ) from exc

        self._client = BleakClient(self.address, timeout=self.timeout)
        await self._client.connect()
        await self._client.start_notify(self.char_uuid, self._handle_notify)

    async def disconnect(self) -> None:
        if self._client is not None:
            try:
                await self._client.stop_notify(self.char_uuid)
            except Exception:  # pragma: no cover - best effort
                pass
            await self._client.disconnect()
            self._client = None

    @property
    def is_connected(self) -> bool:
        return self._client is not None and self._client.is_connected

    # -- notification handling ------------------------------------------- #

    def _handle_notify(self, _sender, data: bytearray) -> None:
        frames = self._decoder.feed(bytes(data), request_command=self._pending_command)
        for frame in frames:
            if self.frame_logger is not None:
                self.frame_logger.rx(frame)
            # Unsolicited incoming command (e.g. 0x89 registration/remote event).
            if frame.flag == FLAG_COMMAND and frame.command == int(Cmd.ASYNC_NOTIFICATION):
                if self.on_notification is not None:
                    self.on_notification(frame)
                continue
            if self._response is not None and not self._response.done():
                self._response.set_result(frame)

    # -- request/response ------------------------------------------------- #

    async def send(
        self,
        command_id: int,
        payload: bytes = b"",
        address: int = 0xFFFFFFFF,
        *,
        timeout: Optional[float] = None,
    ) -> Frame:
        """Send one command frame and await its acknowledgement."""

        if not self.is_connected:
            raise TransportError("transport is not connected")

        loop = asyncio.get_event_loop()
        async with self._lock:
            self._pending_command = command_id
            self._response = loop.create_future()
            if self.frame_logger is not None:
                self.frame_logger.tx(command_id, payload)
            frame = encode_command(command_id, payload, address)
            try:
                for i in range(0, len(frame), self.payload_size):
                    await self._client.write_gatt_char(
                        self.char_uuid, frame[i:i + self.payload_size], response=True
                    )
                return await asyncio.wait_for(self._response, timeout or self.timeout)
            except asyncio.TimeoutError as exc:
                raise TransportError(
                    f"no response to command 0x{command_id:02X} within "
                    f"{timeout or self.timeout}s"
                ) from exc
            finally:
                self._pending_command = None
                self._response = None
