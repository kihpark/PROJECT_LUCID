# chore/lucid-link-nuance — DCR-002 v2 Link Nuance Modifier + Understanding Depth (DR-066)

Independent track A, stacked on `feat/lucid-sprint-3-pr3`. Branch base will rebase to `main` once PR-3-3 lands.

DCR-002 v2 closes a long-running design question: how to express link semantics richer than the canonical 15 link types without forcing users to learn a second ontology. PO concluded that the previously-proposed two-layer split (canonical link + nuance metadata) added cognitive overload for end users; this PR ships the **single-layer with optional modifier** alternative.

Beta scope is **storage and metric only** — the Structure decomposer does NOT populate `link_nuance` in beta, and the average understanding-depth is NOT yet surfaced to users. Both come online in Phase 1+ via LLM-driven decomposition and the Stellar afterglow / Dashboard surfaces.

## What changed

### `backend/api/models/links.py` — `LinkRecord.link_nuance`

```python
class LinkRecord(LucidBaseModel):
    from_uid: UID
    to_uid: UID
    link_type: str
    link_nuance: str | None = None   # ← new, DR-066
    weight: float = 1.0
    created_at: datetime = Field(default_factory=utc_now)
```

Free-form modifier on top of the canonical 15-axis link type. The docstring catalogs illustrative values per link type:

- **DERIVED_FROM**: `causal` / `responsive` / `evolutionary` / `inspirational`
- **SUPPORTS**: `evidence` / `mechanism` / `case`
- **SUPERSEDES**: `improved` / `outdated` / `scope_shift`
- **CONTRADICTS**: `direct` / `scope` / `temporal`

The field accepts any string so the modifier vocabulary can evolve without schema migrations. `None` (default) behaves as a plain link of the named type — **100% backward compat**.

### `backend/api/storage/elasticsearch/mappings.py` — minor

`lucid_objects.connected_objects` nested gains `link_nuance: keyword` (nullable). Existing documents without the field stay valid.

### `backend/api/storage/elasticsearch/link_nuance_migration.py` — new

`ensure_link_nuance_field()` — idempotent `put_mapping` helper for live indices. Safe to call repeatedly; "field already exists" errors are treated as success.

### `backend/api/metrics/understanding.py` — new

Two functions, both keyed on a `knowledge_space_id`:

| Function | Returns |
|----------|---------|
| `compute_understanding_depth(fact_uid, ks, max_hop=2)` | count of distinct OTHER facts reachable via Object-mediated 1-/2-hop traversal |
| `compute_user_average_understanding(ks)` | average depth across every fact in the KS |

**Beta-time data path:**
- 1-hop = `{ other_fact : exists Object O s.t. fact_uid ∈ O.fact_uids ∧ other_fact ∈ O.fact_uids }`
- 2-hop = same applied transitively, minus the seed objects, deduped against 1-hop

Helpers explicitly **copy** returned sets — a bug I caught in test #4 where mutation across calls collapsed the average. Production code is now mutation-free.

Direct Fact ↔ Fact edges (SUPPORTS / CONTRADICTS / NEGATES) are **not counted** here in beta because the beta data model only persists them inside `SourceJob.extracted_metadata`. Once Sprint 4 indexes them into `lucid_facts.connected_facts` (Phase 1+), this module gains a second traversal axis.

### `backend/api/storage/postgres/orm.py` + Alembic `0013_understanding_depth_logs`

```python
class UnderstandingDepthLog(Base):
    __tablename__ = "understanding_depth_logs"
    # columns:
    #   id, user_id (FK cascade), knowledge_space_id, measured_at
    #   average_depth (float), max_depth (int),
    #   isolated_facts_count (int), total_facts (int)
    # CHECK: all four counts >= 0
    # INDEX: knowledge_space_id
```

Privacy invariants (DCR-001 family): NO fact UIDs, NO claim text, NO source URLs, NO object names. **Counts + ratios only.**

### Tests — 9 unit + 3 integration

