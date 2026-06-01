# Sprint 3 baseline — Structure decomposer accuracy + latency

**Status:** methodology locked; first run pending PO with real
ANTHROPIC_API_KEY. Re-run after every meaningful change to the
system prompt or model.

## Method

50 baseline samples in `backend/tests/baseline/samples.json`. Each
sample has a manually-annotated ground truth (expected fact count,
negation flag count + scope, expected extraction_status + failure
reason). The harness `backend/tests/baseline/measure_baseline.py`
runs `decompose()` over each sample and compares.

### Sample distribution

| Category | Count |
|----------|-------|
| Plain proposition (KO) | 8 |
| Plain proposition (EN) | 7 |
| Procedure (KO) | 5 |
| Procedure (EN) | 5 |
| Negation — full (KO + EN) | 5 |
| Negation — partial (KO + EN) | 3 |
| Negation — ambiguous (KO + EN) | 2 |
| Homonym disambiguation candidates | 5 |
| Multi-fact compound (3-5 facts) | 5 |
| Non-decomposable (opinion / ad / creative / ambiguous attribution) | 5 |
| **Total** | **50** |

Languages: 25 Korean, 25 English (mixed homonyms count as bilingual).

### Metrics

| ID | Metric | Target |
|----|--------|--------|
| M1 | Fact-count mean absolute error vs ground truth | < 0.6 |
| M2 | Negation-flag accuracy (correct flag count / negation cases) | ≥ 80% |
| M3 | Failure-reason precision (correct reason / failure cases) | ≥ 80% |
| L50 | Latency p50 | ≤ 4000 ms |
| L95 | Latency p95 | ≤ 8000 ms |
| Cost | Total $ for full 50-sample run | ≤ $0.40 |

Targets are **internal** — they are diagnostic, not contractual.
Negation accuracy is the headliner because DCR-001 lives or dies on
the Structure stage's ability to read negation correctly.

## How to run

```bash
cd backend
ANTHROPIC_API_KEY=sk-ant-... python -m tests.baseline.measure_baseline
```

Outputs:
- Console: per-sample line + aggregate JSON
- `docs/sprint-3-baseline-results.json`: full row-by-row + summary
- Append the summary to the "Run history" section below by hand

## Run history

## Run 2026-05-29 (first real run)

**Model:** `claude-sonnet-4-5`  (50/50 samples real API; no mock fallback)
**Prompt caching:** confirmed working — total **663** input tokens across 50 calls (system prompt cached after sample 1).

### Aggregate

| Metric | Result | Target | Status |
|--------|--------|--------|--------|
| M1 fact-count MAE | 0.50 | < 0.6 | PASS |
| **M2 negation accuracy** | **87.5%** (8 cases) | ≥ 80% | **PASS** |
| M3 failure-reason precision | 85.7% (7 cases) | ≥ 80% | PASS |
| L50 latency | 6002 ms | ≤ 4,000 ms | MISS |
| L95 latency | 14203 ms | ≤ 8,000 ms | MISS |
| Cost | $0.26 | ≤ $0.40 | PASS |
| Input tokens | 663 | (prompt caching) | observed |
| Output tokens | 17,235 | — | observed |

### Decision

**M2 = 87.5% > 80% target → Sonnet 4.5 confirmed as the beta default. Haiku A/B not required.**

### Per-category status pass rate

| Category | OK / Total | Pass rate |
|----------|------------|-----------|
| failure_ad | 1/1 | 100% |
| failure_ambig | 1/1 | 100% |
| failure_creative | 1/1 | 100% |
| failure_opinion | 2/2 | 100% |
| homonym | 4/5 | 80% |
| multi_fact | 3/5 | 60% |
| negation_ambiguous | 0/2 | 0% |
| negation_full | 5/5 | 100% |
| negation_partial | 2/3 | 67% |
| procedure | 9/10 | 90% |
| proposition | 10/15 | 67% |

### Mismatches (12 / 50)

