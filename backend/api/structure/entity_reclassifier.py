"""Backfill class/entity_type for legacy entities currently stuck at 'concept'.

After feat/entity-layer-restore, NEW captures classify correctly, but
LEGACY entities (created before the restore) still sit at class='concept'
with entity_type=None. This module retroactively reclassifies them.

Strategy
========
1. Korean-name heuristic for high-confidence person + organization +
   location cases (cheap, deterministic, zero LLM spend).
2. LLM fallback for ambiguous shapes (foreign brand names, multi-word
   phrases that may be genuine concepts).

Idempotent: rerunning produces no-op (non-concept entities skipped at
the backfill site, never overwritten).

Defensive: never overwrites an already-classified entity; never deletes;
falls back to 'other' (no-op) or stays-as-concept on LLM error.

Design choice — batching
------------------------
The PO's first run targets ~41 entities, so a sequential per-entity LLM
call is fine (~0.5s each, ~20s total, ~$0.005 spend). A future
larger backfill would warrant a batched prompt or sliding-window cache;
for now the simplicity wins. The module exposes `backfill_one_entity`
as the unit so a batched orchestrator can swap in later without
rewriting the heuristic/LLM split.
"""
from __future__ import annotations

import logging
import os
import re
import time
from typing import Any

from api.storage.elasticsearch.client import LUCID_OBJECTS

logger = logging.getLogger("lucid.structure.entity_reclassifier")


# ---------------------------------------------------------------------------
# Heuristic config
# ---------------------------------------------------------------------------

# Well-known country names (Korean short forms) that pattern-match as
# 2-4 syllable Hangul AND would otherwise be misclassified as person.
# Conservative whitelist; we only need to head off the common case.
_KO_COUNTRY_WHITELIST: frozenset[str] = frozenset({
    "미국", "중국", "일본", "한국", "영국", "독일",
    "프랑스", "러시아", "북한", "대만", "호주", "캐나다",
})

# Korean organization suffixes — substring at END of name.
# Order matters for multi-char suffixes: list longest first so the
# matcher catches them before shorter prefixes of the same string.
_KO_ORG_SUFFIXES: tuple[str, ...] = (
    "연구소", "공사", "재단", "협회", "학교", "대학",
    "정당", "본부", "위원회", "교회", "법인", "조합",
    "부", "청", "원", "회", "사", "단", "국", "소", "당",
)

# Korean location/place suffixes — strict administrative-division
# tail characters. NOT used for whitelist countries (which only
# resemble person shape on character count alone).
_KO_LOC_SUFFIXES: tuple[str, ...] = (
    "시", "도", "군", "구", "동", "읍", "면", "리", "주",
)

# A Hangul syllable codepoint range, for the person heuristic.
_HANGUL_RE = re.compile(r"^[가-힣]+$")


def _looks_like_korean_name(name: str) -> bool:
    """2-4 Hangul syllables, no whitespace, no Latin, no digits."""
    if not name:
        return False
    s = name.strip()
    if not s or " " in s or "\t" in s:
        return False
    if not _HANGUL_RE.match(s):
        return False
    return 2 <= len(s) <= 4


def _ends_with_any(name: str, suffixes: tuple[str, ...]) -> str | None:
    """Return the matched suffix or None.

    Matches longest-first so '위원회' wins over '회' when both apply.
    """
    s = name.strip()
    if not s:
        return None
    # Sort by length DESC so multi-char wins.
    for suf in sorted(suffixes, key=len, reverse=True):
        if s.endswith(suf):
            return suf
    return None


def classify_by_heuristic(
    name: str, aliases: list[str] | None = None
) -> str | None:
    """Return 'person' | 'organization' | 'place' | None.

    None means "ambiguous — defer to LLM". The heuristic favors
    high-confidence Korean cases; foreign brands (록히드마틴, L3해리스)
    and multi-word phrases (정부조달 금지 대상 기업 수) fall through.

    The aliases list is checked too: a Korean alias on an English-primary
    entity (legacy relabel artifacts) can still trip the heuristic.
    """
    if not name or not str(name).strip():
        return None
    candidates: list[str] = [str(name).strip()]
    if aliases:
        for a in aliases:
            if a and isinstance(a, str) and a.strip():
                candidates.append(a.strip())

    for cand in candidates:
        # 1. Country whitelist (must come BEFORE person check — 미국 is
        #    3 Hangul and would otherwise match person shape).
        if cand in _KO_COUNTRY_WHITELIST:
            return "place"

        # 2. Organization suffix (must come BEFORE person check — 정부서울청사
        #    ends in 사 which is an org suffix even though length<=4).
        org_suf = _ends_with_any(cand, _KO_ORG_SUFFIXES)
        if org_suf:
            return "organization"

        # 3. Location suffix.
        loc_suf = _ends_with_any(cand, _KO_LOC_SUFFIXES)
        if loc_suf:
            return "place"

        # 4. Person heuristic: 2-4 Hangul, no whitespace, no org suffix.
        #    (We already returned for the suffix cases above.)
        if _looks_like_korean_name(cand):
            return "person"

    return None


