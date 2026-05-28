"""JWT (HS256) issue + decode.

Token payload (`JWTPayload`):
  sub      user_id as a string
  exp      expiry timestamp (UTC seconds-since-epoch)
  iat      issued-at timestamp
  type     "access" (refresh tokens land in Phase 1+ if needed)

Tokens are stateless. Logout in beta is a client-side discard
(SecuRity Rule per Sprint 1B P0: server cannot revoke a JWT short of
key rotation; if logout-while-active becomes critical, add a token
denylist in Postgres).

Reads `SECRET_KEY`, `JWT_ALGORITHM` (default HS256), and
`JWT_EXPIRES_MINUTES` (default 43200 = 30 days) from env.
"""
from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import jwt as pyjwt

logger = logging.getLogger("lucid.security.jwt")

JWT_ALGORITHM = "HS256"
DEFAULT_EXPIRES_MINUTES = 30 * 24 * 60  # 30 days
_MIN_SECRET_LENGTH = 32


@dataclass(frozen=True)
class JWTPayload:
    sub: str
    exp: int
    iat: int
    type: str


def _secret_key() -> str:
    """Fetch SECRET_KEY from env; raise on missing or obviously-too-short."""
    key = os.getenv("SECRET_KEY")
    if not key:
        raise RuntimeError(
            "SECRET_KEY environment variable is required for JWT signing. "
            "Generate with: python -c \"import secrets; print(secrets.token_urlsafe(64))\""
        )
    if len(key) < _MIN_SECRET_LENGTH:
        logger.warning(
            "SECRET_KEY is shorter than %d chars; tokens are weak", _MIN_SECRET_LENGTH
        )
    return key


def _algorithm() -> str:
    return os.getenv("JWT_ALGORITHM", JWT_ALGORITHM)


def _expires_minutes() -> int:
    raw = os.getenv("JWT_EXPIRES_MINUTES")
    try:
        return int(raw) if raw else DEFAULT_EXPIRES_MINUTES
    except (TypeError, ValueError):
        return DEFAULT_EXPIRES_MINUTES


def create_access_token(user_id: str | uuid.UUID, *, expires_minutes: int | None = None) -> str:
    """Mint a signed JWT for `user_id`.

    `expires_minutes` overrides the env default (useful for tests).
    """
    now = datetime.now(UTC)
    delta = timedelta(minutes=expires_minutes or _expires_minutes())
    payload = {
        "sub": str(user_id),
        "iat": int(now.timestamp()),
        "exp": int((now + delta).timestamp()),
        "type": "access",
    }
    return pyjwt.encode(payload, _secret_key(), algorithm=_algorithm())


def decode_token(token: str) -> JWTPayload:
    """Decode and validate signature + expiry.

    Raises `pyjwt.PyJWTError` family on any failure; callers map to
    HTTPException(401) at the route boundary.
    """
    raw = pyjwt.decode(token, _secret_key(), algorithms=[_algorithm()])
    return JWTPayload(
        sub=str(raw["sub"]),
        exp=int(raw["exp"]),
        iat=int(raw["iat"]),
        type=str(raw.get("type", "access")),
    )
