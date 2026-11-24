"""Jenix Lock desktop client (Phase 3).

A dependency-light Python client for the HAHA/Jenix BLE lock protocol,
reconstructed and live-validated in Phases 1-2. The ``protocol`` module
performs no I/O and no Bluetooth; it only builds request frames and parses
responses, so it is fully unit-testable offline. The ``transport`` and
``session`` modules add BLE I/O via ``bleak`` and a demand-driven session
state machine.

No real credentials, lock IDs or keys are stored in this package. They are
supplied at runtime through configuration (see ``client.config``).
"""

from __future__ import annotations

__version__ = "0.1.0"

__all__ = ["__version__"]
