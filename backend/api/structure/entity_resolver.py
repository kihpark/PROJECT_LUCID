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

# B-62-fix-v2 (PO 2026-06-22): strip trailing Korean particles so the
# surface used for entity lookup matches the canonical entity form.
# "중국 상무부는" -> "중국 상무부", "삼성전자가" -> "삼성전자".
# Anchored to END of string only — never strips mid-word, so 우리은행
# stays 우리은행 (the trailing 행 is not a particle and 은행 is not in
# the list). The PO directive is conservative — only the common 1-2
# character postpositions are recognised.
_KOREAN_PARTICLES_RE = re.compile(
    r"(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만|까지|부터|에게|한테)$"
)


def strip_korean_particles(text: str) -> str:
    """Return `text` with at most one trailing Korean particle removed.

    Empty / None / non-Korean inputs pass through unchanged. Only matches
    when the trailing character(s) are a known postposition; whitespace
    is trimmed after stripping. Idempotent — calling twice on the same
    input is the same as once (the particles only match once at the
    very end).
    """
    if not text:
        return text
    return _KOREAN_PARTICLES_RE.sub("", text).strip()




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
    # B-62-debug (PO 2026-06-22): point 4a instrumentation. Persisted
    # canonical entity — the final source of truth for what the recall
    # display will surface as primary_label.
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "B-62-debug PERSISTED_CREATE object_uid=%s primary_label=%r "
            "primary_lang=%r aliases=%s name_en=%r",
            object_uid, chosen_primary, chosen_lang,
            list(aliases or []), name_en,
        )
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


def _repromote_primary_to_surface(
    *,
    client,
    object_uid: str,
    existing_doc: dict,
    new_primary: str,
    new_primary_lang: str,
) -> None:
    """B-62-fix-v2 (PO 2026-06-22): swap an existing English primary for
    the Korean capture surface.

    Pre-conditions are checked by `resolve_entity`:
      - The existing doc's primary is English and NOT brand-shaped.
      - The supplied surface is Korean and non-empty.
      - They are different.

    Side effects on the ES doc:
      - primary_label <- new_primary
      - primary_lang  <- new_primary_lang
      - aliases       <- existing aliases + previous primary (de-duped,
                         case-insensitive). The new primary is removed
                         from aliases if it was there.
      - relabel_history += one audit entry (field shipped in b668bd7).
      - The legacy `name` field is also rewritten so the recall display
        path (which reads `name`) reflects the re-promote.
    """
    prev_primary = (existing_doc.get("primary_label")
                    or existing_doc.get("name") or "").strip()
    prev_primary_lang = (existing_doc.get("primary_lang")
                         or _detect_lang(prev_primary))

    aliases_in = list(existing_doc.get("aliases") or [])
    # Aliases may be either strings (the typical shape) or {label: ...}
    # dicts for cross-language alias metadata; we normalise to strings
    # for the dedup pass.
    normalised: list[str] = []
    seen_lc: set[str] = set()
    for a in aliases_in:
        if isinstance(a, dict):
            label = (a.get("label") or "").strip()
        else:
            label = str(a).strip()
        if not label:
            continue
        if label.lower() == new_primary.strip().lower():
            continue  # the new primary should not also be an alias
        if label.lower() in seen_lc:
            continue
        seen_lc.add(label.lower())
        normalised.append(label)
    if (
        prev_primary
        and prev_primary.lower() not in seen_lc
        and prev_primary.lower() != new_primary.strip().lower()
    ):
        normalised.append(prev_primary)

    relabel_history = list(existing_doc.get("relabel_history") or [])
    relabel_history.append({
        "from_primary": prev_primary,
        "from_primary_lang": prev_primary_lang,
        "to_primary": new_primary,
        "to_primary_lang": new_primary_lang,
        "reason": "B-62-fix-v2 runtime re-promote on Korean surface reuse",
    })

    # B-62-debug (PO 2026-06-22): point 4b instrumentation. Persisted
    # re-promote — the canonical entity's primary_label has been
    # swapped from English to Korean.
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "B-62-debug PERSISTED_REPROMOTE object_uid=%s new_primary=%r "
            "new_primary_lang=%s prev_primary=%r aliases=%s",
            object_uid, new_primary, new_primary_lang, prev_primary,
            normalised,
        )
    try:
        client.update(
            index=LUCID_OBJECTS,
            id=object_uid,
            doc={
                "primary_label": new_primary,
                "primary_lang": new_primary_lang,
                "name": new_primary,
                "aliases": normalised,
                "relabel_history": relabel_history,
            },
            refresh="wait_for",
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "entity re-promote update failed for %s: %s", object_uid, exc,
        )


