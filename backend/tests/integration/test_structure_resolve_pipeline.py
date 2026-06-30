"""B-62 structure-resolve - end-to-end pipeline integration tests.

Each test exercises the Structure -> Validate -> ES write path with a
mocked Claude client. The first three lock the surface-preservation
invariants. The fourth locks the OPL fallback. The fifth locks the
cross-language entity merge. The sixth locks the canonical_key dedup +
source-append behavior.
"""
from __future__ import annotations

import pytest

# REQ-004 STAGE 1c-iv: predicate_mapper 폐기. 이 테스트는 통제어 OPL
# 매핑 / fallback 동작을 검증하던 B-62 invariant 테스트로, v3 (자연어
# predicate verbatim) 와 무관해진다. ★ 모듈 단위 skip — 삭제 대신
# skip 으로 두는 이유: PO 가 회귀 검증을 다시 원할 경우 history 가 남도록.
pytest.skip(
    "REQ-004 STAGE 1c-iv: predicate_mapper deleted (v3 = natural-language "
    "predicate verbatim, OPL 통제어 0). Superseded by "
    "test_stage1c_literal_zero.py.",
    allow_module_level=True,
)

from typing import Any  # noqa: E402
from unittest.mock import MagicMock, patch  # noqa: E402

from api.storage.canonical import canonical_key  # noqa: E402
from api.storage.elasticsearch.facts import insert_or_dedup_fact  # noqa: E402
from api.structure.entity_resolver import resolve_entity  # noqa: E402
from api.structure.predicate_mapper import map_predicate_to_opl  # noqa: E402

# ---------------------------------------------------------------------------
# 1. Korean capture -> Korean object preserved (B-53 surface invariant)
# ---------------------------------------------------------------------------

def test_korean_capture_keeps_object_in_korean() -> None:
    """Acceptance criterion #1: 한국어 캡처 -> 한국어 object."""
    raw_predicate = "설립자"
    code, needs_review = map_predicate_to_opl(raw_predicate)

    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    fact_uid, created = insert_or_dedup_fact(
        subject_entity_id="ent-국방부",
        predicate_code=code,
        object_ref={"kind": "literal", "value": "국방부 장관"},
        knowledge_space_id="ks-1",
        source_uid="src-1",
        original_surface=raw_predicate,
        capture_lang="ko",
        object_value="국방부 장관",
        claim="국방부의 설립자는 국방부 장관이다.",
        es_client=client,
        needs_review=needs_review,
    )
    assert created is True
    body = client.index.call_args.kwargs["document"]
    assert body["predicate_code"] == "FOUNDED_BY"
    assert body["object_value"] == "국방부 장관"          # surface preserved
    assert body["original_surface"] == "설립자"
    assert body["capture_lang"] == "ko"
    assert body["predicate"] == "설립자"                  # legacy surface


# ---------------------------------------------------------------------------
# 2. English capture -> English object preserved
# ---------------------------------------------------------------------------

def test_english_capture_keeps_object_in_english() -> None:
    code, needs_review = map_predicate_to_opl("founded_by")
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    fact_uid, created = insert_or_dedup_fact(
        subject_entity_id="ent-spacex",
        predicate_code=code,
        object_ref={"kind": "literal", "value": "Elon Musk"},
        knowledge_space_id="ks-1",
        source_uid="src-2",
        original_surface="founded_by",
        capture_lang="en",
        object_value="Elon Musk",
        claim="SpaceX was founded by Elon Musk.",
        es_client=client,
        needs_review=needs_review,
    )
    assert created is True
    body = client.index.call_args.kwargs["document"]
    assert body["object_value"] == "Elon Musk"
    assert body["capture_lang"] == "en"
    assert body["predicate_code"] == "FOUNDED_BY"


# ---------------------------------------------------------------------------
# 3. Predicate OPL coverage - "ceo" surface maps to LED_BY
# ---------------------------------------------------------------------------

