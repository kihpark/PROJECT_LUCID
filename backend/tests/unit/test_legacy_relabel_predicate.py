"""B-62-fix legacy-korean-relabel — predicate-only unit tests.

These cover the pure-function path of `find_candidates` (i.e. the
shape decisions: brand exclusion, no-Korean-alias exclusion, already-
Korean-primary exclusion). The integration tests exercise the
end-to-end ES round-trip; here we drive a mock ES client and assert on
the candidate list directly so the predicate stays pinned even when the
ES schema or `relabel()` body changes.
"""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from scripts.relabel_legacy_korean_entities import find_candidates


def _es(docs: list[dict]) -> MagicMock:
    """Mock ES client whose .search returns `docs` wrapped in the ES
    hit envelope. Each entry in `docs` must include `_id` and `_source`.
    """
    client = MagicMock()
    client.search.return_value = {
        "hits": {"hits": docs, "total": {"value": len(docs)}},
    }
    return client


def test_brand_shape_primary_is_excluded_even_with_korean_alias() -> None:
    """SpaceX has a Korean alias 스페이스X but is brand-shaped (single
    Latin token <=16 chars). The script must NOT promote 스페이스X to
    primary — PR-B's `_looks_like_brand` heuristic owns this call."""
    client = _es([
        {
            "_id": "obj-brand-spacex",
            "_source": {
                "object_uid": "obj-brand-spacex",
                "primary_label": "SpaceX",
                "primary_lang": "en",
                "name": "SpaceX",
                "aliases": ["스페이스X"],
            },
        },
        {
            "_id": "obj-brand-openai",
            "_source": {
                "object_uid": "obj-brand-openai",
                "primary_label": "OpenAI",
                "primary_lang": "en",
                "name": "OpenAI",
                "aliases": ["오픈에이아이"],
            },
        },
    ])
    out = find_candidates(client)
    assert out == [], f"brand-shape exclusion failed: {out}"


def test_no_korean_alias_means_no_relabel() -> None:
    """Multi-word English primary (descriptive metric name) with NO
    Korean alias and an English `name` field — there is nothing to
    promote, so the entry must be skipped silently."""
    client = _es([
        {
            "_id": "obj-no-ko",
            "_source": {
                "object_uid": "obj-no-ko",
                "primary_label": "initial funding raised",
                "primary_lang": "en",
                "name": "initial funding raised",
                "aliases": [],
            },
        },
        {
            "_id": "obj-no-ko-with-en-alias",
            "_source": {
                "object_uid": "obj-no-ko-with-en-alias",
                "primary_label": "stock price increase",
                "primary_lang": "en",
                "name": "stock price increase",
                "aliases": ["share price uptick"],
            },
        },
    ])
    out = find_candidates(client)
    assert out == []


def test_already_korean_primary_is_idempotent_noop() -> None:
    """A doc whose primary is already Korean must NOT be re-relabeled.
    This is the idempotence pin: a second run of the script after an
    --apply pass must return zero candidates."""
    client = _es([
        {
            "_id": "obj-already-ko",
            "_source": {
                "object_uid": "obj-already-ko",
                "primary_label": "회사채",
                "primary_lang": "ko",
                "name": "회사채",
                "aliases": ["corporate bonds"],
            },
        },
        {
            "_id": "obj-ko-via-detect",
            "_source": {
                "object_uid": "obj-ko-via-detect",
                # primary_lang missing — predicate must fall back to
                # _detect_lang(primary_label) which returns ko.
                "primary_label": "우리자산운용",
                "name": "우리자산운용",
                "aliases": ["Woori Asset Management"],
            },
        },
    ])
    out = find_candidates(client)
    assert out == []


def test_multiword_english_with_korean_alias_is_relabeled() -> None:
    """Positive case: multi-word English primary plus a Korean alias
    is the exact shape the script targets. The candidate list must
    surface it."""
    client = _es([
        {
            "_id": "obj-target",
            "_source": {
                "object_uid": "obj-target",
                "primary_label": "Woori Asset Management",
                "primary_lang": "en",
                "name": "Woori Asset Management",
                "aliases": ["우리자산운용"],
            },
        },
    ])
    out = find_candidates(client)
    assert len(out) == 1
    assert out[0]["id"] == "obj-target"
    assert out[0]["current_primary"] == "Woori Asset Management"
    assert out[0]["korean_alias"] == "우리자산운용"


def test_legacy_korean_name_field_promotes_when_aliases_empty() -> None:
    """When `aliases` is empty but the legacy `name` field carries a
    Korean form distinct from the English primary, that legacy field
    becomes the relabel target. This is the back-compat path for
    pre-data-bedrock docs."""
    client = _es([
        {
            "_id": "obj-legacy",
            "_source": {
                "object_uid": "obj-legacy",
                "primary_label": "corporate bonds",
                "primary_lang": "en",
                "name": "회사채",
                "aliases": [],
            },
        },
    ])
    out = find_candidates(client)
    assert len(out) == 1
    assert out[0]["korean_alias"] == "회사채"
