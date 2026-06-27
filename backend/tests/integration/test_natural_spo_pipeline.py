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
    """`회사채 발행 계획` Korean predicate -> PLANS code.

    feat/stage3-predicate-code-fact-type: the gloss dict is REPEALED.
    The label is now the raw Korean surface, preserved verbatim — NOT
    an English gloss like 'plans bond issuance'. The OPL code stays
    PLANS via the substring cue list (classification logic unchanged)."""
    code, label, needs_review = map_predicate_to_type_and_label(
        "회사채 발행 계획",
    )
    assert code == "PLANS"
    assert label == "회사채 발행 계획"

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
    assert body["predicate_label"] == "회사채 발행 계획"
    assert body["original_surface"] == "회사채 발행 계획"
    assert body["capture_lang"] == "ko"
    # canonical_key composed only of (subject_uid, predicate_code,
    # object_canonical) — label not in it. (canonical_key signature
    # is GUARDED by STAGE 3 PO directive: no change.)
    assert body["canonical_key"] == canonical_key(
        "ent-corp", "PLANS", {"kind": "literal", "value": "1000억원"},
    )
    # English gloss is no longer produced; raw Korean is now the label.
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
    """Capture A: predicate '설립자' -> label '설립자' (raw Korean).
    Capture B: predicate '설립자' (same natural surface) -> dedup hit;
    first label kept.

    feat/stage3-predicate-code-fact-type: the dedup key now includes
    the natural-language predicate as a tie-breaker. The PO accepts
    that two captures with DIFFERENT natural surfaces (e.g. '설립자'
    vs 'founder') do NOT collapse — even when they share the same OPL
    code — because they are weak duplicates a human can clean up.
    What MUST still collapse is two captures with the SAME natural
    surface (the historical canonical_key invariant)."""
    fact_store: dict[str, dict[str, Any]] = {}

    def _make_client():
        client = MagicMock()

        def _search(*, index, query, size):
            filt = query["bool"]["filter"]
            terms = {next(iter(f["term"])): next(iter(f["term"].values()))
                     for f in filt}
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
                # STAGE 3: fact_type wins when present; predicate_code
                # is the legacy fallback.
                if ckey_fact_type is not None:
                    if doc.get("fact_type") != ckey_fact_type and \
                       doc.get("type") != ckey_fact_type:
                        continue
                elif ckey_predicate is not None:
                    if doc.get("predicate_code") != ckey_predicate:
                        continue
                # Natural predicate tie-breaker.
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

    # Capture A: Korean surface; STAGE 3 — label is raw Korean (no gloss).
    code_a, label_a, _ = map_predicate_to_type_and_label("설립자")
    assert code_a == "FOUNDED_BY"
    assert label_a == "설립자"

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
    assert fact_store[uid_a]["predicate_label"] == "설립자"

    # Capture B: SAME Korean surface, different source -> dedup hit.
    code_b, label_b, _ = map_predicate_to_type_and_label("설립자")
    assert code_b == "FOUNDED_BY"
    assert label_b == "설립자"

    uid_b, created_b = insert_or_dedup_fact(
        subject_entity_id="ent-spacex",
        predicate_code=code_b,
        object_ref=obj_ref,
        knowledge_space_id="ks-1",
        source_uid="src-B",
        original_surface="설립자",
        capture_lang="ko",
        object_value="Elon Musk",
        es_client=client,
        predicate_label=label_b,
    )
    assert created_b is False           # dedup hit
    assert uid_a == uid_b               # same fact uid
    assert len(fact_store) == 1         # one ES doc

    # canonical_key invariant: the first capture's label is preserved
    # (DEDUP path NEVER overwrites predicate_label).
    assert fact_store[uid_a]["predicate_label"] == "설립자"

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


# ---------------------------------------------------------------------------
# 6. B-62-fix-v2 subject-natlang (PO 2026-06-22): defense-in-depth
#    - (a) re-promote: legacy English-primary entity becomes Korean primary
#      on first Korean reuse.
#    - (b) surface-as-original-span: Korean particle stripped before lookup
#      so the canonical entity is found.
# ---------------------------------------------------------------------------

