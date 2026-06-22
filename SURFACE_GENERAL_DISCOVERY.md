# SURFACE_GENERAL_DISCOVERY — feat/spo-surface-content-language

PO 2026-06-22. Replaces the ~25-entry KO↔EN dictionary band-aid in
surface_extractor.py with a content-language-preserving verbatim
substring mechanism.

## 0.1 LLM output structure

The LLM (claude-sonnet-4-6) returns JSON conforming to the schema in
`backend/api/structure/prompts.py::SYSTEM_PROMPT`. Parsed into
`StructureResult` (`backend/api/structure/models.py`).

Per-fact subject/object surface fields on `StructureFact`:
- `subject_surface: str | None` — line 87, models.py (optional;
  populated by B-62-fix-v2 directive in the prompt).
- `object_surface: str | None` — line 88, models.py.

Per-object identity fields on `StructureObject`:
- `name: str` — line 50, models.py. LLM's canonical (often
  English-normalized).
- `name_en: str | None` — line 51.
- `aliases: list[str]` — line 53 (B-52 source-surface preservation).

The `StructureFact.subject_uid` references one of
`StructureResult.objects[i].uid` (LLM placeholder "obj-N").

## 0.2 Dictionary band-aid location (to be DELETED)

`backend/api/structure/surface_extractor.py`:
- Lines 52-83: `_KO_EN_ORG_DICT` (~25 curated KO↔EN org/policy nouns).
- Lines 86-88: `_EN_TO_KO_LOWER` derived lower-case lookup.
- Lines 91-98: `_has_hangul` (kept — but moved to `has_hangul`
  public-named).
- Lines 101-156: `derive_korean_surface_from_claim` (DELETE).

Caller in `backend/api/structure/processor.py`:
- Lines 58-61: import.
- Lines 179-194: Mode A defense block calling
  `derive_korean_surface_from_claim`.

Tests:
- `backend/tests/unit/test_korean_surface_derivation.py` (all 10
  tests) — DELETE.
- `backend/tests/integration/test_b62_debug_measurement.py` —
  Scenarios A/B asserted English primary as the "measured bug".
  Post-replacement these scenarios now exercise the new verbatim
  validator. Updated to reflect the new behavior (violation flagged
  but LLM surface kept; we do NOT recover Korean via dictionary).

## 0.3 Source-text scope at structure time

CRITICAL discovery: the full article body IS available at structure
time.

In `backend/api/structure/processor.py::process_extracted_job`:
- Line 567: `merged_text = job.extracted_text or ""` — full text.
- Line 573: `decompose(merged_text, ...)` — LLM receives the full
  body.
- The per-object matching loop (line 597) currently does NOT pass
  `merged_text` to `_match_object`.

The verbatim validator can be run against either the per-claim text
(`fact.claim`) OR the full merged_text. We use the **claim** as the
primary scope (because the LLM emitted the surface for THAT fact)
and fall back to merged_text only when the surface is missing from
the claim — a defensive widening.

## 0.4 _looks_like_brand (reused, untouched)

`backend/api/structure/entity_resolver.py:102-121`:
- Regex `^[A-Za-z][A-Za-z0-9]{1,15}$` — single Latin token, 2-16
  chars.
- Reused by `brand_resolver.py` (self-check assertion) and by
  `detect_violation` in `surface_extractor.py`.

## 0.5 Mechanism

PRIMARY (i): LLM is instructed in the prompt (new B-62-fix-v3
clause) to return `subject_surface` / `object_surface` as **verbatim
substrings** of the source text (the claim).

FALLBACK (ii): deterministic validator
`surface_extractor.detect_violation`:

  violation iff:
    - source contains Hangul, AND
    - surface contains no Hangul, AND
    - surface is NOT brand-shaped (per `_looks_like_brand`), AND
    - surface is NOT a verbatim substring of the source.

On violation: KEEP the LLM surface (we do not invent), set
`needs_review=True` on the fact for HITL resolution.

NO dictionary guess. The dictionary disappears entirely.

## 0.6 Brand exception layer

`backend/api/structure/brand_resolver.py` (NEW):
- Small map (~12 entries) of Korean transliterations of known
  international brands → English canonical form.
- Self-check: every value satisfies `_looks_like_brand`.
- Applied AFTER particle stripping but BEFORE the violation check,
  so 스페이스X → SpaceX before validation runs (and the resulting
  English surface is correctly recognized as brand-shaped).

## Files touched

- DELETE: `surface_extractor.py` dictionary code + tests file.
- NEW: `surface_extractor.py` rewritten with `has_hangul`,
  `strip_korean_particles`, `is_verbatim_substring`,
  `detect_violation`.
- NEW: `brand_resolver.py`.
- MODIFIED: `prompts.py` — B-62-fix-v3 verbatim clause.
- MODIFIED: `processor.py::_match_object` — wires the new mechanism;
  removes dictionary call.
- MODIFIED: `tests/integration/test_b62_debug_measurement.py` — A/B
  scenarios now assert violation flagging + LLM surface kept.
- NEW: `tests/unit/test_surface_verbatim.py`.
- NEW: `tests/unit/test_brand_resolver.py`.
- NEW: `tests/integration/test_surface_general_pipeline.py`.
