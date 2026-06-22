"""B-62 natural-spo-display - end-to-end pipeline integration tests.

Locks the four invariants of the natural-SPO display PR:

  1. Korean predicate surface flows through to an English label on the
     fact doc; the predicate_code is the OPL type, original_surface
     preserves the Korean capture.
  2. English natural-language predicate surface echoes verbatim onto
     predicate_label.
  3. Two captures with different surfaces but the same canonical type
     and object dedup via canonical_key (label NEVER part of dedup
     key) and the first capture's label is preserved.
  4. A Korean entity capture with the LLM-provided English co-mention
     resolves to one canonical entity, and the Korean surface lands
     in aliases so the recall path keeps cross-lingual matching.

These tests mirror the existing test_structure_resolve_pipeline.py
style: MagicMock ES client, no docker dependency.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock

import pytest

from api.storage.canonical import canonical_key
from api.storage.elasticsearch.facts import insert_or_dedup_fact
from api.structure.entity_resolver import resolve_entity
from api.structure.predicate_mapper import map_predicate_to_type_and_label

pytestmark = pytest.mark.integration


# ---------------------------------------------------------------------------
# 1. Korean predicate -> English label via gloss dict
# ---------------------------------------------------------------------------

def test_korean_predicate_yields_english_label_on_fact() -> None:
    """`회사채 발행 계획` Korean predicate -> PLANS code +
    "plans bond issuance" label preserved on the ES doc."""
    code, label, needs_review = map_predicate_to_type_and_label(
        "회사채 발행 계획",
    )
    assert code == "PLANS"
    assert label == "plans bond issuance"

    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    fact_uid, created = insert_or_dedup_fact(
        subject_entity_id="ent-corp",
        predicate_code=code,
        object_ref={"kind": "literal", "value": "1000억원"},
        knowledge_space_id="ks-1",
        source_uid="src-1",
        original_surface="회사채 발행 계획",
        capture_lang="ko",
        object_value="1000억원",
        claim="회사가 1000억원 회사채 발행을 계획한다.",
        es_client=client,
        needs_review=needs_review,
        predicate_label=label,
    )
    assert created is True
    body = client.index.call_args.kwargs["document"]
    assert body["predicate_code"] == "PLANS"
    assert body["predicate_label"] == "plans bond issuance"
    assert body["original_surface"] == "회사채 발행 계획"
    assert body["capture_lang"] == "ko"
    # canonical_key composed only of (subject_uid, predicate_code,
    # object_canonical) — label not in it.
    assert body["canonical_key"] == canonical_key(
        "ent-corp", "PLANS", {"kind": "literal", "value": "1000억원"},
    )
    assert "plans bond issuance" not in body["canonical_key"]


# ---------------------------------------------------------------------------
# 2. English natural-language predicate echoes onto predicate_label
# ---------------------------------------------------------------------------

def test_english_natural_predicate_echoes_onto_label() -> None:
    """English natural surface 'announces partnership' -> ANNOUNCES code +
    the natural surface echoed onto the label."""
    code, label, needs_review = map_predicate_to_type_and_label(
        "announces partnership",
    )
    assert code == "ANNOUNCES"
    assert label == "announces partnership"

    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    fact_uid, created = insert_or_dedup_fact(
        subject_entity_id="ent-spacex",
        predicate_code=code,
        object_ref={"kind": "entity", "uid": "ent-nasa"},
        knowledge_space_id="ks-1",
        source_uid="src-2",
        original_surface="announces partnership",
        capture_lang="en",
        object_value="ent-nasa",
        claim="SpaceX announces partnership with NASA.",
        es_client=client,
        needs_review=needs_review,
        predicate_label=label,
    )
    assert created is True
    body = client.index.call_args.kwargs["document"]
    assert body["predicate_code"] == "ANNOUNCES"
    assert body["predicate_label"] == "announces partnership"


# ---------------------------------------------------------------------------
# 3. Two captures with different surfaces / labels dedup via canonical_key;
#    the first capture's label is preserved on the existing doc.
# ---------------------------------------------------------------------------

def test_two_surface_phrasings_dedup_and_first_label_wins() -> None:
    """Capture A: predicate '설립자' -> label 'founded by'.
    Capture B: predicate 'founder' -> label 'founder'.
    Both map to FOUNDED_BY + same object -> dedup; first label kept."""
    fact_store: dict[str, dict[str, Any]] = {}

    def _make_client():
        client = MagicMock()

        def _search(*, index, query, size):
            filt = query["bool"]["filter"]
            terms = {next(iter(f["term"])): next(iter(f["term"].values()))
                     for f in filt}
            ckey_subject = terms.get("subject_uid")
            ckey_predicate = terms.get("predicate_code")
            ckey_object = terms.get("object_canonical")
            for doc in fact_store.values():
                if (
                    doc.get("subject_uid") == ckey_subject
                    and doc.get("predicate_code") == ckey_predicate
                    and doc.get("object_canonical") == ckey_object
                    and not doc.get("retracted_at")
                ):
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

    # Capture A: Korean surface, Korean -> English gloss.
    code_a, label_a, _ = map_predicate_to_type_and_label("설립자")
    assert code_a == "FOUNDED_BY"
    assert label_a == "founded by"

    obj_ref: dict = {"kind": "literal", "value": "Elon Musk"}
    uid_a, created_a = insert_or_dedup_fact(
        subject_entity_id="ent-spacex",
        predicate_code=code_a,
        object_ref=obj_ref,
        knowledge_space_id="ks-1",
        source_uid="src-A",
        original_surface="설립자",
        capture_lang="ko",
        object_value="Elon Musk",
        es_client=client,
        predicate_label=label_a,
    )
    assert created_a is True
    assert fact_store[uid_a]["predicate_label"] == "founded by"

    # Capture B: English natural surface, different phrasing, same OPL
    # code and object -> dedup hit.
    code_b, label_b, _ = map_predicate_to_type_and_label("founder")
    assert code_b == "FOUNDED_BY"
    # `founder` is a direct OPL_LOOKUP key (no gloss-dict hit) so it
    # echoes through the English-echo path.
    assert label_b == "founder"

    uid_b, created_b = insert_or_dedup_fact(
        subject_entity_id="ent-spacex",
        predicate_code=code_b,
        object_ref=obj_ref,
        knowledge_space_id="ks-1",
        source_uid="src-B",
        original_surface="founder",
        capture_lang="en",
        object_value="Elon Musk",
        es_client=client,
        predicate_label=label_b,
    )
    assert created_b is False           # dedup hit
    assert uid_a == uid_b               # same fact uid
    assert len(fact_store) == 1         # one ES doc

    # canonical_key invariant: the first capture's label is preserved
    # (DEDUP path NEVER overwrites predicate_label). The label on the
    # stored doc is still capture-A's gloss.
    assert fact_store[uid_a]["predicate_label"] == "founded by"

    # Both sources appended.
    sources = fact_store[uid_a]["source_uids"]
    assert "src-A" in sources
    assert "src-B" in sources


# ---------------------------------------------------------------------------
# 4. Cross-language entity merge + LLM natural-name primary
# ---------------------------------------------------------------------------

def test_korean_entity_with_llm_english_name_primary_is_natural_english() -> None:
    """The LLM tagged the entity in both Korean (스페이스X) and English
    (SpaceX). When we resolve the Korean surface with the English
    llm_name hint, the canonical entity gets SpaceX as primary_label
    (the LLM's natural name) and 스페이스X lands in aliases."""
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    uid, was_created = resolve_entity(
        "스페이스X", "ko",
        space_id="ks-1",
        llm_name="SpaceX",
        es_client=client,
    )
    assert was_created is True
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "SpaceX"
    assert body["primary_lang"] == "en"
    assert "스페이스X" in body["aliases"]



# ---------------------------------------------------------------------------
# 5. B-62-fix subject-natlang (PO 2026-06-22): Korean common-noun capture
#    preserves Korean primary even when LLM emits English translation as
#    `name`. Brand-shaped English (SpaceX, OpenAI, KAIST) still wins.
# ---------------------------------------------------------------------------

def test_korean_common_noun_capture_preserves_korean_primary() -> None:
    """Regression: Korean source emits 회사채; Claude translates `name`
    to 'corporate bonds'. The resolver MUST defend the Korean surface
    as primary_label and demote the English translation to aliases."""
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    uid, was_created = resolve_entity(
        "회사채", "ko",
        space_id="ks-1",
        llm_name="corporate bonds",
        es_client=client,
    )
    assert was_created is True
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "회사채"
    assert body["primary_lang"] == "ko"
    assert "corporate bonds" in body["aliases"]


def test_korean_firm_name_descriptive_translation_preserves_korean_primary() -> None:
    """Regression: 우리자산운용 + Claude's 'Woori Asset Management' (a
    multi-word descriptive translation, NOT a brand) -> Korean primary
    is preserved. English translation lands in aliases."""
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    uid, was_created = resolve_entity(
        "우리자산운용", "ko",
        space_id="ks-1",
        llm_name="Woori Asset Management",
        es_client=client,
    )
    assert was_created is True
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "우리자산운용"
    assert body["primary_lang"] == "ko"
    assert "Woori Asset Management" in body["aliases"]
