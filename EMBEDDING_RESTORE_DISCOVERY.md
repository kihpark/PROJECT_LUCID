# EMBEDDING_RESTORE_DISCOVERY

Branch: `feat/search-embedding-restore` (worktree `worktree-search-embedding-restore`)
Base: `origin/main @ c5cbb80`
PO ground truth: "선거관리위원회" search returns "최저임금위원회" — common substring "위원회".

## 1. Current `get_embedding` implementation

**File:** `backend/api/storage/elasticsearch/embeddings.py:81`

It is **already** a real OpenAI `text-embedding-3-small` wrapper with LRU cache and retry. Returns `tuple[float, ...] | None`. Graceful: no key → None, network error → None after MAX_RETRIES.

This is NOT the bug. The bug is on the **write side**.

## 2. Embedding write path — the real bug

Two callers, both passing `with_embedding=False`:

| File | Line | Call |
| --- | --- | --- |
| `backend/api/routes/validate.py` | 680 | `bulk_module(pending_nodes, with_embedding=False)` |
| `backend/api/routes/validate.py` | 922 | `create_fact(node, with_embedding=False)` |
| `backend/api/storage/elasticsearch/replay.py` | 496 | `create_fact(node, with_embedding=False)` |

Worse: `backend/api/storage/elasticsearch/facts.py::insert_or_dedup_fact` (the B-62 canonical insert path used by `api/structure/processor.py`) **never calls `get_embedding` at all** — there is no `embedding` field in the body dict it indexes (facts.py:425-458).

Net result: every fact ever indexed has empty (missing) `embedding`. kNN against a query vector matches NOTHING (all candidate vectors are missing). The recall code falls through to the entity-name fallback (recall.py:937-960) which uses the wildcard `*위원회*` substring path and returns "최저임금위원회".

## 3. Recall fallback chain — verbatim (recall.py:917-963)

```
1. embedding = get_embedding(q)
   if None: return _empty("embedding_unavailable")
2. hits = _knn_facts_validated_only(...)
3. drop hits below threshold (default 0.72)
4. if not facts:
     matched_entities = _resolve_entities_by_name(q, ks)
     (3-tier: exact keyword → multi_match analyzed → wildcard substring)
     entity_seed_uids = [...]
     if entity_seed_uids:
         seed_hits = _facts_for_entity(entity_seed_uids, ...)
         facts.extend(_hit_to_fact(h) for h in seed_hits)
5. if not facts: return _empty("no_facts_above_floor")
6. expand via _entity_link_facts(...)
```

The **bug surface**: step 4 wildcard `*위원회*` returns ANY entity whose name contains "위원회" — so a search for "선거관리위원회" picks up "최저임금위원회". There is no confidence gate.

## 4. `OPENAI_API_KEY` status

Present in `.env` (worktree-local copy). `grep -c OPENAI_API_KEY .env` → 1 line, value populated.

## 5. Test fixture monkey-patching

`backend/tests/integration/conftest.py:315-331` — `fake_embedding` fixture monkey-patches `get_embedding` in:
- `api.storage.elasticsearch.embeddings`
- `api.storage.elasticsearch.facts`
- `api.storage.elasticsearch.objects`

Returns a tuple of 1536 × 0.5 floats. **MUST NOT BREAK** — existing tests depend on it. Smoke tests in a new `tests/smoke/` dir will need a no-conftest path or explicit reset.

## 6. Existing unit tests at `tests/unit/test_es_embeddings.py`

Already covers: graceful fallback when key missing, LRU cache, empty input. We will add complementary `tests/unit/test_embedding.py` only if there is non-overlapping value — otherwise extend existing file.

## 7. RecallResponse `signature` field

`RecallResponse.signature` exists (recall.py:78 — `SIGNATURE_EMPTY = "검증된 사실이 없습니다"`). PO directive in spec calls for "관련 검증 사실 없음" but the existing empty signature already conveys the same intent. **Decision**: keep the existing `SIGNATURE_EMPTY` to avoid breaking FE copy expectations; if no fallback is confident, emit `_empty("no_confident_match")`.

## 8. Plan summary

1. **Embedding compute is already correct** — keep `get_embedding` as-is. Optional: improve to allow forced-zero (1536 × 0.0) instead of None on `with_embedding=True` callers that previously got `with_embedding=False` (keep None semantics for now, callers strip null).
2. **Wire embedding into the actual write paths**:
   - `validate.py:680` — flip to `with_embedding=True` so dogfood-validate path computes embeddings.
   - `validate.py:922` — flip to `with_embedding=True` for accept-all.
   - `facts.py::insert_or_dedup_fact` — compute embedding on the miss-branch body.
   - `replay.py:496` — keep False (replay is for backfilling old data; backfill script covers it).
3. **Confidence guard in recall**:
   - Add `_is_kNN_meaningful(hits, 0.3)` — but note ES kNN scores are already gated by `RECALL_SCORE_FLOOR=0.72`. The guard becomes redundant; we keep it as a defensive belt-and-braces but log when it would fire.
   - Add `_entity_match_is_confident(query, name, 0.6)` — bigram Jaccard. Apply BEFORE `_facts_for_entity` so unrelated entities never become seed uids.
4. **Backfill tool**: `backend/scripts/backfill_embeddings.py` — scan KS facts, batch-embed claims, update_by_query.
5. **Type count fix (C)**: facets call `_facets_for([f.fact_uid for f in facts])`. Facets count = displayed facts. Already aligned. **Defer** — no obvious mismatch.
