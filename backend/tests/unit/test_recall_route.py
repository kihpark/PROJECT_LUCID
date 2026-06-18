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

from api.models.recall import RecallFacets, RecallFact, RecallResponse
from api.routes.recall import (
    RECALL_SCORE_FLOOR,
    SIGNATURE_EMPTY,
    SIGNATURE_HIT_TEMPLATE,
    _date_range_filter,
    _empty,
    _entity_link_facts,
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


# ---------------------------------------------------------------------------
# B-50 — score_threshold / date range / match_kinds
# ---------------------------------------------------------------------------

def test_date_range_filter_none_when_both_bounds_absent():
    assert _date_range_filter(None, None) is None


def test_date_range_filter_single_bound():
    dt = datetime(2026, 6, 1, tzinfo=UTC)
    clause = _date_range_filter(dt, None)
    assert clause == {"range": {"validated_at": {"gte": dt.isoformat()}}}
    clause = _date_range_filter(None, dt)
    assert clause == {"range": {"validated_at": {"lte": dt.isoformat()}}}


def test_date_range_filter_both_bounds_inclusive():
    a = datetime(2026, 1, 1, tzinfo=UTC)
    b = datetime(2026, 12, 31, tzinfo=UTC)
    clause = _date_range_filter(a, b)
    assert clause == {"range": {"validated_at": {
        "gte": a.isoformat(), "lte": b.isoformat(),
    }}}


def test_knn_body_carries_date_range_when_provided():
    """B-50 ★ recall by date window: the range clause must reach ES."""
    captured: dict = {}
    fake_client = MagicMock()

    def fake_search(*, index: str, body: dict):
        captured["body"] = body
        return {"hits": {"hits": []}}

    fake_client.search.side_effect = fake_search
    dt = datetime(2026, 6, 1, tzinfo=UTC)
    with patch("api.routes.recall.get_client", return_value=fake_client):
        _knn_facts_validated_only(
            [0.1] * 1536, "ks-test", 5,
            date_from=dt, date_to=None,
        )

    filters = captured["body"]["knn"]["filter"]
    ranges = [f for f in filters if "range" in f]
    assert ranges == [{"range": {"validated_at": {"gte": dt.isoformat()}}}]


def test_entity_link_body_carries_date_range_when_provided():
    captured: dict = {}
    fake_client = MagicMock()

    def fake_search(*, index: str, body: dict):
        captured["body"] = body
        return {"hits": {"hits": []}}

    fake_client.search.side_effect = fake_search
    a = datetime(2026, 1, 1, tzinfo=UTC)
    b = datetime(2026, 6, 30, tzinfo=UTC)
    with patch("api.routes.recall.get_client", return_value=fake_client):
        _entity_link_facts(
            ["uid-1"], "ks-test",
            exclude_fact_uids=set(),
            date_from=a, date_to=b,
        )

    filters = captured["body"]["query"]["bool"]["filter"]
    ranges = [f for f in filters if "range" in f]
    assert ranges == [{"range": {"validated_at": {
        "gte": a.isoformat(), "lte": b.isoformat(),
    }}}]


def _ks_user_setup():
    ks_id = uuid4()
    user = _make_user()
    fake_session = MagicMock()
    fake_ks = MagicMock()
    fake_ks.id = ks_id
    fake_ks.user_id = user.id
    fake_session.get.return_value = fake_ks
    return ks_id, user, fake_session


def _hit(fact_uid: str, score: float, ks_id):
    return {
        "_source": {
            "fact_uid": fact_uid, "claim": "x",
            "subject_uid": "obj-1", "predicate": "p", "object_value": "Y",
            "source_uids": [], "validated_at": "2026-06-01T10:00:00Z",
            "validator_id": "u-1", "validation_method": "manual",
            "knowledge_space_id": str(ks_id),
            "negation_flag": False, "negation_scope": None,
        },
        "_score": score,
    }


def test_recall_score_threshold_lower_admits_previously_filtered_hits():
    """B-50 ★ similarity slider: a hit at 0.6 is below the 0.72 default
    floor but admitted when the caller sets score_threshold=0.5."""
    ks_id, user, fake_session = _ks_user_setup()
    hits = [_hit("fn-1", 0.6, ks_id)]
    with patch(
        "api.routes.recall._new_session", return_value=fake_session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=hits,
    ), patch(
        "api.routes.recall._entity_link_facts", return_value=[],
    ), patch(
        "api.routes.recall._enrich_with_labels", side_effect=lambda f, _: f,
    ), patch(
        "api.routes.recall._facets_for", return_value=RecallFacets(),
    ), patch(
        "api.routes.recall._build_entity_brief", return_value=None,
    ):
        # default threshold drops the 0.6 hit
        r_default = recall(space_id=ks_id, q="x", limit=10, user=user)
        # lowered threshold admits it
        r_loose = recall(
            space_id=ks_id, q="x", limit=10, score_threshold=0.5, user=user,
        )

    assert r_default.facts == [] and r_default.total == 0
    assert r_loose.total == 1 and r_loose.facts[0].fact_uid == "fn-1"


def test_recall_score_threshold_higher_drops_marginal_hits():
    """B-50 ★ similarity slider tightened: 0.85 cuts the 0.75 fact."""
    ks_id, user, fake_session = _ks_user_setup()
    # ES returns hits sorted by _score desc — the recall loop breaks
    # on first below-floor, so high-score hits must come first.
    hits = [_hit("fn-high", 0.92, ks_id), _hit("fn-mid", 0.75, ks_id)]
    with patch(
        "api.routes.recall._new_session", return_value=fake_session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=hits,
    ), patch(
        "api.routes.recall._entity_link_facts", return_value=[],
    ), patch(
        "api.routes.recall._enrich_with_labels", side_effect=lambda f, _: f,
    ), patch(
        "api.routes.recall._facets_for", return_value=RecallFacets(),
    ), patch(
        "api.routes.recall._build_entity_brief", return_value=None,
    ):
        r = recall(
            space_id=ks_id, q="x", limit=10, score_threshold=0.85, user=user,
        )
    assert r.total == 1 and r.facts[0].fact_uid == "fn-high"


def test_recall_entity_link_always_runs_post_b50_fix():
    """B-50-fix (PO A direction): the server ignores match_kinds and
    ALWAYS runs the entity-link expansion. The previous behaviour
    (turning off 'embedding' returned empty; turning off 'entity_link'
    skipped the expansion) was a UX trap, since the embedding pass is
    what seeds the graph join.

    Lock the contract: regardless of any client-side intent the
    server-side flow is fixed — kNN seeds, expansion runs.
    """
    ks_id, user, fake_session = _ks_user_setup()
    hits = [_hit("fn-1", 0.95, ks_id)]
    link_mock = MagicMock(return_value=[])
    with patch(
        "api.routes.recall._new_session", return_value=fake_session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=hits,
    ), patch(
        "api.routes.recall._entity_link_facts", link_mock,
    ), patch(
        "api.routes.recall._enrich_with_labels", side_effect=lambda f, _: f,
    ), patch(
        "api.routes.recall._facets_for", return_value=RecallFacets(),
    ), patch(
        "api.routes.recall._build_entity_brief", return_value=None,
    ):
        r = recall(space_id=ks_id, q="x", limit=10, user=user)

    assert r.total == 1
    # entity-link helper was consulted exactly once.
    assert link_mock.call_count == 1


def test_recall_ignores_unknown_match_kinds_query_param():
    """B-50-fix: clients on a pre-fix build may still send
    `match_kinds=...`. FastAPI tolerates unknown query keys, but a
    test asserts our function signature no longer accepts it as a
    kwarg — call sites that drop the param keep working."""
    import inspect

    from api.routes.recall import recall as recall_route
    params = set(inspect.signature(recall_route).parameters.keys())
    assert "match_kinds" not in params


def test_recall_date_range_plumbed_to_both_helpers():
    """B-50 ★ date range plumbing: both the kNN pass and the entity-
    link expansion receive the same date_from / date_to bounds."""
    ks_id, user, fake_session = _ks_user_setup()
    knn_calls: list[dict] = []
    link_calls: list[dict] = []

    def knn_record(*args, **kw):
        knn_calls.append(dict(kw))
        return [_hit("fn-1", 0.9, ks_id)]

    def link_record(*args, **kw):
        link_calls.append(dict(kw))
        return []

    a = datetime(2026, 1, 1, tzinfo=UTC)
    b = datetime(2026, 12, 31, tzinfo=UTC)

    with patch(
        "api.routes.recall._new_session", return_value=fake_session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", side_effect=knn_record,
    ), patch(
        "api.routes.recall._entity_link_facts", side_effect=link_record,
    ), patch(
        "api.routes.recall._enrich_with_labels", side_effect=lambda f, _: f,
    ), patch(
        "api.routes.recall._facets_for", return_value=RecallFacets(),
    ), patch(
        "api.routes.recall._build_entity_brief", return_value=None,
    ):
        recall(
            space_id=ks_id, q="x", limit=10,
            date_from=a, date_to=b, user=user,
        )

    assert knn_calls and knn_calls[0]["date_from"] == a
    assert knn_calls[0]["date_to"] == b
    assert link_calls and link_calls[0]["date_from"] == a
    assert link_calls[0]["date_to"] == b


def test_recall_no_new_params_preserves_pre_b50_behaviour():
    """B-50 backwards-compat guard: omitting the new params behaves
    identically to before — the embedding pass runs at the
    RECALL_SCORE_FLOOR default, the entity-link pass runs, no date
    range reaches either helper."""
    ks_id, user, fake_session = _ks_user_setup()
    knn_calls: list[dict] = []

    def knn_record(*args, **kw):
        knn_calls.append(dict(kw))
        return [_hit("fn-1", 0.8, ks_id)]

    with patch(
        "api.routes.recall._new_session", return_value=fake_session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", side_effect=knn_record,
    ), patch(
        "api.routes.recall._entity_link_facts", return_value=[],
    ), patch(
        "api.routes.recall._enrich_with_labels", side_effect=lambda f, _: f,
    ), patch(
        "api.routes.recall._facets_for", return_value=RecallFacets(),
    ), patch(
        "api.routes.recall._build_entity_brief", return_value=None,
    ):
        r = recall(space_id=ks_id, q="x", limit=10, user=user)

    assert r.total == 1
    assert knn_calls[0]["date_from"] is None
    assert knn_calls[0]["date_to"] is None
