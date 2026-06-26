"""M3-1 canonical-layer — surface-form → canonical mapping rules.

PO 의뢰서 verbatim (m31-canonical-layer 2026-06-24):
  - 표면형 → canonical 매핑 (결정적 규칙 + LLM classifier 보조,
    느슨한 ontology — 경직 강제 금지).

Three layered rules:

  1. ``normalize_label(label)`` — deterministic surface normalization
     used by the canonical key + alias dedup. NFKC fold, lowercase,
     whitespace collapse. No language-specific magic — just
     unicode-correct equality.

  2. ``deterministic_canonical_key(entity_type, name, name_en)`` —
     the cheap deterministic test. Returns a tuple ``(entity_type,
     normalized_surface)`` for every non-empty surface form, so two
     entities sharing ANY normalized variant under the same
     ``entity_type`` collide. This collapses the 7 PO-KS clusters we
     measured in discovery: shared ``name_en`` keyword across two
     ``lucid_objects`` docs already proves they are the same entity.

  3. ``llm_canonical_match(a, b)`` — fallback for the ambiguous
     "fuzzy" cluster (Levenshtein < 3 / brand-shape variation /
     ko→en transliteration without a shared keyword). PO 의뢰서
     constrains spend: "비용 가드: 결정적 우선." We only call Claude
     when the deterministic test was inconclusive AND a fuzzy
     candidate pair was detected. Stub returns ``False`` when the
     ANTHROPIC_API_KEY is absent so unit tests run dry.

The module is import-time pure — no ES or LLM call lands until a
caller invokes the relevant function. That keeps M3-1 cheap to
import from CLI / test contexts.
"""
from __future__ import annotations

import json
import logging
import os
import re
import unicodedata
from typing import Any

logger = logging.getLogger("lucid.services.canonical_mapping")

# ---------------------------------------------------------------------------
# Rule 1 — normalize_label
# ---------------------------------------------------------------------------

# Collapses ALL Unicode whitespace classes (spaces, tabs, ideographic
# spaces, etc.) into the empty string. Chosen over single-space
# collapse because Korean entity surfaces routinely vary on
# whitespace presence ("MP 머티리얼즈" vs "MP머티리얼스") — those
# pairs MUST hash to the same key. English multi-word phrases also
# collapse, which is fine for entity dedup: "Bank of Korea" and
# "BankofKorea" should not be treated as distinct entities.
_WHITESPACE_RE = re.compile(r"\s+", re.UNICODE)


def normalize_label(label: str | None) -> str:
    """Return a deterministic normalized form of ``label``.

    Steps (in order):
      1. NFKC unicode fold — collapses fullwidth / halfwidth / circled
         variants onto their canonical codepoints so "ＭＰ" and "MP"
         agree.
      2. Strip surrounding whitespace.
      3. Lowercase (Unicode-aware ``str.casefold`` would also fold
         German ß → ss; ``lower`` is enough for ko/en).
      4. Collapse all whitespace to the empty string.

    Empty / None inputs return ``""``. This is the SAME function used
    by the canonical_key, alias dedup, and the cluster discovery
    pass — the three paths share one source of truth.
    """
    if not label:
        return ""
    s = unicodedata.normalize("NFKC", str(label)).strip().lower()
    return _WHITESPACE_RE.sub("", s)


# ---------------------------------------------------------------------------
# Rule 2 — deterministic canonical key
# ---------------------------------------------------------------------------

