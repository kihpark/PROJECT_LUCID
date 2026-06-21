"""B-62 landing-integration: pure-logic tests for email normalisation."""
from __future__ import annotations


def test_email_lower_strips_and_lowercases():
    raw = "  Mixed.Case@Example.COM  "
    normalised = raw.lower().strip()
    assert normalised == "mixed.case@example.com"


def test_email_lower_idempotent():
    once = "alpha@beta.io".lower().strip()
    twice = once.lower().strip()
    assert once == twice == "alpha@beta.io"


def test_email_lower_keeps_plus_addressing():
    raw = "User+Tag@Example.com"
    assert raw.lower().strip() == "user+tag@example.com"
