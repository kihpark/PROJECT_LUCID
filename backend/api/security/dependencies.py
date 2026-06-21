"""FastAPI Depends() helpers for JWT-protected routes.

Three helpers in increasing strictness:
  require_jwt        verify and return the raw payload; raises 401 on failure
  get_current_user_id  decoded sub as a UUID
  get_current_user   loads the User row from Postgres

All three depend on the OAuth2PasswordBearer flow with tokenUrl=
"api/auth/login" — clients POST credentials there and receive a
token in the response body.
"""
from __future__ import annotations

import logging
import uuid

import jwt as pyjwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy.orm import Session

from api.security.jwt import JWTPayload, decode_token
from api.storage.postgres.orm import User
from api.storage.postgres.session import make_sessionmaker

logger = logging.getLogger("lucid.security.deps")

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def _credentials_exception(detail: str = "Could not validate credentials") -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_jwt(token: str = Depends(oauth2_scheme)) -> JWTPayload:
    """Validate the bearer token. 401 on missing / expired / bad sig."""
    try:
        return decode_token(token)
    except pyjwt.ExpiredSignatureError as exc:
        raise _credentials_exception("Token expired") from exc
    except pyjwt.PyJWTError as exc:
        raise _credentials_exception("Invalid token") from exc


def get_current_user_id(payload: JWTPayload = Depends(require_jwt)) -> uuid.UUID:
    """Extract `sub` as a UUID. 401 on malformed payload."""
    try:
        return uuid.UUID(payload.sub)
    except (ValueError, TypeError) as exc:
        raise _credentials_exception("Malformed user id in token") from exc


# Module-level sessionmaker — built lazily. Tests reset via fixtures.
_session_factory = None


def _sessionmaker() -> Session:
    global _session_factory
    if _session_factory is None:
        _session_factory = make_sessionmaker()
    return _session_factory()


def get_current_user(
    user_id: uuid.UUID = Depends(get_current_user_id),
) -> User:
    """Fetch the User row by id. 401 if the user no longer exists."""
    session = _sessionmaker()
    try:
        user = session.get(User, user_id)
        if user is None:
            raise _credentials_exception("User not found")
        return user
    finally:
        session.close()


def require_admin(
    user: User = Depends(get_current_user),
) -> User:
    """Gate for admin-only endpoints. 403 for non-admin."""
    if not user.is_admin:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="admin_only",
        )
    return user
