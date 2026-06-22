# Discovery — feat/spo-faithful-korean-decomp

PO directive (2026-06-23): simplify the cumulative SPO prompt constraints
and trust the LLM to do faithful Korean decomposition. Keep
`subject_recovery` as the deterministic fallback for the subject-only case.

## 0.1 — prompts.py clause inventory

### Step 2a — B-52 surface preservation (KEEP, but SIMPLIFY)
Lines ~89-110. Defines `aliases` mechanism. Useful but verbose. KEEP the
aliases idea (we still write aliases on the StructureObject for
cross-lingual recall), SIMPLIFY by deleting the v3 mandate sub-block
under it.

### B-62-fix-v3 verbatim-surface block (REMOVE — entire ~60-line block)
Lines ~111-166. This is the cumulative-constraint culprit. Includes:
  - Hard `subject_surface MUST be verbatim substring` rule
  - Numbered list 1-6 with hard `금지` / `반드시` mandates
  - 4 worked Korean→canonical-English examples ("Ahn Do-geol",
    "Ministry of Commerce of China", "Woori Asset Management", SpaceX)
  - Verbatim-substring constraint on subject_surface / object_surface
  - "name 필드는 별개입니다. LLM 의 canonical 정규화 (영어 정규형 권장)"

This is exactly what flipped the LLM into "translation mode" — the
prompt tells the LLM to produce two languages per entity and use English
for `name`. We REMOVE the entire v3 block.

### Step 2b — B-53 source-language fact text (KEEP, but TRIM examples)
Lines ~168-203. Useful core rule (claim + object_value stay in source
language). Has 3 worked Korean→Bad-English negative examples (75 billion
USD / greenshoe option / 3.0 percent). Replace these with a single
combined block (Korean OK + English OK) so the prompt is shorter.

### Step 3a — B-33 distributive coordination (KEEP unchanged)
Lines ~209-229. Separate concern (coord splitter), not part of the
translation-mode bug. Keep as-is.

### Step 4 — DCR-001 negation (KEEP unchanged)
Lines ~230-248. Separate concern.

### Few-shot examples (TRIM — currently 6, target 3)
Examples 1-3 in original list (lines 337-423) are the canonical seeds:
  - 1: bilingual (Daniel Kahneman + 프로스펙트)
  - 2: KO partial negation (EU AI Act)
  - 3: opinion failure
Examples 4-6 (lines 424-426, single-line condensed dicts) are PR-3-2
adds:
  - 4: 한국은행 기준금리 (KEEP — used by test_structure_prompts_pr3_2)
  - 5: 삼성전자 영업이익 multi-fact (KEEP — used by same test)
  - 6: 삼성 1938 homonym (KEEP — used by same test)
Action: keep examples 1-6 to avoid breaking test_structure_prompts_pr3_2.
The constraint cuts are in the SYSTEM_PROMPT body, not the few-shots.

### NEW rule to add (replaces all the cuts)
Single rule clause: "각 fact 의 subject / predicate / object 는 소스
텍스트의 언어 그대로 표현. 번역·정규화·canonical 변환 금지." with two
1-line worked examples (Korean + English).

## 0.2 — Schema strict-fields inventory

### `LucidBaseModel` (api/models/base.py)
- `extra="forbid"`  (project-wide; protects against retired DR-053 fields)
- Inherited by StructureResult, StructureObject (current sources of
  validation failures when the LLM emits extra fields like
  `entity_type`, `person_origin`, or `top_level_extra_field`)

### `StructureFact` (already loose)
- `model_config = ConfigDict(extra="ignore", ...)` ✓ already correct
- Required: uid, claim, type_, subject_uid, predicate, object_value
- Optional already: subject_surface, object_surface, negation_*,
  tags_suggested

### `StructureObject` (BLOCKING — inherits forbid)
- Inherits `extra="forbid"` from LucidBaseModel — **this is one likely
  source of the live ValidationError today**: if the LLM emits
  `entity_type` or `person_origin` (which prior round attempts
  encouraged), validation fails.
- Required: uid, class_ (alias `class`), name
- Optional: name_en, aliases, properties
- **FIX**: add `model_config = ConfigDict(extra="ignore", ...)` to
  StructureObject so LLM extras are silently dropped (matching the
  StructureFact precedent — same DR-053 isolation since
  storage-layer Object models keep their own `extra="forbid"`).

### `StructureResult` (BLOCKING — inherits forbid)
- Inherits `extra="forbid"` from LucidBaseModel.
- Required: extraction_status
- Optional default: everything else (facts/objects/links default to [])
- **FIX**: same `extra="ignore"` override. The LLM can add a top-level
  field (e.g. it stamps `"version": 1` or `"comment": "..."`) and the
  whole envelope fails validation.

### `StructureFactObjectLink` (BLOCKING — inherits forbid)
- Same fix: `extra="ignore"`. The LLM may pad these with extras.

### `StructureDisambiguation` (BLOCKING — inherits forbid)
- Same fix.

## 0.3 — Live failure trace path

### Current capture path

`process_extracted_job` (processor.py:618)
  → `decompose` (decomposer.py:21)
    → `decompose_via_claude` (claude_client.py:114)
      → SDK call → text blocks → `_parse_json_safely` (JSON ok)
      → `_build_result` (claude_client.py:203)
        → **`StructureResult.model_validate(parsed)`** ← FAILS HERE
        → except clause logs only `exc` (NOT `e.errors()`) on line 214
        → returns empty `_empty_failure("malformed_llm_output")`
  → back in decomposer, sees facts=[], extraction_status=no_facts_found
  → back in processor, surface_map is empty → no _match_object loop
  → **The recovery layer NEVER fires** because Pydantic killed the
    entire envelope before any fact reached the violation check.

### Fix order
1. **First**: log `e.errors()` in claude_client.py line 214 so we have
   field-level evidence in production logs.
2. **Then**: relax the schemas (extra="ignore") so the natural LLM
   response shape passes.
3. **Then**: simplify the prompt so the natural shape is the right one.
4. Keep claim_recovery as the per-fact safety net (its dispatch in
   `_match_object` was already wired by 6th round; it stays).

## 0.4 — One-line log enhancement plan

In `claude_client.py:213-216` replace the bare `logger.warning(...)`
with two lines that include `getattr(exc, 'errors', lambda: None)()`
when ValidationError, plus a truncated preview of the parsed dict.
