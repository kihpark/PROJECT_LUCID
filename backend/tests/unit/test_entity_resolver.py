"""B-62 structure-resolve + natural-spo-display - entity_resolver tests."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from api.structure.entity_resolver import pick_natural_primary, resolve_entity


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