| File | Tests |
|------|-------|
| `tests/unit/test_link_nuance_and_understanding.py` (9) | LinkRecord nuance accepted / defaults None / backward-compat dump, depth isolated / 1-hop / 2-hop dedup, user-average correct / empty-KS zero, UnderstandingDepthLog PII column audit |
| `tests/integration/test_link_nuance.py` (3, skip-pattern) | `es_link_nuance_persists` round-trips a connected_objects entry; `es_query_filter_by_nuance` filters by nuance via a nested query; `alembic_0013_up_down` confirms the table + FK shape |

### `docs/decision-log.md` — DR-066 added

```
| DR-066 | DCR-002 v2: Link Nuance Modifier (meta/world layer split abandoned).
          LinkRecord gains optional `link_nuance: str | None` ... | Two-layer
          split rejected as cognitive overload ... Adopted 2026-06-01 ... |
```

### `AGENTS.md` — §3 + §5

§3 dir tree gains entries for `api/metrics/understanding.py`, `api/storage/elasticsearch/link_nuance_migration.py`, `alembic 0013`, and the `UnderstandingDepthLog` ORM. §5 gains a "Link Nuance Modifier (DR-066)" subsection that documents the storage-only beta scope, the Phase 1+ rollout via LLM decomposition + Synergy Layer keying, and the beta-time scorer.

## DoD verified locally

| Check | Result |
|-------|--------|
| `ruff check .` | All checks passed |
| `mypy .` | Success — no issues in **88** source files |
| `pytest tests/unit -q` | **202 passed** in 3.1s (was 193 in PR-3-3; **+9** track A) |
| `pytest tests/integration/test_link_nuance.py --collect-only -q` | **3 tests collected** |

### DoD I could not verify locally
- Live Alembic upgrade (`alembic upgrade head` on a clean Postgres) — PO docker validates
- Live ES `put_mapping` against an actual `lucid_objects` index — PO docker validates
- `compute_user_average_understanding` against a populated KS — needs FactNode persistence (Sprint 4)

## Commits

```
2d1f2a7  docs(link-nuance): DR-066 + AGENTS §3 + §5 — DCR-002 v2 Link Nuance
38a9711  test(link-nuance): 9 unit + 3 integration tests for DR-066
0d85130  feat(link-nuance): understanding_depth + UnderstandingDepthLog + 0013
4cf5e77  feat(link-nuance): LinkRecord.link_nuance + ES nested keyword + ensure helper
```

## What this PR does NOT do

- Does NOT populate `link_nuance` from the Structure decomposer — Phase 1+
- Does NOT expose the average understanding-depth to users — Phase 1+ (Stellar afterglow + Dashboard)
- Does NOT add an Edges / Connections index for Fact↔Fact direct links — Sprint 4 (FactNode persistence)
- Does NOT define a fixed modifier vocabulary — the field is free-form by design
- Does NOT migrate existing Object docs to add the field — the field is nullable and ES tolerates missing nested keys

## Sprint coordination

- **Stacked on** `feat/lucid-sprint-3-pr3` — when PR-3-3 merges to main, this branch rebases (no conflicts expected; track A only touches LinkRecord + new files + AGENTS §5)
- **Independent of** Sprint 2A (Chrome Extension) — track B will branch from main once both this PR and PR-3-3 land
- **Alembic chain:** 0001 → 0011 (PR-3-2) → **0012** (PR-3-3 structure_metrics_logs) → **0013** (this PR understanding_depth_logs)

## Test plan

- [ ] Branch base check: `git log feat/lucid-sprint-3-pr3..HEAD --oneline` shows the 4 track-A commits
- [ ] After rebase to main: re-run `pytest tests/unit -q` → 202 pass
- [ ] Local Alembic upgrade: `alembic upgrade head` → `0013` present, `understanding_depth_logs` table created, CHECK + index present
- [ ] Live ES: `python -c "from api.storage.elasticsearch.link_nuance_migration import ensure_link_nuance_field; print(ensure_link_nuance_field())"` → `True`
- [ ] Re-run twice in a row to confirm idempotency
- [ ] LinkRecord round-trip: create with `link_nuance='evidence'`, serialize, parse → field preserved
- [ ] Down-migration: `alembic downgrade 0012` → table dropped cleanly, no orphan FKs
