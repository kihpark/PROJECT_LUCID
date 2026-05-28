"""Password hashing + verification via bcrypt.

Plain-text passwords never leave the request boundary. The hash format
is bcrypt's standard `$2b$...` so future verification can pick up a
different bcrypt library if needed.
"""
from __future__ import annotations

import bcrypt


def hash_password(plain: str) -> str:
    """Return a bcrypt-hashed password string.

    Cost factor 12 — bcrypt default in 4.x. Increase if hardware
    permits, decrease only for tests (use a fixture there, not
    a global change).
    """
    if not isinstance(plain, str) or not plain:
        raise ValueError("password must be a non-empty string")
    salt = bcrypt.gensalt(rounds=12)
    return bcrypt.hashpw(plain.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Constant-time verification. Returns False on any failure (never raises)."""
    if not plain or not hashed:
        return False
    try:
        return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))
    except (ValueError, TypeError):
        return False
