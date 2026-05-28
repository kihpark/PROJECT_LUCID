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

(empty — pending first run)

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
