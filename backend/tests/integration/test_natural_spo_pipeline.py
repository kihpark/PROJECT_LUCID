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
# 7. B-62-fix-v3 (PO 2026-06-22): Mode A defense. LLM omits subject_surface
#    AND emits English in `name`. The processor's surface-derivation pulls
#    the Korean substring from the claim text via the curated KO↔EN org
#    dictionary and the resolver mints a Korean-primary canonical entity.
# ---------------------------------------------------------------------------


def test_mode_a_korean_claim_with_english_llm_name_resolves_to_korean_primary() -> None:
    """B-62-fix-v3 (PO 2026-06-22): Mode A end-to-end. The LLM emitted
    `name='Ministry of Commerce of China'` and `subject_surface=None`
    for a Korean-language claim. The processor's `_match_object` must
    derive '중국 상무부' from the claim via the dictionary lookup and
    the resolver must mint that as primary_label."""
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
    assert "obj-1" not in surface_map  # confirm raw_surface is absent

    mock_client = MagicMock()
    mock_client.search.return_value = {"hits": {"hits": []}}
    mock_client.exists.return_value = False

    with _patch("api.structure.entity_resolver.get_client", return_value=mock_client), \
         _patch("api.structure.processor.get_embedding", return_value=None):
        result, _ = _match_object(
            decomp.objects[0],
            knowledge_space_id="ks-1",
            surface_map=surface_map,
            decomp=decomp,  # B-62-fix-v3 enabler
        )
    assert result is not None
    assert result.created_new is True
    body = mock_client.index.call_args.kwargs["document"]
    # The dictionary derivation recovered the Korean span from the claim,
    # so the canonical primary is Korean and the English LLM-name lands
    # in aliases (via `co_mention_en` on the resolver create path).
    assert body["primary_label"] == "중국 상무부"
    assert body["primary_lang"] == "ko"
    assert "Ministry of Commerce of China" in body["aliases"]


def test_mode_a_redcat_holdings_english_claim_stays_english() -> None:
    """B-62-fix-v3 control: RedCat Holdings is NOT in the dictionary,
    the claim is English, and there's no Korean to recover. The
    surface-derivation must return None and the original English flow
    runs unchanged — no regression for English brands."""
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
        result, _ = _match_object(
            decomp.objects[0],
            knowledge_space_id="ks-1",
            surface_map=surface_map,
            decomp=decomp,
        )
    assert result is not None
    body = mock_client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "RedCat Holdings"
    assert body["primary_lang"] == "en"


def test_mode_a_export_control_policy_noun_resolves_to_korean() -> None:
    """B-62-fix-v3: policy nouns the LLM translates ('export control'
    → 수출통제) are covered too. The Korean form appears verbatim in
    the claim and is recovered as primary."""
    from unittest.mock import patch as _patch

    from api.models.objects import ObjectClass
    from api.structure.models import StructureFact, StructureObject, StructureResult
    from api.structure.processor import _build_surface_map, _match_object

    decomp = StructureResult(
        objects=[
            StructureObject(
                uid="obj-1",
                **{"class": ObjectClass.CONCEPT.value},
                name="export control",
                name_en="export control",
            ),
        ],
        facts=[
            StructureFact(
                uid="fn-1",
                **{"type": "proposition"},
                claim="중국이 새 수출통제 조치를 발표했다.",
                subject_uid="obj-1",
                subject_surface=None,
                predicate="is",
                object_value="강화됨",
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
        result, _ = _match_object(
            decomp.objects[0],
            knowledge_space_id="ks-1",
            surface_map=surface_map,
            decomp=decomp,
        )
    body = mock_client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "수출통제"
    assert body["primary_lang"] == "ko"
    assert "export control" in body["aliases"]
