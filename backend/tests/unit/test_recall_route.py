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
    _bucket_for,
    _bucket_for_unresolved,
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


def test_hit_to_fact_preserves_raw_predicate_and_predicate_label() -> None:
    """fix/recall-predicate-and-entity-type (PO 2026-06-26): the recall
    card calls `predicateLabel(fact.predicate, fact.predicate_label)`
    which prefers a non-empty `predicate_label`. The backend MUST pass
    BOTH fields through verbatim so the frontend can choose. A Korean
    speech-act predicate ("답했다") that landed in the RELATED_TO bucket
    is the PO repro: predicate carries the raw surface, predicate_label
    carries the same surface (under the new mapper behavior) or
    "related to" (legacy facts already on disk)."""
    hit = {
        "_source": {
            "fact_uid": "fn-han",
            "claim": "한성숙 답했다 ...",
            "subject_uid": "한성숙",
            "predicate": "답했다",
            "predicate_label": "답했다",
            "object_value": "(저가형 반도체 생산 보장 문제를) 챙겨보겠다",
            "source_uids": [],
            "validated_at": "2026-06-25T10:00:00Z",
            "validator_id": "u-1",
            "validation_method": "manual",
            "knowledge_space_id": "ks-1",
            "negation_flag": False,
            "negation_scope": None,
        },
        "_score": 0.83,
    }
    f = _hit_to_fact(hit)
    assert f is not None
    # Both fields must survive serialisation so the FE has them.
    assert f.predicate == "답했다"
    assert f.predicate_label == "답했다"


def test_hit_to_fact_legacy_predicate_label_related_to_still_passes_through() -> None:
    """Legacy facts already on disk persisted predicate_label="related to"
    for every RELATED_TO fallback. The serialiser must still surface the
    field verbatim — the FE helper drops "related to" in favour of the
    canonical surface, so the card recovers the verb."""
    hit = {
        "_source": {
            "fact_uid": "fn-legacy",
            "claim": "한성숙 답했다 ...",
            "subject_uid": "한성숙",
            "predicate": "답했다",
            # Legacy: mapper used to write the literal "related to".
            "predicate_label": "related to",
            "object_value": "(저가형 반도체 생산 보장 문제를) 챙겨보겠다",
            "source_uids": [],
            "validated_at": "2026-06-25T10:00:00Z",
            "validator_id": "u-1",
            "validation_method": "manual",
            "knowledge_space_id": "ks-1",
            "negation_flag": False,
            "negation_scope": None,
        },
        "_score": 0.83,
    }
    f = _hit_to_fact(hit)
    assert f is not None
    assert f.predicate == "답했다"
    # Pass-through is verbatim — the FE helper applies the legacy guard.
    assert f.predicate_label == "related to"


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


# ---------------------------------------------------------------------------
# fix/recall-predicate-and-entity-type (PO 2026-06-26): facet bucketing
# Korean-name fallback. When a fact carries an unresolved subject_uid
# (raw Korean surface, e.g. "한성숙" — the entity resolver never ran on
# legacy captures), the facet panel used to drop the name into the
# "other" bucket because mget on lucid_objects returned no doc. The
# `_bucket_for_unresolved` helper applies the same Korean-name heuristic
# the backfill tool uses so the obvious cases (2-4 Hangul syllable
# personal names) land in "person".
# ---------------------------------------------------------------------------


def test_bucket_for_unresolved_korean_person_name() -> None:
    """한성숙 / 안도걸 / 박기흥 — 2-4 Hangul syllables, no org suffix,
    no location suffix → person."""
    assert _bucket_for_unresolved("한성숙") == "person"
    assert _bucket_for_unresolved("안도걸") == "person"
    assert _bucket_for_unresolved("박기흥") == "person"


def test_bucket_for_unresolved_korean_org_suffix() -> None:
    """국회 / 위원회 / 공사 — known org suffix wins."""
    assert _bucket_for_unresolved("국회") == "organization"
    assert _bucket_for_unresolved("최저임금위원회") == "organization"
    assert _bucket_for_unresolved("한국전력공사") == "organization"


def test_bucket_for_unresolved_korean_place_suffix() -> None:
    """서울시 / 경기도 — known location suffix → place."""
    assert _bucket_for_unresolved("서울시") == "place"
    assert _bucket_for_unresolved("경기도") == "place"


def test_bucket_for_unresolved_country_whitelist() -> None:
    """미국 / 중국 — 2-3 Hangul on the country whitelist → place
    (BEFORE the person heuristic which would otherwise grab them)."""
    assert _bucket_for_unresolved("미국") == "place"
    assert _bucket_for_unresolved("중국") == "place"


def test_bucket_for_unresolved_canonical_uid_returns_other() -> None:
    """A canonical UUID4 should NEVER be classified by the heuristic —
    those resolve via lucid_objects mget; the fallback path is only for
    raw-surface subject_uids."""
    canonical = "550e8400-e29b-41d4-a716-446655440000"
    assert _bucket_for_unresolved(canonical) == "other"


