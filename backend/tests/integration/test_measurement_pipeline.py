"""Integration tests for fact-measurement-layer-v1 (v0.2.0 step 2).

Locks the end-to-end shape: StructureFact (measurement) ->
_serialize_struct_fact emits the 4 measurement fields; a 3-way mixed
batch (action + claim + measurement) serializes cleanly with no field
bleed; recall's _facets_for returns FactTypeFacets with correct
action / claim / measurement counts.

PO directive 2026-06-23: every layer in the pipeline must carry the
new fields without breaking back-compat. Step 1 action+claim behavior
remains untouched; step 2 measurement is purely additive.
"""
from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from api.structure.models import StructureFact
from api.structure.processor import _serialize_struct_fact

pytestmark = pytest.mark.integration


def _measurement_fact() -> StructureFact:
    """A representative measurement fact mirroring a FEW_SHOT example."""
    return StructureFact.model_validate({
        "uid": "fn-m1",
        "type": "proposition",
        "claim": "ChatGPT 의 MAU 는 2026년 3월 기준 8억 명이다.",
        "subject_uid": "obj-1",
        "predicate": "MAU 이다",
        "object_value": "8억 명",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR", "2026-03"],
        "fact_type": "measurement",
        "metric": "MAU",
        "measurement_value": 800000000.0,
        "measurement_unit": "명",
        "as_of": "2026-03",
    })


def _action_fact() -> StructureFact:
    return StructureFact.model_validate({
        "uid": "fn-a1",
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


def _claim_fact() -> StructureFact:
    return StructureFact.model_validate({
        "uid": "fn-c1",
        "type": "proposition",
        "claim": "안도걸 의원은 디지털자산기본법 제정에 속도를 낼 것이라고 밝혔다.",
        "subject_uid": "obj-3",
        "predicate": "밝혔다",
        "object_value": "디지털자산기본법 제정에 속도를 낼 것",
        "negation_flag": False,
        "negation_scope": None,
        "tags_suggested": ["KR"],
        "fact_type": "claim",
        "speaker_uid": "obj-3",
        "speaker_label": "안도걸 의원",
        "speech_act": "밝혔다",
        "content_claim": "디지털자산기본법 제정에 속도를 낼 것",
        "stance": "neutral",
    })


# ---------------------------------------------------------------------------
# 1. Measurement fact serializes with all 4 measurement fields preserved
# ---------------------------------------------------------------------------


def test_measurement_fact_serializes_with_metric_value_unit_as_of() -> None:
    """The wire-shape doc that lands in ES carries fact_type='measurement'
    and the 4 metric / value / unit / as_of fields."""
    f = _measurement_fact()
    d = _serialize_struct_fact(f)
    assert d["fact_type"] == "measurement"
    assert d["metric"] == "MAU"
    assert d["measurement_value"] == 800000000.0
    assert d["measurement_unit"] == "명"
    assert d["as_of"] == "2026-03"


# ---------------------------------------------------------------------------
# 2. Mixed batch — action + claim + measurement all coexist cleanly
# ---------------------------------------------------------------------------


def test_mixed_three_types_serialize_independently() -> None:
    """A real KO article often emits multiple facts of different types.
    The serializer must keep each bucket's metadata on its own row —
    no field bleed across action / claim / measurement."""
    f_action = _action_fact()
    f_claim = _claim_fact()
    f_measure = _measurement_fact()

    d_action = _serialize_struct_fact(f_action)
    d_claim = _serialize_struct_fact(f_claim)
    d_measure = _serialize_struct_fact(f_measure)

    # Action: default fact_type, claim+measurement fields null.
    assert d_action["fact_type"] == "action"
    assert d_action["speaker_label"] is None
    assert d_action["metric"] is None
    assert d_action["measurement_value"] is None

    # Claim: speaker / speech_act populated; measurement fields null.
    assert d_claim["fact_type"] == "claim"
    assert d_claim["speaker_label"] == "안도걸 의원"
    assert d_claim["metric"] is None
    assert d_claim["measurement_value"] is None
    assert d_claim["as_of"] is None

    # Measurement: metric / value / unit / as_of populated; claim
    # fields null.
    assert d_measure["fact_type"] == "measurement"
    assert d_measure["metric"] == "MAU"
    assert d_measure["measurement_value"] == 800000000.0
    assert d_measure["measurement_unit"] == "명"
    assert d_measure["as_of"] == "2026-03"
    assert d_measure["speaker_label"] is None
    assert d_measure["content_claim"] is None


# ---------------------------------------------------------------------------
# 3. _facets_for returns FactTypeFacets with all 3 bucket counts
# ---------------------------------------------------------------------------


def test_facets_for_returns_three_way_fact_type_counts() -> None:
    """_facets_for asks ES for a fact_type terms agg and surfaces
    bucket counts for all 3 types on RecallFacets.fact_types.
    Uses a mocked ES client so the test is hermetic — no live ES."""
    from api.routes import recall as recall_mod

    fake_response = {
        "aggregations": {
            "subjects": {"buckets": []},
            "objects": {"buckets": []},
            "predicates": {"buckets": [
                {"key": "발표했다", "doc_count": 5},
            ]},
            "fact_types": {"buckets": [
                {"key": "action", "doc_count": 12},
                {"key": "claim", "doc_count": 6},
                {"key": "measurement", "doc_count": 3},
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

    assert facets.fact_types.action == 12
    assert facets.fact_types.claim == 6
    assert facets.fact_types.measurement == 3
    # Sanity — predicates also wired through.
    assert any(p.name == "발표했다" and p.count == 5 for p in facets.predicates)


def test_facets_for_missing_measurement_bucket_defaults_zero() -> None:
    """Back-compat: ES indexes from before step 2 never bucket on
    'measurement'. The agg returns only action/claim buckets;
    FactTypeFacets.measurement stays at 0."""
    from api.routes import recall as recall_mod

    fake_response = {
        "aggregations": {
            "subjects": {"buckets": []},
            "objects": {"buckets": []},
            "predicates": {"buckets": []},
            "fact_types": {"buckets": [
                {"key": "action", "doc_count": 4},
                {"key": "claim", "doc_count": 2},
            ]},
        }
    }
    mock_client = MagicMock()
    mock_client.search.return_value = fake_response

    with patch.object(recall_mod, "get_client", return_value=mock_client):
        facets = recall_mod._facets_for(
            fact_uids=["fact-uid-1"],
            knowledge_space_id="ks-test",
        )

    assert facets.fact_types.action == 4
    assert facets.fact_types.claim == 2
    assert facets.fact_types.measurement == 0
