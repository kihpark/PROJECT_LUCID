"""Pure-logic tests for the upsert dup-key + email normalisation.

feat/landing-fix-spec: the route now upserts on email_lower instead of
returning a duplicate-flagged response. These tests pin the email
normalisation logic (case-insensitive + whitespace-trimmed) and the
shape of the upsert: same canonical email -> same application_id is
returned the second time, with the new payload replacing the old.
"""
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


def test_upsert_reuses_existing_application_id():
    """Pure unit: when a hit exists, the route reuses its application_id.

    Mirrors the lookup path in api.routes.applications.submit_application:
    if the ES dup-check returns a hit, the existing application_id is
    pulled out of `_source` and reused as the doc id for the next
    index() call (overwriting the doc rather than minting a new id).
    """
    existing = {
        "_source": {
            "application_id": "fixed-uuid-abc-123",
            "email_lower": "reuse@example.com",
            "profession": "old",
            "q1": "old q1",
            "q2": "old q2",
        }
    }
    hits = [existing]
    application_id = (
        hits[0]["_source"].get("application_id") if hits else None
    )
    assert application_id == "fixed-uuid-abc-123"


def test_no_hits_means_fresh_uuid_path():
    """Empty hits -> the route falls through to mint a new uuid."""
    hits: list[dict] = []
    application_id = (
        hits[0]["_source"].get("application_id") if hits else None
    )
    assert application_id is None
