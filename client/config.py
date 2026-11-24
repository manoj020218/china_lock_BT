"""Runtime configuration for the Jenix lock client.

Secrets (connection password) and site identifiers (lock ID, BLE address) are
NEVER committed. They are read at runtime from, in order of precedence:

1. explicit arguments,
2. environment variables ``JENIX_LOCK_ID``, ``JENIX_LOCK_ADDRESS``,
   ``JENIX_LOCK_PASSWORD``, ``JENIX_COMMAND_VERSION``,
3. a local JSON file (default ``./jenix.config.json`` or ``$JENIX_CONFIG``).

See ``client/jenix.config.example.json`` for the shape. The real config file
is git-ignored.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import os
from pathlib import Path
from typing import Optional

DEFAULT_CONFIG_FILENAME = "jenix.config.json"


@dataclass
class LockConfig:
    lock_id: str
    address: str = ""
    password: str = ""
    command_version: int = 0

    def require_live(self) -> None:
        missing = [n for n in ("lock_id", "address", "password") if not getattr(self, n)]
        if missing:
            raise ValueError(
                "missing required config for a live connection: "
                + ", ".join(missing)
                + " (set via --lock-id/--address/--password, env vars, or a config file)"
            )

    def require_connectable(self) -> None:
        """Require a password and some way to reach the lock (address or id)."""

        if not self.password:
            raise ValueError("missing connection password (--password / env / config)")
        if not self.address and not self.lock_id:
            raise ValueError(
                "need an --address or a --lock-id to find the lock "
                "(a lock-id triggers a BLE scan by advertised name)"
            )


def _load_file(path: Optional[str]) -> dict:
    candidate = path or os.environ.get("JENIX_CONFIG") or DEFAULT_CONFIG_FILENAME
    p = Path(candidate)
    if not p.is_file():
        return {}
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


def load_config(
    *,
    lock_id: Optional[str] = None,
    address: Optional[str] = None,
    password: Optional[str] = None,
    command_version: Optional[int] = None,
    config_path: Optional[str] = None,
) -> LockConfig:
    data = _load_file(config_path)

    def pick(arg, env, key, default=""):
        if arg not in (None, ""):
            return arg
        if os.environ.get(env):
            return os.environ[env]
        if data.get(key) not in (None, ""):
            return data[key]
        return default

    cv_raw = pick(
        None if command_version is None else str(command_version),
        "JENIX_COMMAND_VERSION", "command_version", "0",
    )
    try:
        cv = int(cv_raw)
    except (TypeError, ValueError):
        cv = 0

    return LockConfig(
        lock_id=pick(lock_id, "JENIX_LOCK_ID", "lock_id"),
        address=pick(address, "JENIX_LOCK_ADDRESS", "address"),
        password=pick(password, "JENIX_LOCK_PASSWORD", "password"),
        command_version=cv,
    )