def test_predicate_ceo_maps_to_led_by_on_inserted_fact() -> None:
    code, needs_review = map_predicate_to_opl("ceo")
    assert code == "LED_BY"
    assert needs_review is False

    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    fact_uid, _ = insert_or_dedup_fact(
        subject_entity_id="ent-apple",
        predicate_code=code,
        object_ref={"kind": "literal", "value": "Tim Cook"},
        knowledge_space_id="ks-1",
        source_uid="src-3",
        original_surface="ceo",
        capture_lang="en",
        object_value="Tim Cook",
        es_client=client,
        needs_review=needs_review,
    )
    body = client.index.call_args.kwargs["document"]
    assert body["predicate_code"] == "LED_BY"
    assert body["needs_review"] is False


# ---------------------------------------------------------------------------
# 4. Ambiguous predicate -> RELATED_TO + needs_review=True
# ---------------------------------------------------------------------------

def test_ambiguous_predicate_routes_to_related_to_with_review_flag() -> None:
    # B-62 natural-spo-display: the OPL v1 expansion legitimately covers
    # rivalry (COMPETES_WITH), so we use a genuinely ambiguous surface
    # that has no lookup OR substring hit.
    code, needs_review = map_predicate_to_opl("is_friend_with")
    assert code == "RELATED_TO"
    assert needs_review is True

    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    fact_uid, _ = insert_or_dedup_fact(
        subject_entity_id="ent-google",
        predicate_code=code,
        object_ref={"kind": "literal", "value": "Apple"},
        knowledge_space_id="ks-1",
        source_uid="src-4",
        original_surface="is_friend_with",
        capture_lang="en",
        object_value="Apple",
        es_client=client,
        needs_review=needs_review,
    )
    body = client.index.call_args.kwargs["document"]
    assert body["predicate_code"] == "RELATED_TO"
    assert body["needs_review"] is True
    assert body["original_surface"] == "is_friend_with"


# ---------------------------------------------------------------------------
# 5. Cross-language entity merge via co_mention_en hint
# ---------------------------------------------------------------------------

def test_cross_language_entity_merge_via_co_mention_collapses_subjects() -> None:
    """★ Acceptance criterion #3: 한/영 동일 entity -> 같은 entity_id.
    Two captures, one English ("SpaceX") and one Korean ("스페이스X")
    with the LLM-provided co-mention hint, must resolve to the SAME
    canonical subject_entity_id."""

    # Shared state across two structure calls.
    canonical_store: dict[str, dict[str, Any]] = {}

    def _make_client():
        client = MagicMock()

        def _search(*, index, query, size):
            # Iterate canonical_store; match on any field requested.
            filt = query["bool"]["filter"]
            field, value = next(iter(filt[1]["term"].items()))
            for doc in canonical_store.values():
                if doc.get(field) == value:
                    return {"hits": {"hits": [{"_source": doc}]}}
                aliases = doc.get("aliases") or []
                if field == "aliases" and value in aliases:
                    return {"hits": {"hits": [{"_source": doc}]}}
            return {"hits": {"hits": []}}

        client.search.side_effect = _search
        client.exists.side_effect = lambda **kw: kw["id"] in canonical_store
        client.get.side_effect = lambda **kw: {
            "_source": canonical_store[kw["id"]]
        }

        def _index(*, index, id, document, refresh):
            canonical_store[id] = dict(document)

        client.index.side_effect = _index

        def _update(*, index, id, doc, refresh):
            canonical_store[id].update(doc)

        client.update.side_effect = _update
        return client

    client = _make_client()

    # Capture 1: English surface "SpaceX" -> creates canonical entity.
    uid_a, created_a = resolve_entity(
        "SpaceX", "en", space_id="ks-1", es_client=client,
    )
    assert created_a is True
    # Capture 2: Korean surface "스페이스X" with co_mention_en="SpaceX"
    # -> resolves to the SAME entity_id.
    uid_b, created_b = resolve_entity(
        "스페이스X", "ko", space_id="ks-1",
        co_mention_en="SpaceX", es_client=client,
    )
    assert created_b is False
    assert uid_a == uid_b
    # The Korean surface was appended to the canonical entity's aliases.
    canonical = canonical_store[uid_a]
    assert "스페이스X" in canonical["aliases"]


