"""Credential derivation for admin login.

Thin, honest wrappers over :mod:`tools.protocol_codec`. Only the legacy
(command-version 0) path is implemented end to end, because the validated
target firmware ``BK50D-V2.5`` reports command version 0. The newer DES
timestamp-challenge path is derivable but intentionally not completed here; it
raises a clear error until there is a lock to validate it against.

No password, lock ID or key is logged or stored by this module.
"""

from __future__ import annotations

from tools.protocol_codec import derive_credential_token, derive_login_key


def login_key_for(password: str, lock_id: str, command_version: int) -> str:
    """Derive the admin login key string for the given protocol version.

    For command version 0 this is the decimal-ASCII key the lock expects for a
    0x13 login. For a nonzero version it returns the eight-character DES key
    (the caller must still build the DES challenge payload, which is not yet
    implemented here).
    """

    token = derive_credential_token(password, lock_id)
    return derive_login_key(token, command_version)


def build_login_payload(password: str, lock_id: str, command_version: int) -> bytes:
    """Return the 0x13 payload bytes for the given firmware's login scheme.

    Legacy (version 0): the decimal-ASCII login key, sent directly.
    Newer (nonzero): not implemented; raises ``NotImplementedError``.
    """

    if command_version == 0:
        return login_key_for(password, lock_id, command_version).encode("ascii")

    raise NotImplementedError(
        "DES timestamp-challenge login (command version "
        f"{command_version}) is not implemented yet; the validated BK50D-V2.5 "
        "lock uses legacy command version 0. Implement and validate the "
        "D1 + single-DES(time||~time) payload before using this path."
    )
