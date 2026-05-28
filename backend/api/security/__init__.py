"""Lucid security primitives.

Sprint 1B:
- password.py     bcrypt hash + verify
- jwt.py          HS256 mint + decode + claims
- dependencies.py FastAPI Depends helpers (get_current_user, etc.)
"""
from api.security.dependencies import (
    get_current_user,
    get_current_user_id,
    require_jwt,
)
from api.security.jwt import (
    JWT_ALGORITHM,
    JWTPayload,
    create_access_token,
    decode_token,
)
from api.security.password import hash_password, verify_password

__all__ = [
    "hash_password",
    "verify_password",
    "create_access_token",
    "decode_token",
    "JWT_ALGORITHM",
    "JWTPayload",
    "require_jwt",
    "get_current_user",
    "get_current_user_id",
]
