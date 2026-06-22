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
    no paraphrase). The LLM-supplied `name` (when present) is treated
    as the canonical *natural* surface — pick_natural_primary prefers
    it without forcing English.
  - primary_lang records the detected language code.
  - entity_type is left None in this PR (later ticket).
  - When no co-mention hint exists and the surface differs, the two
    stay separate - that is the honest "we do not know" answer.

B-62 natural-spo-display additions (2026-06-21):
  - `pick_natural_primary(llm_name, llm_name_en, surface, surface_lang)`
    chooses the primary label without language coercion. When the LLM
    gives `name` we trust it as the natural form. `name_en` becomes an
    alias rather than overriding a Korean primary label.
  - `resolve_entity(...)` accepts an optional `llm_name` kwarg and
    seeds aliases from EVERY non-empty unique input surface that is
    not the primary.
"""
from __future__ import annotations

import logging
import re
from typing import Any

from api.models.base import new_uid
from api.storage.elasticsearch.client import LUCID_OBJECTS, get_client

logger = logging.getLogger("lucid.structure.entity_resolver")

# B-62-fix subject-natlang (PO 2026-06-22): brand-shape heuristic.
# Conservative — single-token Latin (no whitespace), 2-16 chars. Catches
# SpaceX, OpenAI, IBM, KAIST, NASA, Toyota, Apple. Rejects descriptive
# translations like "Woori Asset Management", "corporate bonds", and
# "Ministry of Defense" (all multi-word with spaces).
_BRAND_SHAPE_RE = re.compile(r"^[A-Za-z][A-Za-z0-9]{1,15}$")


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
        if "가" <= ch <= "힣" or "ᄀ" <= ch <= "ᇿ" or "㄰" <= ch <= "㆏":
            return "ko"
    return "en"


def _looks_like_brand(text: str | None) -> bool:
    """B-62-fix: return True when `text` looks like a globally-recognized
    brand-mark (single Latin token, 2-16 chars).

    Conservative by design. Any string with whitespace (e.g. "Woori
    Asset Management", "corporate bonds", "Ministry of Defense") is
    treated as a descriptive translation, NOT a brand, and rejected.
    Single-token Latin strings like SpaceX, OpenAI, IBM, KAIST, Toyota
    are accepted as brand-shaped.

    This is purely a shape test — we do not consult an allowlist. The
    PO directive (2026-06-22) is to defend Korean primary labels when
    the LLM translates a common noun, NOT to gate brand recognition.
    """
    if not text:
        return False
    s = str(text).strip()
    if not s:
        return False
    return bool(_BRAND_SHAPE_RE.match(s))


def pick_natural_primary(
    llm_name: str | None,
    llm_name_en: str | None,
    surface: str,
    surface_lang: str,
) -> tuple[str, str]:
    """Pick the (primary_label, primary_lang) for a new canonical entity.

    Precedence (B-62 natural-spo-display + B-62-fix subject-natlang):
      1. If `llm_name` is non-empty AND its detected language differs
         from the surface's detected language AND the surface is Korean
         AND `llm_name` is NOT brand-shaped (single-token Latin <=16
         chars), we DEFEND the Korean surface as primary. This prevents
         Claude's translation of Korean common nouns / firm names
         (회사채 -> "corporate bonds", 우리자산운용 -> "Woori Asset
         Management", 국방부 -> "Ministry of Defense") from silently
         becoming the canonical primary label. The English llm_name
         still lands in aliases via `_build_alias_seed`.
      2. Else if `llm_name` is non-empty: trust it as the natural form
         and re-detect its language — Korean stays Korean, English
         stays English. Brand-shaped English (SpaceX, OpenAI, KAIST)
         falls through to here even on a Korean capture surface.
      3. Else: the capture surface and its declared lang.

    `llm_name_en` is intentionally consulted ONLY as alias material in
    `resolve_entity`'s create path. Promoting it to primary_label would
    silently translate the user's Korean capture into English — the
    exact regression PO called out.
    """
    candidate = (llm_name or "").strip()
    if candidate:
        cand_lang = _detect_lang(candidate)
        # Re-detect from the surface itself; the passed-in `surface_lang`
        # may be a job-level lang code that doesn't match the actual
        # surface (the bug surfaced when surface_lang='ko' but the
        # caller's mental model conflated job vs surface).
        surface_lang_detected = _detect_lang(surface or "")
        if (
            cand_lang != surface_lang_detected
            and surface_lang_detected == "ko"
            and not _looks_like_brand(candidate)
        ):
            # B-62-fix: defend the Korean surface — Claude translated a
            # common noun / firm name to English. Keep Korean as primary.
            return surface, "ko"
        return candidate, cand_lang
    return surface, surface_lang


def _build_alias_seed(
    primary: str,
    surface: str,
    llm_name: str | None,
    llm_name_en: str | None,
) -> list[str]:
    """Collect every non-empty unique surface in {surface, llm_name,
    llm_name_en} that is NOT the chosen primary. Case-insensitive
    de-dup. Order preserved roughly as: surface, llm_name, llm_name_en."""
    primary_lc = primary.strip().lower()
    seen: set[str] = {primary_lc}
    out: list[str] = []
    for candidate in (surface, llm_name, llm_name_en):
        if not candidate:
            continue
        c = str(candidate).strip()
        if not c:
            continue
        if c.lower() in seen:
            continue
        seen.add(c.lower())
        out.append(c)
    return out


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
    primary_label: str | None = None,
    primary_lang: str | None = None,
) -> str:
    """Insert a fresh canonical entity. Returns its object_uid.

    Writes BOTH the legacy `name` field (so the recall display path keeps
    working) AND the new canonical `primary_label` / `primary_lang` /
    `aliases` fields. `class` defaults to "concept" - the canonical
    entity_type ontology is a separate later ticket.

    B-62 natural-spo-display: when `primary_label` is supplied the
    canonical surface picks up that value (the LLM's natural name);
    otherwise we fall back to the legacy "primary = surface" path so
    existing call sites still get the right shape.
    """
    object_uid = new_uid()
    chosen_primary = primary_label or surface
    chosen_lang = primary_lang or lang
    # B-62 data bedrock: lucid_objects mapping has dynamic=strict, so we
    # only write fields it knows about. Skip embedding for now (the
    # processor will compute it on the object_matcher path; entity
    # resolution itself does not need to embed).
    body: dict[str, Any] = {
        "object_uid": object_uid,
        "class": "concept",
        # `name` carries the canonical natural surface so the recall
        # display path keeps working unchanged.
        "name": chosen_primary,
        "primary_label": chosen_primary,
        "primary_lang": chosen_lang,
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
    llm_name: str | None = None,
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
      6. create_new with primary_label picked via pick_natural_primary.

    B-62 natural-spo-display:
      - `llm_name` carries the LLM-emitted natural surface for the
        entity. When present, the CREATE path uses
        pick_natural_primary(llm_name, co_mention_en, surface,
        surface_lang) for primary_label and primary_lang. The chosen
        primary is excluded from aliases; every other non-empty input
        surface is preserved as an alias.
      - The LOOKUP path is unchanged so existing exact/alias matches
        keep landing on the same object.

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

    # Nothing matched - mint a fresh canonical entity using the
    # natural-primary picker so a Korean capture stays Korean.
    primary_label, primary_lang = pick_natural_primary(
        llm_name, co_mention_en, surface, lang,
    )
    aliases = _build_alias_seed(
        primary_label, surface, llm_name, co_mention_en,
    )
    object_uid = _create_entity(
        client,
        surface=surface,
        lang=lang,
        knowledge_space_id=space_id,
        aliases=aliases,
        name_en=co_mention_en if co_mention_en and co_mention_en != primary_label else None,
        primary_label=primary_label,
        primary_lang=primary_lang,
    )
    return object_uid, True


__all__ = [
    "resolve_entity",
    "pick_natural_primary",
    "_detect_lang",
]
