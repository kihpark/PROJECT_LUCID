# feat/prompts-classification-recovery — Discovery

PO directive 2026-06-23 (v0.2.0 graduation gate 2): production facts are
defaulting to `fact_type='action'` 100% of the time, because the LLM is
omitting the `fact_type` field entirely. The Pydantic `StructureFact`
model carries `fact_type: Literal[...] = "action"` as its default, and
`extra='ignore'` swallows unknown fields silently, so the omission is
invisible at parse time and only shows up as a flat distribution in the
recall view.

## Baseline measurements

| metric | value |
| --- | --- |
| `prompts.py` byte size | 42,521 bytes |
| `SYSTEM_PROMPT` length (chars) | 16,161 |
| `FEW_SHOT_EXAMPLES` total | 13 |
| Examples with **all** facts carrying `fact_type` | 7 |
| Examples with **at least one** fact missing `fact_type` | 5 |
| Total facts across all examples | 15 |
| Facts missing `fact_type` | **8 / 15 (53%)** |
| Cache directive | `cache_control: {"type": "ephemeral"}` on the single system block |

The cache key is the full hash of SYSTEM_PROMPT + few-shots + tools — so
any change to either invalidates the cache on next call without any
extra book-keeping.

## Root-cause hypothesis (confirmed by structure inspection)

1. **Mixed signal in few-shots.** Examples 1, 2, 4, 5, 6 (the older
   anchors — Kahneman, EU AI Act, 한국은행 기준금리, 삼성전자 23조,
   삼성 1938) ship without `fact_type` on any fact. The newer examples
   (7+) added during fact-claim-layer-v1 and fact-measurement-layer-v1
   carry it. From the LLM's perspective `fact_type` looks optional.

2. **Schema buries the field in a comment block.** In the
   `# Output format — strict JSON` section the canonical JSON example
   shows `fact_type` once, then the `// v0.2.0 step 1` / `// step 2`
   comment paragraphs imply the field is conditional on the
   classification. There is no MANDATORY callout.

3. **No version tag in the prompt.** The prompt does not carry an
   identifier such as `# prompt v0.2.0-classification-recovery`, so any
   tweak to the few-shots alone is hard to attribute when reading prod
   logs / cache analytics.

## Fix shape (this branch)

- **prompts.py — schema rewrite.** Insert a `## MANDATORY FIELDS PER FACT`
  block right after `# Output format — strict JSON`, enumerating
  `fact_type` first, then the conditional sub-fields for `claim` and
  `measurement`. Add an explicit "Omitting fact_type is a parse failure"
  sentence so the LLM has no excuse.
- **prompts.py — few-shot backfill.** Add `fact_type` to every fact in
  examples 0, 1, 3, 4, 5. Where the fact is obviously a measurement
  (한국은행 기준금리, 삼성전자 영업이익 23조, Kahneman 손실회피계수
  2.25) populate `metric` / `measurement_value` / `measurement_unit` /
  `as_of`. Where it is a pure action (EU AI Act 적용되지 않는다,
  반도체 부문 흑자 전환, 디스플레이 흑자 축소, 삼성 1938 설립) use
  `fact_type='action'`.
- **prompts.py — version tag.** Add
  `# prompt v0.2.0-classification-recovery (force fact_type emission)`
  as the first line of `SYSTEM_PROMPT` so the cache hash changes
  predictably.
- **processor.py — distribution logging.** Insert a `Counter`-based
  `INFO` log right after the `decompose()` call succeeds so the
  fact_type distribution is visible in the structure-stage logs without
  needing to re-index ES. Cost is negligible (~5-20 facts per call).

## Live LLM probe — SKIPPED

PO permission to skip the live probe before applying the fix; the
structural diagnosis above is sufficient. After the patch lands, the
live smokes under `LUCID_LIVE_LLM_SMOKE=1` (the existing
`test_claude_fact_types.py` plus the new `test_classification_recovery.py`)
verify the recovery against PO's WGBI / 출생아 samples.

## Out of scope

- No changes to `StructureFact` Pydantic shape — the data contract is
  stable; only the LLM emission frequency is being repaired.
- No closed enums on `speech_act` / `metric` / `measurement_unit` /
  `as_of` — open natural-language strings remain the contract.
- No changes to `llm-parse-resilient` JSON extractor.
- No version.ts bump, no v0.2.0 tag — graduation gate is for PO.
