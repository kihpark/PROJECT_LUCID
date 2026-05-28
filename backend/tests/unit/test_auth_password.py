"""Unit: bcrypt password hashing + verification."""
from __future__ import annotations

import pytest

from api.security import hash_password, verify_password


def test_hash_password_returns_bcrypt_string():
    h = hash_password("hunter2")
    assert h.startswith("$2b$")
    assert len(h) >= 60  # bcrypt hashes are 60 chars


def test_verify_password_correct():
    h = hash_password("correct horse battery staple")
    assert verify_password("correct horse battery staple", h) is True


def test_verify_password_wrong():
    h = hash_password("a")
    assert verify_password("b", h) is False


def test_verify_password_empty_inputs_return_false():
    assert verify_password("", "$2b$12$abc") is False
    assert verify_password("any", "") is False


def test_verify_password_malformed_hash_returns_false_not_raises():
    # Should not raise; returns False so the auth handler keeps timing constant
    assert verify_password("pw", "not-a-bcrypt-hash") is False


def test_hash_password_rejects_empty():
    with pytest.raises(ValueError):
        hash_password("")


def test_hash_password_unique_salt_per_call():
    """Same plaintext -> two different hashes (different salts)."""
    a = hash_password("same")
    b = hash_password("same")
    assert a != b
    # Both should still verify
    assert verify_password("same", a) is True
    assert verify_password("same", b) is True
