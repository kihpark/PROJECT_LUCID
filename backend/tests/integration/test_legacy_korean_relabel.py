"""B-62-fix legacy-korean-relabel — end-to-end ES integration.

Drives the script against a real (test-prefixed) lucid_objects index.
Each test seeds a single doc, runs the script via its public API
(`find_candidates` + `relabel`), and asserts on the post-write doc
shape. Idempotence is exercised by running `find_candidates` twice on
the same doc set and confirming the second run returns nothing.
"""
from __future__ import annotations

import uuid

import pytest

pytestmark = pytest.mark.integration


def _seed(es_client, doc: dict) -> str:
    """Insert one doc into the (test-prefixed) lucid_objects index and
    return its _id."""
    from api.storage.elasticsearch.client import LUCID_OBJECTS
    uid = doc["object_uid"]
    es_client.index(
        index=LUCID_OBJECTS,
        id=uid,
        document=doc,
        refresh="wait_for",
    )
    return uid


def _delete(es_client, uid: str) -> None:
    from api.storage.elasticsearch.client import LUCID_OBJECTS
    try:
        es_client.delete(index=LUCID_OBJECTS, id=uid, refresh="wait_for")
    except Exception:
        pass


def _filter(items: list[dict], uid: str) -> list[dict]:
    return [i for i in items if i["id"] == uid]


def test_english_multiword_with_korean_alias_gets_relabeled(
    es_client, es_indexes,
) -> None:
    """The shape PR-B's regression produced: English multi-word primary
    with the Korean form sitting in aliases. After relabel:
      - primary_label == Korean form
      - primary_lang == 'ko'
      - aliases includes the prior English primary (cross-language
        recall must still find the doc by its old surface).
    """
    from scripts.relabel_legacy_korean_entities import (
        ensure_relabel_history_mapping,
        find_candidates,
        relabel,
    )

    ensure_relabel_history_mapping(es_client)

    uid = f"obj-relabel-{uuid.uuid4().hex[:8]}"
    doc = {
        "object_uid": uid,
        "class": "concept",
        "name": "Woori Asset Management",
        "primary_label": "Woori Asset Management",
        "primary_lang": "en",
        "aliases": ["우리자산운용"],
        "properties": {},
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": "ks-relabel-positive",
    }
    _seed(es_client, doc)
    try:
        cands = _filter(find_candidates(es_client), uid)
        assert len(cands) == 1
        relabel(es_client, cands[0])

        from api.storage.elasticsearch.client import LUCID_OBJECTS
        es_client.indices.refresh(index=LUCID_OBJECTS)
        post = es_client.get(index=LUCID_OBJECTS, id=uid)["_source"]
        assert post["primary_label"] == "우리자산운용"
        assert post["primary_lang"] == "ko"
        assert "Woori Asset Management" in post["aliases"]
        # Korean form removed from aliases since it is now the primary.
        assert "우리자산운용" not in post["aliases"]
        # Audit trail recorded.
        history = post.get("relabel_history") or []
        assert len(history) == 1
        assert history[0]["from_primary"] == "Woori Asset Management"
        assert history[0]["to_primary"] == "우리자산운용"
    finally:
        _delete(es_client, uid)


def test_brand_shape_primary_is_not_relabeled(es_client, es_indexes) -> None:
    """SpaceX 스페이스X must NOT be relabeled even when 스페이스X sits
    in aliases. The brand-shape heuristic owns this call so the global
    brand mark stays English."""
    from scripts.relabel_legacy_korean_entities import find_candidates

    uid = f"obj-brand-{uuid.uuid4().hex[:8]}"
    doc = {
        "object_uid": uid,
        "class": "concept",
        "name": "SpaceX",
        "primary_label": "SpaceX",
        "primary_lang": "en",
        "aliases": ["스페이스X"],
        "properties": {},
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": "ks-relabel-brand",
    }
    _seed(es_client, doc)
    try:
        cands = _filter(find_candidates(es_client), uid)
        assert cands == []
    finally:
        _delete(es_client, uid)


def test_english_primary_without_korean_alias_skipped(
    es_client, es_indexes,
) -> None:
    """No Korean alias and no Korean `name` field — nothing to promote.
    The doc must not appear in the candidate list."""
    from scripts.relabel_legacy_korean_entities import find_candidates

    uid = f"obj-no-ko-{uuid.uuid4().hex[:8]}"
    doc = {
        "object_uid": uid,
        "class": "concept",
        "name": "initial funding raised",
        "primary_label": "initial funding raised",
        "primary_lang": "en",
        "aliases": [],
        "properties": {},
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": "ks-relabel-no-ko",
    }
    _seed(es_client, doc)
    try:
        cands = _filter(find_candidates(es_client), uid)
        assert cands == []
    finally:
        _delete(es_client, uid)


def test_already_korean_primary_is_idempotent(es_client, es_indexes) -> None:
    """A doc with Korean primary must be skipped — running the script
    a second time after an --apply pass must be a no-op for it."""
    from scripts.relabel_legacy_korean_entities import find_candidates

    uid = f"obj-already-ko-{uuid.uuid4().hex[:8]}"
    doc = {
        "object_uid": uid,
        "class": "concept",
        "name": "회사채",
        "primary_label": "회사채",
        "primary_lang": "ko",
        "aliases": ["corporate bonds"],
        "properties": {},
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": "ks-relabel-idempotent",
    }
    _seed(es_client, doc)
    try:
        cands = _filter(find_candidates(es_client), uid)
        assert cands == []
    finally:
        _delete(es_client, uid)


def test_aliases_correctly_updated_on_relabel(es_client, es_indexes) -> None:
    """After relabel, aliases must:
      - drop the alias that became the primary,
      - retain any other pre-existing aliases (case-insensitive de-dup),
      - gain the prior English primary on the end.
    """
    from scripts.relabel_legacy_korean_entities import (
        ensure_relabel_history_mapping,
        find_candidates,
        relabel,
    )

    ensure_relabel_history_mapping(es_client)

    uid = f"obj-aliases-{uuid.uuid4().hex[:8]}"
    doc = {
        "object_uid": uid,
        "class": "concept",
        "name": "Ministry of Defense",
        "primary_label": "Ministry of Defense",
        "primary_lang": "en",
        # `MoD` is a pre-existing English short form we must preserve;
        # `국방부` is the Korean form that will become the new primary.
        "aliases": ["국방부", "MoD"],
        "properties": {},
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": "ks-relabel-aliases",
    }
    _seed(es_client, doc)
    try:
        cands = _filter(find_candidates(es_client), uid)
        assert len(cands) == 1
        relabel(es_client, cands[0])

        from api.storage.elasticsearch.client import LUCID_OBJECTS
        es_client.indices.refresh(index=LUCID_OBJECTS)
        post = es_client.get(index=LUCID_OBJECTS, id=uid)["_source"]

        assert post["primary_label"] == "국방부"
        assert "MoD" in post["aliases"]
        assert "Ministry of Defense" in post["aliases"]
        assert "국방부" not in post["aliases"]

        # Second pass — must be idempotent.
        cands2 = _filter(find_candidates(es_client), uid)
        assert cands2 == []
    finally:
        _delete(es_client, uid)
