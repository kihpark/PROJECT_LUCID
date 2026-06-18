"""B-52 regression tests: Korean ↔ English cross-language entity match.

Acceptance criterion (★ in the brief):
  "국방부" 검색 → Ministry of Defense 사실 반환.

Locked by:
- test_object_model_accepts_aliases — Pydantic surface supports
  the new field.
- test_structure_object_accepts_aliases — decomposer-stage surface
  carries aliases through to the structure metadata.
- test_resolve_entities_term_match_on_alias — exact-keyword path
  (`name.keyword`/`name_en.keyword`/`aliases.keyword`) hits an
  alias when the canonical `name` is in another language.
- test_resolve_entities_multi_match_fallback — analyzed match across
  the three fields catches morpheme/tokenizer splits the keyword
  path misses.
- test_resolve_entities_canonical_sort_preserved — alias hits still
  land canonical-first so B-49b's brief representative stays right.
"""
from __future__ import annotations

from typing import Any
from unittest.mock import MagicMock, patch
from uuid import uuid4


def test_object_model_accepts_aliases():
    """The persisted Object node carries the surface-form list."""
    from api.models.objects import Object, ObjectClass
    o = Object(
        object_uid=str(uuid4()),
        **{"class": ObjectClass.ORGANIZATION},  # type: ignore[arg-type]
        name="Ministry of Defense",
        name_en="Ministry of Defense",
        aliases=["국방부", "MOD"],
        knowledge_space_id="ks-1",
    )
    assert o.aliases == ["국방부", "MOD"]
    # by_alias dump produces the wire shape ES consumes.
    dumped = o.model_dump(by_alias=True, mode="json")
    assert dumped["aliases"] == ["국방부", "MOD"]


def test_structure_object_accepts_aliases():
    """The decomposer-stage struct carries aliases too — without it
    the field would be silently dropped before reaching ES."""
    from api.structure.models import StructureObject
    so = StructureObject(
        uid="obj-1",
        **{"class": "organization"},  # type: ignore[arg-type]
        name="Ministry of Defense",
        name_en="Ministry of Defense",
        aliases=["국방부"],
    )
    assert so.aliases == ["국방부"]
    dumped = so.model_dump(by_alias=True, mode="json")
    assert dumped["aliases"] == ["국방부"]


def _fake_hits(*docs: dict[str, Any]) -> dict[str, Any]:
    return {"hits": {"hits": [{"_source": d} for d in docs]}}


def test_resolve_entities_term_match_on_alias():
    """★ Korean query hits a canonical Object via its alias even when
    the Object's `name` is English."""
    from api.routes.recall import _resolve_entities_by_name

    canonical_uid = "59ca596c-c1eb-4983-a36a-87b35adce76b"
    canonical = {
        "object_uid": canonical_uid,
        "name": "Ministry of Defense",
        "name_en": "Ministry of Defense",
        "aliases": ["국방부"],
        "class": "organization",
        "knowledge_space_id": "ks-1",
    }

    captured: list[dict[str, Any]] = []

    class _FakeClient:
        def search(self, **kw):
            body = kw.get("body") or {}
            captured.append(body)
            return _fake_hits(canonical)

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        matches = _resolve_entities_by_name("국방부", "ks-1")

    assert len(matches) == 1
    assert matches[0]["object_uid"] == canonical_uid

    # Tier-1 query included aliases.keyword in the `should` clause —
    # confirms the new field is in the search target set.
    first_query = captured[0]["query"]["bool"]["should"]
    target_fields = {next(iter(c["term"].keys())) for c in first_query}
    assert "aliases.keyword" in target_fields
    assert "name.keyword" in target_fields
    assert "name_en.keyword" in target_fields


def test_resolve_entities_multi_match_fallback():
    """When the exact-keyword tier returns nothing, an analyzed
    multi_match across {name, name_en, aliases} runs as Tier 2 — this
    is what catches nori-tokenized splits the keyword filter misses."""
    from api.routes.recall import _resolve_entities_by_name

    canonical = {
        "object_uid": "59ca596c-c1eb-4983-a36a-87b35adce76b",
        "name": "Ministry of Defense",
        "name_en": "Ministry of Defense",
        "aliases": ["국방부"],
        "class": "organization",
        "knowledge_space_id": "ks-1",
    }
    calls: list[dict[str, Any]] = []

    class _FakeClient:
        def search(self, **kw):
            body = kw.get("body") or {}
            calls.append(body)
            # Tier 1 returns empty; Tier 2 returns the canonical.
            if len(calls) == 1:
                return _fake_hits()
            return _fake_hits(canonical)

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        matches = _resolve_entities_by_name("국방", "ks-1")

    assert len(matches) == 1
    # Tier 2 used multi_match with the three target fields.
    tier2 = calls[1]["query"]["bool"]["should"]
    mm = next(c for c in tier2 if "multi_match" in c)
    assert set(mm["multi_match"]["fields"]) == {"name", "name_en", "aliases"}


def test_resolve_entities_canonical_sort_preserved():
    """B-49b contract: when two Object docs share a name (one
    placeholder, one canonical UUID4), the canonical lands first.
    The new alias field must not disturb that ordering."""
    from api.routes.recall import _resolve_entities_by_name

    placeholder = {
        "object_uid": "obj-1",
        "name": "Ministry of Defense",
        "name_en": "Ministry of Defense",
        "aliases": ["국방부"],
        "knowledge_space_id": "ks-1",
    }
    canonical = {
        "object_uid": "59ca596c-c1eb-4983-a36a-87b35adce76b",
        "name": "Ministry of Defense",
        "name_en": "Ministry of Defense",
        "aliases": ["국방부"],
        "knowledge_space_id": "ks-1",
    }

    class _FakeClient:
        def search(self, **kw):
            # ES returns placeholder first — sort must promote canonical.
            return _fake_hits(placeholder, canonical)

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        out = _resolve_entities_by_name("국방부", "ks-1")

    assert out[0]["object_uid"] == "59ca596c-c1eb-4983-a36a-87b35adce76b"
    assert out[1]["object_uid"] == "obj-1"


def test_resolve_entities_returns_empty_on_no_match():
    """All three tiers return nothing → empty list (no crash)."""
    from api.routes.recall import _resolve_entities_by_name

    class _FakeClient:
        def search(self, **kw):
            return _fake_hits()

    with patch("api.routes.recall.get_client", return_value=_FakeClient()):
        out = _resolve_entities_by_name("도시에는없는엔티티", "ks-1")
    assert out == []


def test_resolve_entities_handles_empty_query():
    from api.routes.recall import _resolve_entities_by_name
    assert _resolve_entities_by_name("", "ks-1") == []
    assert _resolve_entities_by_name("   ", "ks-1") == []
