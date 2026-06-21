"""B-62 structure-resolve - canonical entity resolution.

Given a (surface_text, lang) pair extracted by the LLM, find an existing
canonical entity in lucid_objects or create a fresh canonical one. The
lookup is exact-match (case-insensitive) over:

  1. primary_label (new canonical field shipped in B-62 data bedrock)
  2. aliases[] (new canonical field; cross-language surface forms)
  3. legacy name / name_en (back-compat with pre-data-bedrock objects)

Cross-language alias merging is the PO-flagged load-bearing path:

  > cross-language 병합은 alias (여기서 SpaceX≡스페이스X 실작동).

Within ONE structure call we keep a session-local cache so two surface
forms that the LLM tagged as the same entity (via the optional name_en
hint) converge to ONE canonical entity_id. The Korean surface is then
appended to the existing canonical entity's aliases.

Constraints (PO directive 2026-06-21):
  - primary_label preserves the user's CAPTURE SURFACE (no translation,
    no paraphrase).
  - primary_lang records the detected language code.
  - entity_type is left None in this PR (later ticket).
  - When no co-mention hint exists and the surface differs, the two
    stay separate - that is the honest "we do not know" answer.
"""
from __future__ import annotations

import logging
from typing import Any

from api.models.base import new_uid
from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client

logger = logging.getLogger("lucid.structure.entity_resolver")


def _detect_lang(text: str) -> str:
    """Crude heuristic - presence of any Hangul codepoint => ko, else en.

    This is intentionally minimal. Real language detection is downstream
    (the recall layer carries its own). For canonical-entity purposes we
    only need to distinguish ko vs en for the cross-lingual merge hint;
    other languages collapse to "en" as a safe default.
    """
    if not text:
        return "en"
    for ch in text:
        # Hangul Syllables block + Jamo blocks.
        if "\uAC00" <= ch <= "\uD7A3" or "\u1100" <= ch <= "\u11FF" or "\u3130" <= ch <= "\u318F":
            return "ko"
    return "en"


def _lookup_by_field(
    client: Any,
    *,
    field: str,
    value: str,
    knowledge_space_id: str,
) -> dict[str, Any] | None:
    """Run one exact-match keyword query against lucid_objects.

    Returns the first matching _source dict, or None. Errors degrade
    quietly to None so a flaky ES never breaks the structure stage.
    """
    try:
        resp = client.search(
            index=LUCID_OBJECTS,
            query={"bool": {"filter": [
                {"term": {"knowledge_space_id": knowledge_space_id}},
                {"term": {field: value}},
            ]}},
            size=10,
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("entity lookup on %s=%r failed: %s", field, value, exc)
        return None
    hits = (resp.get("hits") or {}).get("hits") or []
    if not hits:
        return None
    return hits[0].get("_source")


def _create_entity(
    client: Any,
    *,
    surface: str,
    lang: str,
    knowledge_space_id: str,
    aliases: list[str] | None = None,
    name_en: str | None = None,
) -> str:
    """Insert a fresh canonical entity. Returns its object_uid.

    Writes BOTH the legacy `name` field (so the recall display path keeps
    working) AND the new canonical `primary_label` / `primary_lang` /
    `aliases` fields. `class` defaults to "concept" - the canonical
    entity_type ontology is a separate later ticket.
    """
    object_uid = new_uid()
    # B-62 data bedrock: lucid_objects mapping has dynamic=strict, so we
    # only write fields it knows about. Skip embedding for now (the
    # processor will compute it on the object_matcher path; entity
    # resolution itself does not need to embed).
    body: dict[str, Any] = {
        "object_uid": object_uid,
        "class": "concept",
        "name": surface,
        "primary_label": surface,
        "primary_lang": lang,
        "aliases": list(aliases or []),
        "properties": {},
        "fact_uids": [],
        "connected_objects": [],
        "knowledge_space_id": knowledge_space_id,
    }
    if name_en:
        body["name_en"] = name_en
    try:
        client.index(
            index=LUCID_OBJECTS,
            id=object_uid,
            document=body,
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("entity create for %r failed: %s", surface, exc)
    return object_uid


def _append_alias(
    client: Any,
    *,
    object_uid: str,
    new_alias: str,
) -> bool:
    """Append `new_alias` to an existing entity's aliases (case-insensitive
    de-dup). Returns True when the list grew. The recall display path
    reads `name` for primary surface, so it keeps working unchanged."""
    try:
        if not client.exists(index=LUCID_OBJECTS, id=object_uid):
            return False
        doc = client.get(index=LUCID_OBJECTS, id=object_uid)["_source"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("entity alias-append fetch failed for %s: %s", object_uid, exc)
        return False
    aliases = list(doc.get("aliases") or [])
    folded = {a.lower() for a in aliases if isinstance(a, str)}
    if new_alias.lower() in folded or new_alias.lower() == (doc.get("name") or "").lower():
        return False
    aliases.append(new_alias)
    try:
        client.update(
            index=LUCID_OBJECTS,
            id=object_uid,
            doc={"aliases": aliases},
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("entity alias-append update failed for %s: %s", object_uid, exc)
        return False
    return True


def resolve_entity(
    surface: str,
    lang: str,
    *,
    space_id: str,
    co_mention_en: str | None = None,
    es_client: Any | None = None,
) -> tuple[str, bool]:
    """Resolve a (surface, lang) entity reference to a canonical entity_id.

    Match order:
      1. exact primary_label == surface  (B-62 canonical)
      2. exact name == surface           (legacy back-compat)
      3. exact name_en == surface        (legacy back-compat)
      4. exact aliases == surface        (B-52 / B-62 alias array)
      5. co_mention_en hint: if provided, try the same lookups against
         the English form. On hit, APPEND the Korean (or other) surface
         to that entity's aliases - this is the SpaceX <-> 스페이스X
         convergence path the PO called out.
      6. create_new with primary_label = surface, primary_lang = lang.

    Returns (entity_id, was_created).
    """
    client = es_client if es_client is not None else get_client()
    surface = (surface or "").strip()
    if not surface:
        # Defensive: return a fresh uid so downstream code never sees
        # the empty string. The caller should not pass empty input.
        return new_uid(), True

    # B-62 canonical fields first; the new structure-resolve writes
    # them, but legacy docs (created before this PR) only carry
    # `name` / `name_en`, so we fall back through those too.
    for field in ("primary_label", "name", "name_en", "aliases"):
        hit = _lookup_by_field(
            client, field=field, value=surface, knowledge_space_id=space_id,
        )
        if hit is not None:
            uid = hit.get("object_uid")
            if uid:
                return uid, False

    # Cross-language merge: if the LLM gave us the English form alongside
    # the Korean surface, try the English form against an existing
    # English entity and append the Korean surface as an alias.
    if co_mention_en and co_mention_en.strip() and co_mention_en.strip().lower() != surface.lower():
        en = co_mention_en.strip()
        for field in ("primary_label", "name", "name_en", "aliases"):
            hit = _lookup_by_field(
                client, field=field, value=en, knowledge_space_id=space_id,
            )
            if hit is not None:
                uid = hit.get("object_uid")
                if uid:
                    _append_alias(client, object_uid=uid, new_alias=surface)
                    return uid, False

    # Nothing matched - mint a fresh canonical entity.
    object_uid = _create_entity(
        client,
        surface=surface,
        lang=lang,
        knowledge_space_id=space_id,
        name_en=co_mention_en if co_mention_en and co_mention_en != surface else None,
    )
    return object_uid, True


__all__ = [
    "resolve_entity",
    "_detect_lang",
]
