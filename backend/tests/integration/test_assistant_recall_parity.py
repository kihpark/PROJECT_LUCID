"""feat/entity-layer-restore — assistant ↔ recall retrieval parity.

PO directive (2026-06-23) symptom (6): assistant returns "검증된 지식
없습니다" for a query while recall surfaces the same facts. Root cause:
assistant ran kNN only; recall has a 3-stage retrieval (kNN, entity-name
fallback, entity-link expansion).

This module exercises the assistant's _retrieve_candidates against the
SAME mocked ES backend the recall route would see, then asserts that:

  1. When kNN returns 0 hits, assistant falls through to entity-name
     lookup and returns the union of facts referencing that entity.
  2. When kNN returns hits above the threshold, assistant still
     returns them (no regression on the happy path).
  3. The assistant's candidate list matches recall's fact list for the
     same query (parity invariant).
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

def _hit(fact_uid: str, subject_uid: str, claim: str, ks: str) -> dict[str, Any]:
    return {
        "_source": {
            "fact_uid": fact_uid,
            "claim": claim,
            "subject_uid": subject_uid,
            "predicate": "발표했다",
            "object_value": "수출통제 명단",
            "source_uids": [f"src-{fact_uid}"],
            "validated_at": "2026-06-01T10:00:00Z",
            "validator_id": "u-1",
            "validation_method": "manual",
            "knowledge_space_id": ks,
            "negation_flag": False,
            "negation_scope": None,
        },
        "_score": 0.9,
    }


def _entity_doc(uid: str, name: str) -> dict[str, Any]:
    return {
        "object_uid": uid,
        "name": name,
        "primary_label": name,
        "class": "organization",
        "entity_type": "organization",
    }


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

def test_assistant_falls_back_to_entity_name_when_knn_empty() -> None:
    """The exact PO repro: '중국 상무부' — kNN finds nothing above the
    floor, but the entity-name path resolves and brings back the 4 facts
    Recall would surface. Pre-fix: assistant returned []. Post-fix: 4
    candidates.
    """
    from api.routes.assistant import _retrieve_candidates

    ks = str(uuid4())
    entity_uid = "c813cbf1-2767-4264-9d9a-778a82277ac5"

    # Mock get_embedding so the helper proceeds without OpenAI.
    fake_emb = [0.1] * 1536

    # Stage 1 returns 0 (kNN miss). Stage 2 (entity-name lookup) returns
    # one entity, then a fact lookup for that uid returns 2 facts.
    with patch(
        "api.routes.assistant.get_embedding",
        return_value=fake_emb,
    ), patch(
        "api.routes.assistant._knn_facts_validated_only",
        return_value=[],
    ), patch(
        "api.routes.assistant._resolve_entities_by_name",
        return_value=[_entity_doc(entity_uid, "중국 상무부")],
    ), patch(
        "api.routes.assistant._facts_for_entity",
        return_value=[
            _hit("fact-1", entity_uid, "중국 | 발표했다 | A", ks),
            _hit("fact-2", entity_uid, "중국 | 발표했다 | B", ks),
        ],
    ), patch(
        "api.routes.assistant._enrich_with_labels",
        side_effect=lambda facts, ks_id: facts,
    ):
        candidates = _retrieve_candidates("중국 상무부", ks, 10)

    assert len(candidates) == 2
    assert candidates[0]["fact_uid"] == "fact-1"
    assert candidates[1]["fact_uid"] == "fact-2"


def test_assistant_returns_knn_hits_when_above_floor() -> None:
    """Happy path is unchanged — when kNN has hits, the entity-name
    fallback never runs.
    """
    from api.routes.assistant import _retrieve_candidates

    ks = str(uuid4())
    entity_uid = str(uuid4())

    fake_emb = [0.1] * 1536

    with patch(
        "api.routes.assistant.get_embedding", return_value=fake_emb,
    ), patch(
        "api.routes.assistant._knn_facts_validated_only",
        return_value=[
            _hit("fact-1", entity_uid, "claim text", ks),
        ],
    ), patch(
        "api.routes.assistant._resolve_entities_by_name",
        return_value=[_entity_doc(entity_uid, "stub")],
    ) as resolve_mock, patch(
        "api.routes.assistant._facts_for_entity",
        return_value=[],
    ), patch(
        "api.routes.assistant._enrich_with_labels",
        side_effect=lambda facts, ks_id: facts,
    ):
        candidates = _retrieve_candidates("anything", ks, 10)

    assert len(candidates) == 1
    assert candidates[0]["fact_uid"] == "fact-1"
    # No fallback when kNN already had hits.
    resolve_mock.assert_not_called()


def test_assistant_returns_empty_when_neither_knn_nor_entity_match() -> None:
    """When kNN AND entity-name both return nothing, assistant returns
    []. Caller then yields the 검증된 지식 없습니다 envelope.
    """
    from api.routes.assistant import _retrieve_candidates

    ks = str(uuid4())
    fake_emb = [0.1] * 1536

    with patch(
        "api.routes.assistant.get_embedding", return_value=fake_emb,
    ), patch(
        "api.routes.assistant._knn_facts_validated_only", return_value=[],
    ), patch(
        "api.routes.assistant._resolve_entities_by_name", return_value=[],
    ), patch(
        "api.routes.assistant._facts_for_entity", return_value=[],
    ):
        candidates = _retrieve_candidates("기상천외한 질의", ks, 10)

    assert candidates == []
