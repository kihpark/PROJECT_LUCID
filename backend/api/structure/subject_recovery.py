"""Deterministic Korean subject recovery from claim text.

PO 2026-06-22 directive (feat/spo-subject-claim-recovery):

When the LLM produces an English/Latin surface for a Korean entity
against the verbatim rule (B-62-fix-v3-general), we recover the Korean
form by parsing the claim text. Pure text parsing — no LLM, no
dictionary, no translation.

Korean grammatical signal: the subject is the noun phrase immediately
preceding a topic/subject particle (은/는/이/가, plus 께서 honorific and
에서 for institutional subjects).

This handles:
  "일본은..." → 일본
  "중국 상무부는..." → 중국 상무부
  "안도걸 더불어민주당 의원은..." → 안도걸 더불어민주당 의원
  "에이비옥스가..." → 에이비옥스
  "대통령께서..." → 대통령
  "22일 중국 상무부는..." → 중국 상무부 (leading adverbial excluded)

Why this is the last round of the subject-preservation fix: the
recovery does NOT require LLM cooperation. The claim is in our hands
and the particle boundary is unambiguous. Whether the LLM emits
"Japan" or "일본" for the surface, we can always recover "일본" from
the claim "일본은 ...". This removes the failure mode from the loop.
"""
from __future__ import annotations

import re

# Subject/topic particles. Longer particles must be tried first to
# avoid false short matches (e.g. 께서 contains 서, but we want the
# whole honorific form, not just 서).
_SUBJECT_PARTICLES: tuple[str, ...] = (
    "께서",   # honorific subject ("선생님께서")
    "에서",   # institutional subject ("정부에서 발표") — narrow use
    "은",
    "는",
    "이",
    "가",
)

# Characters that can be part of a Korean noun phrase head:
# - Hangul syllables (가-힣)
# - CJK Unified Ideographs (Hanja) and extensions
# - Digits (for compounds like "G20", though rare)
# - Interpunct (·) used in Korean compound nouns ("서울대·KAIST")
# - Space (compound nouns are space-separated: "중국 상무부")
# Stops at ASCII Latin letters, punctuation, sentence boundaries.
_NOUN_CHAR = re.compile(
    r"["
    r"가-힣"   # Hangul syllables (가-힣)
    r"㐀-䶿"   # CJK Extension A
    r"一-鿿"   # CJK Unified Ideographs (Hanja)
    r"豈-﫿"   # CJK Compatibility Ideographs
    r"0-9"
    r"·"          # middle dot
    r" "
    r"]"
)

# Leading temporal adverbial regex — strips dates / time references
# from the front of a recovered noun phrase. Examples:
#   "22일 중국 상무부" → "중국 상무부"
#   "지난 12일 한국은행" → "한국은행"
#   "11월 22일 정부" → "정부"
# The pattern handles repeated time tokens (e.g. "11월 22일").
_LEADING_TIME_RE = re.compile(
    r"^\s*"
    r"(?:"
    r"(?:[0-9]+\s*(?:일|월|년|시|분|초|주|개월|시간))"
    r"|"
    r"(?:지난|이번|다음|올|작년|올해|내년)"
    r"(?:\s+[0-9]+\s*(?:일|월|년|시|분|초|주|개월|시간))?"
    r")"
    r"(?:\s+(?:[0-9]+\s*(?:일|월|년|시|분|초|주|개월|시간)))*"
    r"\s+"
)


def _has_hangul_or_hanja(text: str) -> bool:
    """Return True iff `text` contains at least one Hangul or Hanja char."""
    return any(
        '가' <= ch <= '힣'
        or '㐀' <= ch <= '䶿'
        or '一' <= ch <= '鿿'
        for ch in text
    )


def recover_korean_subject_from_claim(claim: str | None) -> str | None:
    """Recover the Korean subject from a claim using particle boundaries.

    Find the noun phrase immediately preceding the FIRST subject or
    topic particle in the claim. Returns None if no recoverable phrase
    is found (rare — only when the claim has no particle, or the
    particle is at the start, or the phrase is empty after cleanup).

    "First particle wins" because the claim is one fact's worth of
    text; the main clause's subject is the leftmost agent. Subordinate
    clauses come after.

    Algorithm:
      1. Scan the claim and find the leftmost subject/topic particle
         occurrence that is preceded by at least one noun character
         (so we don't match a particle floating in whitespace).
      2. Walk LEFT from the particle position, accumulating chars that
         can be part of a noun phrase head (Hangul, Hanja, digits,
         space, interpunct).
      3. Stop at the first non-noun character (Latin letter,
         punctuation, sentence boundary).
      4. Trim leading whitespace.
      5. Strip leading temporal adverbials ("22일 ", "지난 12일 ", etc.).
      6. Require at least one Hangul or Hanja char in the result.
      7. Return the recovered noun phrase, or None.
    """
    if not claim or not isinstance(claim, str):
        return None

    # Find the leftmost particle occurrence that satisfies the
    # particle-boundary constraints:
    #   - preceded by a noun character (not space or non-noun),
    #   - followed by a phrase boundary: space, sentence punctuation,
    #     or end-of-string. (This excludes 이/는/가 appearing INSIDE
    #     a word — e.g. the 이 inside "에이비옥스" is part of the noun,
    #     not a particle, because it's followed by 비 — a noun char.)
    # Iterate ALL particles and pick the smallest claim-index where
    # this is true.
    claim_len = len(claim)
    # Phrase boundary chars: space, common Korean sentence punctuation,
    # ASCII punctuation, parentheses, quotes.
    _BOUNDARY_CHARS = set(" \t\n,.!?:;'\"()[]{}—-–·")
    best_pos = -1
    for particle in _SUBJECT_PARTICLES:
        for match in re.finditer(re.escape(particle), claim):
            idx = match.start()
            if idx == 0:
                continue
            prev_char = claim[idx - 1]
            # The char immediately before the particle must be a noun
            # character AND not a space (particles attach to nouns
            # without a space).
            if not _NOUN_CHAR.match(prev_char):
                continue
            if prev_char == " ":
                continue
            # The char immediately AFTER the particle must be a phrase
            # boundary — space, punctuation, or end-of-string. This
            # is what disambiguates "이" the particle from "이" inside
            # a word like 에이비옥스 or 이재명.
            after_idx = idx + len(particle)
            if after_idx < claim_len:
                next_char = claim[after_idx]
                if next_char not in _BOUNDARY_CHARS:
                    continue
            if best_pos == -1 or idx < best_pos:
                best_pos = idx
            break  # for this particle, first valid occurrence is enough

    if best_pos == -1:
        return None

    # Walk left to collect the noun phrase head.
    end = best_pos  # exclusive — claim[start:end] is the phrase
    start = end
    while start > 0 and _NOUN_CHAR.match(claim[start - 1]):
        start -= 1

    phrase = claim[start:end].strip()
    if not phrase:
        return None

    # Strip leading temporal adverbial if present.
    cleaned = _LEADING_TIME_RE.sub("", phrase, count=1).strip()
    if cleaned:
        phrase = cleaned

    # Final sanity: the recovered phrase must contain at least one
    # Hangul or Hanja char. Otherwise we recovered noise (digits + space).
    if not _has_hangul_or_hanja(phrase):
        return None

    return phrase


__all__ = ["recover_korean_subject_from_claim"]
