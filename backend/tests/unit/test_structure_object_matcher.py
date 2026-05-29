"""Unit tests for api.structure.object_matcher (PR-3-2 DCR-001)."""
from __future__ import annotations

from unittest.mock import patch

import pytest

from api.models.objects import ObjectClass
from api.structure.object_matcher import (
    AUTO_THRESHOLD_STANDARD,
    AUTO_THRESHOLD_TIGHT,
    DISAMBIG_FLOOR,
    TIGHT_CLASSES,
    MatchResult,
    match_or_create_object,
)

KS = "ks-test-001"


def _es_obj(uid: str, name: str, klass: str, score: float | None = None):
    """Build an ES hit dict matching what _exact_name_search / kNN return."""
    d = {"object_uid": uid, "name": name, "class": klass}
    if score is not None:
        d["_score"] = score
    return d


def test_dcr001_thresholds_are_constants():
    assert AUTO_THRESHOLD_TIGHT == 0.98
    assert AUTO_THRESHOLD_STANDARD == 0.95
    assert DISAMBIG_FLOOR == 0.70
    assert ObjectClass.PERSON in TIGHT_CLASSES
    assert ObjectClass.ORGANIZATION in TIGHT_CLASSES
    assert ObjectClass.SERVICE in TIGHT_CLASSES


def test_exact_name_match_returns_existing_uid():
    """Case-insensitive exact name match in the same KS short-circuits."""
    with patch(
        "api.structure.object_matcher._exact_name_search",
        return_value=[_es_obj("obj-existing-1", "Samsung Electronics", "organization")],
    ):
        result = match_or_create_object(
            "samsung electronics", ObjectClass.ORGANIZATION, KS,
        )
    assert isinstance(result, MatchResult)
    assert result.matched_object_uid == "obj-existing-1"
    assert result.disambiguation_required is False
    assert result.created_new is False
    assert result.decision_reason == "exact_match"


def test_exact_name_multi_match_triggers_disambig():
    """Two exact matches => disambiguation_required=True."""
    with patch(
        "api.structure.object_matcher._exact_name_search",
        return_value=[
            _es_obj("obj-1", "삼성", "organization"),
            _es_obj("obj-2", "삼성", "organization"),
        ],
    ):
        result = match_or_create_object("삼성", ObjectClass.ORGANIZATION, KS)
    assert result.matched_object_uid is None
    assert result.disambiguation_required is True
    assert len(result.candidates) == 2
    assert result.decision_reason == "exact_match_multi"


def test_knn_above_tight_threshold_auto_merges():
    """Person/Org/Service: 0.98 floor → auto-merge."""
    with patch(
        "api.structure.object_matcher._exact_name_search", return_value=[],
    ), patch(
        "api.storage.elasticsearch.queries.knn_search_objects",
        return_value=[_es_obj("obj-tight-1", "Anthropic PBC",
                              "organization", score=0.985)],
    ):
        result = match_or_create_object(
            "Anthropic", ObjectClass.ORGANIZATION, KS,
            candidate_embedding=[0.1] * 1536,
        )
    assert result.matched_object_uid == "obj-tight-1"
    assert result.decision_reason.startswith("knn_auto")
    assert result.disambiguation_required is False


def test_knn_below_tight_threshold_but_above_floor_disambig():
    """Org @ 0.93 (below 0.98, above 0.70) → disambig queue."""
    with patch(
        "api.structure.object_matcher._exact_name_search", return_value=[],
    ), patch(
        "api.storage.elasticsearch.queries.knn_search_objects",
        return_value=[_es_obj("obj-1", "Apple Inc.",
                              "organization", score=0.93)],
    ):
        result = match_or_create_object(
            "Apple", ObjectClass.ORGANIZATION, KS,
            candidate_embedding=[0.1] * 1536,
        )
    assert result.matched_object_uid is None
    assert result.disambiguation_required is True
    assert result.decision_reason.startswith("knn_disambig")
    assert result.candidates[0].score == pytest.approx(0.93)


def test_knn_above_standard_threshold_for_loose_class_auto_merges():
    """Concept @ 0.96 (above 0.95 standard) → auto-merge."""
    with patch(
        "api.structure.object_matcher._exact_name_search", return_value=[],
    ), patch(
        "api.storage.elasticsearch.queries.knn_search_objects",
        return_value=[_es_obj("obj-1", "Free Will", "concept", score=0.96)],
    ):
        result = match_or_create_object(
            "free will", ObjectClass.CONCEPT, KS,
            candidate_embedding=[0.1] * 1536,
        )
    assert result.matched_object_uid == "obj-1"
    assert result.decision_reason.startswith("knn_auto")


def test_no_match_creates_new_object():
    """No exact + kNN below floor → create_new."""
    with patch(
        "api.structure.object_matcher._exact_name_search", return_value=[],
    ), patch(
        "api.storage.elasticsearch.queries.knn_search_objects",
        return_value=[],
    ):
        result = match_or_create_object(
            "Brand New Service", ObjectClass.SERVICE, KS,
            candidate_embedding=[0.1] * 1536,
        )
    assert result.created_new is True
    assert result.new_object_uid is not None
    assert result.decision_reason == "create_new"
    assert result.disambiguation_required is False


def test_kspace_isolation_blocks_other_space_matches():
    """When kNN is invoked, the matcher must pass the caller's KS through."""
    captured: dict = {}

    def fake_knn(emb, *, k, knowledge_space_id, object_class, extra_filters=None):
        captured["ks"] = knowledge_space_id
        captured["class"] = object_class
        return []

    with patch(
        "api.structure.object_matcher._exact_name_search", return_value=[],
    ), patch(
        "api.storage.elasticsearch.queries.knn_search_objects",
        side_effect=fake_knn,
    ):
        match_or_create_object(
            "Whatever", ObjectClass.PERSON, "ks-only-this",
            candidate_embedding=[0.1] * 1536,
        )
    assert captured["ks"] == "ks-only-this"
    assert captured["class"] == "person"
