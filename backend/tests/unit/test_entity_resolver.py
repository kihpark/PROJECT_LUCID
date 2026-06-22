"""B-62 structure-resolve + natural-spo-display - entity_resolver tests."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from api.structure.entity_resolver import (
    _looks_like_brand,
    pick_natural_primary,
    resolve_entity,
)


def _hit(uid: str, **extra) -> dict:
    """Build a fake ES hit envelope for one entity doc."""
    src = {"object_uid": uid, "name": extra.pop("name", uid)}
    src.update(extra)
    return {"hits": {"hits": [{"_source": src}]}}


def _no_hit() -> dict:
    return {"hits": {"hits": []}}


# --- Lookup paths ----------------------------------------------------------


def test_exact_match_on_primary_label_returns_existing_uid() -> None:
    client = MagicMock()
    # First call (field=primary_label) hits.
    client.search.return_value = _hit("existing-1", primary_label="SpaceX")
    uid, was_created = resolve_entity(
        "SpaceX", "en", space_id="ks-1", es_client=client,
    )
    assert was_created is False
    assert uid == "existing-1"


def test_exact_match_on_aliases_returns_existing_uid() -> None:
    client = MagicMock()
    # primary_label miss, name miss, name_en miss, aliases HIT.
    client.search.side_effect = [
        _no_hit(), _no_hit(), _no_hit(),
        _hit("existing-2", aliases=["스페이스X"]),
    ]
    uid, was_created = resolve_entity(
        "스페이스X", "ko", space_id="ks-1", es_client=client,
    )
    assert was_created is False
    assert uid == "existing-2"


def test_legacy_name_match_returns_existing_uid() -> None:
    """Pre-data-bedrock objects only have `name`, no primary_label.
    The resolver must still find them via the back-compat lookup."""
    client = MagicMock()
    client.search.side_effect = [
        _no_hit(),  # primary_label miss
        _hit("legacy-1", name="OldEntity"),  # name hit
    ]
    uid, was_created = resolve_entity(
        "OldEntity", "en", space_id="ks-1", es_client=client,
    )
    assert was_created is False
    assert uid == "legacy-1"


def test_legacy_name_en_match_returns_existing_uid() -> None:
    client = MagicMock()
    client.search.side_effect = [
        _no_hit(),  # primary_label miss
        _no_hit(),  # name miss
        _hit("legacy-2", name_en="Samsung Electronics"),
    ]
    uid, was_created = resolve_entity(
        "Samsung Electronics", "en", space_id="ks-1", es_client=client,
    )
    assert was_created is False
    assert uid == "legacy-2"


# --- Create paths ----------------------------------------------------------


def test_lookup_miss_creates_new_entity_with_canonical_fields() -> None:
    client = MagicMock()
    client.search.return_value = _no_hit()  # nothing exists yet
    client.index.return_value = None
    uid, was_created = resolve_entity(
        "NewCo", "en", space_id="ks-1", es_client=client,
    )
    assert was_created is True
    assert uid  # non-empty
    # Verify the inserted doc carries the canonical fields.
    indexed = client.index.call_args
    assert indexed is not None
    body = indexed.kwargs["document"]
    assert body["primary_label"] == "NewCo"
    assert body["primary_lang"] == "en"
    assert body["name"] == "NewCo"
    assert body["knowledge_space_id"] == "ks-1"


def test_lookup_miss_with_korean_surface_preserves_korean_primary_label() -> None:
    """PO directive: 한국어 캡처 -> 한국어 object (영어 패러프레이즈 0)."""
    client = MagicMock()
    client.search.return_value = _no_hit()
    uid, was_created = resolve_entity(
        "스페이스X", "ko", space_id="ks-1", es_client=client,
    )
    assert was_created is True
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "스페이스X"
    assert body["primary_lang"] == "ko"


# --- Cross-language merge via co_mention_en hint ---------------------------


def test_cross_language_merge_via_co_mention_returns_existing_id() -> None:
    """SpaceX (en) already exists. The Korean surface "스페이스X" arrives
    with co_mention_en="SpaceX". The resolver finds SpaceX, appends
    the Korean surface as an alias, and returns SpaceX's uid."""
    client = MagicMock()
    # The Korean surface itself misses on all four fields (primary_label,
    # name, name_en, aliases). The English co-mention hits on
    # primary_label.
    def _search_side_effect(*, index, query, size):
        filt = query["bool"]["filter"]
        # filt[1] is the field-value term clause; extract (field, value).
        field, value = next(iter(filt[1]["term"].items()))
        if value == "스페이스X":
            return _no_hit()
        if value == "SpaceX" and field == "primary_label":
            return _hit("uid-spacex", primary_label="SpaceX")
        return _no_hit()

    client.search.side_effect = _search_side_effect
    client.exists.return_value = True
    client.get.return_value = {"_source": {"name": "SpaceX", "aliases": []}}

    uid, was_created = resolve_entity(
        "스페이스X", "ko", space_id="ks-1",
        co_mention_en="SpaceX", es_client=client,
    )
    assert uid == "uid-spacex"
    assert was_created is False
    # The Korean surface should have been appended to the existing
    # SpaceX entity's aliases via an ES update.
    assert client.update.called
    update_kwargs = client.update.call_args.kwargs
    assert update_kwargs["id"] == "uid-spacex"
    assert "스페이스X" in update_kwargs["doc"]["aliases"]