def test_bucket_for_unresolved_obj_placeholder_returns_other() -> None:
    """obj-N placeholders also resolve via lucid_objects; not our path."""
    assert _bucket_for_unresolved("obj-1") == "other"
    assert _bucket_for_unresolved("obj-42") == "other"


def test_bucket_for_unresolved_empty_returns_other() -> None:
    """Defensive: empty / None never throw, always 'other'."""
    assert _bucket_for_unresolved("") == "other"
    assert _bucket_for_unresolved("   ") == "other"


def test_bucket_for_unresolved_non_korean_returns_other() -> None:
    """A Latin string with no Korean shape is not classified by the
    heuristic — falls back to 'other' so the FE shows it neutrally."""
    assert _bucket_for_unresolved("ACME Corp") == "other"
    assert _bucket_for_unresolved("xyzzy") == "other"


def test_bucket_for_legacy_class_still_routes_correctly() -> None:
    """Regression guard: the existing `_bucket_for(class_name)` path is
    untouched — only the unresolved fallback is new."""
    assert _bucket_for("person") == "person"
    assert _bucket_for("organization") == "organization"
    assert _bucket_for("place") == "place"
    assert _bucket_for(None) == "other"
    assert _bucket_for("concept") == "other"


# ---------------------------------------------------------------------------
# fix/enrich-labels-cascade-fallback (PO 2026-07-01) — _resolve_label
# cascade + _enrich_with_labels wiring.
#
# Repro: 이재명 대통령 (uid 466b13bb) had name='이재명 대통령',
# primary_label='이재명 대통령', canonical_name=None. All 4 facts
# referencing subject_uid=466b13bb came back with subject_label=None
# because the enricher read `name` only and, in the sweep, 87/87
# entities also had canonical_name=None.
#
# Contract:
#   1. cascade order canonical_name -> name -> primary_label -> None
#   2. subject / object / speaker / related_entity all use the cascade
#   3. entities missing every candidate stay None (FE shows 미해결)
# ---------------------------------------------------------------------------

from api.routes.recall import _enrich_with_labels, _resolve_label


def test_resolve_label_prefers_canonical_name_when_present() -> None:
    """First cascade tier: canonical_name wins over name / primary_label."""
    src = {
        "canonical_name": "이재명",
        "name": "재명 이",
        "primary_label": "President Lee",
    }
    assert _resolve_label(src) == "이재명"


def test_resolve_label_falls_back_to_name_when_canonical_none() -> None:
    """★ PO repro: canonical_name=None but name is present —
    the previous single-field lookup surfaced None; the cascade
    surfaces the name."""
    src = {
        "canonical_name": None,
        "name": "이재명 대통령",
        "primary_label": "이재명 대통령",
    }
    assert _resolve_label(src) == "이재명 대통령"


def test_resolve_label_falls_back_to_primary_label_when_name_missing() -> None:
    """Second-tier fallback: only primary_label populated. This is the
    B-62 decomposer path — some legacy docs never got `name` written
    and only carry the canonical primary_label."""
    src = {"canonical_name": None, "name": None, "primary_label": "SpaceX"}
    assert _resolve_label(src) == "SpaceX"


def test_resolve_label_returns_none_when_all_candidates_empty() -> None:
    """Last resort: FE surfaces 미해결 entity so the miss stays visible."""
    assert _resolve_label({}) is None
    assert _resolve_label({"canonical_name": None, "name": None}) is None
    assert _resolve_label(
        {"canonical_name": "", "name": "", "primary_label": ""},
    ) is None


def test_resolve_label_treats_empty_string_as_missing() -> None:
    """Empty strings must not satisfy the cascade — otherwise a
    doc with name='' would win and the FE renders nothing."""
    src = {"canonical_name": "", "name": "이재명 대통령"}
    assert _resolve_label(src) == "이재명 대통령"


def _make_recall_fact(
    *,
    fact_uid: str = "fn-1",
    subject_uid: str = "obj-subj-1",
    object_value: str = "literal answer",
    speaker_uid: str | None = None,
    related_entity_uids: list[str] | None = None,
) -> RecallFact:
    return RecallFact(
        fact_uid=fact_uid,
        claim="X",
        subject_uid=subject_uid,
        predicate="did",
        object_value=object_value,
        source_uids=[],
        validated_at=datetime.now(UTC),
        validator_id="user-1",
        validation_method="manual",
        knowledge_space_id="ks-1",
        score=0.9,
        speaker_uid=speaker_uid,
        related_entity_uids=related_entity_uids or [],
    )


def _mget_response(docs: list[dict]) -> dict:
    """Shape an ES mget response the way the client returns it."""
    return {"docs": docs}


def _mget_doc(
    uid: str,
    *,
    canonical_name: str | None = None,
    name: str | None = None,
    primary_label: str | None = None,
    entity_class: str | None = None,
) -> dict:
    return {
        "_id": uid,
        "found": True,
        "_source": {
            "object_uid": uid,
            "canonical_name": canonical_name,
            "name": name,
            "primary_label": primary_label,
            "class": entity_class,
        },
    }


