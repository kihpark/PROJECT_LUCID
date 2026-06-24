"""Unit tests for search-embedding-restore fallback confidence guards.

Covers the two helpers added in api.routes.recall:
  _is_kNN_meaningful(hits, threshold)
  _entity_match_is_confident(query, name, threshold)

The PO repro case is the critical assertion: searching for
'선거관리위원회' must NOT confidently match '최저임금위원회' (they only
share the common '위원회' tail).
"""
from __future__ import annotations

from api.routes.recall import (
    _entity_match_is_confident,
    _is_kNN_meaningful,
)


def test_knn_empty_is_not_meaningful():
    assert _is_kNN_meaningful([], 0.3) is False


def test_knn_below_threshold_is_not_meaningful():
    assert _is_kNN_meaningful([{"_score": 0.1}], 0.3) is False


def test_knn_above_threshold_is_meaningful():
    assert _is_kNN_meaningful([{"_score": 0.5}], 0.3) is True


def test_entity_match_unrelated_위원회_pair_is_not_confident():
    """PO repro: 선거관리위원회 vs 최저임금위원회 share only the '위원회'
    tail. Bigram Jaccard must fall below 0.6."""
    assert _entity_match_is_confident(
        "선거관리위원회", "최저임금위원회", 0.6,
    ) is False


def test_entity_match_self_is_confident():
    assert _entity_match_is_confident("위철환", "위철환", 0.6) is True


def test_entity_match_exact_korean_org_self_is_confident():
    assert _entity_match_is_confident(
        "선거관리위원회", "선거관리위원회", 0.6,
    ) is True


def test_entity_match_empty_inputs_are_not_confident():
    assert _entity_match_is_confident("", "선거관리위원회", 0.6) is False
    assert _entity_match_is_confident("선거관리위원회", "", 0.6) is False


def test_entity_match_single_char_query_falls_through():
    """A single-character query degrades to a unigram set (the
    code takes the `else` branch in ngrams()). Self-match still
    confident; obvious mismatch not confident."""
    assert _entity_match_is_confident("위", "위", 0.6) is True
    assert _entity_match_is_confident("위", "최저임금위원회", 0.6) is False
