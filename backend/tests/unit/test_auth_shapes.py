"""Unit: Pydantic request/response shapes for auth + settings."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.models.auth import (
    LoginRequest,
    RegisterRequest,
    UpdateUserSettingsRequest,
)


def test_register_request_minimum():
    req = RegisterRequest(email="alice@example.com", password="hunter2!")
    assert req.email == "alice@example.com"
    assert req.password == "hunter2!"
    assert req.name is None


def test_register_request_rejects_short_password():
    with pytest.raises(ValidationError):
        RegisterRequest(email="bob@example.com", password="short")


def test_register_request_rejects_bad_email():
    with pytest.raises(ValidationError):
        RegisterRequest(email="not-an-email", password="hunter2!")


def test_login_request_accepts_any_password_length():
    """login validates against the stored hash; we do not pre-filter length."""
    assert LoginRequest(email="c@d.com", password="x").password == "x"


def test_update_settings_validation_mode_enum():
    req = UpdateUserSettingsRequest(validation_mode="strict")
    assert req.validation_mode == "strict"


def test_update_settings_rejects_unknown_mode():
    with pytest.raises(ValidationError):
        UpdateUserSettingsRequest(validation_mode="paranoid")


def test_update_settings_all_optional():
    req = UpdateUserSettingsRequest()
    assert req.validation_mode is None
    assert req.surface_on_by_default is None
