"""Unit tests for the recall route (DR-089 thin slice).

Cover the contract bits that don't need Postgres + ES:
  - Pydantic shapes accept manual-only RecallFact
  - Embedding-unavailable degrades to the empty signature
  - ES kNN body carries the validation_method=manual filter VERBATIM
    (the zero-hallucination guarantee is enforced at the query layer,
     not just in post-fetch filtering)
"""
from __future__ import annotations

from datetime import UTC, datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest
from pydantic import ValidationError

from api.models.recall import RecallFact, RecallResponse
from api.routes.recall import (
    RECALL_SCORE_FLOOR,
    SIGNATURE_EMPTY,
    SIGNATURE_HIT_TEMPLATE,
    _empty,
    _hit_to_fact,
    _knn_facts_validated_only,
    recall,
)


def _make_user(user_id: str | None = None):
    user = MagicMock()
    user.id = user_id or uuid4()
    return user


# ---------------------------------------------------------------------------
# Pydantic invariants — validation_method literal
# ---------------------------------------------------------------------------

def test_recall_fact_accepts_manual_only():
    f = RecallFact(
        fact_uid="fn-1", claim="X", subject_uid="obj-1", predicate="is",
        object_value="Y", validated_at=datetime.now(UTC),
        validator_id="user-1", validation_method="manual",
        knowledge_space_id="ks-1", score=0.9,
    )
    assert f.validation_method == "manual"


def test_recall_fact_rejects_auto_validation():
    """The Literal["manual"] type guards against the auto path leaking
    into the response shape even if some upstream code tries it."""
    with pytest.raises(ValidationError):
        RecallFact(
            fact_uid="fn-1", claim="X", subject_uid="obj-1", predicate="is",
            object_value="Y", validated_at=datetime.now(UTC),
            validator_id="user-1", validation_method="auto",
            knowledge_space_id="ks-1", score=0.9,
        )


def test_recall_response_default_total_zero():
    r = RecallResponse(signature=SIGNATURE_EMPTY, total=0)
    assert r.facts == []
    assert r.total == 0


# ---------------------------------------------------------------------------
# Signature templates
# ---------------------------------------------------------------------------

def test_signature_hit_template_includes_n():
    assert "3개" in SIGNATURE_HIT_TEMPLATE.format(n=3)
    assert "As far as I know" in SIGNATURE_HIT_TEMPLATE.format(n=3)


def test_signature_empty_literal():
    assert SIGNATURE_EMPTY == "검증된 사실이 없습니다"


# ---------------------------------------------------------------------------
# _empty helper
# ---------------------------------------------------------------------------

def test_empty_returns_envelope_with_zero_facts():
    r = _empty("test-reason")
    assert r.signature == SIGNATURE_EMPTY
    assert r.facts == []
    assert r.total == 0


# ---------------------------------------------------------------------------
# _hit_to_fact — non-manual rows MUST be dropped even if they leaked
# ---------------------------------------------------------------------------

def test_hit_to_fact_drops_non_manual_validation_method():
    """Defensive check: even if a non-manual row somehow gets past the
    ES filter, the serialiser must reject it."""
    hit = {
        "_source": {
            "fact_uid": "fn-1", "claim": "X",
            "subject_uid": "obj-1", "predicate": "is", "object_value": "Y",
            "source_uids": [], "validated_at": "2026-06-01T10:00:00Z",
            "validator_id": "u-1",
            "validation_method": "auto",   # <- not manual
            "knowledge_space_id": "ks-1",
        },
        "_score": 0.9,
    }
    assert _hit_to_fact(hit) is None


def test_hit_to_fact_drops_malformed_source():
    hit = {"_source": {"claim": "incomplete"}, "_score": 0.9}
    assert _hit_to_fact(hit) is None


