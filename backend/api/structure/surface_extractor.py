"""Surface extraction utilities — content-language preservation (B-62-fix-v3 general).

PO 2026-06-22 directive (feat/spo-surface-content-language):

Replaces the curated ~25-entry KO↔EN dictionary from prior fix
iterations (`_KO_EN_ORG_DICT`, `derive_korean_surface_from_claim`)
with a GENERAL verbatim-substring constraint. The LLM is instructed
to return surfaces as verbatim substrings of the source text; this
module validates that constraint and degrades gracefully (HITL flag)
when violated.

Why the dictionary failed: it only covered ~25 ministry / regulator
/ policy nouns. Person names ("안도걸 더불어민주당 의원"), arbitrary
Korean companies, foreign officials, and any out-of-dictionary
concept noun still got translated to English by the LLM and the
dictionary had no entry to recover them. The general principle —
"the verbatim source-text span is the surface" — works for ALL
entities the LLM extracts, not just the curated 25.

Mechanism:
  - PRIMARY (i): prompt clause B-62-fix-v3 (in prompts.py) instructs
    the LLM to emit subject_surface / object_surface as a verbatim
    substring of the source text. Position-pointing = no translation.
  - FALLBACK (ii): `detect_violation` flags Hangul-source + Latin-
    non-brand + non-substring surfaces. The caller flags the fact for
    HITL review and keeps the LLM surface as-is. We do NOT guess.

Brand exception (separate `brand_resolver.py` module): Korean
transliterations of international brands (스페이스X → SpaceX) are
normalized to the English canonical BEFORE the violation check. This
is a narrow brands-only map, not a general translation dictionary.
"""
from __future__ import annotations

import re

# Korean postpositions to strip from the end of a surface. The LLM may
# emit "중국 상무부는" instead of "중국 상무부" — the trailing 는 is the
# topic particle, not part of the entity.
_KOREAN_PARTICLES_RE = re.compile(
    r"(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만|까지|부터|에게|한테)$"
)


_HANGUL_RE = re.compile(r"[가-힣]")


def has_hangul(text: str | None) -> bool:
    """Return True when `text` contains at least one Hangul syllable.

    Used by `detect_violation` to decide whether the source text is
    Korean-content (in which case Latin surfaces need scrutiny).
    """
    if not text:
        return False
    return bool(_HANGUL_RE.search(text))


# Back-compat shim: the prior dictionary module exported `_has_hangul`.
# Some callers (and lingering debug scripts) may import it. Keep the
# alias so we don't break the import surface.
_has_hangul = has_hangul


def strip_korean_particles(text: str) -> str:
    """Strip at most one trailing Korean postposition from `text`.

    Empty / None / non-Korean pass through unchanged. Idempotent —
    only matches once at the end. Examples:
      "중국 상무부는"  → "중국 상무부"
      "삼성전자가"    → "삼성전자"
      "SpaceX"      → "SpaceX"
      ""            → ""
    """
    if not text:
        return text
    return _KOREAN_PARTICLES_RE.sub("", text).strip()


def is_verbatim_substring(surface: str, source: str) -> bool:
    """Return True iff `surface` appears in `source` as a substring.

    Tries both the raw surface AND the particle-stripped surface (the
    LLM may include or omit the postposition; either form should
    validate when the bare-entity form is present in the source).
    """
    if not surface or not source:
        return False
    if surface in source:
        return True
    bare = strip_korean_particles(surface)
    if bare and bare != surface and bare in source:
        return True
    return False


def detect_violation(
    surface: str,
    source: str,
    *,
    looks_like_brand: bool,
) -> bool:
    """Return True when the LLM's surface violates the verbatim rule.

    A violation is when ALL of:
      - source contains Hangul (Korean content), AND
      - surface has no Hangul (Latin / English), AND
      - surface is NOT brand-shaped (not an English canonical brand),
      - AND surface is NOT a verbatim substring of the source.

    These conditions identify the case the LLM anglicized a Korean
    common noun / person / government entity against the verbatim
    rule. The caller flags the fact for HITL review.

    Returns False (no violation) when:
      - source is English / non-Korean — surface stays whatever it is,
      - surface has Hangul — LLM preserved Korean correctly,
      - surface is brand-shaped — English brand in Korean text is
        legitimate (SpaceX, OpenAI, IBM),
      - surface is a verbatim substring — English entity name
        legitimately appears in the source (Lockheed Martin in a
        Korean article, etc.).
    """
    if not has_hangul(source):
        return False
    if has_hangul(surface):
        return False
    if looks_like_brand:
        return False
    if is_verbatim_substring(surface, source):
        return False
    return True


def detect_predicate_violation(predicate: str, claim: str) -> bool:
    """Return True when the LLM emitted an English predicate on a
    Korean claim.

    feat/spo-decide-payload-wire (PO 2026-06-23): the PO directive is
    "predicate 측 verbatim - rule-based parse 금지, prompt 강화 + 위반시
    flag". The prompt now instructs the LLM to keep the predicate in the
    source language as a verb phrase; this util detects the residual
    violations so the Decide UI surfaces them for HITL review.

    A violation is when ALL of:
      - claim contains Hangul (Korean source), AND
      - predicate has no Hangul (Latin / snake_case English).

    Returns False (no violation) when:
      - claim is English / non-Korean — English predicate is correct,
      - predicate has Hangul — LLM preserved Korean correctly.

    Unlike `detect_violation`, we do NOT check whether the predicate is
    a verbatim substring of the claim: predicates are normally an
    abstraction over the verb phrase (e.g. claim "발표했다 ..." →
    predicate "발표했다"), and they don't always literally appear in
    the source. Source-language script is the only honest signal.

    We also do NOT exempt brand-shaped predicates — there is no such
    thing as a "brand predicate". `elected_president`, `imposed_export_control`,
    `is_former_member_of` are all snake_case English and trip the flag
    when the claim is Korean.
    """
    if not has_hangul(claim):
        return False
    if has_hangul(predicate):
        return False
    return True


__all__ = [
    "has_hangul",
    "_has_hangul",
    "strip_korean_particles",
    "is_verbatim_substring",
    "detect_violation",
    "detect_predicate_violation",
]
