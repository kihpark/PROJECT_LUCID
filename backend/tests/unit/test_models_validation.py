"""Unit tests for validation.py, contradiction.py, source.py."""
from __future__ import annotations

import pytest
from pydantic import ValidationError

from api.models.base import new_uid
from api.models.contradiction import ContradictionPair, GatekeepingWarning
from api.models.source import Source, SourcePolicy, SourceType
from api.models.validation import ValidationMethod, ValidationRecord


def test_validation_record_manual():
    vr = ValidationRecord(
        fact_uid=new_uid(),
        validator_id=new_uid(),
        validation_method="manual",
    )
    assert vr.validation_method is ValidationMethod.MANUAL
    assert vr.override_warning is False


def test_validation_record_auto_with_note():
    vr = ValidationRecord(
        fact_uid=new_uid(),
        validator_id=new_uid(),
        validation_method="auto",
        notes="auto-accepted from trusted source",
    )
    assert vr.notes == "auto-accepted from trusted source"


@pytest.mark.parametrize("pattern", ["A", "B", "C"])
def test_contradiction_pair_patterns(pattern):
    cp = ContradictionPair(
        fact_a_uid=new_uid(),
        fact_b_uid=new_uid(),
        pattern=pattern,
    )
    assert cp.pattern == pattern
    assert cp.resolved is False


def test_contradiction_pattern_must_be_a_b_or_c():
    with pytest.raises(ValidationError):
        ContradictionPair(
            fact_a_uid=new_uid(),
            fact_b_uid=new_uid(),
            pattern="Z",
        )


def test_gatekeeping_warning_save_anyway():
    gw = GatekeepingWarning(
        claim_attempted="X",
        source_url="https://example.com",
        decision="save_anyway",
        user_id=new_uid(),
    )
    assert gw.decision == "save_anyway"


def test_gatekeeping_warning_decision_must_be_cancel_or_save_anyway():
    with pytest.raises(ValidationError):
        GatekeepingWarning(
            claim_attempted="X",
            source_url="https://example.com",
            decision="hmm",
            user_id=new_uid(),
        )


def test_source_policy_enum():
    assert {p.value for p in SourcePolicy} == {"trusted", "careful"}


def test_source_type_enum_lists_seven_beta_entry_points():
    """SourceType enumerates the 7 beta entry points (DR-025/DR-026)."""
    expected = {
        "web_article",
        "highlighted_text",
        "youtube",
        "page_image",
        "pdf",
        "pwa_share",
        "url_paste",
    }
    assert {s.value for s in SourceType} == expected


def test_source_minimal():
    s = Source(
        source_uid=new_uid(),
        domain="wsj.com",
        source_type="web_article",
        source_url="https://wsj.com/articles/example",
        knowledge_space_id=new_uid(),
    )
    assert s.capture_count == 1
