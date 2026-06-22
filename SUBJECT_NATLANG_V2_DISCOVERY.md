# Subject-natlang v2 — Discovery (2026-06-22)

## 1. PO example "Ministry of Commerce of China"

Searched lucid_objects for "Ministry of Commerce" / "상무부" / "중국 상무부":
- primary_label match "Ministry of Commerce": 0 hits
- name match "상무부": 1 false-positive (Korean analyzer overlap on 국방부)
- name match "중국": 0 hits

The PO example is hypothetical / illustrative — no record exists in dev ES.

## 2. ES baseline (KS-scoped)

- lucid_objects total: 81 docs
- Created >= 2026-06-22 (PR-B ship): 0 docs
- Created < 2026-06-22: 81 docs (all pre-PR-B legacy)

## 3. Failure mode — observed in legacy ES

Representative legacy entity: faed9d2d-a198-413e-8e83-040d168e4a19
- class = organization
- name = 국방부 (Korean; correct shape post-PR-B)
- name_en = Ministry of Defense
- aliases = ['국방부']
- primary_label = absent
- primary_lang = absent
- created_at = 2026-06-18T12:17:25Z  (BEFORE PR-B ship)

Many legacy entities have English `name` translated from Korean sources
(e.g. "Korea Investment Management", "Mirae Asset Securities", "Goldman
Sachs") with NO Korean alias.

### Mix of failure modes:

- (b) LLM English-only — legacy entities where name is English and no
  Korean alias exists. Source surface was lost at decomposition time.
- (a) reuse-with-Korean-alias — none currently observed (no post-PR-B
  captures yet), but is the failure mode fresh captures will create
  when they hit a legacy English-primary doc.

## 4. Code path

Production pipeline (called by ALL captures today):

processor.process_extracted_job
  -> decompose (LLM)
  -> for each StructureObject:
       match_or_create_object(obj.name, ...)   # object_matcher.py
         exact_name_search (name.keyword)      # only sees obj.name
         knn_search_objects                    # embedding similarity
         create_new                            # writes name = obj.name

`resolve_entity` (entity_resolver.py:293) IS NOT CALLED from production
code today — only from tests. It is the canonical-field layer
(primary_label, primary_lang, aliases) that DR-074 / B-62 shipped but
never wired into the processor. This explains why all stored docs
have primary_label = absent.

## 5. Decision — defenses to apply

PR-v2 takes the spec at face value: defenses ship in `resolve_entity`
so that when the DR-074 wiring lands, the canonical layer is correct.

### (b) original-span-as-surface
- Add subject_surface / object_surface to the LLM JSON schema.
- Add B-62-fix-v2 clause to prompts.py.
- Extend StructureFact model with subject_surface, object_surface.
- Add strip_korean_particles helper in entity_resolver.py and call
  it inside resolve_entity on the supplied surface before lookup.

### (a) re-promote on reuse
- In resolve_entity, when lookup hits an existing doc whose
  primary_label is English and not brand-shaped AND the supplied
  surface is Korean and different — re-promote.
- _repromote_primary_to_surface updates primary_label, primary_lang,
  appends the previous English primary to aliases, appends a
  relabel_history audit entry (field shipped in b668bd7).

### Brand guard
Both branches gated on _looks_like_brand (existing helper).

## 6. Backfill — no extension needed

feat/spo-legacy-korean-relabel (b668bd7) already covers entities with
English primary + Korean alias. Runtime re-promote in (a) covers
everything else as it gets reused. PR-v2 does NOT add a new script.

## 7. Decision risks

- Particle strip false-positive — 우리은행 should NOT strip to 우리. The
  regex matches END only; 우리은행 ends in 행 (not a particle), so the
  strip never fires. 은행 (a noun) is not in the particle list.
- Resolver not wired — re-promote only fires when resolve_entity is
  called. Production code doesn't call it. PR-v2 ships defenses so
  the DR-074 wiring PR can land the fix with no churn.

