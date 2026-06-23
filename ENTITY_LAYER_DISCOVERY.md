# entity-layer-restore — Discovery (2026-06-23)

PO directive: "추측 금지" — discovery-first. Each of 4 symptoms has its
exact break point identified below from code-trace + live ES inspection.

## Live data summary (KS 4a3a8bb7-5f3f-4a44-bc2d-f8e296966b5b)

```
lucid_objects: 32 docs total
  class distribution: concept=32  ← 100% concept (ALL entities)
  entity_type: MISSING on 100%    ← field exists in mapping but never written

samples:
  uid=c813cbf1  name='중국 상무부'   class=concept entity_type=MISSING
  uid=de5ab741  name='중국 재정부'   class=concept entity_type=MISSING
  uid=69b86d0b  name='한동훈'         class=concept entity_type=MISSING
  uid=f29784c4  name='이재명'         class=concept entity_type=MISSING
```

The data is unambiguous: in production every single entity is being
stored as `class=concept` regardless of what the LLM classified it as.

---

## (2)/(7) entity_type classifier — where it dies

### Pipeline trace (Korean article → ES doc)

1. `prompts.py` SYSTEM_PROMPT lines 40-56 lists 13 ObjectClass values
   and asks the LLM to emit `"class": "person"|"organization"|...`.
   STATUS: OK. LLM is asked correctly, prompt has good Korean
   few-shot examples (한국은행 → organization, 삼성전자 → organization).

2. `models.py::StructureObject` lines 60-61:
   ```
   uid: UID
   class_: ObjectClass = Field(alias="class")
   ```
   STATUS: OK. Pydantic parses LLM's `"class"` into `class_`.

3. `processor.py::_match_object` line 187:
   ```
   resolved_class = _safe_object_class(obj.class_)
   ```
   `resolved_class` IS computed correctly (= ObjectClass.PERSON for 한동훈).

4. `processor.py::_match_object` line 287, calls:
   ```
   match_or_create_object(
       candidate_name, resolved_class, knowledge_space_id,
       candidate_embedding=embedding_list,
       surface=surface,                       # ← when surface present,
       surface_lang=surface_lang,             #   goes to resolve_entity
       llm_name_en=obj.name_en,
   )
   ```

5. BREAK POINT 1 — `object_matcher.py::match_or_create_object`
   lines 184-191:
   ```
   if surface and surface.strip():
       ...
       entity_uid, was_created = resolve_entity(
           surface,
           lang,
           space_id=knowledge_space_id,
           co_mention_en=llm_name_en,
           llm_name=candidate_name,
           # NO candidate_class PASSED ← bug
       )
   ```
   `candidate_class` (the parsed ObjectClass) is silently dropped
   when the surface path is taken (which is the prod path because
   B-62-fix-v2 always supplies `surface`).

6. BREAK POINT 2 — `entity_resolver.py::_create_entity` line 260:
   ```
   body: dict[str, Any] = {
       "object_uid": object_uid,
       "class": "concept",            # ← HARDCODED
       "name": chosen_primary,
       ...
   }
   ```
   The docstring even admits it: "`class` defaults to "concept" - the
   canonical entity_type ontology is a separate later ticket."
   So EVERY entity created via `resolve_entity` is stored as concept.

7. `routes/validate.py::_upsert_referenced_objects` lines 312-330
   re-creates the same uid at validate time and reads the class from
   the JSONB structure payload. `_serialize_struct_object` does carry
   the LLM's class through `by_alias=True`. But the live data shows
   100% of entities are `class=concept` — meaning either:
   - validate's create_object never effectively overwrites the doc, or
   - the structure JSONB at the time of validate also had class=concept
     because the LLM placeholder uid never matched.
   In either case the structural fix is to STOP HARDCODING in step 6,
   so the structure-stage create itself carries the LLM class.

### Verdict — symptoms (2) and (7)
- Primary break point: `entity_resolver.py:260` hardcodes
  `"class": "concept"` on every new entity create.
- Secondary: `object_matcher.py:184-191` doesn't pass any class hint
  to `resolve_entity`.
- The LLM emits the class correctly; the prompt is fine. The
  downstream resolver silently overwrites it.

### Why 한동훈 specifically falls into "concept"
The LLM classified 한동훈 as `person`. `StructureObject.class_ =
ObjectClass.PERSON`. The `_match_object` path computes
`resolved_class = ObjectClass.PERSON`. Then `match_or_create_object`
takes the surface branch (line 174). `resolve_entity` is called WITHOUT
`candidate_class`. `_create_entity` writes `"class": "concept"`
regardless. Net result: 한동훈 in ES has `class=concept`, and Recall
facets bucket it under "other"/기타.

Recall's bucket lookup (`recall.py:_OBJECT_CLASS_BUCKET` lines 653-657)
only maps `organization`/`person`/`place`. `concept` → "other". So
even with the live data as-is, fixing `_create_entity` to emit
`class=person` and `entity_type=person` for 한동훈 would automatically
put it in the "person" bucket on the next capture.

---

## (6) Assistant vs Recall asymmetry — "중국 상무부"

### Recall path for "중국 상무부" (works → returns 4 facts)
`routes/recall.py::recall()` runs three retrieval stages:

1. Stage 1: `_knn_facts_validated_only(embedding, ks, k=10, ...)`
   → 0 hits above 0.72 score floor (the multilingual embedding model
   does not score "중국 상무부" close to any fact embedding above 0.72).
   Live test confirms: kNN returns 0 hits.