def test_cross_language_without_co_mention_creates_separate_entities() -> None:
    """No co_mention hint -> stay separate. PO is okay with this; the
    honest answer is "we do not know if these are the same entity."""
    client = MagicMock()
    client.search.return_value = _no_hit()
    uid1, created1 = resolve_entity(
        "SpaceX", "en", space_id="ks-1", es_client=client,
    )
    uid2, created2 = resolve_entity(
        "스페이스X", "ko", space_id="ks-1", es_client=client,
    )
    assert created1 is True
    assert created2 is True
    assert uid1 != uid2


# --- B-62 natural-spo-display: pick_natural_primary -----------------------


def test_pick_natural_primary_uses_llm_name_when_present_english() -> None:
    """SpaceX captured with the same llm_name → primary = SpaceX / en."""
    label, lang = pick_natural_primary(
        llm_name="SpaceX",
        llm_name_en=None,
        surface="SpaceX",
        surface_lang="en",
    )
    assert label == "SpaceX"
    assert lang == "en"


def test_pick_natural_primary_uses_llm_name_when_present_korean() -> None:
    """The LLM name is Korean — we trust it as the natural form. We do
    NOT promote name_en to override a Korean primary."""
    label, lang = pick_natural_primary(
        llm_name="삼성전자",
        llm_name_en="Samsung Electronics",
        surface="삼성전자",
        surface_lang="ko",
    )
    assert label == "삼성전자"
    assert lang == "ko"


def test_pick_natural_primary_falls_back_to_surface_when_llm_name_absent() -> None:
    label, lang = pick_natural_primary(
        llm_name=None,
        llm_name_en=None,
        surface="스페이스X",
        surface_lang="ko",
    )
    assert label == "스페이스X"
    assert lang == "ko"


def test_pick_natural_primary_falls_back_to_surface_when_llm_name_blank() -> None:
    label, lang = pick_natural_primary(
        llm_name="   ",  # whitespace-only -> treat as absent
        llm_name_en="Whatever",
        surface="회사채",
        surface_lang="ko",
    )
    assert label == "회사채"
    assert lang == "ko"


# --- B-62 natural-spo-display: resolve_entity create-path uses LLM name ---


def test_korean_capture_without_llm_name_creates_korean_primary() -> None:
    """`회사채` Korean capture, no llm_name -> primary_label = `회사채`,
    primary_lang = `ko`."""
    client = MagicMock()
    client.search.return_value = _no_hit()
    uid, was_created = resolve_entity(
        "회사채", "ko", space_id="ks-1", es_client=client,
    )
    assert was_created is True
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "회사채"
    assert body["primary_lang"] == "ko"


def test_english_capture_without_llm_name_creates_english_primary() -> None:
    """`SpaceX` English capture -> primary_label = `SpaceX`,
    primary_lang = `en`."""
    client = MagicMock()
    client.search.return_value = _no_hit()
    uid, was_created = resolve_entity(
        "SpaceX", "en", space_id="ks-1", es_client=client,
    )
    assert was_created is True
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "SpaceX"
    assert body["primary_lang"] == "en"


def test_korean_capture_with_english_llm_name_keeps_english_primary() -> None:
    """`스페이스X` Korean capture WITH llm_name='SpaceX' -> primary
    becomes the LLM-provided 'SpaceX' / 'en'; the Korean surface lands
    in aliases tagged 'ko'."""
    client = MagicMock()
    client.search.return_value = _no_hit()
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
    # The Korean capture surface MUST be preserved as an alias.
    assert "스페이스X" in body["aliases"]