def test_hit_to_fact_serializes_clean_manual_hit():
    hit = {
        "_source": {
            "fact_uid": "fn-1", "claim": "삼성전자 영업이익",
            "subject_uid": "obj-1", "predicate": "is", "object_value": "Y",
            "source_uids": ["src-1"], "validated_at": "2026-06-01T10:00:00Z",
            "validator_id": "u-1", "validation_method": "manual",
            "knowledge_space_id": "ks-1",
            "negation_flag": False, "negation_scope": None,
        },
        "_score": 0.85,
    }
    f = _hit_to_fact(hit)
    assert f is not None
    assert f.fact_uid == "fn-1"
    assert f.claim == "삼성전자 영업이익"
    assert f.score == 0.85


# ---------------------------------------------------------------------------
# _knn_facts_validated_only — ES query body carries the filter VERBATIM
# ---------------------------------------------------------------------------

def test_knn_body_has_validation_method_manual_filter():
    """The hard guarantee that motivates the whole feature: the ES kNN
    query MUST include `validation_method=manual` as a term filter. If
    this regresses (e.g. a refactor drops the filter), the
    zero-hallucination contract breaks silently."""
    captured: dict = {}

    fake_client = MagicMock()

    def fake_search(*, index: str, body: dict):
        captured["index"] = index
        captured["body"] = body
        return {"hits": {"hits": []}}

    fake_client.search.side_effect = fake_search

    with patch(
        "api.routes.recall.get_client", return_value=fake_client,
    ):
        _knn_facts_validated_only([0.1] * 1536, "ks-test", 5)

    filters = captured["body"]["knn"]["filter"]
    methods = [f["term"]["validation_method"] for f in filters
               if "validation_method" in f.get("term", {})]
    spaces = [f["term"]["knowledge_space_id"] for f in filters
              if "knowledge_space_id" in f.get("term", {})]
    assert methods == ["manual"], (
        "validation_method=manual filter MUST be present in the ES kNN "
        "query body. This is the zero-hallucination guarantee."
    )
    assert spaces == ["ks-test"]
    assert captured["body"]["knn"]["k"] == 5


# ---------------------------------------------------------------------------
# Route — embedding unavailable degrades silently to empty envelope
# ---------------------------------------------------------------------------

def test_recall_returns_empty_when_embedding_unavailable():
    """When the embedding API is unreachable the route MUST NOT 500.
    Recall degrades quietly — the contract is "we surface nothing"."""
    ks_id = uuid4()
    user = _make_user()
    fake_session = MagicMock()
    fake_ks = MagicMock()
    fake_ks.id = ks_id
    fake_ks.user_id = user.id
    fake_session.get.return_value = fake_ks

    with patch(
        "api.routes.recall._new_session",
        return_value=fake_session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=None,
    ):
        result = recall(space_id=ks_id, q="삼성전자", limit=10, user=user)

    assert result.signature == SIGNATURE_EMPTY
    assert result.facts == []
    assert result.total == 0


def test_recall_returns_empty_when_no_hits_above_floor():
    """All hits below the score floor → empty envelope (same as no hits)."""
    ks_id = uuid4()
    user = _make_user()
    fake_session = MagicMock()
    fake_ks = MagicMock()
    fake_ks.id = ks_id
    fake_ks.user_id = user.id
    fake_session.get.return_value = fake_ks

    low_hit = {
        "_source": {
            "fact_uid": "fn-low", "claim": "X",
            "subject_uid": "obj-1", "predicate": "is", "object_value": "Y",
            "source_uids": [], "validated_at": "2026-06-01T10:00:00Z",
            "validator_id": "u-1", "validation_method": "manual",
            "knowledge_space_id": str(ks_id),
        },
        "_score": RECALL_SCORE_FLOOR - 0.1,
    }

    with patch(
        "api.routes.recall._new_session",
        return_value=fake_session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=[low_hit],
    ):
        result = recall(space_id=ks_id, q="something", limit=10, user=user)

    assert result.signature == SIGNATURE_EMPTY
    assert result.facts == []