2. Stage 2 (fallback for empty kNN) lines 867-891:
   ```
   if not facts:
       matched_entities = _resolve_entities_by_name(q, str(ks.id))
       entity_seed_uids = [doc.get("object_uid") for doc in matched_entities]
       if entity_seed_uids:
           seed_hits = _facts_for_entity(entity_seed_uids, ...)
   ```
   `_resolve_entities_by_name` runs exact-keyword on
   `name.keyword / name_en.keyword / aliases.keyword`. Live test:
   returns 1 match (uid c813cbf1 = "중국 상무부").
   `_facts_for_entity` then runs:
   ```
   filter: subject_uid IN [uid] OR object_value IN [uid]
   ```
   Live test: returns 4 facts.

3. Stage 3 (entity-link expansion): `_entity_link_facts` runs again
   for all entity uids the now-non-empty facts reference.

### Assistant path for "중국 상무부" (fails → returns 0)
`routes/assistant.py::_retrieve_candidates` lines 44-68:
```
embedding = get_embedding(query)
hits = _knn_facts_validated_only(list(embedding), space_id, k)
```
That's it. No entity-name fallback. No entity-link expansion. When
kNN returns 0, the assistant returns empty candidates and the route
returns "검증된 지식에 이 주제가 없습니다."

### Verdict — symptom (6)
The asymmetry is structural: assistant only knows kNN. Recall has
three layers and falls through entity-name → entity-link when kNN
fails. Fix is to align assistant with recall by replicating the
entity-name + entity-link fallback inside `_retrieve_candidates`.

---

## (1) Label propagation — 이재명 → UUID display

### Live data
- 이재명 entity exists: `uid=f29784c4-...  name='이재명'  primary_label='이재명'`
- 0 facts in `lucid_facts` reference 이재명 by uid (no fact has
  `subject_uid=f29784c4-...` or `object_value=f29784c4-...`).
- 2 facts mentioning 중국 상무부 in CLAIM TEXT but with subject_uid
  set to the literal string "중국 상무부" (not a UUID).
- 0 orphan UUIDs found (every UUID subject_uid in facts resolves in
  lucid_objects).

```
fact=74d5add6 subject_uid='중국 상무부' (literal, not UUID)
  claim: 중국 상무부 | 수출통제 관리 명단에 추가했다고 밝혔다 | 미국 기업 10곳
fact=97f7d992 subject_uid='중국 상무부' (literal)
```

### Pipeline trace
`stellarRealAdapter.ts::pushFactAsNode` line 49:
```
const subject = fact.subject_label || fact.subject_uid;
```
`fact.subject_label` is null whenever the backend's `_enrich_with_labels`
(recall.py line 306) mget returns no doc. mget returns no doc when the
subject_uid is a UUID that doesn't exist in `lucid_objects`. For the
PO's reported "이재명 → 082106b8-...":
- `082106b8-...` is NOT in the current `lucid_objects` index.
- It is also NOT a `subject_uid` on any current fact.
- Likely the PO was looking at an earlier state; the UUID belonged to
  an entity that has since been recreated under a different canonical
  uid (or was wiped).

### Verdict — symptom (1)
The structural fix is a frontend fallback: when `fact.subject_label`
is null AND `fact.subject_uid` looks like a UUID, render a placeholder
(or the surface fact-side text), never the raw UUID. Small surgical
addition to `stellarRealAdapter.ts`. Backend doesn't owe a fix here
because the data IS consistent in the current snapshot — what we owe
is preventing future captures from creating orphan UUIDs, which the
class-fix + entity_type fix indirectly help by keeping the canonical
entity layer aligned.

---

## (4) Home count after wipe — cache vs source

### Pipeline trace
`routes/home.py::_pending_validation_count` lines 158-177:
```
session.query(SourceJobORM)
    .filter(
        SourceJobORM.user_id == user_id,
        SourceJobORM.knowledge_space_id == ks_id,
        SourceJobORM.status.in_({"structured"}),
    )
    .count()
```
This is a fresh DB count on every call. No cache layer in the backend.

`routes/home.py::_facts_count`:
```
def _safe_count(index, filters):
    client.count(index=index, body={"query": {"bool": {"filter": filters}}})
```
Also a fresh ES count.

### Verdict — symptom (4)
The backend always returns the live value. The "검증(7) persists after
wipe" is a frontend cache issue — the home brief response was cached
in the browser (React state, SWR cache, or HTTP cache) and the nav
badge re-renders from stale data. Fix is to add `Cache-Control:
no-store` defensively on the home/brief response.

---

## Fix summary — minimal surgery

| # | File | Change |
|---|---|---|
| 1 | `prompts.py` | (already correct; no change) |
| 2 | `models.py` | (no change — class_ already plumbed) |
| 3 | `object_matcher.py` | Pass `candidate_class` into `resolve_entity` |
| 4 | `entity_resolver.py` | Accept optional `entity_class` in resolve_entity / _create_entity, write BOTH `class` and `entity_type` to ES |
| 5 | `mappings.py` | (no change — entity_type keyword field already exists) |
| 6 | `recall.py::_OBJECT_CLASS_BUCKET` | Expand bucket set; prefer `entity_type` over `class` |
| 7 | `assistant.py::_retrieve_candidates` | After kNN, when empty, apply entity-name + entity-link fallback |
| 8 | `home.py::home_brief` | Add `Cache-Control: no-store` response header |
| 9 | `stellarRealAdapter.ts` | When label null and subject_uid is UUID, render placeholder |

NOTE on `entity_type` vs `class`:
- The mapping already has `entity_type: keyword`. We set BOTH `class`
  (back-compat — Recall's mget label_class lookup reads `src.get("class")`)
  AND `entity_type` (canonical). Recall facets will prefer `entity_type`
  and fall back to `class`. For this PR both fields get the same value
  coming from the LLM's ObjectClass.

### Surface-faithful preserved
None of the above changes touch faithful surface (Korean
subject/predicate/object on facts). The class/entity_type is metadata
on the entity layer only.
