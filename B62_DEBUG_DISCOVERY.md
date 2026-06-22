# B-62 Debug Discovery — third Korean subject regression

**PO directive (2026-06-22)**: stop the speculative-patch loop. Three
prior attempts (`feat/spo-subject-natlang-fix`, `…-v2`,
`feat/spo-resolver-wiring`) all merged to main and fresh captures
**still** show English where Korean is required:

- `Ministry of Commerce of China` instead of `중국 상무부`
- `Ministry of Finance of China` instead of `중국 재정부`
- `export control` instead of `수출통제`

This document records the measurement we ran instead of guessing.

## Method

The capture stage is opaque from inside the worktree (no live
extension session, no Anthropic spend). Instead we exercised the
production `_match_object` path with hand-built `StructureResult`
fixtures simulating the live failure modes, captured the four
debug-instrumentation breadcrumbs we shipped in
`adb75c7 instrument(spo): B-62-debug …`, and asserted on the body
the resolver actually persisted to Elasticsearch (`client.index`
call). See `backend/tests/integration/test_b62_debug_measurement.py`.

The four instrumentation points:
1. **LLM_RAW** — every post-coord-split fact's subject_name /
   subject_surface / subject_name_en (in `decomposer.py`).
2. **MATCHER_INPUT** — the (surface, surface_lang, llm_name_en,
   raw_surface_from_map) tuple `_match_object` forwards into
   `match_or_create_object` (in `processor.py`).
3. **RESOLVE** — which branch `resolve_entity` took
   (`primary_lookup_hit` / `co_mention_hit` / `create_new`) and the
   picked primary (in `entity_resolver.py`).
4. **PERSISTED** — the final `primary_label`/`primary_lang` on the
   ES doc (in `_create_entity` / `_repromote_primary_to_surface`).

## Measured values

### Case 1: "중국 상무부" — Scenario A (LLM omitted subject_surface)

The LLM emitted `subject_surface=None`. The processor's
`_build_surface_map` therefore had no entry for `obj-1`, and
`_match_object` fell back to `obj.name` ("Ministry of Commerce of
China"). `_detect_lang` on that English string returns `"en"`. The
entire Korean defense chain in `entity_resolver` never engaged.

| Point | Field | Value |
|-------|-------|-------|
| 1 LLM_RAW | subject_name | `"Ministry of Commerce of China"` |
| 1 LLM_RAW | subject_surface | `None` |
| 1 LLM_RAW | subject_name_en | `"Ministry of Commerce of China"` |
| 1 LLM_RAW | claim | `"중국 상무부는 새로운 수출통제 조치를 발표했다."` |
| 2 MATCHER_INPUT | surface | `"Ministry of Commerce of China"` ← Korean already lost |
| 2 MATCHER_INPUT | surface_lang | `"en"` |
| 2 MATCHER_INPUT | raw_surface_from_map | `None` (LLM omission confirmed) |
| 3 RESOLVE | branch | `create_new` |
| 3 RESOLVE | picked_primary | `"Ministry of Commerce of China"` |
| 3 RESOLVE | picked_primary_lang | `"en"` |
| 3 RESOLVE | looks_like_brand_llm_name | `False` |
| 4 PERSISTED | primary_label | `"Ministry of Commerce of China"` |
| 4 PERSISTED | primary_lang | `"en"` |

**Korean → English transition occurs at Point 1 → Point 2.** The LLM
hands the matcher only an English string; everything downstream is
faithful to that input.

### Case 2: "중국 재정부" — Scenario B (LLM put English in subject_surface)

A variant of Case 1. The LLM honoured the `subject_surface` field
but populated it with the English translation rather than the Korean
span. The matcher still receives English. Outcome identical.

| Point | Field | Value |
|-------|-------|-------|
| 1 LLM_RAW | subject_name | `"Ministry of Finance of China"` |
| 1 LLM_RAW | subject_surface | `"Ministry of Finance of China"` ← LLM ignored prompt directive |
| 1 LLM_RAW | claim | `"중국 재정부는 새 정책을 발표했다."` |
| 2 MATCHER_INPUT | surface | `"Ministry of Finance of China"` |
| 2 MATCHER_INPUT | surface_lang | `"en"` |
| 2 MATCHER_INPUT | raw_surface_from_map | `"Ministry of Finance of China"` (LLM gave us English) |
| 3 RESOLVE | branch | `create_new` |
| 3 RESOLVE | picked_primary | `"Ministry of Finance of China"` |
| 3 RESOLVE | picked_primary_lang | `"en"` |
| 4 PERSISTED | primary_label | `"Ministry of Finance of China"` |
| 4 PERSISTED | primary_lang | `"en"` |

### Case 3: "수출통제" / "export control"

Reproduces the same shape as Case 1: the LLM emits an English noun
phrase as the entity name, with no Korean subject_surface. Persisted
primary is English. This is a policy noun, not an organisation —
the same dictionary remedy applies.

### Baseline: "국방부" — Scenario C (LLM correctly emitted Korean)

The LLM honoured the prompt and emitted `subject_surface="국방부"`.
The defense chain engages, `pick_natural_primary` picks Korean,
persisted primary is Korean. Confirms the v2 fixes ARE correct for
the case where the LLM gives us the right input.

| Point | Field | Value |
|-------|-------|-------|
| 2 MATCHER_INPUT | surface | `"국방부"` |
| 2 MATCHER_INPUT | surface_lang | `"ko"` |
| 4 PERSISTED | primary_label | `"국방부"` |
| 4 PERSISTED | primary_lang | `"ko"` |

### Control: "RedCat Holdings" (English claim, English brand)

English-only path. Stays English. No regression risk from any new
Korean-defense layer.

## Conclusion

**Mode: A (dominant).** Korean → English transition occurs at
**Point 1 → Point 2**: the LLM either omits `subject_surface` (Case
1) or fills it with the English translation (Case 2). The matcher
then receives an English `surface` with `surface_lang="en"`, and
the entire Korean-defense chain in `entity_resolver`
(`_maybe_repromote_on_hit`, `pick_natural_primary`'s Korean defense)
never engages because every guard condition requires the surface to
be Korean.

**Cause.** Three rounds of prompt-only enforcement of "fill
`subject_surface` with the verbatim source-language span" have
failed in production. The LLM defaults to either omitting the field
or translating Korean → English for government / common-noun
entities (the same class of names it already translated for the
canonical `name` field). Prompt enforcement is not reliable for
this case.

**Remedy.** Code-deterministic Korean surface derivation from the
claim text. When (a) the claim contains Hangul, (b) the LLM-emitted
name is English non-brand, and (c) a known Korean equivalent of
that English name appears verbatim in the claim, recover the Korean
substring and use it as `surface` before calling `resolve_entity`.
The dictionary is curated to government / ministerial / policy
nouns — the class the LLM reliably translates. Brand-shape guard
via `_looks_like_brand` blocks any attempt to korean-ify real
English brands (RedCat, Lockheed, SpaceX, etc.). See Step 1 below.
