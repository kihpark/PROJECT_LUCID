# MEASUREMENT_COMPLETENESS_DISCOVERY (v0.2.0 step 2.5)

Branch: `feat/measurement-completeness`
Base:   `3e157fc` (v0.2.0 step 2 shipped — measurement layer)
Date:   2026-06-24

## Problem (PO verbatim, 2026-06-24)

For a captured fact `노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.`:

| field | stored | verdict |
|---|---|---|
| fact_type | measurement | ok |
| claim | (원문 verbatim) | ok |
| metric | `최초 요구안 차이` | bad — drops `노사 양측의`, `시급 기준` |
| measurement_value | 1680.0 | ok |
| measurement_unit | 원 | ok |
| as_of | `2027` | bad — application time, NOT measurement time |
| completeness | `{complete: False, coverage: 0.25, missing: [...]}` | validator already catches via the SPO check, but not for the measurement quadruple — accidental |
| needs_review | True | ok |

PO directive: **surface = faithful, structure = metadata on top**. Measurement
must not throw away the original sentence.

## 0.1 Sample patterns — metric loss

Across the 노사 case + the existing PO regression suite (`test_claude_measurements.py`), the LLM loses qualifiers in this priority order:

1. **Subject qualifier** dropped most often — `"노사 양측의"`, `"OpenAI 의"`, `"삼성전자 의"`. The metric becomes a bare noun (`차이`, `매출`, `MAU`).
2. **Basis qualifier** next — `"시급 기준"`, `"Q1 기준"`, `"WHO 기준"`. These map to the LLM's mental model of "context" and get pushed to `as_of` or dropped entirely.
3. **Temporal qualifier** when present — the LLM often correctly pulls `"2026년 3월 기준"` into `as_of`, but when the qualifier is `"적용"` / `"시행"` it incorrectly persists into `as_of` as well (the 노사 `2027` bug).
4. **Method qualifier** rarely — `"WHO 기준"`, `"국제기준"`. Almost never preserved.

## 0.2 FactCard.tsx render — claim text DOES render

Read of `frontend/web/components/FactCard.tsx`:

- Lines 499–510: claim text renders verbatim in non-edit mode (`{displayClaim(fact, lang)}`) — the original sentence is always shown.
- Lines 543–589: measurement strip renders BELOW the claim text — `[MEASUREMENT] {metric} = {value} {unit} (as_of)`.
- Lines 591–608: SPO dl renders BELOW the strip (text-xxs, font-mono).

Order is:
1. Claim text (`p` element, text-base) — prominent
2. Measurement strip (font-mono, text-sm)
3. SPO grid (text-xxs)

**Finding**: claim text is NOT hidden. The earlier PO concern ("chip 중심이라 원문 안 보임") was a misreading — the chip+strip coexists with the original sentence already. The real lever PO wants is **emphasis tuning**: ensure the strip never visually competes with the claim, and ensure the claim is rendered with a distinguishable `data-testid` we can regression-check.

### Decision (this PR)
- Keep the current order (claim first, strip second). Add a `data-testid="fact-claim-${factUid}"` on the claim `<p>` (it's there — line 503 — good).
- Make claim text visible in a new test: when fact is `fact_type='measurement'`, BOTH `fact-claim-${uid}` and `fact-measurement-strip-${uid}` must be in the DOM.
- Adjust the measurement strip to label itself `[MEASUREMENT]` prefix to give the chip metaphor visual identity vs the claim sentence — and document that the strip is a derived view, not a replacement.

## 0.3 Completeness validator — current scope SPO-only

`backend/api/structure/completeness_validator.py::check_completeness(claim, subject, predicate, object_text, *, coverage_threshold=0.7)`:

- Tokenizes claim → content-token set (Korean particle strip + punct strip + stoplist).
- Tokenizes `subject + predicate + object_text` → SPO content-token set.
- Coverage = fraction of claim tokens present in SPO tokens.
- Returns `{complete, missing, coverage, reason}`.

Plan: add a sibling `check_measurement_completeness(claim, metric, measurement_value, measurement_unit, as_of, entity_label, *, coverage_threshold=0.7)`. Same tokenization. Quadruple is `(entity_label, metric, value-as-str, unit, as_of)`. The processor branches on `fact.fact_type == 'measurement'`.

The 노사 case (good vs bad):
- claim `노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.`
- claim_tokens ≈ {노사, 양측, 최초, 요구안, 차이, 시급, 기준, 1680원, 이다}
  (이다 is stoplisted; 1680원 stays a content token; tokens may split further on `원` — handled by the existing tokenizer behavior).
- BAD quad: metric=`최초 요구안 차이`, unit=`원`, as_of=`2027`, value=`1680`, entity=`(none)` → coverage drops because `노사, 양측, 시급, 기준` not in quad.
- GOOD quad: metric=`노사 양측의 최초 요구안 차이 (시급 기준)`, unit=`원`, as_of=`null`, value=`1680`, entity=`노사` → coverage covers `노사, 양측, 최초, 요구안, 차이, 시급, 기준, 1680`.

## 0.4 as_of disambiguation patterns

Currently observed:

| pattern | as_of correctly null? | example |
|---|---|---|
| measurement time literal | YES — populated | `"2026년 3월 기준 MAU"` → `as_of="2026-03"` |
| measurement time + 이다/이었다 | YES — populated | `"2025-Q4 GDP 성장률 3%"` → `as_of="2025-Q4"` |
| application/시행 시점 | NO — incorrectly populated (PO's 노사 bug) | `"2027년 적용 최저임금"` → as_of="2027" wrong; should be null |
| 발효 시점 | NO — same failure mode | `"2026년 7월 발효되는 ..."` → as_of erroneously becomes "2026-07" |

**Resolution**: the prompt must teach the LLM that `as_of` = "measurement time" only. When the source says "적용", "시행", "발효", "예정", the LLM must leave `as_of=null` and leave the application-time information in the `claim` surface (which it already does — claim is faithful by step 2a).

## Implementation plan

1. **Prompt (Step 2c)** — append measurement-completeness rule + as_of disambiguation. 2 KO few-shots:
   - 노사 case: rich metric vs thin metric.
   - application-time case: as_of=null with surface explanation.
2. **Validator** — add `check_measurement_completeness`.
3. **Processor** — branch on `fact.fact_type == 'measurement'`.
4. **Tests** — unit (~7), integration (~3), live smoke (~3), FactCard (~2 — chip+claim coexist, needs_review surface).
5. **FactCard / RecallView** — claim text already visible; add regression test and document the contract.

## Constraints respected

- No `applies_at` / `measurement_time` split — `as_of` stays single, can be null.
- No enum on metric.
- Step 1 (action/claim) untouched.
- Entity meta-network untouched.
- ES mapping unchanged.
- SPO validator for action/claim untouched.
- Pure-action regression (`"10곳을 올렸다"` stays action) preserved.