def test_resolve_entity_aliases_preserve_every_input_surface() -> None:
    """All non-empty unique surfaces (other than the chosen primary)
    must land in aliases regardless of language."""
    client = MagicMock()
    client.search.return_value = _no_hit()
    uid, _ = resolve_entity(
        "스페이스X", "ko",
        space_id="ks-1",
        llm_name="SpaceX",
        co_mention_en="SpaceX Inc.",
        es_client=client,
    )
    body = client.index.call_args.kwargs["document"]
    # primary = SpaceX. Aliases should include the Korean surface and
    # the co_mention_en value (SpaceX Inc.).
    assert body["primary_label"] == "SpaceX"
    aliases_lc = [a.lower() for a in body["aliases"]]
    assert "스페이스x" in aliases_lc
    assert "spacex inc." in aliases_lc
    # The chosen primary is NOT included as an alias.
    assert "spacex" not in aliases_lc


def test_resolve_entity_llm_name_only_no_redundant_alias() -> None:
    """When llm_name == surface, no duplicate alias is created."""
    client = MagicMock()
    client.search.return_value = _no_hit()
    uid, _ = resolve_entity(
        "SpaceX", "en",
        space_id="ks-1",
        llm_name="SpaceX",
        es_client=client,
    )
    body = client.index.call_args.kwargs["document"]
    assert body["primary_label"] == "SpaceX"
    assert body["aliases"] == []



# --- B-62-fix subject-natlang (PO 2026-06-22) --------------------------------
# Defense in depth: when Claude translates a Korean common noun / firm name
# to English (e.g. 회사채 -> "corporate bonds", 우리자산운용 -> "Woori Asset
# Management"), pick_natural_primary must keep the Korean surface as primary.
# Brand-shaped English (SpaceX, OpenAI, KAIST) still wins.


def test_looks_like_brand_single_token_latin_accepted() -> None:
    assert _looks_like_brand("SpaceX") is True
    assert _looks_like_brand("OpenAI") is True
    assert _looks_like_brand("IBM") is True
    assert _looks_like_brand("KAIST") is True
    assert _looks_like_brand("Toyota") is True
    assert _looks_like_brand("iPhone") is True


def test_looks_like_brand_multiword_rejected() -> None:
    # Descriptive English translations have whitespace -> not a brand.
    assert _looks_like_brand("Woori Asset Management") is False
    assert _looks_like_brand("corporate bonds") is False
    assert _looks_like_brand("Ministry of Defense") is False
    assert _looks_like_brand("Bank of Korea") is False
    assert _looks_like_brand("base interest rate") is False


def test_looks_like_brand_edge_cases() -> None:
    assert _looks_like_brand(None) is False
    assert _looks_like_brand("") is False
    assert _looks_like_brand("   ") is False
    # Single char is too short to be brand-shaped.
    assert _looks_like_brand("A") is False
    # Korean text never matches the Latin shape test.
    assert _looks_like_brand("회사채") is False
    assert _looks_like_brand("스페이스X") is False
    # Over-long single token is rejected as a safety bound.
    assert _looks_like_brand("A" * 17) is False


def test_pick_natural_primary_korean_surface_descriptive_english_llm_name_keeps_korean() -> None:
    """B-62-fix regression case: 회사채 Korean surface + Claude's
    translation 'corporate bonds' -> Korean surface wins."""
    label, lang = pick_natural_primary(
        llm_name="corporate bonds",
        llm_name_en="corporate bonds",
        surface="회사채",
        surface_lang="ko",
    )
    assert label == "회사채"
    assert lang == "ko"


def test_pick_natural_primary_korean_surface_firm_name_translation_keeps_korean() -> None:
    """우리자산운용 + Claude's translation 'Woori Asset Management'
    -> Korean surface wins (multi-word English is not brand-shaped)."""
    label, lang = pick_natural_primary(
        llm_name="Woori Asset Management",
        llm_name_en="Woori Asset Management",
        surface="우리자산운용",
        surface_lang="ko",
    )
    assert label == "우리자산운용"
    assert lang == "ko"


