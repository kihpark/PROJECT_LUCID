"""feat/prompts-classification-recovery — unit tests for forced fact_type emission.

Verifies the prompt enforces fact_type MANDATORY and that the model
shape correctly handles back-compat / claim / measurement payloads.
"""
from __future__ import annotations

from api.structure.models import StructureFact
from api.structure.prompts import SYSTEM_PROMPT, FEW_SHOT_EXAMPLES


def test_prompt_mandates_fact_type_explicitly() -> None:
    """The system prompt must explicitly call out fact_type as MANDATORY."""
    assert "MANDATORY" in SYSTEM_PROMPT
    assert "fact_type" in SYSTEM_PROMPT
    # The three values must all be enumerated in the schema section
    assert '"action"' in SYSTEM_PROMPT
    assert '"claim"' in SYSTEM_PROMPT
    assert '"measurement"' in SYSTEM_PROMPT


def test_prompt_carries_version_tag_for_cache_invalidation() -> None:
    """The prompt should embed a version tag so cache key changes
    automatically (Anthropic ephemeral cache uses content hash)."""
    assert "classification-recovery" in SYSTEM_PROMPT or "v0.2.0" in SYSTEM_PROMPT


def test_all_few_shot_facts_carry_fact_type() -> None:
    """Every fact across every few-shot example must include fact_type
    so the LLM sees consistent signal that the field is non-optional."""
    for idx, ex in enumerate(FEW_SHOT_EXAMPLES):
        for fact in ex["output"].get("facts", []):
            assert "fact_type" in fact, (
                f"few-shot example {idx} fact {fact.get('uid')} missing fact_type"
            )
            assert fact["fact_type"] in {"action", "claim", "measurement"}


def test_structure_fact_back_compat_defaults_to_action() -> None:
    """Legacy payloads without fact_type still validate (defaults to action).

    ★ STAGE 1c-vii: ACTION + literal object_value 는 validator 가 raise.
    default=action 검증을 위해 object_value 는 entity_id shape (obj-2)
    으로 변경 — validator 통과 + 기본값 검증 보존.
    """
    fact = StructureFact.model_validate({
        "uid": "fn-1",
        "claim": "X did Y.",
        "type": "proposition",
        "subject_uid": "obj-1",
        "predicate": "did",
        "object_value": "obj-2",
    })
    assert fact.fact_type == "action"


def test_structure_fact_claim_with_all_fields() -> None:
    """A claim payload populates speaker_label, speech_act, content_claim, stance."""
    fact = StructureFact.model_validate({
        "uid": "fn-1",
        "claim": "안도걸 의원은 ...라고 밝혔다.",
        "type": "proposition",
        "subject_uid": "obj-1",
        "predicate": "밝혔다",
        "object_value": "디지털자산 ...",
        "fact_type": "claim",
        "speaker_uid": "obj-1",
        "speaker_label": "안도걸 의원",
        "speech_act": "밝혔다",
        "content_claim": "디지털자산기본법 제정에 속도를 낼 것",
        "stance": "neutral",
    })
    assert fact.fact_type == "claim"
    assert fact.speaker_label == "안도걸 의원"
    assert fact.speech_act == "밝혔다"
    assert fact.stance == "neutral"


def test_structure_fact_measurement_with_all_fields() -> None:
    """A measurement payload populates metric, value, unit, as_of."""
    fact = StructureFact.model_validate({
        "uid": "fn-1",
        "claim": "ChatGPT MAU 는 2026-03 8억 명이다.",
        "type": "proposition",
        "subject_uid": "obj-1",
        "predicate": "MAU 이다",
        "object_value": "8억 명",
        "fact_type": "measurement",
        "metric": "MAU",
        "measurement_value": 800000000,
        "measurement_unit": "명",
        "as_of": "2026-03",
    })
    assert fact.fact_type == "measurement"
    assert fact.metric == "MAU"
    assert fact.measurement_value == 800000000
    assert fact.as_of == "2026-03"
