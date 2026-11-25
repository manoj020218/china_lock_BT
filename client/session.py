"""Demand-driven lock session: connect, log in, run commands.

This ties the pure protocol layer to the BLE transport and models the
lifecycle observed in Phase 2: the lock is not an always-connected peripheral;
each burst of work connects, reads the version, authenticates (receiving a
fresh session address), runs serialized commands, and disconnects.

Write and unlock operations are gated behind ``allow_write`` so a dry run can
never change lock state. The session address returned by login is used for all
subsequent frames and is never persisted as a stable identity.
"""

from __future__ import annotations

from datetime import datetime
from typing import Callable, List, Optional

from tools.protocol_codec import INITIAL_ADDRESS, Frame

from . import protocol as P
from .auth import build_login_payload
from .config import LockConfig
from .transport import BleTransport


class WriteNotAllowed(Exception):
    """Raised when a state-changing operation is attempted without allow_write."""


class NotAuthenticated(Exception):
    """Raised when an authenticated command is attempted before login."""


class HahaLock:
    def __init__(
        self,
        config: LockConfig,
        *,
        allow_write: bool = False,
        payload_size: int = 20,
        timeout: float = 5.0,
        scan_timeout: float = 8.0,
        on_remote_event: Optional[Callable[[Frame], None]] = None,
        frame_logger=None,
        transport=None,
    ) -> None:
        config.require_connectable()
        self.config = config
        self.allow_write = allow_write
        self.scan_timeout = scan_timeout
        self._on_remote_event = on_remote_event
        self._frame_logger = frame_logger
        self._payload_size = payload_size
        self._timeout = timeout
        # An explicit transport (e.g. the ESP32-S3 serial bridge) is used as-is;
        # otherwise a direct BLE transport is built on connect().
        self._provided_transport = transport
        self._transport = None
        self._session_address = INITIAL_ADDRESS
        self._authenticated = False

    # -- lifecycle -------------------------------------------------------- #

    async def __aenter__(self) -> "HahaLock":
        await self.connect()
        return self

    async def __aexit__(self, *exc) -> None:
        await self.disconnect()

    async def connect(self) -> None:
        if self._provided_transport is not None:
            self._transport = self._provided_transport
            await self._transport.connect()
            return
        address = self.config.address
        if not address:
            from .discover import resolve_address
            if self._frame_logger is not None:
                self._frame_logger.event(f"scanning for lock id {self.config.lock_id}...")
            address = await resolve_address(self.config.lock_id, timeout=self.scan_timeout)
            if not address:
                raise RuntimeError(
                    f"no lock advertising id {self.config.lock_id} was found in range"
                )
            if self._frame_logger is not None:
                self._frame_logger.event(f"found lock at {address}")
        self._transport = BleTransport(
            address,
            payload_size=self._payload_size,
            timeout=self._timeout,
            on_notification=self._on_remote_event,
            frame_logger=self._frame_logger,
        )
        await self._transport.connect()

    async def disconnect(self) -> None:
        if self._transport is not None:
            await self._transport.disconnect()
        self._authenticated = False
        self._session_address = INITIAL_ADDRESS

    # -- core send/check -------------------------------------------------- #

    async def _send(self, command: P.Command, *, use_initial: bool = False) -> Frame:
        command_id, payload = command
        address = INITIAL_ADDRESS if use_initial else self._session_address
        frame = await self._transport.send(command_id, payload, address)
        if frame.error_code not in (None, 0):
            raise P.LockError(frame.error_code, context=f"command 0x{command_id:02X}")
        return frame

    def _require_write(self) -> None:
        if not self.allow_write:
            raise WriteNotAllowed(
                "this operation changes lock state; pass allow_write=True "
                "(CLI: --allow-write) to permit it"
            )

    def _require_auth(self) -> None:
        if not self._authenticated:
            raise NotAuthenticated("call login() first")

    # -- authentication --------------------------------------------------- #

    async def get_version(self) -> P.VersionInfo:
        frame = await self._send(P.build_get_version(), use_initial=not self._authenticated)
        return P.parse_version(frame.payload)

    async def login(self) -> P.VersionInfo:
        """Read version, authenticate, and adopt the assigned session address."""

        version = await self.get_version()
        cv = version.command_version if self.config.command_version is None else self.config.command_version
        payload = build_login_payload(self.config.password, self.config.lock_id, cv)
        frame = await self._transport.send(
            int(P.Cmd.ADMIN_LOGIN), payload, INITIAL_ADDRESS
        )
        if frame.error_code not in (None, 0):
            raise P.LockError(frame.error_code, context="admin login")
        # The login acknowledgement carries the session address for this burst.
        if frame.address not in (0, INITIAL_ADDRESS):
            self._session_address = frame.address
        self._authenticated = True
        return version

    # -- read operations -------------------------------------------------- #

    async def battery(self):
        self._require_auth()
        frame = await self._send(P.build_get_battery())
        return P.parse_battery(frame.payload)

    async def get_time(self) -> datetime:
        self._require_auth()
        frame = await self._send(P.build_get_time())
        return P.parse_time(frame.payload)

    async def list_users(self, *, max_iterations: int = 512) -> List[P.User]:
        self._require_auth()
        users: List[P.User] = []
        frame = await self._send(P.build_get_users(0, 0))
        batch = P.parse_users_response(frame.payload)
        users.extend(batch)
        iterations = 0
        while batch and iterations < max_iterations:
            iterations += 1
            frame = await self._send(P.build_get_users(1, 0))
            batch = P.parse_users_response(frame.payload)
            # Stop if the lock stops returning new users.
            new = [u for u in batch if u.user_id not in {x.user_id for x in users}]
            if not new:
                break
            users.extend(new)
        return users

    async def record_count(self, start: datetime, end: datetime) -> int:
        self._require_auth()
        frame = await self._send(P.build_record_count(start, end))
        return P.parse_record_count(frame.payload)

    async def read_records(
        self, start: datetime, end: datetime, *, batch_size: int = 5
    ) -> List[P.Record]:
        self._require_auth()
        total = await self.record_count(start, end)
        records: List[P.Record] = []
        offset = 0
        while offset < total:
            frame = await self._send(P.build_record_batch(offset, batch_size))
            batch = P.parse_record_batch(frame.payload)
            if not batch:
                break
            records.extend(batch)
            offset += len(batch)
        return records

    async def get_parameter(self, selector: Optional[int] = None) -> bytes:
        self._require_auth()
        frame = await self._send(P.build_get_parameter(selector))
        return frame.payload

    # -- write operations (gated) ---------------------------------------- #

    async def unlock(self, user_id: int, pin: str = "") -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_unlock(user_id, pin))

    async def lock(self, user_id: int, pin: str = "") -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_lock(user_id, pin))

    async def set_time(self, dt: datetime, tz_offset_minutes: int) -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_set_time(dt, tz_offset_minutes))

    async def free_user_id(self) -> int:
        self._require_auth()
        frame = await self._send(P.build_get_free_user_id())
        return int.from_bytes(frame.payload[:4], "big") if frame.payload else 0

    async def add_user(self, user: P.User) -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_set_user(user))

    async def delete_user(self, user_id: int) -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_delete_user(user_id))

    async def enroll_pin(self, user_id: int, pin: str) -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_start_enrollment(P.EnrollType.PIN, user_id, pin))

    async def set_auto_lock_delay(self, seconds: int) -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_set_auto_lock_delay(seconds))

    async def set_normally_open(
        self, weekday_mask: int, start_minute: int, end_minute: int
    ) -> None:
        self._require_auth()
        self._require_write()
        await self._send(
            P.build_set_normally_open(weekday_mask, start_minute, end_minute)
        )

    async def reboot(self) -> None:
        self._require_auth()
        self._require_write()
        await self._send(P.build_reboot())

    async def factory_reset(self) -> None:
        """Destructive: wipes binding, users, credentials and settings."""

        self._require_auth()
        self._require_write()
        await self._send(P.build_factory_reset())
