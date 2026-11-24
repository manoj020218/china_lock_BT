"""BLE discovery: find the lock by advertised name.

The lock advertises a recognized name prefix plus an underscore and its lock ID
(e.g. ``Lck1_8F3EE684ECE3``) and the FFE0 service UUID, and on the validated
firmware carries no manufacturer-specific data. Matching therefore relies on
the name prefix, an RSSI threshold and an optional lock-ID allowlist, with the
FFE0 service as a corroborating signal.

The matching rule is factored into :func:`matches_lock` so it can be unit
tested without Bluetooth. :func:`scan_for_locks` performs the actual bleak scan.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Optional, Sequence

# Recognized advertised-name prefixes (Phase 1). "Vir" is the app's non-BLE
# virtual lock type and is intentionally excluded.
NAME_PREFIXES: tuple = ("Lck1", "Lck2", "Lock", "Acc1", "Acc2", "Acc")
SERVICE_FFE0 = "0000ffe0-0000-1000-8000-00805f9b34fb"
DEFAULT_RSSI_THRESHOLD = -90


@dataclass(frozen=True)
class LockAdvertisement:
    address: str
    name: str
    rssi: Optional[int]
    lock_id: Optional[str]


def extract_lock_id(name: str) -> Optional[str]:
    """Return the lock ID after the first underscore, if present."""

    if "_" in name:
        suffix = name.split("_", 1)[1].strip()
        return suffix or None
    return None


def matches_lock(
    name: str,
    rssi: Optional[int],
    service_uuids: Sequence[str],
    *,
    prefixes: Sequence[str] = NAME_PREFIXES,
    rssi_threshold: int = DEFAULT_RSSI_THRESHOLD,
    lock_id: Optional[str] = None,
    require_service: bool = False,
) -> bool:
    """Pure predicate: does this advertisement look like the wanted lock?"""

    if not name:
        return False
    if not any(name.startswith(p) for p in prefixes):
        return False
    if rssi is not None and rssi < rssi_threshold:
        return False
    if lock_id:
        adv_id = extract_lock_id(name)
        if not adv_id or adv_id.upper() != lock_id.upper():
            return False
    if require_service:
        uuids = {u.lower() for u in service_uuids}
        if SERVICE_FFE0 not in uuids:
            return False
    return True


async def scan_for_locks(
    *,
    timeout: float = 8.0,
    rssi_threshold: int = DEFAULT_RSSI_THRESHOLD,
    prefixes: Sequence[str] = NAME_PREFIXES,
    lock_id: Optional[str] = None,
    require_service: bool = False,
) -> List[LockAdvertisement]:
    """Scan and return matching lock advertisements, strongest RSSI first."""

    try:
        from bleak import BleakScanner
    except ImportError as exc:  # pragma: no cover - environment dependent
        raise RuntimeError(
            "bleak is required for BLE scanning; install it with 'pip install bleak'"
        ) from exc

    found = await BleakScanner.discover(timeout=timeout, return_adv=True)
    results: List[LockAdvertisement] = []
    for device, adv in found.values():
        name = adv.local_name or getattr(device, "name", None) or ""
        if matches_lock(
            name, adv.rssi, adv.service_uuids or [],
            prefixes=prefixes, rssi_threshold=rssi_threshold,
            lock_id=lock_id, require_service=require_service,
        ):
            results.append(
                LockAdvertisement(
                    address=device.address, name=name, rssi=adv.rssi,
                    lock_id=extract_lock_id(name),
                )
            )
    results.sort(key=lambda a: (a.rssi is None, -(a.rssi or -999)))
    return results


async def resolve_address(
    lock_id: str, *, timeout: float = 8.0, rssi_threshold: int = DEFAULT_RSSI_THRESHOLD
) -> Optional[str]:
    """Return the BLE address of the strongest advertisement for a lock ID."""

    matches = await scan_for_locks(
        timeout=timeout, rssi_threshold=rssi_threshold, lock_id=lock_id
    )
    return matches[0].address if matches else None