- `ko-prop-003` (proposition) — expected `success`, got `no_facts_found` (facts 1→0, neg 0→0)
- `ko-prop-005` (proposition) — expected `success`, got `no_facts_found` (facts 1→0, neg 0→0)
- `ko-prop-006` (proposition) — expected `success`, got `no_facts_found` (facts 1→0, neg 0→0)
- `en-prop-003` (proposition) — expected `success`, got `no_facts_found` (facts 1→0, neg 0→0)
- `en-prop-005` (proposition) — expected `success`, got `no_facts_found` (facts 1→0, neg 0→0)
- `ko-proc-001` (procedure) — expected `success`, got `no_facts_found` (facts 1→0, neg 0→0)
- `ko-neg-part-002` (negation_partial) — expected `success`, got `no_facts_found` (facts 2→0, neg 1→0)
- `ko-neg-amb-001` (negation_ambiguous) — expected `no_facts_found`, got `success` (facts 0→1, neg 0→1)
- `en-neg-amb-001` (negation_ambiguous) — expected `no_facts_found`, got `success` (facts 0→1, neg 0→1)
- `ko-hom-001` (homonym) — expected `success`, got `no_facts_found` (facts 1→0, neg 0→0)
- `ko-multi-001` (multi_fact) — expected `success`, got `no_facts_found` (facts 3→0, neg 0→0)
- `ko-multi-002` (multi_fact) — expected `success`, got `no_facts_found` (facts 3→0, neg 0→0)

### Observations + follow-ups

1. **Korean propositions under-extract (3/8 returned no_facts_found):**
   `ko-prop-003`, `ko-prop-005`, `ko-prop-006`. Likely cause: the prompt's
   "PRECISION over RECALL" guidance bites on simple statistical claims
   ("한국은행 기준금리 3.0%", "ChatGPT 월간 사용자 2억 명"). Mitigation
   options for a follow-up prompt revision:
   - Add a few-shot example of a single-statistic proposition.
   - Soften the conservatism for plain factual statements with explicit
     numeric values.
2. **English propositions miss 2/7** — `en-prop-003` (BTC market cap) and
   `en-prop-005` (Fed rate hike). Same pattern as Korean.
3. **Korean partial-negation under-extract (1/3)** — `ko-neg-part-002`
   ("공복 유산소는 fat loss 에 차이가 없지만 식후 유산소는 …") returned
   no_facts_found. The "X is not Y, but X is Z" compound is rare in
   the few-shot set; consider adding a second partial-negation example
   in `prompts.py::FEW_SHOT_EXAMPLES`.
4. **Korean multi-fact compounds (2/3 miss)** — `ko-multi-001` and
   `ko-multi-002` returned no_facts_found despite containing 3 distinct
   facts. English compounds (`en-multi-001`, `en-multi-002`) extracted
   3-5 facts correctly. KO compound handling is a known weakness; PR-3-2
   prompt iteration should target this.
5. **Ambiguous negation (2/2 over-extract)** — both ambiguous negation
   cases produced facts where the ground truth expected
   `failure_reason='negation_ambiguous'`. The model interpreted "AI가
   모든 직업을 대체하지는 않을 것" as a forecast statement worth
   extracting. The prompt's `negation_ambiguous` definition may need
   examples of forecast/conditional language.
6. **Latency targets missed** — p50 6.0s vs target 4s; p95 14.2s vs
   target 8s. Sonnet 4.5 on long Korean compounds runs slow. This is
   tolerable for beta (Decide overlay polls /api/jobs every 1-2s, user
   sees a "extracting..." state); revisit if user complaints arise.
   Caching saved input tokens but not output latency.
7. **Cost well under target** — $0.26 vs $0.40 target. Prompt caching is
   working: ~13 input tokens per sample after the first. Output tokens
   dominate cost ($0.26 = ~$0.25 output + ~$0.002 input).

### Re-test trigger conditions

Re-run this baseline when any of the following change:
- `prompts.py` SYSTEM_PROMPT body (any non-cosmetic edit)
- `prompts.py` FEW_SHOT_EXAMPLES
- `CLAUDE_MODEL` env default
- `samples.json` schema (re-annotate ground truth too)


## Known limitations

- Ground truth was annotated by the PO; multi-fact compounds have
  some judgement calls on whether a clause is one fact or two.
- Whisper transcripts (Sprint 2C) are not in this baseline because
  the Structure stage takes merged_text, not raw audio; the audio
  path is implicit through the Capture stage.
- This baseline does NOT test Object disambiguation accuracy
  (PR-3-2 scope). It does emit `disambiguation_candidates` arrays
  but does not compare them against ground truth in this version.

## How to add samples

Append to `samples.json` with the schema documented in
`samples.json[0]`. Keep the category distribution within ±2 of the
above counts so M1/M2/M3 stay comparable across runs.