def deterministic_canonical_key(
    entity_type: str | None,
    name: str | None,
    name_en: str | None = None,
    *,
    aliases: list[str] | None = None,
) -> list[tuple[str, str]]:
    """Return every (entity_type, normalized_surface) candidate key.

    The CALLER decides equivalence: two entities are deterministically
    "the same" when their candidate key sets intersect. We return a
    list rather than a single string because a single doc legitimately
    carries multiple surfaces (Korean primary + English alias + raw
    aliases list) — any one of which can hash-collide with the same
    surface on another doc.

    Why a list and not a frozenset? Order is preserved so the discovery
    report can show "matched on alias #2" deterministically. Callers
    that need a set can wrap with ``set(...)``.

    ``entity_type`` is required: the canonical key NEVER crosses class
    boundaries (the PO 의뢰서 says "ontology — 경직 강제 금지" but the
    SAME PO directive ships the 13 ObjectClasses as a controlled vocab.
    We respect both by KEEPING the class as part of the key — so a
    "민주당 / Democratic Party" organization and a hypothetical "민주당"
    PRODUCT NAME cannot accidentally merge — without REJECTING a
    capture whose class is unfamiliar). Empty / None ``entity_type``
    short-circuits to an empty list (no key, caller must skip).
    """
    if not entity_type:
        return []
    et = str(entity_type).strip().lower()
    if not et:
        return []
    surfaces: list[str] = []
    for raw in (name, name_en, *(aliases or [])):
        n = normalize_label(raw)
        if n and n not in surfaces:
            surfaces.append(n)
    return [(et, s) for s in surfaces]


# ---------------------------------------------------------------------------
# Rule 3 — LLM classifier fallback
# ---------------------------------------------------------------------------

_LLM_SYSTEM = (
    "You are a Korean+English named-entity equivalence judge. Given "
    "two candidate entity records, decide whether they refer to the "
    "SAME real-world entity (e.g. 'Bank of Korea' and '한국은행' "
    "refer to the same central bank; 'MP Materials' and 'MP "
    "머티리얼즈' refer to the same firm; 'South Korea' and '국내' "
    "do NOT — '국내' means 'domestic', which is broader). Reply "
    "with a single line of JSON: {\"same_entity\": true|false, "
    "\"reason\": \"<short justification>\"}. Never add extra "
    "prose."
)


def _record_summary(rec: dict[str, Any]) -> str:
    """One-line summary used to keep the LLM prompt short and cheap."""
    fields = []
    for k in ("primary_label", "name", "name_en", "entity_type", "class"):
        v = rec.get(k)
        if v:
            fields.append(f"{k}={v!r}")
    aliases = rec.get("aliases") or []
    if aliases:
        fields.append(f"aliases={list(aliases)!r}")
    return "; ".join(fields)


def llm_canonical_match(
    candidate_a: dict[str, Any],
    candidate_b: dict[str, Any],
) -> bool:
    """Return True when Claude says the two candidates are the same entity.

    Cheap-by-default: when ``ANTHROPIC_API_KEY`` is unset (unit tests,
    CI without secrets) we return ``False`` — better to UNDER-merge
    than to over-merge on a stub. Anthropic SDK errors degrade to
    ``False`` as well (the discovery report can still recover the
    deterministic cluster; the LLM is purely additive).

    The PO 의뢰서 says "비용 가드: 결정적 우선" — callers MUST exhaust
    the deterministic key first and only ask the LLM about pairs that
    failed the deterministic test.
    """
    if not os.getenv("ANTHROPIC_API_KEY"):
        logger.debug("llm_canonical_match: no API key, returning False")
        return False
    try:
        # Lazy import — keeps the test path zero-cost.
        import anthropic  # noqa: PLC0415
    except ImportError:
        logger.warning(
            "llm_canonical_match: anthropic SDK missing, returning False"
        )
        return False

    user = (
        "Candidate A: " + _record_summary(candidate_a)
        + "\nCandidate B: " + _record_summary(candidate_b)
    )
    model = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5")
    try:
        client = anthropic.Anthropic()
        resp = client.messages.create(
            model=model,
            max_tokens=256,
            system=_LLM_SYSTEM,
            messages=[{"role": "user", "content": user}],
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning("llm_canonical_match: API call failed: %s", exc)
        return False
    try:
        text = "".join(
            block.text for block in resp.content if getattr(block, "text", None)
        ).strip()
        # Strip optional code fences.
        if text.startswith("```"):
            text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE)
        payload = json.loads(text)
    except Exception as exc:  # noqa: BLE001
        logger.warning("llm_canonical_match: malformed LLM output: %s", exc)
        return False
    return bool(payload.get("same_entity"))


__all__ = [
    "normalize_label",
    "deterministic_canonical_key",
    "llm_canonical_match",
]
