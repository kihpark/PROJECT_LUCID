# Changelog

All notable changes to Lucid will be documented here.
Format: [Keep a Changelog](https://keepachangelog.com).
Versioning: pre-alpha 0.y.z — 0.MINOR = dogfood round unit, tag = PO dogfood verification graduation.

## [0.1.0] — 2026-06-23

Anchor before data-model overhaul. CSVS loop (Capture–Structure–Validate–Surface) end-to-end on the single SPO model with Korean-first surface layer and entity classification restored.

### Added
- **Faithful Korean SPO decomposition** — predicate as semantically complete verb phrase, object as complete noun phrase; deterministic completeness validator (coverage threshold 0.7) flags incomplete decomps as `needs_review`.
- **Entity type classification** — LLM emits class (person/organization/place/concept/event/other); backend persists `entity_type` alongside `class`; Recall facet groups by typed entity.
- **`PATCH /api/spaces/{ks}/facts/{fact_uid}`** — surface field modify in Recall fact detail view; audit-preserving (claim → aliases + edit_history).
- **Decide UI chip-click bind** — autocomplete chip click pre-arms `prevSubjectRef.current` so parent-sync useEffect does not overwrite input.
- **Capture complete toast** — step-down polling (30×1s + 50×3s = 180s) + OS notification fallback; chrome extension reload required.
- **Pending Queue card** — article title (extracted via og:title/title/readability) + relative date (방금 전 / N시간 전) + hostname as muted metadata.
- **Count source unification** — ONE TRUE FILTER `status='structured' AND fact_count>0` shared by /home/brief badge + copy + /pending list.
- **Status='validated'** — alembic 0018 + `validate.decide` flips status after Submit; pending count decrements automatically.
- **Entity class backfill** — heuristic (Korean person pattern + organization suffix) + LLM fallback; admin script for retroactive reclassification.
- **Mappings sync (non-destructive)** — `ensure_mappings()` startup hook adds missing fields to live ES indexes additively; codifies subject_label / object_label / predicate_violation / primary_label / etc.
- **Assistant inference-first layout** — AI inference block at top with primary styling, verified facts below as supporting evidence.
- **Stellar adaptive density** — for n<30 graphs, charge -50 + center force 0.08 + node size up to 5.0 → clickable ball.
- **Recall pipe-claim auto-reformat** — older facts with `claim="S | P | O"` render as `S → P → O` with `(재구성됨)` marker.
- **Home greeting hydration fix** — time-of-day greeting deferred to client mount; SSR neutral fallback `안녕하세요`.
- **Negation policy consistency** — pending queue negation chip removed (Decide already correct); future plug-in points documented for B-54 fact_relations writer.

### Changed
- Decide UI prefers `obj.name` over `obj.name_en` regardless of `lang` — backend-corrected Korean surface always wins.
- Home `/api/home/brief` response carries `Cache-Control: no-store`.

### Out of scope (planned for 0.2.0)
- Fact 3-way split (Action / Claim / Measurement)
- Entity meta-network (CASOS / DNA)
- kNN embedding restoration (currently dummy, score 0.00)
- Agent isolation permanence (backend `--reload` removal, bind-mount removal)

### Migration
- alembic 0018 (source_status_validated) applied at startup; `ensure_mappings()` reconciles live ES with declared mappings.
- One-shot entity reclassification script: `docker compose exec backend python -m scripts.backfill_entity_class --email kihpark85@gmail.com --apply`.
