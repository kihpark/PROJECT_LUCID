"""B-45-fix3 regression tests: when the kNN main pass returns no
fact above the score floor, fall back to entity-name lookup so a
query that resolves to a known entity surfaces ALL of that entity's
manual facts.

This is the cross-lingual escape hatch — Korean image facts often
sit at 0.71 against an English query, just below the 0.72 floor.
The entity-name path (B-49b + B-52) goes name + name_en + aliases,
so an entity that matches by ANY label produces results.

Each ★ acceptance criterion is locked by a named test:
- test_entity_fallback_when_knn_zero_hits
- test_entity_fallback_does_not_trigger_when_knn_has_hits
- test_entity_fallback_returns_empty_when_neither_path_matches
- test_entity_fallback_threads_through_label_enrichment_and_facets
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4

from api.models.recall import RecallFacets


def _ks_user_setup():
    ks_id = uuid4()
    user = MagicMock()
    user.id = uuid4()
    session = MagicMock()
    ks = MagicMock()
    ks.id = ks_id
    ks.user_id = user.id
    session.get.return_value = ks
    return ks_id, user, session


def _es_fact_hit(fact_uid: str, subject_uid: str, claim: str, ks_id) -> dict:
    return {
        "_id": fact_uid,
        "_source": {
            "fact_uid": fact_uid,
            "claim": claim,
            "subject_uid": subject_uid,
            "predicate": "p",
            "object_value": "v",
            "source_uids": ["src-A"],
            "validated_at": "2026-06-15T09:00:00Z",
            "validator_id": "u-1",
            "validation_method": "manual",
            "knowledge_space_id": str(ks_id),
            "negation_flag": False,
            "negation_scope": None,
        },
        "_score": 1.0,
    }


def test_entity_fallback_when_knn_zero_hits():
    """★ kNN returns 0 facts; the entity name lookup hits a known
    entity; that entity's facts surface as the response."""
    from api.routes.recall import recall

    ks_id, user, session = _ks_user_setup()
    entity_uid = str(uuid4())
    matched_entity = {
        "object_uid": entity_uid,
        "name": "국방부",
        "name_en": "Ministry of Defense",
        "aliases": ["국방부"],
        "class": "organization",
    }
    seed_hits = [_es_fact_hit("f-1", entity_uid, "Korean claim 1", ks_id)]

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=[],
    ), patch(
        "api.routes.recall._resolve_entities_by_name",
        return_value=[matched_entity],
    ), patch(
        "api.routes.recall._facts_for_entity", return_value=seed_hits,
    ), patch(
        "api.routes.recall._entity_link_facts", return_value=[],
    ), patch(
        "api.routes.recall._enrich_with_labels", side_effect=lambda f, _: f,
    ), patch(
        "api.routes.recall._facets_for", return_value=RecallFacets(),
    ), patch(
        "api.routes.recall._build_entity_brief", return_value=None,
    ):
        r = recall(space_id=ks_id, q="Ministry of Defense", limit=10, user=user)

    assert r.total == 1
    assert r.facts[0].fact_uid == "f-1"
    assert r.facts[0].claim == "Korean claim 1"


def test_entity_fallback_does_not_trigger_when_knn_has_hits():
    """Performance: when the kNN main pass produces facts above the
    floor, the fallback path MUST NOT run. We pin that by asserting
    `_resolve_entities_by_name` is never consulted from the main
    flow when kNN delivered."""
    from api.routes.recall import recall

    ks_id, user, session = _ks_user_setup()
    knn_hit = _es_fact_hit("f-knn", "uid-x", "claim", ks_id)
    knn_hit["_score"] = 0.9  # above 0.72 floor

    resolve_mock = MagicMock()  # will track invocations
    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=[knn_hit],
    ), patch(
        "api.routes.recall._resolve_entities_by_name", resolve_mock,
    ), patch(
        "api.routes.recall._facts_for_entity", return_value=[],
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
    # ★ resolve_entities is NOT consulted from the main path when kNN
    # had a hit. (B-49b's brief synthesis is the only other caller
    # and it's after this assertion path.)
    assert resolve_mock.call_count == 0


def test_entity_fallback_returns_empty_when_neither_path_matches():
    """When BOTH the kNN pass and the entity-name lookup come up
    empty, recall still surfaces the empty envelope — same signature,
    same shape as the pre-fix3 zero-hit response."""
    from api.routes.recall import SIGNATURE_EMPTY, recall

    ks_id, user, session = _ks_user_setup()
    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=[],
    ), patch(
        "api.routes.recall._resolve_entities_by_name", return_value=[],
    ):
        r = recall(space_id=ks_id, q="nothing-matches", limit=10, user=user)
    assert r.signature == SIGNATURE_EMPTY
    assert r.facts == []
    assert r.total == 0


def test_entity_fallback_threads_through_label_enrichment_and_facets():
    """★ The facts surfaced by the fallback go through the same
    `_enrich_with_labels` + `_facets_for` pipeline as kNN-pass facts,
    so subject_label resolves and the facet bucket reflects the
    fallback-surfaced entity. This is the contract that makes the
    PO's "facet 에 엔티티 집계" criterion hold."""
    from api.routes.recall import recall

    ks_id, user, session = _ks_user_setup()
    entity_uid = str(uuid4())
    matched = {
        "object_uid": entity_uid, "name": "국방부",
        "name_en": "Ministry of Defense", "class": "organization",
    }
    seed = [_es_fact_hit("f-1", entity_uid, "x", ks_id)]

    enrich_calls: list[Any] = []
    facets_calls: list[Any] = []

    def _enrich(facts, ks):
        enrich_calls.append(len(facts))
        return facts

    def _facets(fact_uids, ks):
        facets_calls.append(fact_uids)
        return RecallFacets()

    with patch(
        "api.routes.recall._new_session", return_value=session,
    ), patch(
        "api.routes.recall.get_embedding", return_value=[0.1] * 1536,
    ), patch(
        "api.routes.recall._knn_facts_validated_only", return_value=[],
    ), patch(
        "api.routes.recall._resolve_entities_by_name", return_value=[matched],
    ), patch(
        "api.routes.recall._facts_for_entity", return_value=seed,
    ), patch(
        "api.routes.recall._entity_link_facts", return_value=[],
    ), patch(
        "api.routes.recall._enrich_with_labels", side_effect=_enrich,
    ), patch(
        "api.routes.recall._facets_for", side_effect=_facets,
    ), patch(
        "api.routes.recall._build_entity_brief", return_value=None,
    ):
        recall(space_id=ks_id, q="Ministry of Defense", limit=10, user=user)

    # Fallback fact was threaded through both label enrichment and
    # facet aggregation — same hot-path code the kNN result follows.
    assert enrich_calls == [1]
    assert facets_calls == [["f-1"]]
