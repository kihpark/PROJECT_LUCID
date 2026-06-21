"""B-62 structure-resolve - entity_resolver unit tests."""
from __future__ import annotations

from unittest.mock import MagicMock

import pytest

from api.structure.entity_resolver import resolve_entity


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
