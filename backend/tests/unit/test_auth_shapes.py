"""Unit: Pydantic request/response shapes for auth + settings.

B-61-fix-admission: RegisterRequest/RegisterResponse were removed
together with the public /api/auth/register endpoint. Their fields
(email + password + optional name) are still validated downstream by
the LoginRequest schema (for password) and the ApproveResponse schema
(for the admin admission flow); the schema shapes are exercised
end-to-end by the integration suite.
"""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.models.auth import (
    LoginRequest,
    UpdateUserSettingsRequest,
)


def test_login_request_accepts_any_password_length():
    """login validates against the stored hash; we do not pre-filter length."""
    assert LoginRequest(email="c@d.com", password="x").password == "x"


def test_login_request_rejects_bad_email():
    with pytest.raises(ValidationError):
        LoginRequest(email="not-an-email", password="hunter2!")


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