# ---------------------------------------------------------------------------
# LLM fallback (Anthropic Claude)
# ---------------------------------------------------------------------------

# The valid output set MUST be a subset of ObjectClass (see
# api/models/objects.py) so the write at backfill time lands on a
# value the live system accepts. 'other' is a sentinel ONLY — it
# means "abstain" and is treated as a no-op at backfill time.
_LLM_VALID_CLASSES: frozenset[str] = frozenset({
    "person", "organization", "place", "concept", "event", "other",
})

# Tolerance: the PO's brief mentions 'location'; map it to the canonical
# 'place'. Belt-and-braces — if the LLM emits the brief's wording we
# still land on a writable value.
_LLM_ALIASES: dict[str, str] = {
    "location": "place",
    "loc": "place",
    "org": "organization",
    "company": "organization",
    "people": "person",
}


_LLM_SYSTEM_PROMPT = (
    "You are an entity classifier for a Korean+English knowledge graph. "
    "Given ONE entity name, reply with EXACTLY ONE LOWERCASE WORD from "
    "this set:\n"
    "  person, organization, place, concept, event, other\n\n"
    "Rules:\n"
    "- 'person' = a named individual human (e.g. 정청래, Donald Trump).\n"
    "- 'organization' = a company, agency, party, committee "
    "(e.g. 더불어민주당, Lockheed Martin, 중국 상무부).\n"
    "- 'place' = a country, city, region (e.g. 미국, 서울).\n"
    "- 'event' = a discrete happening (e.g. 2020 미국 대선).\n"
    "- 'concept' = an abstract idea, metric, term (e.g. 손실 회피, "
    "원포인트 개헌, 정부조달 금지 대상 기업 수).\n"
    "- 'other' = none of the above / cannot determine.\n\n"
    "Respond with ONLY the single word. No punctuation. No explanation."
)


def classify_by_llm(name: str, context: str | None = None) -> str:
    """Single-entity Claude classification. Returns one of:
    'person', 'organization', 'place', 'concept', 'event', 'other'.

    Returns 'other' on ANY failure (missing key, network, parse error)
    so the caller treats it as no-op and the existing class stays.
    """
    if not name or not str(name).strip():
        return "other"

    if not os.getenv("ANTHROPIC_API_KEY"):
        logger.info("entity_reclassifier: ANTHROPIC_API_KEY missing — abstain")
        return "other"

    try:
        from anthropic import Anthropic
    except ImportError:
        logger.warning("entity_reclassifier: anthropic package not installed")
        return "other"

    model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5")
    user_msg = f"Entity name: {name.strip()}"
    if context:
        user_msg += f"\nContext: {context.strip()}"

    client = Anthropic()
    start = time.monotonic()
    try:
        resp = client.messages.create(
            model=model,
            max_tokens=20,
            system=_LLM_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "entity_reclassifier: LLM call failed for %r: %s", name, exc,
        )
        return "other"

    latency_ms = int((time.monotonic() - start) * 1000)
    raw_parts: list[str] = []
    for block in resp.content:
        if getattr(block, "type", "") == "text":
            raw_parts.append(getattr(block, "text", "") or "")
    raw = "".join(raw_parts).strip().lower()
    # Strip surrounding punctuation / quotes / periods.
    raw = re.sub(r"[^a-z]", "", raw)
    raw = _LLM_ALIASES.get(raw, raw)

    if raw in _LLM_VALID_CLASSES:
        logger.info(
            "entity_reclassifier: LLM classified %r -> %r (%dms)",
            name, raw, latency_ms,
        )
        return raw

    logger.warning(
        "entity_reclassifier: LLM returned unrecognized class %r for %r",
        raw, name,
    )
    return "other"


# ---------------------------------------------------------------------------
# Backfill primitives
# ---------------------------------------------------------------------------

# Classes that mean "no information added" — never trigger a write.
_NOOP_CLASSES: frozenset[str] = frozenset({"concept", "other", ""})


