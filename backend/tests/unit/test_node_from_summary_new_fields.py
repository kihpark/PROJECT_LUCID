"""Unit tests for `_coerce_fact_to_factnode` step1+2+2.5 field wiring.

The v0.2.0 graduation gate. The structurer LLM tags every fact with a
`fact_type` ('action' | 'claim' | 'measurement') and emits five claim-
only fields + four measurement-only fields when the bucket matches.
Those fields land in `source_jobs.extracted_metadata.structure.facts`
(Postgres jsonb) correctly, but used to get silently dropped on the
validate.decide -> ES write boundary because the canonical_kwargs loop
in `_coerce_fact_to_factnode` did not pull them out of the fact summary.

This module pins the wiring so a future refactor that loses a field
fails loudly here instead of leaking nulls into lucid_facts.
"""
from __future__ import annotations

import pytest

from api.routes.validate import _coerce_fact_to_factnode


@pytest.fixture
def action_summary() -> dict:
    """Bare action fact — no speaker / measurement payload."""
    return {
        "fact_uid": "fn-act-1",
        "uid": "fn-act-1",
        "claim": "삼성전자가 신규 공장을 발표했다.",
        "type": "proposition",
        "subject_uid": "obj-1",
        "predicate": "announced",
        "object_value": "신규 공장",
        "fact_type": "action",
    }


@pytest.fixture
def claim_summary() -> dict:
    """A 'claim'-bucket fact with full speaker provenance."""
    return {
        "fact_uid": "fn-claim-1",
        "uid": "fn-claim-1",
        "claim": "한국은행 총재는 금리 인하 가능성을 시사했다.",
        "type": "proposition",
        "subject_uid": "obj-2",
        "predicate": "stated",
        "object_value": "금리 인하 가능성",
        "fact_type": "claim",
        "speaker_uid": "obj-2",
        "speaker_label": "한국은행 총재",
        "speech_act": "시사했다",
        "content_claim": "금리 인하 가능성",
        "stance": "neutral",
    }


@pytest.fixture
def measurement_summary() -> dict:
    """A 'measurement'-bucket fact with metric / value / unit / as_of."""
    return {
        "fact_uid": "fn-meas-1",
        "uid": "fn-meas-1",
        "claim": "ChatGPT의 MAU는 2026년 3월 기준 8억 명이다.",
        "type": "proposition",
        "subject_uid": "obj-3",
        "predicate": "has_metric",
        "object_value": "MAU",
        "fact_type": "measurement",
        "metric": "ChatGPT의 월간 활성 사용자 (MAU)",
        "measurement_value": 800000000.0,
        "measurement_unit": "명",
        "as_of": "2026-03",
    }


def test_claim_summary_propagates_speaker_fields(claim_summary):
    """Speaker/speech_act/content_claim/stance must reach FactNode for
    fact_type=='claim' so the recall claim card can render them."""
    node = _coerce_fact_to_factnode(
        claim_summary, edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.fact_type == "claim"
    assert node.speaker_uid == "obj-2"
    assert node.speaker_label == "한국은행 총재"
    assert node.speech_act == "시사했다"
    assert node.content_claim == "금리 인하 가능성"
    assert node.stance == "neutral"


def test_measurement_summary_propagates_metric_fields(measurement_summary):
    """metric / measurement_value / measurement_unit / as_of must reach
    FactNode for fact_type=='measurement' so the time-series moat
    survives the validate boundary."""
    node = _coerce_fact_to_factnode(
        measurement_summary, edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.fact_type == "measurement"
    assert node.metric == "ChatGPT의 월간 활성 사용자 (MAU)"
    assert node.measurement_value == 800000000.0
    assert node.measurement_unit == "명"
    assert node.as_of == "2026-03"


def test_action_summary_leaves_claim_and_measurement_fields_none(action_summary):
    """Non-speaker, non-measurement facts stay as fact_type='action' and
    the 9 conditional fields stay None — no garbage leakage."""
    node = _coerce_fact_to_factnode(
        action_summary, edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.fact_type == "action"
    # Claim-only block stays None.
    assert node.speaker_uid is None
    assert node.speaker_label is None
    assert node.speech_act is None
    assert node.content_claim is None
    assert node.stance is None
    # Measurement-only block stays None.
    assert node.metric is None
    assert node.measurement_value is None
    assert node.measurement_unit is None
    assert node.as_of is None


def test_measurement_value_zero_is_preserved():
    """Regression test for the `is not None` guard. `measurement_value=0`
    is a valid value (unemployment 0%, zero-incident year) that would be
    silently dropped by a naive `if meta.get(field):` truthy check."""
    summary = {
        "fact_uid": "fn-meas-zero",
        "uid": "fn-meas-zero",
        "claim": "Country X reported 0% inflation in Q1 2026.",
        "type": "proposition",
        "subject_uid": "obj-x",
        "predicate": "reported",
        "object_value": "0% inflation",
        "fact_type": "measurement",
        "metric": "Country X inflation rate",
        "measurement_value": 0,  # falsy but valid
        "measurement_unit": "%",
        "as_of": "2026-Q1",
    }
    node = _coerce_fact_to_factnode(
        summary, edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    # The whole point: 0 must survive the propagation.
    assert node.measurement_value == 0.0
    assert node.fact_type == "measurement"


def test_legacy_summary_without_new_fields_constructs_with_defaults():
    """Facts captured before the step1+2 prompt rollout have no fact_type
    or speaker / measurement payload. The coerce path must still build a
    valid FactNode (all new fields default to None) — back-compat."""
    legacy = {
        "fact_uid": "fn-legacy-1",
        "uid": "fn-legacy-1",
        "claim": "Legacy fact captured before step 1.",
        "type": "proposition",
        "subject_uid": "obj-l",
        "predicate": "is",
        "object_value": "legacy",
    }
    node = _coerce_fact_to_factnode(
        legacy, edited_claim=None, edited_metadata=None,
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    # No fact_type at all (the structurer didn't emit one).
    assert node.fact_type is None
    # All 9 conditional fields stay at their default None.
    assert node.speaker_uid is None
    assert node.speech_act is None
    assert node.metric is None
    assert node.measurement_value is None


def test_edited_metadata_overrides_new_fields():
    """If the PO edits e.g. speaker_label on the Decide overlay, the
    override flows through edited_metadata and wins over the
    structure-stage value — the canonical_kwargs merge respects the
    edit, same contract as the legacy S/P/O fields."""
    summary = {
        "fact_uid": "fn-edit-1",
        "uid": "fn-edit-1",
        "claim": "X said Y.",
        "type": "proposition",
        "subject_uid": "obj-e",
        "predicate": "said",
        "object_value": "Y",
        "fact_type": "claim",
        "speaker_label": "X (original)",
        "speech_act": "said",
        "stance": "neutral",
    }
    node = _coerce_fact_to_factnode(
        summary,
        edited_claim=None,
        edited_metadata={
            "speaker_label": "X (corrected)",
            "stance": "positive",
        },
        knowledge_space_id="ks-1", validator_id="u-1",
    )
    assert node.speaker_label == "X (corrected)"
    assert node.stance == "positive"
    # Unedited fact_type / speech_act survive.
    assert node.fact_type == "claim"
    assert node.speech_act == "said"
