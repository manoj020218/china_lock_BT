"""Serial transport: drive the lock through the ESP32-S3 BLE bridge.

This speaks the line protocol of ``firmware/`` (Stage 1 bridge) over the USB
serial port. It presents the same async ``connect`` / ``send`` / ``disconnect``
interface as :class:`client.transport.BleTransport`, so the session and the
whole validated protocol stack run unchanged — the ESP32-S3 is just the BLE
radio.

A background reader thread parses the bridge's lines. ``RX <hex>`` lines are fed
to the frame reassembler; decoded frames resolve the pending command's response
or, for unsolicited 0x89 notifications, the ``on_notification`` callback. Other
lines (CONNECTED / ERR / PONG / ...) go to a control queue for connect().
"""

from __future__ import annotations

import asyncio
import queue
import threading
from typing import Callable, Optional

from tools.protocol_codec import (
    FLAG_COMMAND,
    Frame,
    FrameStreamDecoder,
    encode_command,
)
from .protocol import Cmd
from .transport import TransportError


class SerialBridgeTransport:
    def __init__(
        self,
        port: str,
        lock_ref: str,
        *,
        baud: int = 115200,
        timeout: float = 8.0,
        connect_timeout: float = 20.0,
        on_notification: Optional[Callable[[Frame], None]] = None,
        frame_logger=None,
    ) -> None:
        self.port = port
        self.lock_ref = lock_ref
        self.baud = baud
        self.timeout = timeout
        self.connect_timeout = connect_timeout
        self.on_notification = on_notification
        self.frame_logger = frame_logger

        self._ser = None
        self._decoder = FrameStreamDecoder()
        self._pending_command: Optional[int] = None
        self._responses: "queue.Queue[Frame]" = queue.Queue()
        self._control: "queue.Queue[str]" = queue.Queue()
        self._reader: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._connected = False

    # -- reader thread ---------------------------------------------------- #

    def _reader_loop(self) -> None:
        buf = b""
        while not self._stop.is_set():
            try:
                data = self._ser.readline()
            except Exception:
                break
            if not data:
                continue
            line = (buf + data).decode("utf-8", errors="replace").strip()
            buf = b""
            if not line:
                continue
            if line.startswith("RX "):
                self._feed_rx(line[3:].strip())
            elif line.startswith("# "):
                continue  # bridge debug log
            else:
                self._control.put(line)

    def _feed_rx(self, hex_str: str) -> None:
        try:
            chunk = bytes.fromhex(hex_str.replace(" ", ""))
        except ValueError:
            return
        frames = self._decoder.feed(chunk, request_command=self._pending_command)
        for frame in frames:
            if self.frame_logger is not None:
                self.frame_logger.rx(frame)
            if frame.flag == FLAG_COMMAND and frame.command == int(Cmd.ASYNC_NOTIFICATION):
                if self.on_notification is not None:
                    self.on_notification(frame)
                continue
            self._responses.put(frame)

    def _write_line(self, text: str) -> None:
        self._ser.write((text + "\n").encode("ascii"))
        self._ser.flush()

    def _drain_control(self) -> None:
        try:
            while True:
                self._control.get_nowait()
        except queue.Empty:
            pass

    # -- lifecycle (async wrappers over blocking serial I/O) -------------- #

    async def connect(self) -> None:
        await asyncio.to_thread(self._connect_blocking)

    def _connect_blocking(self) -> None:
        try:
            import serial  # pyserial
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise TransportError(
                "pyserial is required for the serial bridge; "
                "install it with 'pip install pyserial'"
            ) from exc

        self._ser = serial.Serial(self.port, self.baud, timeout=0.5)
        self._stop.clear()
        self._reader = threading.Thread(target=self._reader_loop, daemon=True)
        self._reader.start()

        self._drain_control()
        self._write_line(f"CONNECT {self.lock_ref}")
        import time
        t0 = time.time()
        while time.time() - t0 < self.connect_timeout:
            try:
                line = self._control.get(timeout=0.5)
            except queue.Empty:
                continue
            if line.startswith("CONNECTED"):
                self._connected = True
                return
            if line.startswith("ERR"):
                raise TransportError(f"bridge could not connect: {line}")
        raise TransportError("timed out waiting for the bridge to connect to the lock")

    async def disconnect(self) -> None:
        await asyncio.to_thread(self._disconnect_blocking)

    def _disconnect_blocking(self) -> None:
        try:
            if self._ser is not None and self._ser.is_open:
                try:
                    self._write_line("DISCONNECT")
                except Exception:
                    pass
        finally:
            self._stop.set()
            if self._ser is not None:
                try:
                    self._ser.close()
                except Exception:
                    pass
            self._connected = False

    @property
    def is_connected(self) -> bool:
        return self._connected and self._ser is not None and self._ser.is_open

    # -- request/response ------------------------------------------------- #

    async def send(
        self,
        command_id: int,
        payload: bytes = b"",
        address: int = 0xFFFFFFFF,
        *,
        timeout: Optional[float] = None,
    ) -> Frame:
        return await asyncio.to_thread(
            self._send_blocking, command_id, payload, address, timeout or self.timeout
        )

    def _send_blocking(self, command_id, payload, address, timeout) -> Frame:
        if not self.is_connected:
            raise TransportError("serial bridge is not connected")
        # Flush any stale response before issuing the next serialized command.
        try:
            while True:
                self._responses.get_nowait()
        except queue.Empty:
            pass
        self._pending_command = command_id
        if self.frame_logger is not None:
            self.frame_logger.tx(command_id, payload)
        frame = encode_command(command_id, payload, address)
        self._write_line("TX " + frame.hex())
        try:
            return self._responses.get(timeout=timeout)
        except queue.Empty as exc:
            raise TransportError(
                f"no response to command 0x{command_id:02X} within {timeout}s"
            ) from exc
        finally:
            self._pending_command = None


def scan_via_bridge(port: str, *, baud: int = 115200, duration: float = 6.0):
    """Ask the ESP32-S3 bridge to scan and return ``[(addr, rssi, name), ...]``."""

    import time

    import serial  # pyserial

    s = serial.Serial(port, baud, timeout=0.5)
    try:
        time.sleep(1.2)  # let the board settle after the port opens
        s.reset_input_buffer()
        s.write(b"SCAN\n")
        results = []
        t0 = time.time()
        while time.time() - t0 < duration:
            line = s.readline().decode("utf-8", errors="replace").strip()
            if line.startswith("ADV "):
                parts = line[4:].split(None, 2)
                if len(parts) >= 2:
                    addr, rssi = parts[0], parts[1]
                    name = parts[2] if len(parts) > 2 else ""
                    results.append((addr, rssi, name))
            elif line.startswith("SCANDONE"):
                break
        return results
    finally:
        s.close()