def test_pick_natural_primary_korean_surface_with_brand_english_llm_name_keeps_english() -> None:
    """스페이스X + Claude's brand-canonical 'SpaceX' -> SpaceX wins
    because SpaceX is brand-shaped (single Latin token)."""
    label, lang = pick_natural_primary(
        llm_name="SpaceX",
        llm_name_en="SpaceX",
        surface="스페이스X",
        surface_lang="ko",
    )
    assert label == "SpaceX"
    assert lang == "en"


def test_pick_natural_primary_english_surface_unaffected_by_fix() -> None:
    """Defense applies only when surface is Korean. English surface +
    English llm_name -> English wins (existing behavior preserved)."""
    label, lang = pick_natural_primary(
        llm_name="SpaceX",
        llm_name_en="SpaceX",
        surface="SpaceX",
        surface_lang="en",
    )
    assert label == "SpaceX"
    assert lang == "en"


def test_resolve_entity_korean_surface_english_translation_creates_korean_primary() -> None:
    """End-to-end at resolve_entity level: Korean surface 회사채 + LLM
    name 'corporate bonds' -> created object has Korean primary_label
    and the English translation lands in aliases."""
    client = MagicMock()
    client.search.return_value = _no_hit()
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
    # The English translation MUST be preserved as an alias so the
    # recall path can still cross-lingually match.
    assert "corporate bonds" in body["aliases"]


def test_resolve_entity_korean_surface_firm_name_translation_creates_korean_primary() -> None:
    """우리자산운용 + LLM name 'Woori Asset Management' (multi-word ->
    not brand-shaped) -> Korean primary, English in aliases."""
    client = MagicMock()
    client.search.return_value = _no_hit()
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


def test_prompts_contains_korean_common_noun_rule() -> None:
    """Pin the B-62-fix prompt clause so a future refactor cannot
    silently drop it."""
    from api.structure.prompts import SYSTEM_PROMPT
    assert "B-62-fix subject-natlang" in SYSTEM_PROMPT
    assert "한국어 일반명사" in SYSTEM_PROMPT
    assert "회사채" in SYSTEM_PROMPT
    assert "우리자산운용" in SYSTEM_PROMPT
    # The brand-allowed exception must be documented.
    assert "SpaceX" in SYSTEM_PROMPT


# --- B-62-fix-v2 subject-natlang (PO 2026-06-22) ----------------------------
# Defense in depth:
#   (a) re-promote: when reuse hits a non-brand English primary AND the
#       new surface is Korean, re-promote the Korean surface as primary.
#   (b) surface-as-original-span: strip trailing Korean particles before
#       lookup so "중국 상무부는" matches the canonical "중국 상무부".


def test_korean_particle_strip_strips_common_postpositions() -> None:
    from api.structure.entity_resolver import strip_korean_particles
    assert strip_korean_particles("중국 상무부는") == "중국 상무부"
    assert strip_korean_particles("삼성전자가") == "삼성전자"
    assert strip_korean_particles("한국은행이") == "한국은행"
    assert strip_korean_particles("국방부의") == "국방부"
    assert strip_korean_particles("정부에서") == "정부"


def test_korean_particle_strip_preserves_non_particle_endings() -> None:
    from api.structure.entity_resolver import strip_korean_particles
    # 우리은행 ends in 행 (NOT a particle) — preserved.
    assert strip_korean_particles("우리은행") == "우리은행"
    # English passes through unchanged.
    assert strip_korean_particles("SpaceX") == "SpaceX"
    # Idempotent.
    assert strip_korean_particles(strip_korean_particles("삼성전자가")) == "삼성전자"
    # None / empty preserved.
    assert strip_korean_particles("") == ""
    assert strip_korean_particles(None) is None  # type: ignore[arg-type]