def test_enrich_with_labels_rescues_canonical_none_via_name_fallback() -> None:
    """★ PO repro: subject_uid=466b13bb, ES doc has canonical_name=None
    but name='이재명 대통령'. Post-cascade: subject_label populated."""
    subj_uid = str(uuid4())
    fact = _make_recall_fact(subject_uid=subj_uid)
    client = MagicMock()
    client.mget.return_value = _mget_response([
        _mget_doc(
            subj_uid,
            canonical_name=None,
            name="이재명 대통령",
            primary_label="이재명 대통령",
            entity_class="person",
        ),
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        out = _enrich_with_labels([fact], "ks-1")

    assert len(out) == 1
    assert out[0].subject_label == "이재명 대통령"
    assert out[0].subject_entity_type == "person"


def test_enrich_with_labels_primary_label_only_still_resolves() -> None:
    """canonical_name=None AND name=None — primary_label is the only
    surviving surface. Legacy B-62-decomposer docs are shaped this way."""
    subj_uid = str(uuid4())
    fact = _make_recall_fact(subject_uid=subj_uid)
    client = MagicMock()
    client.mget.return_value = _mget_response([
        _mget_doc(
            subj_uid,
            canonical_name=None,
            name=None,
            primary_label="SpaceX",
            entity_class="organization",
        ),
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        out = _enrich_with_labels([fact], "ks-1")

    assert out[0].subject_label == "SpaceX"


def test_enrich_with_labels_all_candidates_missing_returns_none() -> None:
    """Last-resort miss: ES doc found but every candidate blank.
    subject_label stays None so the FE renders 미해결 entity."""
    subj_uid = str(uuid4())
    fact = _make_recall_fact(subject_uid=subj_uid)
    client = MagicMock()
    client.mget.return_value = _mget_response([
        _mget_doc(subj_uid, canonical_name=None, name=None, primary_label=None),
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        out = _enrich_with_labels([fact], "ks-1")

    assert out[0].subject_label is None


def test_enrich_with_labels_uses_cascade_for_speaker_uid() -> None:
    """fix/enrich-labels-cascade-fallback: speaker_uid resolves via the
    same cascade. Claim-layer facts with speaker_uid but no canonical
    name previously showed a blank 발화자 badge."""
    subj_uid = str(uuid4())
    speaker_uid = str(uuid4())
    fact = _make_recall_fact(subject_uid=subj_uid, speaker_uid=speaker_uid)
    client = MagicMock()
    client.mget.return_value = _mget_response([
        _mget_doc(subj_uid, name="Subject A"),
        _mget_doc(speaker_uid, canonical_name=None, name="이재명 대통령"),
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        out = _enrich_with_labels([fact], "ks-1")

    assert out[0].subject_label == "Subject A"
    assert out[0].speaker_label == "이재명 대통령"


def test_enrich_with_labels_uses_cascade_for_related_entity_uids() -> None:
    """fix/enrich-labels-cascade-fallback: related_entity_labels is
    index-aligned with related_entity_uids. Missing entries stay None
    so the FE can zip and show 미해결 for the missing ones."""
    subj_uid = str(uuid4())
    rel_a = str(uuid4())
    rel_b = str(uuid4())  # will NOT be in mget response — missing
    fact = _make_recall_fact(
        subject_uid=subj_uid, related_entity_uids=[rel_a, rel_b],
    )
    client = MagicMock()
    client.mget.return_value = _mget_response([
        _mget_doc(subj_uid, name="Subject A"),
        _mget_doc(rel_a, canonical_name=None, primary_label="Related A"),
        # rel_b: mark as not-found so the resolver skips it
        {"_id": rel_b, "found": False},
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        out = _enrich_with_labels([fact], "ks-1")

    assert out[0].related_entity_labels == ["Related A", None]


def test_enrich_with_labels_batches_all_uid_families_in_one_mget() -> None:
    """One ES round-trip regardless of how many uid families the facts
    reference. Guards against a regression where speaker_uid /
    related_entity_uids trigger extra mget calls."""
    subj_uid = str(uuid4())
    speaker_uid = str(uuid4())
    rel_uid = str(uuid4())
    fact = _make_recall_fact(
        subject_uid=subj_uid,
        speaker_uid=speaker_uid,
        related_entity_uids=[rel_uid],
    )
    client = MagicMock()
    client.mget.return_value = _mget_response([
        _mget_doc(subj_uid, name="S"),
        _mget_doc(speaker_uid, name="Sp"),
        _mget_doc(rel_uid, name="R"),
    ])
    with patch("api.routes.recall.get_client", return_value=client):
        _enrich_with_labels([fact], "ks-1")

    assert client.mget.call_count == 1
    call_ids = set(client.mget.call_args.kwargs["body"]["ids"])
    assert call_ids == {subj_uid, speaker_uid, rel_uid}
