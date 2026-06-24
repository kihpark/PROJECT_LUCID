# Measurement Layer Discovery — v0.2.0 step 2 (fact-measurement-layer-v1)

PO directive 2026-06-23: Fact 3-way split, step 2 of 3.

> **3) 수치 (Measurement)** — 시점에 매인 값
> - 본질: numeric data
> - 구조: `{ metric, entity, value(numeric), unit, as_of(시점), source }`
> - 핵심: as_of(시점). 같은 metric 의 여러 시점 → **시계열.** 검증된 시계열은
>   노트앱/LLM 이 못 만드는 해자.
> - 예: `{ metric: MAU, entity: ChatGPT, value: 800000000, unit: 명, as_of: 2026-03 }`

Step 1 (action vs claim) shipped at commit add4332 / main 7e182a5. This PR
extends that work with a 3rd `fact_type='measurement'` bucket carrying 4 new
fields (metric / measurement_value / measurement_unit / as_of). Step 3
(contradiction detection) is DEFERRED to a future round.

## 0.1 Current state of `fact_type` enum

`backend/api/structure/models.py::StructureFact` currently has:

```python
fact_type: Literal["action", "claim"] = "action"
speaker_uid: str | None = None
speaker_label: str | None = None
speech_act: str | None = None
content_claim: str | None = None
stance: str | None = None
```

Extend `fact_type` literal to `Literal["action", "claim", "measurement"]`.
Default stays `"action"` so legacy / silent payloads still bucket cleanly.

### Naming rationale — `measurement_value` / `measurement_unit`

The PO spec names the fields `value` and `unit`, but those collide with
existing pydantic / pythonic uses (`value` is a built-in property name on
many shapes, `unit` is reserved-feeling). To keep the FactNode storage
shape orthogonal to claim-field naming and avoid any silent collision at
ES-index time, the persistence shape uses prefixed names:

- `metric: str | None` — unchanged from spec
- `measurement_value: float | None` — value is a float (see below)
- `measurement_unit: str | None` — open string
- `as_of: str | None` — open string (ISO date / year-month / quarter)

### `measurement_value` as `float` (not `Decimal`)

The PO use cases — MAU (8 hundred million), 매출 (70 조 원), 실업률 (3.4%) —
all fit safely inside an IEEE-754 double. JSON has no native Decimal,
ES `double` is the closest analog, and the LLM emits raw numerics. The
exactness gain from Decimal isn't worth the round-trip cost (Decimal →
str → JSON → float at ES, Decimal → str → JSON → str → ES if we forced
storage as string). When precision-critical metrics show up (currency
sub-cent accounting), we add a separate `currency_value` Decimal field
behind a `metric_kind` tag — not in scope here.

## 0.2 prompts.py — existing Step 2c (verbatim)

The current Action vs Claim clause (lines 174–198) is reproduced below
verbatim. The new clause replaces this block with a 3-way classification
guide while keeping the prior wording for action / claim and ADDING a
parallel measurement section + few-shot examples.

```
  Step 2c. RULE — fact 유형 분류 (Action vs Claim — v0.2.0 step 1):

          각 fact 가 다음 둘 중 어디에 속하는지 분류하세요. fact_type 필드.

            - action: 사건/행위 — "X가 Y를 했다"
            - claim:  발화/주장/관측 — "X가 ~라고 말했다",
                                       "X가 ~할 것이라 전망했다"

              'claim' 의 본질 = "누가 무엇을 말했나" (one-hop provenance).
              Lucid 는 화자의 말 자체를 fact 로 인정하되, 그 내용 진실은
              보증하지 않음.

              fact_type='claim' 이면 추가 필드:
                - speaker:       발화 주체 (한국어 surface)
                - speech_act:    발화 행위 (원문 동사 그대로 — 강제 enum 없음)
                - content_claim: 발화 내용 (한국어 문장)
                - stance:        supportive | critical | neutral | mixed | unknown

          분류 가이드:
            - 동사 '발표했다', '추가했다', '올렸다', '발사했다' = action
            - 동사 '밝혔다', '주장했다', '말했다', '전망했다',
                  '예측했다', '논평했다' = claim
            - "X가 [Y는 ...]고 말했다" = claim (content 분명)
            - 한 문장에서 둘 다 나오면 별도 fact 두 개
```

Existing few-shot examples for action / claim (lines 434–511 in prompts.py)
remain untouched. We APPEND two measurement few-shots after them.

## 0.3 ES mapping additions

`backend/api/storage/elasticsearch/mappings.py::LUCID_FACTS_MAPPING` already
has the claim-side fields:

- `fact_type: keyword`
- `speaker_uid / speaker_label / speech_act: keyword`
- `content_claim: text` (korean_analyzer)
- `stance: keyword`

ADD 4 new properties:

- `metric: keyword` — exact-match facet / aggregation; free-form Korean
  surface (no controlled vocabulary at extraction time)
- `measurement_value: double` — numeric for range queries + future
  time-series aggregation
- `measurement_unit: keyword` — open string ("명", "조 원", "%", "달러")
- `as_of: keyword` — open string ("2026", "2026-03", "2026-Q1",
  "2026-03-23"); kept as keyword (not `date`) because the LLM emits
  ranges / approximations that no single date format covers

`ensure_mappings()` auto-syncs additive properties on the next backend
restart — no migration needed.

## 0.4 Recall facet expansion

`backend/api/models/recall.py::FactTypeFacets` currently has:

```python
class FactTypeFacets(BaseModel):
    action: int = 0
    claim: int = 0
```

Extend with `measurement: int = 0`. The `_facets_for` aggregation already
runs a `fact_type` terms agg; we add a third bucket branch.

`RecallFact` adds 4 optional fields mirroring the StructureFact shape:
`metric / measurement_value / measurement_unit / as_of` (all None on
non-measurement facts; the FactCard branches on `fact_type=='measurement'`).

## 0.5 Frontend (FactCard / RecallView)

- `FactSummary` and `RecallFact` types gain 4 optional measurement fields.
- `fact_type` literal widens to `'action' | 'claim' | 'measurement' | null`.
- `FactCard.tsx`: when `fact.fact_type === 'measurement'`, render a
  `[MEASUREMENT]` badge (warm color so it differentiates from the cool
  `[CLAIM]`) AND a formatted strip below the claim showing
  `metric = value (locale-formatted) unit (as_of)`.
- `RecallView.tsx::SearchControlsPanel` adds a `[수치]` toggle that filters
  `fact_type='measurement'` from the rendered list (client-side, like
  claimOnly).
- `FactTypeFacets` TS interface adds `measurement: number`.

## 0.6 Tests (target shapes)

- Unit (`backend/tests/unit/test_measurement_fact_classification.py`):
  ~7 cases pinning StructureFact + _serialize_struct_fact shape.
- Integration (`backend/tests/integration/test_measurement_pipeline.py`):
  ~3 cases for serializer + facet aggregation.
- Smoke (`backend/tests/smoke/test_claude_measurements.py`):
  ~3 live-LLM cases gated by `LUCID_LIVE_LLM_SMOKE=1`.
- Frontend (`frontend/web/tests/FactCard.test.tsx` extensions):
  ~4 cases pinning badge + measurement strip + locale formatting.

## 0.7 Out of scope

- Contradiction detection (PO step 3 deferred)
- Entity meta-network expansion (separate round)
- Time-series re-aggregation on measurement (later: render same metric
  across multiple as_of as a chart)
- Decimal precision for currency metrics (later: add `metric_kind`)
- alembic migration (ES-only; mappings auto-sync)