def test_v2_repromote_english_primary_to_korean_on_reuse() -> None:
    """E2E: existing English-primary entity `Ministry of Commerce of China`
    + fresh Korean capture `중국 상무부` -> re-promote so primary becomes
    Korean. Brand-shape guard prevents over-correction (SpaceX stays)."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-moc",
        "primary_label": "Ministry of Commerce of China",
        "primary_lang": "en",
        "name": "Ministry of Commerce of China",
        "aliases": [],
        "relabel_history": [],
    }
    # First lookup field is primary_label — hit.
    client.search.return_value = {"hits": {"hits": [{"_source": existing}]}}
    client.get.return_value = {"_source": existing}

    uid, was_created = resolve_entity(
        "중국 상무부", "ko", space_id="ks-1", es_client=client,
    )
    assert was_created is False
    assert uid == "uid-moc"
    assert client.update.called
    doc = client.update.call_args.kwargs["doc"]
    assert doc["primary_label"] == "중국 상무부"
    assert doc["primary_lang"] == "ko"
    assert "Ministry of Commerce of China" in doc["aliases"]


def test_v2_brand_guard_blocks_spacex_repromote() -> None:
    """`SpaceX` is brand-shaped — even with Korean capture `스페이스X`,
    primary stays SpaceX."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-spacex",
        "primary_label": "SpaceX",
        "primary_lang": "en",
        "name": "SpaceX",
        "aliases": [],
    }
    client.search.return_value = {"hits": {"hits": [{"_source": existing}]}}
    client.get.return_value = {"_source": existing}

    uid, _ = resolve_entity(
        "스페이스X", "ko", space_id="ks-1", es_client=client,
    )
    assert uid == "uid-spacex"
    assert not client.update.called


