# SPO Decomposition Completeness — Discovery

## 0.1 Current prompt (`backend/api/structure/prompts.py`)

### FAITHFUL DECOMPOSITION RULE (PR-2, Step 2a)

```
FAITHFUL DECOMPOSITION RULE (PO 2026-06-23):

각 fact 의 subject / predicate / object 는 **소스 텍스트의
언어 그대로** 표현하세요. 번역·정규화·canonical 변환·
로마자화 자체가 위반입니다.
```

— Talks about *language* (KO → KO, EN → EN). Says NOTHING about completeness of phrases.

### Predicate-related clauses (PR `spo-decide-payload-wire`, Step 2b)

```
PREDICATE 도 동사구 그대로 (PO 2026-06-23, decide-payload-wire):
predicate 는 source 언어의 동사·서술어를 그대로 사용:
  한국어 기사: "선출했다", "출신이다", "발표했다", "올렸다",
               "조달했다", "축소되었다"
```

— All examples are bare verbs! "올렸다", "발표했다" — the prompt is literally training the LLM to drop modifier/target phrases. This is the load-bearing cause: the LLM sees the rule + examples and concludes "predicate = bare verb token". Need to recalibrate without re-introducing translation pressure.

### Current few-shot examples — 6 total
1. KO + EN proposition (Kahneman + Prospect Theory)
2. KO partial negation (EU AI Act)
3. KO opinion failure (coffee)
4. KO base interest rate (single fact)
5. KO Samsung quarterly (3 facts, predicates like `기록했다`, `전환했다`, `축소되었다` — all bare verbs)
6. KO Samsung founding (1938)

ALL few-shot Korean predicates are bare verbs: 기록했다 / 전환했다 / 축소되었다 / 기준금리였다 / 설립되었다 / 평균이다. Same problem — the LLM models its own output on this pattern.

## 0.2 PR-2's prompt simplification — gap

The simpler prompt removed verbatim mandate to fix translation-mode pressure. But it also:
- Steered predicate examples toward bare verbs ("올렸다") — the LLM strips `수출통제 대상에` modifier
- Steered object examples toward short noun phrases ("3.0%") — the LLM strips `미국 기업` modifier

We need ONE clause that says "합쳐서 원문 의미 보존". Not a translation rule. A meaning-coverage rule.

## 0.3 Where decomposition lands

- `decompose()` → `backend/api/structure/decomposer.py` returns `StructureResult` with `.facts: list[StructureFact]`
- Each `StructureFact` has `.claim`, `.subject_uid`, `.subject_surface`, `.predicate`, `.object_value`, `.object_surface`
- The processor walks facts in `process_extracted_job` (lines 845-855):
  ```
  facts_payload = [
      _serialize_struct_fact(f, uid_map=..., violation_per_object=..., 
                             match_per_object=..., decomp_objects=...)
      for f in decomp.facts
  ]
  ```
- **Insertion point**: `_serialize_struct_fact` in `processor.py` (~line 435). Already computes `needs_review` from `surface_violation | predicate_violation | predicate_mapper.needs_review`. Add a `completeness_violation` term.

## 0.4 Available signals for validation

- `fact.claim` — the original sentence (e.g. "중국 정부가 미국 기업 10곳을 수출통제 대상에 올렸다.")
- `corrected_subject_label` — already computed inside `_serialize_struct_fact` via `_resolve_label(subj_uid_raw)` (matches `match_per_object`'s corrected primary_label, falls back to LLM raw `name`)
- `fact.predicate` — predicate verb phrase
- `fact.object_value` — object surface (literal string or obj-N placeholder; only literals matter for content tokens)

For completeness check, we union the SURFACE content tokens of (subject_label, predicate, object_value) and verify they cover the claim's content tokens. Korean particles need stripping (은/는/이/가/을/를/의/에/...).

The validator is deterministic — no LLM call. Just particle strip + content-token set membership. Threshold 0.7 chosen because:
- 0.5 too lax (allows half-missing modifiers)
- 0.8 too tight (legitimate concise decomps fail when one stopword-like token drops)
- 0.7 catches "10곳" failing the "미국 기업 10곳을 수출통제 대상에 올렸다" coverage (3/8 = 0.375) while letting good decomps pass.