def test_repromote_english_to_korean_on_reuse() -> None:
    """Existing entity has English primary `Ministry of Commerce of China`
    (non-brand, multi-word). A fresh Korean capture supplies surface
    `중국 상무부`. The lookup hits via aliases / name_en, and the resolver
    re-promotes the Korean surface as primary, demoting the English form
    to aliases + audit trail."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-moc",
        "primary_label": "Ministry of Commerce of China",
        "primary_lang": "en",
        "name": "Ministry of Commerce of China",
        "aliases": [],
        "relabel_history": [],
    }
    # Lookup: primary_label miss, name miss, name_en miss, aliases HIT.
    client.search.side_effect = [
        _no_hit(),
        _no_hit(),
        _no_hit(),
        {"hits": {"hits": [{"_source": existing}]}},
    ]
    client.get.return_value = {"_source": existing}

    uid, was_created = resolve_entity(
        "중국 상무부", "ko", space_id="ks-1", es_client=client,
    )
    assert was_created is False
    assert uid == "uid-moc"
    # Re-promote should have called .update() with the new Korean primary.
    assert client.update.called
    upd = client.update.call_args.kwargs
    assert upd["id"] == "uid-moc"
    doc = upd["doc"]
    assert doc["primary_label"] == "중국 상무부"
    assert doc["primary_lang"] == "ko"
    # The previous English primary lands in aliases.
    assert "Ministry of Commerce of China" in doc["aliases"]
    # Audit trail extended.
    assert any(
        h["from_primary"] == "Ministry of Commerce of China"
        and h["to_primary"] == "중국 상무부"
        for h in doc["relabel_history"]
    )


def test_no_repromote_brand_entity() -> None:
    """SpaceX (brand-shaped) MUST NOT be displaced even when a Korean
    capture `스페이스X` lands on it. Brand canonical wins."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-spacex",
        "primary_label": "SpaceX",
        "primary_lang": "en",
        "name": "SpaceX",
        "aliases": [],
    }
    client.search.side_effect = [
        {"hits": {"hits": [{"_source": existing}]}},
    ]
    client.get.return_value = {"_source": existing}

    uid, was_created = resolve_entity(
        "스페이스X", "ko", space_id="ks-1", es_client=client,
    )
    assert uid == "uid-spacex"
    assert was_created is False
    # No re-promote: SpaceX is brand-shaped.
    assert not client.update.called


def test_no_repromote_same_primary() -> None:
    """Surface equals existing primary -> no-op, no update."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-toyota",
        "primary_label": "Toyota",
        "primary_lang": "en",
        "name": "Toyota",
        "aliases": [],
    }
    client.search.side_effect = [
        {"hits": {"hits": [{"_source": existing}]}},
    ]
    client.get.return_value = {"_source": existing}

    uid, _ = resolve_entity(
        "Toyota", "en", space_id="ks-1", es_client=client,
    )
    assert uid == "uid-toyota"
    assert not client.update.called


def test_no_repromote_existing_korean_primary() -> None:
    """Existing primary is already Korean. No re-promote needed."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-kdef",
        "primary_label": "국방부",
        "primary_lang": "ko",
        "name": "국방부",
        "aliases": ["국방부"],
    }
    client.search.side_effect = [
        {"hits": {"hits": [{"_source": existing}]}},
    ]
    client.get.return_value = {"_source": existing}

    uid, _ = resolve_entity(
        "국방부", "ko", space_id="ks-1", es_client=client,
    )
    assert uid == "uid-kdef"
    assert not client.update.called


def test_repromote_strips_particle_before_lookup() -> None:
    """Surface `중국 상무부는` (with particle) must strip to `중국 상무부`
    BEFORE the ES lookup runs, so the lookup hits the canonical entity."""
    client = MagicMock()
    existing = {
        "object_uid": "uid-moc",
        "primary_label": "Ministry of Commerce of China",
        "primary_lang": "en",
        "name": "Ministry of Commerce of China",
        "aliases": ["중국 상무부"],
        "relabel_history": [],
    }
    seen_values: list[str] = []

    def _search(*, index, query, size):
        filt = query["bool"]["filter"]
        _field, value = next(iter(filt[1]["term"].items()))
        seen_values.append(value)
        if value == "중국 상무부":
            return {"hits": {"hits": [{"_source": existing}]}}
        return _no_hit()

    client.search.side_effect = _search
    client.get.return_value = {"_source": existing}

    uid, _ = resolve_entity(
        "중국 상무부는", "ko", space_id="ks-1", es_client=client,
    )
    assert uid == "uid-moc"
    # No query ever used the particle-bearing surface.
    assert "중국 상무부는" not in seen_values


def test_prompts_contains_subject_surface_v2_rule() -> None:
    """Pin the B-62-fix-v2 prompt clause so a future refactor cannot
    silently drop it."""
    from api.structure.prompts import SYSTEM_PROMPT
    assert "B-62-fix-v2 subject surface" in SYSTEM_PROMPT
    assert "subject_surface" in SYSTEM_PROMPT
    assert "원문 텍스트에 실제로 등장한 표현" in SYSTEM_PROMPT
    assert "중국 상무부" in SYSTEM_PROMPT
    # object_surface for entity refs too
    assert "object_surface" in SYSTEM_PROMPT