def _maybe_repromote_on_hit(
    *,
    client,
    object_uid: str,
    surface: str,
) -> None:
    """B-62-fix-v2 wrapper around `_repromote_primary_to_surface` that
    fetches the existing doc, applies the guards, and re-promotes when
    appropriate. Called from `resolve_entity`'s lookup-hit branches.

    Guards:
      - The existing doc must exist and be readable.
      - existing primary must be detected English.
      - existing primary must NOT be brand-shaped (Toyota / SpaceX stay).
      - Supplied surface must be detected Korean.
      - Supplied surface must differ from existing primary (cheap no-op).
    """
    # B-62-debug (PO 2026-06-22): point 3d instrumentation. Log entry +
    # which guard short-circuited (if any). Helps disambiguate "Mode B
    # re-promote silently skipped" cases from "primary already Korean".
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "B-62-debug REPROMOTE_ENTER object_uid=%s surface=%r",
            object_uid, surface,
        )
    surface_stripped = (surface or "").strip()
    if not surface_stripped:
        logger.debug("B-62-debug REPROMOTE_SKIP reason=empty_surface")
        return
    if _detect_lang(surface_stripped) != "ko":
        logger.debug(
            "B-62-debug REPROMOTE_SKIP reason=surface_not_ko surface=%r",
            surface_stripped,
        )
        return
    try:
        doc = client.get(index=LUCID_OBJECTS, id=object_uid)["_source"]
    except Exception as exc:  # noqa: BLE001
        logger.warning("entity re-promote fetch failed for %s: %s", object_uid, exc)
        return
    existing_primary = (doc.get("primary_label") or doc.get("name") or "").strip()
    if not existing_primary:
        logger.debug("B-62-debug REPROMOTE_SKIP reason=no_existing_primary")
        return
    if existing_primary == surface_stripped:
        logger.debug(
            "B-62-debug REPROMOTE_SKIP reason=primary_already_matches surface=%r",
            surface_stripped,
        )
        return
    existing_lang = (doc.get("primary_lang") or _detect_lang(existing_primary))
    if existing_lang != "en":
        logger.debug(
            "B-62-debug REPROMOTE_SKIP reason=existing_primary_not_en "
            "existing_primary=%r existing_lang=%s",
            existing_primary, existing_lang,
        )
        return
    if _looks_like_brand(existing_primary):
        logger.debug(
            "B-62-debug REPROMOTE_SKIP reason=existing_primary_brand_shape "
            "existing_primary=%r",
            existing_primary,
        )
        return
    if _looks_like_brand(surface_stripped):
        # Defensive: a brand-shaped surface should never displace an
        # existing primary, even when language detection misfires.
        logger.debug(
            "B-62-debug REPROMOTE_SKIP reason=surface_brand_shape surface=%r",
            surface_stripped,
        )
        return
    _repromote_primary_to_surface(
        client=client,
        object_uid=object_uid,
        existing_doc=doc,
        new_primary=surface_stripped,
        new_primary_lang="ko",
    )


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
    # B-62-fix-v2 (PO 2026-06-22): strip trailing Korean particles so the
    # surface used for lookup matches the canonical entity form.
    # "중국 상무부는" -> "중국 상무부", "삼성전자가" -> "삼성전자".
    surface = strip_korean_particles(surface)
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
                # B-62-debug (PO 2026-06-22): point 3a instrumentation.
                # Direct primary lookup hit — captures which field
                # matched, the existing canonical primary, and whether
                # the surface looks brand-shaped (affects re-promote
                # eligibility downstream).
                if logger.isEnabledFor(logging.DEBUG):
                    logger.debug(
                        "B-62-debug RESOLVE branch=primary_lookup_hit field=%s "
                        "surface=%r existing_uid=%s existing_primary=%r "
                        "looks_like_brand_surface=%s",
                        field, surface, uid,
                        hit.get("primary_label") or hit.get("name"),
                        _looks_like_brand(surface),
                    )
                # B-62-fix-v2: defense (a). If the matched entity's
                # primary is English (non-brand) and our surface is
                # Korean, re-promote the Korean surface so the recall
                # display picks up the source-language form. No-op
                # when guards reject (brand, language match, equality).
                _maybe_repromote_on_hit(
                    client=client, object_uid=uid, surface=surface,
                )
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
                    # B-62-debug (PO 2026-06-22): point 3b instrumentation.
                    # Co-mention English lookup hit — Korean surface will
                    # be appended as alias and re-promote may swap primary.
                    if logger.isEnabledFor(logging.DEBUG):
                        logger.debug(
                            "B-62-debug RESOLVE branch=co_mention_hit field=%s "
                            "surface=%r co_mention=%r existing_uid=%s "
                            "existing_primary=%r",
                            field, surface, en, uid,
                            hit.get("primary_label") or hit.get("name"),
                        )
                    _append_alias(client, object_uid=uid, new_alias=surface)
                    # B-62-fix-v2: defense (a). Same re-promote logic on
                    # the co_mention path so the Korean capture surface
                    # becomes primary when the existing doc carries the
                    # English co-mention as primary.
                    _maybe_repromote_on_hit(
                        client=client, object_uid=uid, surface=surface,
                    )
                    return uid, False

    # Nothing matched - mint a fresh canonical entity using the
    # natural-primary picker so a Korean capture stays Korean.
    primary_label, primary_lang = pick_natural_primary(
        llm_name, co_mention_en, surface, lang,
    )
    aliases = _build_alias_seed(
        primary_label, surface, llm_name, co_mention_en,
    )
    # B-62-debug (PO 2026-06-22): point 3c instrumentation. Create-new
    # branch — capture the picked primary, its detected language, and
    # whether the LLM-name was brand-shaped. This is the dominant
    # "Korean → English" transition site when surface arrived as English.
    if logger.isEnabledFor(logging.DEBUG):
        logger.debug(
            "B-62-debug RESOLVE branch=create_new surface=%r llm_name=%r "
            "co_mention_en=%r picked_primary=%r picked_primary_lang=%s "
            "looks_like_brand_llm_name=%s",
            surface, llm_name, co_mention_en, primary_label, primary_lang,
            _looks_like_brand(llm_name) if llm_name else False,
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
    "strip_korean_particles",
    "_detect_lang",
    "_looks_like_brand",
]