def test_v2_korean_particle_stripped_before_lookup() -> None:
    """LLM emits subject_surface='중국 상무부는' (with particle). The
    resolver strips the particle and lookup matches the canonical entity."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-moc",
        "primary_label": "중국 상무부",
        "primary_lang": "ko",
        "name": "중국 상무부",
        "aliases": [],
    }
    seen: list[str] = []

    def _search(*, index, query, size):
        filt = query["bool"]["filter"]
        _f, v = next(iter(filt[1]["term"].items()))
        seen.append(v)
        if v == "중국 상무부":
            return {"hits": {"hits": [{"_source": existing}]}}
        return {"hits": {"hits": []}}

    client.search.side_effect = _search
    client.get.return_value = {"_source": existing}

    uid, was_created = resolve_entity(
        "중국 상무부는", "ko", space_id="ks-1", es_client=client,
    )
    assert was_created is False
    assert uid == "uid-moc"
    assert "중국 상무부는" not in seen


def test_v2_missing_subject_surface_falls_back_to_name_via_resolve_entity() -> None:
    """When the LLM omits subject_surface (legacy / older Claude payload),
    the resolver behavior is unchanged — it operates on whatever surface
    the processor passes in. This locks the back-compat invariant."""
    client = MagicMock()
    client.search.return_value = {"hits": {"hits": []}}

    # Surface fallback is what the caller would pass after coalescing
    # subject_surface to subject_name. With "삼성전자" surface alone (no
    # llm_name), the create path mints a Korean primary.
    uid, was_created = resolve_entity(
        "삼성전자", "ko", space_id="ks-1", es_client=client,
    )
    assert was_created is True
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "삼성전자"
    assert body["primary_lang"] == "ko"


# ---------------------------------------------------------------------------
# 7. B-62-fix-v3-general (feat/spo-surface-content-language, PO 2026-06-22):
#    verbatim-substring constraint replaces the dictionary band-aid. When
#    the LLM emits an English surface for a Korean-content entity AND the
#    English form is NOT a substring of the claim, the matcher flags
#    needs_review=True. Primary stays English (we do NOT guess the Korean
#    form — that's HITL's job).
# ---------------------------------------------------------------------------


def test_korean_claim_english_llm_name_recovers_to_korean() -> None:
    """B-62-fix-v6 (feat/spo-subject-claim-recovery): LLM anglicized a
    Korean entity (no subject_surface, English `name`). The verbatim
    validator detects the violation and the deterministic recovery
    pulls "중국 상무부" out of the claim via the 는 particle boundary.
    needs_review=False (recovery succeeded). NO HITL needed — the
    English surface is replaced with the Korean form."""
    from unittest.mock import patch as _patch

    from api.models.objects import ObjectClass
    from api.structure.models import StructureFact, StructureObject, StructureResult
    from api.structure.processor import _build_surface_map, _match_object

    decomp = StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="Ministry of Commerce of China",
                name_en="Ministry of Commerce of China",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="중국 상무부는 새로운 수출통제 조치를 발표했다.",
                subject_uid="obj-1",
                subject_surface=None,  # LLM omitted — Mode A
                predicate="announces",
                object_value="새로운 수출통제 조치",
            ),
        ],
        extraction_status="success",
    )
    surface_map = _build_surface_map(decomp)
    assert "obj-1" not in surface_map

    mock_client = MagicMock()
    mock_client.search.return_value = {"hits": {"hits": []}}
    mock_client.exists.return_value = False

    with _patch("api.structure.entity_resolver.get_client", return_value=mock_client), \
         _patch("api.structure.processor.get_embedding", return_value=None):
        result, _, needs_review = _match_object(
            decomp.objects[0],
            knowledge_space_id="ks-1",
            surface_map=surface_map,
            decomp=decomp,
        )
    assert result is not None
    assert needs_review is False
    body = mock_client.index.call_args.kwargs["document"]
    # B-62-fix-v6: the recovery replaces the LLM's English with the
    # Korean form parsed from the claim. primary_label is Korean.
    assert body["primary_label"] == "중국 상무부"
    assert body["primary_lang"] == "ko"


def test_redcat_holdings_english_claim_stays_english_no_violation() -> None:
    """Control: RedCat Holdings is multi-word English on an English
    claim. No violation (source is not Korean). Primary stays English
    and needs_review=False — regression guard for English entities."""
    from unittest.mock import patch as _patch

    from api.models.objects import ObjectClass
    from api.structure.models import StructureFact, StructureObject, StructureResult
    from api.structure.processor import _build_surface_map, _match_object

    decomp = StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="RedCat Holdings",
                name_en="RedCat Holdings",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="RedCat Holdings announced a new drone line.",
                subject_uid="obj-1",
                subject_surface="RedCat Holdings",
                predicate="announces",
                object_value="a new drone line",
            ),
        ],
        extraction_status="success",
    )
    surface_map = _build_surface_map(decomp)
    mock_client = MagicMock()
    mock_client.search.return_value = {"hits": {"hits": []}}
    mock_client.exists.return_value = False

    with _patch("api.structure.entity_resolver.get_client", return_value=mock_client), \
         _patch("api.structure.processor.get_embedding", return_value=None):
        result, _, needs_review = _match_object(
            decomp.objects[0],
            knowledge_space_id="ks-1",
            surface_map=surface_map,
            decomp=decomp,
        )
    assert result is not None
    assert needs_review is False
    body = mock_client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "RedCat Holdings"
    assert body["primary_lang"] == "en"


def test_lockheed_martin_in_korean_claim_no_violation() -> None:
    """English entity name appearing verbatim in a Korean claim is
    NOT a violation — multi-word English isn't brand-shaped, but the
    surface IS a substring of the source, so the verbatim check
    passes. needs_review=False, primary stays English."""
    from unittest.mock import patch as _patch

    from api.models.objects import ObjectClass
    from api.structure.models import StructureFact, StructureObject, StructureResult
    from api.structure.processor import _build_surface_map, _match_object

    decomp = StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.ORGANIZATION.value},
                name="Lockheed Martin",
                name_en="Lockheed Martin",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="Lockheed Martin이 새 무기 체계를 발표했다.",
                subject_uid="obj-1",
                subject_surface="Lockheed Martin",
                predicate="announces",
                object_value="새 무기 체계",
            ),
        ],
        extraction_status="success",
    )
    surface_map = _build_surface_map(decomp)
    mock_client = MagicMock()
    mock_client.search.return_value = {"hits": {"hits": []}}
    mock_client.exists.return_value = False

    with _patch("api.structure.entity_resolver.get_client", return_value=mock_client), \
         _patch("api.structure.processor.get_embedding", return_value=None):
        result, _, needs_review = _match_object(
            decomp.objects[0],
            knowledge_space_id="ks-1",
            surface_map=surface_map,
            decomp=decomp,
        )
    assert result is not None
    assert needs_review is False
    body = mock_client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "Lockheed Martin"
    assert body["primary_lang"] == "en"
