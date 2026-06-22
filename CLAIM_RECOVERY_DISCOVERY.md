# feat/spo-subject-claim-recovery — STEP 0 Discovery

## 0.1 Current violation fallback (the block to be replaced)

File: `backend/api/structure/processor.py`
Function: `_match_object`
Lines: **209-223** (current behavior in `_match_object`).

The block being replaced (verbatim):

```python
# Step (2) — verbatim violation detection. Source text is the
# claim the entity appears in. When no claim is available
# (defensive), we cannot validate and assume no violation.
source_text = _find_claim_for_obj(decomp, obj.uid) or ""
surface_for_check = bare_surface if not brand_en else brand_en
needs_review = detect_violation(
    surface=surface_for_check,
    source=source_text,
    looks_like_brand=_looks_like_brand(surface_for_check),
)
if needs_review:
    logger.warning(
        "B-62-fix-v3-general verbatim violation: obj=%s "
        "surface=%r is Latin non-brand but claim is Korean "
        "(%r); surface is NOT a substring of claim. Keeping "
        "LLM surface and flagging needs_review=True.",
        obj.uid, surface, source_text,
    )
```

The fallback policy here is **"keep LLM surface + needs_review=True"** — this is the bug. The English "Japan" / "Ministry of Commerce of China" stays as `surface`, and only the HITL flag is set.

## 0.2 Claim access at the violation site — CONFIRMED

`source_text = _find_claim_for_obj(decomp, obj.uid) or ""` is already computed before the violation check (line 209). It is the Korean claim text. We pass it into `recover_korean_subject_from_claim()` for deterministic recovery.

## 0.3 Reuse points

- **`has_hangul`** (`surface_extractor.py`): used inside `detect_violation`. No changes needed.
- **`strip_korean_particles`** (`surface_extractor.py`): not directly reused by the recovery module — `subject_recovery.py` walks the noun phrase head and stops at the particle boundary, so no trailing-particle cleanup is needed. Kept untouched.
- **`_looks_like_brand`** (`entity_resolver.py`): brand check stays in `_match_object`. Untouched.
- **`brand_resolver.resolve_korean_brand`**: SpaceX path stays. Untouched.
- **`detect_violation`** (`surface_extractor.py`): the detection logic is kept; only the *fallback when it returns True* is changed.

## Mechanism (new)

When `detect_violation` returns True:
1. Call `recover_korean_subject_from_claim(source_text)`.
2. If a Korean noun phrase is recovered: **replace** `surface` with the recovered Korean form; set `needs_review = False`.
3. If recovery fails (no particle found — rare): keep the LLM surface and flag `needs_review = True`. This is the genuine HITL case.

No LLM call. No dictionary. No translation. Pure regex over the claim text.
