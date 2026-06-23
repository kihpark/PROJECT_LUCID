"""Integration tests for fact-claim-layer-v1 (v0.2.0 step 1).

Locks the end-to-end shape: StructureFact -> _serialize_struct_fact
emits the claim fields; an ES doc indexed with fact_type='claim'
round-trips through the mapping cleanly; recall's _facets_for
returns FactTypeFacets with correct action/claim counts.

PO directive 2026-06-23: every layer in the pipeline must carry the
new fields without breaking back-compat. Action facts (default
fact_type) remain the dominant case for current-event captures;
claim facts carry one-hop provenance metadata that the FactCard
renders as a speaker / speech_act strip.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact

pytestmark = pytest.mark.integration


def _claim_fact() -> StructureFact:
    """A representative claim fact mirroring the FEW_SHOT example."""
    return StructureFact.model_validate({
        "uid": "fn-1",
        "type": "proposition",
        "claim": "안도걸 의원은 디지털자산기본법 제정에 속도를 낼 것이라고 밝혔다.",
        "subject_uid": "obj-1",
        "predicate": "밝혔다",
        "object_value": "디지털자산기본법 제정에 속도를 낼 것",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "claim",
        "speaker_uid": "obj-1",
        "speaker_label": "안도걸 의원",
        "speech_act": "밝혔다",
        "content_claim": "디지털자산기본법 제정에 속도를 낼 것",
        "stance": "neutral",
    })


def _action_fact() -> StructureFact:
    """A representative action fact (the dominant case)."""
    return StructureFact.model_validate({
        "uid": "fn-2",
        "type": "proposition",
        "claim": "중국 상무부가 미국 기업 10곳을 수출통제 대상에 올렸다.",
        "subject_uid": "obj-1",
        "predicate": "수출통제 대상에 올렸다",
        "object_value": "obj-2",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "action",
    })


# ---------------------------------------------------------------------------
# 1. Claim fact serializes with all claim-only fields preserved
# ---------------------------------------------------------------------------


def test_claim_fact_serializes_with_speaker_and_speech_act() -> None:
    """The wire-shape doc that lands in ES carries fact_type='claim'
    and the 4 speaker / speech_act / content / stance fields."""
    f = _claim_fact()
    d = _serialize_struct_fact(f)
    assert d["fact_type"] == "claim"
    assert d["speaker_label"] == "안도걸 의원"
    assert d["speech_act"] == "밝혔다"
    assert d["content_claim"] == "디지털자산기본법 제정에 속도를 낼 것"
    assert d["stance"] == "neutral"


# ---------------------------------------------------------------------------
# 2. Mixed batch — 1 action + 1 claim, both serialize correctly
# ---------------------------------------------------------------------------


def test_mixed_action_and_claim_facts_serialize_independently() -> None:
    """Pipeline emits multiple facts per article; action and claim
    serialize side-by-side with no field bleed."""
    f_action = _action_fact()
    f_claim = _claim_fact()
    d_action = _serialize_struct_fact(f_action)
    d_claim = _serialize_struct_fact(f_claim)

    # Action fact carries the default fact_type and None on claim fields.
    assert d_action["fact_type"] == "action"
    assert d_action["speaker_label"] is None
    assert d_action["speech_act"] is None

    # Claim fact carries all its metadata.
    assert d_claim["fact_type"] == "claim"
    assert d_claim["speaker_label"] == "안도걸 의원"
    assert d_claim["speech_act"] == "밝혔다"


# ---------------------------------------------------------------------------
# 3. _facets_for returns FactTypeFacets with correct counts (mocked ES)
# ---------------------------------------------------------------------------


def test_facets_for_returns_fact_type_counts() -> None:
    """_facets_for asks ES for a fact_type terms agg and surfaces the
    bucket counts on RecallFacets.fact_types. Uses a mocked ES client
    so the test is hermetic — no live ES required."""
    from api.routes import recall as recall_mod

    fake_response = {
        "aggregations": {
            "subjects": {"buckets": []},
            "objects": {"buckets": []},
            "predicates": {"buckets": [
                {"key": "발표했다", "doc_count": 3},
            ]},
            "fact_types": {"buckets": [
                {"key": "action", "doc_count": 7},
                {"key": "claim", "doc_count": 4},
            ]},
        }
    }
    mock_client = MagicMock()
    mock_client.search.return_value = fake_response

    with patch.object(recall_mod, "get_client", return_value=mock_client):
        facets = recall_mod._facets_for(
            fact_uids=["fact-uid-1", "fact-uid-2"],
            knowledge_space_id="ks-test",
        )

    assert facets.fact_types.action == 7
    assert facets.fact_types.claim == 4
    # Sanity — predicates also wired through.
    assert any(p.name == "발표했다" and p.count == 3 for p in facets.predicates)


# ---------------------------------------------------------------------------
# 4. _facets_for handles missing fact_type aggregation gracefully
# ---------------------------------------------------------------------------


def test_facets_for_missing_fact_type_bucket_returns_zero() -> None:
    """Defensive guard: if ES omits the fact_types agg (legacy index,
    older snapshot) the FactTypeFacets default to zero — no crash."""
    from api.routes import recall as recall_mod

    fake_response = {
        "aggregations": {
            "subjects": {"buckets": []},
            "objects": {"buckets": []},
            "predicates": {"buckets": []},
            # fact_types missing entirely
        }
    }
    mock_client = MagicMock()
    mock_client.search.return_value = fake_response

    with patch.object(recall_mod, "get_client", return_value=mock_client):
        facets = recall_mod._facets_for(
            fact_uids=["fact-uid-1"],
            knowledge_space_id="ks-test",
        )

    assert facets.fact_types.action == 0
    assert facets.fact_types.claim == 0