def backfill_one_entity(
    client: Any,
    index: str,
    doc_id: str,
    source: dict[str, Any],
    *,
    use_llm: bool = True,
    apply: bool = True,
) -> tuple[bool, str, str]:
    """Reclassify one entity. Returns (changed, old_class, new_class).

    Skip rules:
      - If `source['class']` is set and NOT 'concept', skip (idempotent
        — never overwrite an already-classified entity).
      - If heuristic returns None and `use_llm=False`, skip.
      - If the chosen class is 'concept' or 'other' (no information
        gained), skip.

    When `apply=False`, computes what WOULD change but does NOT call
    `client.update`. The (changed, old, new) tuple still reports the
    would-be transition.
    """
    existing_class = (source.get("class") or "").strip()
    name = (source.get("primary_label") or source.get("name") or "").strip()
    aliases = list(source.get("aliases") or [])

    # Idempotency guard: only ever promote from "concept" (the legacy
    # default) or empty. Never overwrite a real class.
    if existing_class and existing_class != "concept":
        return (False, existing_class, existing_class)

    if not name:
        return (False, existing_class, existing_class)

    # 1. Heuristic.
    new_class = classify_by_heuristic(name, aliases=aliases)
    method = "heuristic"

    # 2. LLM fallback.
    if new_class is None:
        if not use_llm:
            return (False, existing_class, existing_class)
        new_class = classify_by_llm(name)
        method = "llm"

    if new_class in _NOOP_CLASSES or new_class is None:
        return (False, existing_class, existing_class)

    if apply:
        try:
            client.update(
                index=index,
                id=doc_id,
                doc={"class": new_class, "entity_type": new_class},
                refresh="wait_for",
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "entity_reclassifier: ES update failed for %s (%r): %s",
                doc_id, name, exc,
            )
            return (False, existing_class, existing_class)
        logger.info(
            "entity_reclassifier: backfilled %s (%r) %r -> %r via %s",
            doc_id, name, existing_class or "(empty)", new_class, method,
        )

    return (True, existing_class or "concept", new_class)


def run_backfill(
    client: Any,
    ks_id: str,
    *,
    use_llm: bool = True,
    apply: bool = True,
    batch_size: int = 500,
) -> dict[str, Any]:
    """Scan every entity in `ks_id` and reclassify the legacy
    concept-stuck ones.

    Returns a summary dict:
      {
        "scanned": int,
        "updated": int,
        "by_class": {"person": int, "organization": int, ...},
        "samples": [{"name": ..., "old": ..., "new": ..., "method": ...}],
        "skipped": int,
        "ks_id": str,
        "applied": bool,
      }
    """
    try:
        resp = client.search(
            index=LUCID_OBJECTS,
            size=batch_size,
            query={"term": {"knowledge_space_id": ks_id}},
        )
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "entity_reclassifier: ES search failed for ks=%s: %s", ks_id, exc,
        )
        return {
            "scanned": 0,
            "updated": 0,
            "by_class": {},
            "samples": [],
            "skipped": 0,
            "ks_id": ks_id,
            "applied": apply,
            "error": str(exc),
        }

    hits = (resp.get("hits") or {}).get("hits") or []
    scanned = len(hits)
    updated = 0
    skipped = 0
    by_class: dict[str, int] = {}
    samples: list[dict[str, Any]] = []

    for hit in hits:
        doc_id = hit["_id"]
        source = hit.get("_source") or {}
        name = (source.get("primary_label") or source.get("name") or "").strip()
        existing_class = (source.get("class") or "").strip()

        # Pre-check method for samples bookkeeping (no extra ES calls).
        if existing_class and existing_class != "concept":
            skipped += 1
            continue

        # Heuristic-first preview so the sample records the right method.
        heuristic_pick = classify_by_heuristic(
            name, aliases=list(source.get("aliases") or [])
        )
        method = "heuristic" if heuristic_pick is not None else "llm"

        changed, old, new = backfill_one_entity(
            client, LUCID_OBJECTS, doc_id, source,
            use_llm=use_llm, apply=apply,
        )
        if changed:
            updated += 1
            by_class[new] = by_class.get(new, 0) + 1
            if len(samples) < 20:
                samples.append({
                    "doc_id": doc_id,
                    "name": name,
                    "old": old,
                    "new": new,
                    "method": method,
                })
        else:
            skipped += 1

    return {
        "scanned": scanned,
        "updated": updated,
        "by_class": by_class,
        "samples": samples,
        "skipped": skipped,
        "ks_id": ks_id,
        "applied": apply,
    }
