"""Unit tests for fact-claim-layer-v1 (v0.2.0 step 1) — Action vs Claim.

Locks the StructureFact field defaults, the serializer's back-compat
default, and the round-trip of claim-only fields through model_dump.

PO directive 2026-06-23: the LLM is the classifier; the backend
remains agnostic about speech_act (open natural-language string),
so no rule-based parsing is asserted here. Only structural
invariants get pinned.
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact


def _struct(**overrides) -> StructureFact:
    payload = {
        "uid": "fn-1",
        "type": "proposition",
        "claim": "x",
        "subject_uid": "obj-1",
        "predicate": "p",
        "object_value": "literal",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": [],
    }
    payload.update(overrides)
    return StructureFact.model_validate(payload)


def test_default_fact_type_is_action():
    """Legacy / silent payloads default to action — back-compat."""
    f = _struct()
    assert f.fact_type == "action"
    assert f.speaker_uid is None
    assert f.speaker_label is None
    assert f.speech_act is None
    assert f.content_claim is None
    assert f.stance is None


def test_claim_fact_preserves_speaker_and_speech_act():
    """fact_type='claim' carries speaker / speech_act / content / stance."""
    f = _struct(
        fact_type="claim",
        speaker_uid="obj-1",
        speaker_label="안도걸 의원",
        speech_act="밝혔다",
        content_claim="디지털자산기본법 제정에 속도를 낼 것",
        stance="neutral",
    )
    assert f.fact_type == "claim"
    assert f.speaker_label == "안도걸 의원"
    # speech_act is open natural-language — round-trip preserves the
    # raw verb without any normalization / enum coercion.
    assert f.speech_act == "밝혔다"
    assert f.content_claim == "디지털자산기본법 제정에 속도를 낼 것"
    assert f.stance == "neutral"


def test_action_fact_has_no_speaker_fields():
    """Action facts default the claim-only fields to None even when
    `fact_type='action'` is explicitly given."""
    f = _struct(fact_type="action")
    assert f.speaker_uid is None
    assert f.speaker_label is None
    assert f.speech_act is None
    assert f.content_claim is None
    assert f.stance is None


def test_serialize_struct_fact_defaults_fact_type_action():
    """The serializer back-compat-fills fact_type when the LLM omits
    it on a legacy payload. ES facet aggregation gets cleaner buckets
    when every doc carries a value."""
    f = _struct()
    d = _serialize_struct_fact(f)
    assert d["fact_type"] == "action"
    # Claim-only fields are emitted as None (not missing) so the
    # mapping projection in routes/recall.py reads None instead of
    # raising KeyError on legacy docs.
    assert d["speaker_uid"] is None
    assert d["speaker_label"] is None
    assert d["speech_act"] is None
    assert d["content_claim"] is None
    assert d["stance"] is None


def test_serialize_struct_fact_preserves_claim_fields():
    """When the LLM provides claim fields they survive serialization."""
    f = _struct(
        fact_type="claim",
        speaker_uid="obj-1",
        speaker_label="트럼프 대통령",
        speech_act="부인했다",
        content_claim="관세 인하 가능성",
        stance="critical",
    )
    d = _serialize_struct_fact(f)
    assert d["fact_type"] == "claim"
    assert d["speaker_uid"] == "obj-1"
    assert d["speaker_label"] == "트럼프 대통령"
    assert d["speech_act"] == "부인했다"
    assert d["content_claim"] == "관세 인하 가능성"
    assert d["stance"] == "critical"


def test_model_dump_by_alias_roundtrips_claim_fields():
    """`model_dump(by_alias=True, mode='json')` is what the serializer
    uses to seed the JSONB blob — ensure the new claim fields ride
    along (not silently dropped by alias / mode='json' coercion)."""
    f = _struct(
        fact_type="claim",
        speaker_uid="obj-2",
        speaker_label="중국 상무부",
        speech_act="발표했다",
        content_claim="수출통제 명단에 올렸다",
        stance="neutral",
    )
    d = f.model_dump(by_alias=True, mode="json")
    assert d["fact_type"] == "claim"
    assert d["speaker_uid"] == "obj-2"
    assert d["speaker_label"] == "중국 상무부"
    assert d["speech_act"] == "발표했다"
    assert d["content_claim"] == "수출통제 명단에 올렸다"
    assert d["stance"] == "neutral"
    # type alias rewrite still works (type_ -> type).
    assert d["type"] == "proposition"
