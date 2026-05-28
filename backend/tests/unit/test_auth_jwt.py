"""Unit: JWT issue + decode + expiry handling."""
from __future__ import annotations

import os
import time

import jwt as pyjwt
import pytest

from api.security import create_access_token, decode_token

SECRET = "unit-test-secret-at-least-32-characters-long-jwt"


@pytest.fixture(autouse=True)
def _set_secret_key(monkeypatch):
    monkeypatch.setenv("SECRET_KEY", SECRET)
    monkeypatch.setenv("JWT_ALGORITHM", "HS256")


def test_create_and_decode_round_trip():
    token = create_access_token("user-123", expires_minutes=5)
    payload = decode_token(token)
    assert payload.sub == "user-123"
    assert payload.type == "access"
    assert payload.exp > payload.iat


def test_decode_raises_on_expired_token():
    # Mint with negative expiry (already-expired)
    token = create_access_token("user-x", expires_minutes=-1)
    with pytest.raises(pyjwt.ExpiredSignatureError):
        decode_token(token)


def test_decode_raises_on_bad_signature(monkeypatch):
    token = create_access_token("user-y", expires_minutes=5)
    monkeypatch.setenv("SECRET_KEY", "DIFFERENT-secret-at-least-32-characters-jwt")
    with pytest.raises(pyjwt.InvalidSignatureError):
        decode_token(token)


def test_create_token_requires_secret_key(monkeypatch):
    monkeypatch.delenv("SECRET_KEY", raising=False)
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        create_access_token("user")