# ---------------------------------------------------------------------------
# 6. Dedup via canonical_key adds a source instead of inserting a new fact
# ---------------------------------------------------------------------------

def test_dedup_via_canonical_key_appends_source_to_existing_fact() -> None:
    """★ Acceptance criterion #5: dedup + source 층위. Two captures of
    the same canonical triple (incl. same natural-language surface)
    from different sources collapse to ONE fact doc; sources[] gets
    BOTH source uids.

    feat/stage3-predicate-code-fact-type: the natural-language
    predicate is now part of the dedup tie-breaker, so the two
    captures must share the same `original_surface` to collapse.
    Different surfaces (e.g. 'founded_by' vs 'founder') are now an
    intentional non-collapse — the PO accepts that as a weak duplicate
    that a human cleans up downstream."""

    fact_store: dict[str, dict[str, Any]] = {}

    def _make_client():
        client = MagicMock()

        def _search(*, index, query, size):
            filt = query["bool"]["filter"]
            terms = {next(iter(f["term"])): next(iter(f["term"].values())) for f in filt}
            ckey_subject = terms.get("subject_uid")
            ckey_predicate = terms.get("predicate_code")
            ckey_fact_type = terms.get("fact_type")
            ckey_object = terms.get("object_canonical")
            ckey_predicate_natlang = terms.get("predicate")
            for doc in fact_store.values():
                if doc.get("retracted_at"):
                    continue
                if doc.get("subject_uid") != ckey_subject:
                    continue
                if doc.get("object_canonical") != ckey_object:
                    continue
                if ckey_fact_type is not None:
                    if doc.get("fact_type") != ckey_fact_type and \
                       doc.get("type") != ckey_fact_type:
                        continue
                elif ckey_predicate is not None:
                    if doc.get("predicate_code") != ckey_predicate:
                        continue
                if ckey_predicate_natlang is not None:
                    stored_pred = (doc.get("predicate") or "").strip().lower()
                    if stored_pred != ckey_predicate_natlang:
                        continue
                return {"hits": {"hits": [{"_source": doc}]}}
            return {"hits": {"hits": []}}

        client.search.side_effect = _search
        client.exists.side_effect = lambda **kw: kw["id"] in fact_store

        def _index(*, index, id, document, refresh):
            fact_store[id] = dict(document)

        client.index.side_effect = _index

        def _update(*, index, id, doc, refresh):
            fact_store[id].update(doc)

        client.update.side_effect = _update

        client.get.side_effect = lambda **kw: {"_source": fact_store[kw["id"]]}
        return client

    client = _make_client()

    code, _ = map_predicate_to_opl("founded_by")
    obj_ref: dict = {"kind": "literal", "value": "Elon Musk"}

    # First capture: a fresh insert.
    uid_a, created_a = insert_or_dedup_fact(
        subject_entity_id="ent-spacex",
        predicate_code=code,
        object_ref=obj_ref,
        knowledge_space_id="ks-1",
        source_uid="src-A",
        original_surface="founded_by",
        capture_lang="en",
        object_value="Elon Musk",
        es_client=client,
    )
    assert created_a is True

    # Second capture: same canonical triple AND same natural surface,
    # different source -> dedup hit.
    uid_b, created_b = insert_or_dedup_fact(
        subject_entity_id="ent-spacex",
        predicate_code=code,
        object_ref=obj_ref,
        knowledge_space_id="ks-1",
        source_uid="src-B",
        original_surface="founded_by",  # same surface predicate
        capture_lang="en",
        object_value="Elon Musk",
        es_client=client,
    )
    assert created_b is False                 # dedup hit
    assert uid_a == uid_b                     # same fact uid
    assert len(fact_store) == 1               # one ES doc
    sources = fact_store[uid_a]["source_uids"]
    assert "src-A" in sources
    assert "src-B" in sources
