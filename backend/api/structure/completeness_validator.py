"""feat/spo-decomp-completeness — deterministic SPO completeness validator.

PO directive (2026-06-23):

  "few-shot 강화만으로 가리지 말 것. 3번 실패 패턴 그대로다.
   완전성 검증을 넣을 것.
   predicate 가 동사만 남기고 목적·수식구를 누락하는지 검증
   (predicate + object 를 합쳐도 원문 핵심이 보존되는지)
   faithful surface(원문 언어) 유지. 의미 변형·요약 금지 —
   자르기만, 내용 추가 금지."

Live evidence:
  "중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다."
    current bad SPO: S="중국" P="올렸다" O="10곳"
    correct SPO   : S="중국 정부" P="수출통제 대상에 올렸다" O="미국 기업 10곳"

This module checks whether each fact's SPO surface preserves the
claim's key content tokens. It is intentionally NOT an LLM
re-decomposition loop — PO directive: 자르기만, 내용 추가 금지. We
only flag incomplete facts for HITL; we never rewrite the predicate
or object surface.

Approach:
  1. Tokenize claim by stripping punctuation, splitting on whitespace,
     then trimming common Korean particles from each token.
  2. Tokenize the SPO surface (subject + predicate + object) the same way.
  3. Compare content-token sets. If too many claim tokens are missing
     from the SPO surface, the fact is incomplete.

The "10곳" vs "미국 기업 10곳" case:
  claim_tokens     = {중국, 정부, 미국, 기업, 10곳, 수출통제, 대상, 올렸다}
  bad SPO tokens   = {중국, 올렸다, 10곳}                  → coverage 3/8 = 0.375 → FAIL
  good SPO tokens  = {중국, 정부, 수출통제, 대상, 올렸다,
                      미국, 기업, 10곳}                    → coverage 8/8 = 1.0   → PASS
"""
from __future__ import annotations

import re

# Korean postpositions to strip from the END of each token. The set is
# the same family `subject_recovery.py` uses for noun-phrase boundary
# detection, but here we apply it as a SUFFIX strip on each token so
# "중국이" and "중국은" both reduce to "중국" for set comparison.
_KOREAN_PARTICLES = re.compile(
    r"(은|는|이|가|을|를|의|에|에서|로|으로|와|과|도|만|까지|부터|에게|한테|께서|라고|라는)$"
)

# Punctuation that should NOT block token boundaries — strip it before
# whitespace-splitting. The Korean middle-dot (·) is important: it joins
# coordinated phrases like "방산·드론·희토류" which we want to split into
# 3 content tokens, not one.
_PUNCT = re.compile(r"[.,!?;:\"'()\[\]<>「」『』·／/]")

# Very common stop tokens that don't carry essential content. We keep
# this list tight — over-aggressive stop-listing causes false positives.
_STOP = frozenset([
    "그", "이", "저", "것", "수", "등", "및", "또는", "하지만", "그리고",
    "한", "두", "세", "네", "다섯",
    "있다", "이다", "였다", "한다",
    "the", "a", "an", "of", "to", "in", "on", "at", "by", "for", "with",
    "and", "or", "but", "is", "are", "was", "were", "be", "been",
])


def _tokenize(text: str) -> list[str]:
    """Crude tokenize: strip punctuation, split on whitespace, lowercase,
    strip Korean particles, skip stopwords and 1-char single letters.

    Order matters: we strip punctuation BEFORE splitting so middle-dots
    join correctly, then strip particles AFTER splitting so each token
    is normalized independently.
    """
    if not text:
        return []
    cleaned = _PUNCT.sub(" ", text)
    raw = cleaned.split()
    out: list[str] = []
    for w in raw:
        w2 = _KOREAN_PARTICLES.sub("", w).strip().lower()
        if not w2:
            continue
        if w2 in _STOP:
            continue
        if len(w2) < 2:
            # 1-char tokens are almost always stop noise. Numbers ("9") and
            # single Hangul ("자") rarely carry essential content on their
            # own; they appear inside multi-char tokens we already capture.
            continue
        out.append(w2)
    return out


def _content_tokens(text: str) -> set[str]:
    return set(_tokenize(text))


def check_completeness(
    claim: str,
    subject: str,
    predicate: str,
    object_text: str,
    *,
    coverage_threshold: float = 0.7,
) -> dict[str, object]:
    """Returns a dict:
       complete   : bool   — True if SPO surface covers ≥ threshold of claim tokens
       missing    : list[str] — claim tokens not found in SPO
       coverage   : float  — fraction (0-1) of claim tokens present in SPO
       reason     : str    — short explanation

    Notes:
      * Empty claim → vacuously complete (nothing to cover).
      * If the SPO surface is all empty, coverage is 0 and the fact fails.
      * Particle stripping handles the common "중국이" vs "중국" mismatch.
    """
    claim_tokens = _content_tokens(claim)
    if not claim_tokens:
        return {
            "complete": True,
            "missing": [],
            "coverage": 1.0,
            "reason": "empty_claim",
        }

    spo_text = " ".join(
        s for s in (subject or "", predicate or "", object_text or "") if s
    )
    spo_tokens = _content_tokens(spo_text)

    missing = sorted(t for t in claim_tokens if t not in spo_tokens)
    coverage = 1.0 - (len(missing) / len(claim_tokens))

    if coverage >= coverage_threshold:
        return {
            "complete": True,
            "missing": missing,
            "coverage": coverage,
            "reason": "ok",
        }

    return {
        "complete": False,
        "missing": missing,
        "coverage": coverage,
        "reason": (
            f"coverage {coverage:.2f} < {coverage_threshold:.2f}; "
            f"missing tokens: {missing[:5]}"
        ),
    }
