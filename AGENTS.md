# AGENTS.md — Lucid Project v2.2
# Cross-tool standard: OpenAI Codex · Claude Code · GitHub Copilot · Cursor
# Read this entire file before doing anything. Do not skip sections.
#
# v2.2 (2026-05-20): CSVS loop complete — Capture/Structure/Validate/Surface
# beta scope locked. Cross-stage invariants added to §4.5. Critical Rules
# 13-16 codify the four cross-stage commitments (no confidence at Structure,
# two capture modes, Surface identity protocol, Capture provenance). DR-025
# through DR-052 record the new resolved decisions.
#
# v2.1 (2026-05-19): consolidated — merges the former AGENTS.md (v0.3) and
# AGENTS_v2.md into this single canonical file, folds in the resolved model
# decisions (fact lifecycle, ValidationMark, Space node, local embeddings),
# and records DR-013..DR-018. This file supersedes all earlier AGENTS files.

---

## 0. Identity

**Lucid = "Validation infrastructure for the post-AI internet."**

Not a note-taking app. A system that makes validated knowledge accumulate
and compound across three contexts:

| Context | Who | Value |
|---------|-----|-------|
| Personal | Individual researcher | "What I personally verified is true" |
| Team | Research team / organization | "What we collectively agreed on" |
| Policy | Government / legislature / IGO | "What is institutionally certified" |

All three run on the same engine. What differs is the KnowledgeSpace type,
visibility, and validation quorum.

**Core invariant — never break this:**
Lucid answers queries using ONLY validated FactNodes from its graph.
Never from LLM general knowledge. If no relevant fact exists, say so honestly.

WisdomDB is Lucid's existing backend engine; all WisdomDB functionality is
subsumed here. O-1 is resolved: build on the WisdomDB chassis (Approach B).

---

## 1. Setup

> **v2 stack (Sprint 1A PR-1A-1, 2026-05-21; sweep completed in
> chore/lucid-v2-doc-sweep):** beta runs on Postgres + Elasticsearch
> (with nori). Neo4j and FAISS are retired. The staleness system
> (`valid_until`, `is_stale`, Mode 5) is also retired (DR-053 / C-14).
> All v1-era inline references in this file have been swept; the few
> remaining mentions of `Neo4j` / `FAISS` / `valid_until` are
> intentional callouts in retraction notes and prohibition lists.

```bash
# Requirements: Docker Desktop, Python 3.11+, Node.js 18+
cp .env.example .env              # Add ANTHROPIC_API_KEY
docker compose up -d              # Postgres + Elasticsearch + Backend
cd backend && pip install -r requirements.txt
uvicorn api.main:app --reload     # http://localhost:8000
```

Verify:
```bash
curl http://localhost:8000/api/health
# {"status":"ok","postgres":"connected","elasticsearch":"connected","version":"0.4.0"}
```

Mock-first rule: The full Capture → Structure → Validate → Surface loop
must pass tests using `tests/mock_llm.py` BEFORE any real API calls.
`tests/mock_llm.py` holds deterministic fake Claude responses; it is the
first checkpoint of S0, not the last.

### 1.1 Beta Capture Entry Points (DR-025, DR-026)

Beta capture is restricted to two devices and seven entry points. The
constraint is provenance: every captured fact must carry a verifiable
`source_url`. Capture paths that cannot guarantee this are excluded.

```
Chrome Extension (Desktop) — 5 entry points
  · Full page capture
  · Highlight / selected text
  · YouTube video (transcript → Whisper fallback)
  · Page image right-click (Claude Vision)
  · PDF opened in Chrome (pdfplumber)

PWA Share Target (Mobile) — 2 entry points
  · OS share sheet (Share Target)
  · URL paste (iOS Share Target workaround)
```

Excluded from beta scope (no `source_url`):
screenshot upload, camera capture, arbitrary file upload, clipboard
auto-detect, voice memo, email forward. Full rationale and Phase 1
policy options: [`docs/capture-stage-spec.md`](docs/capture-stage-spec.md).

---

## 2. Operator Commands (test / lint / type check)

All commands run from `backend/`. The CI workflow at
`.github/workflows/ci.yml` runs the same three in order: ruff → mypy → pytest.

### Tests

```bash
cd backend

pytest tests/ -v                          # All (run before every commit)
pytest tests/unit/ -v                     # Fast, no external deps (<10s)
pytest tests/integration/ -v              # Requires Postgres + Elasticsearch + Docker
pytest tests/unit/test_structurer.py -v   # Specific module
pytest tests/ --cov=. --cov-report=term-missing  # Coverage

# Mock mode (no API keys needed)
LUCID_MOCK_LLM=true pytest tests/ -v
```

### Lint and type check

```bash
cd backend

ruff check .                              # Lint (Sprint 0 baseline rule set)
ruff check . --fix                        # Auto-fix safe lint issues
ruff format .                             # Format (line length 88)

mypy .                                    # Type check (lenient in Sprint 0)
```

Config for both lives in `backend/pyproject.toml`. Mypy strictness ratchets
up sprint-by-sprint as real implementations land.

### Boot the stack

```bash
docker compose up -d                      # postgres + elasticsearch + backend
docker compose logs -f backend            # tail backend logs
docker compose down                       # stop (data persists in volumes)
docker compose down -v                    # stop + wipe postgres + es volumes
```

Rules: Never commit code that breaks existing tests.
Every new feature requires tests. Integration tests need a live Postgres + Elasticsearch.
Ruff + mypy must pass before pushing (CI will block otherwise).
Integration tests are skipped automatically when Postgres / Elasticsearch
are unreachable, so unit-only `pytest tests/unit` works on any laptop.

---

## 3. Architecture

```
Lucid/
├── backend/
│   ├── api/
│   │   ├── main.py                FastAPI app, CORS, health
│   │   └── routes/
│   │       ├── spaces.py          CRUD for KnowledgeSpaces
│   │       ├── capture.py         POST /api/spaces/{sid}/capture/*
│   │       ├── validate.py        GET/POST /api/spaces/{sid}/validate/*
│   │       ├── graph.py           GET /api/spaces/{sid}/facts|graph|stats
│   │       ├── surface.py         POST /api/spaces/{sid}/surface
│   │       ├── query.py           POST /api/spaces/{sid}/query
│   │       └── validation_api.py  POST /api/v1/validate (B2B)
│   ├── core/
│   │   ├── capture/               Multimodal extractors
│   │   │   ├── detector.py        URL/file type auto-detection
│   │   │   ├── youtube.py         Transcript -> Whisper fallback
│   │   │   ├── instagram.py       Extension-based (NOT instaloader — ToS risk)
│   │   │   ├── web.py             newspaper3k + readability
│   │   │   ├── image.py           Claude Vision
│   │   │   ├── audio.py           faster-whisper (local)
│   │   │   └── pdf.py             pdfplumber
│   │   ├── structure/             Atomic fact decomposition
│   │   │   ├── decomposer.py      merged_text -> List[AtomicFact]
│   │   │   └── linker.py          fact -> existing Object nodes
│   │   ├── validate/              HITL + quorum + L1-L4
│   │   │   ├── queue.py           PendingFact lifecycle
│   │   │   ├── quorum.py          Multi-validator quorum logic
│   │   │   └── marker.py          Apply L1/L2/L3/L4 marks
│   │   ├── graph/                 Graph operations (v2: ES adjacency lists)
│   │   │   ├── service.py         CRUD + search + traversal (space-scoped)
│   │   │   └── schema.py          ES index mappings (PR-1A-3)
│   │   ├── embed/                 kNN vector search via ES dense_vector (PR-1A-3)
│   │   │   └── service.py         Embed once at validation (embedding source TBD; see CONFLICTS.md C-18)
│   │   ├── surface/               Proactive recall
│   │   │   └── engine.py          C3 contextual surfacing
│   │   └── synergy/               Background intelligence
│   │       ├── contradiction.py   C1 detection (post-commit)
│   │       ├── pattern.py         C2 synthesis (density-gated)
│   │       └── suggestion.py      C4 cross-cluster links
│   ├── api/models/                Pydantic models (source of truth) — Sprint 1A PR-1A-2
│   │   ├── base.py                LucidBaseModel + UID + utc_now
│   │   ├── objects.py             ObjectClass + 13 concrete classes
│   │   ├── facts.py               AtomicFact + FactNode + EditRecord
│   │   ├── links.py               5+4+6=15 Link Types + LinkRecord
│   │   ├── validation.py          ValidationRecord
│   │   ├── contradiction.py       ContradictionPair (A/B/C) + GatekeepingWarning
│   │   └── source.py              Source + SourcePolicy + SourceType
│   ├── api/security/              Sprint 1B — auth primitives
│   │   ├── password.py            bcrypt hash + verify
│   │   ├── jwt.py                 HS256 mint + decode + JWTPayload
│   │   └── dependencies.py        FastAPI Depends helpers
│   │                              (require_jwt, get_current_user_id,
│   │                               get_current_user)
│   ├── api/storage/postgres/      Relational store — Sprint 1A PR-1A-2 + 1B + DCR-001 + 2C
│   │   ├── orm.py                 12 SQLAlchemy 2.x mapped classes
│   │   │                          (Sprint 1B adds UserSettings,
│   │   │                           password_hash on User; DCR-001 adds
│   │   │                           DisambiguationLog + 3 metric logs;
│   │   │                           Sprint 2C adds SourceJobORM)
│   │   ├── session.py             Sync engine + sessionmaker
│   │   ├── compression.py         gzip helpers for raw_payload (Sprint 2C)
│   │   └── migrations/            Alembic (9 versions: 0001..0009)
│   ├── api/storage/elasticsearch/ Graph adjacency + kNN — Sprint 1A PR-1A-3
│   │   ├── client.py              ES sync client singleton
│   │   ├── mappings.py            3 index mappings (nori + dense_vector hnsw)
│   │   ├── indexes.py             create / delete / reindex (idempotent)
│   │   ├── embeddings.py          OpenAI text-embedding-3-small + LRU cache
│   │   ├── facts.py               Fact CRUD + alias history
│   │   ├── queries.py             kNN / nori text / faceted search
│   │   ├── objects.py             Object CRUD + symmetric link + 1-hop
│   │   └── sources.py             create_or_update_source (capture_count)
│   ├── api/extractors/             Sprint 2C PR-2C-2 (planned)
│   │                              5 extractors + dispatcher + processor
│   ├── api/metrics/                DCR-001 — anonymized aggregate logs
│   │   └── precision.py           M1/M2/M3 recorders
│   ├── alembic.ini                Migration config (run from backend/)
│   ├── tests/
│   │   ├── mock_llm.py            Deterministic fake Claude responses
│   │   ├── unit/                  No external dependencies
│   │   └── integration/           Requires Postgres + Elasticsearch + Docker
│   ├── Dockerfile
│   ├── pyproject.toml             Sprint 0: ruff + mypy + pytest config
│   ├── pytest.ini
│   └── requirements.txt
├── extension/                     Chrome Extension (Manifest V3) — from WisdomDB
├── pwa/                           Mobile PWA Share Target — from WisdomDB
├── frontend/                      Vanilla HTML + D3.js — from WisdomDB
├── docs/
│   ├── decision-log.md            All resolved and open decisions
│   ├── integration-architecture.md
│   ├── development-plan.md
│   └── synergy/                   Synergy Layer spec (use-case, RFC, scenarios)
├── docker-compose.yml
└── .env.example
```

> `extension/`, `pwa/`, and `frontend/` ship as part of the WisdomDB baseline
> import (O-5 resolved: monorepo). Until that import lands, only `backend/`
> exists. Do not recreate those three directories from scratch.

---

## 4. Core Data Model

The canonical models live in **code**, not in this file. Inline
snippets that used to define Pydantic shapes or Cypher schemas have
been retired; the entries below are pointers + invariants.

| Layer | Location | Notes |
|-------|----------|-------|
| Pydantic models (Object, AtomicFact, FactNode, LinkRecord, ValidationRecord, ContradictionPair, GatekeepingWarning, Source) | `backend/api/models/` | Source of truth (PR-1A-2) |
| Relational (User, KnowledgeSpace, AuthSession, SourcePolicy, ArchetypeSurvey, GraphNote) | `backend/api/storage/postgres/orm.py` + Alembic | 6 SQLAlchemy 2.x classes; sync engine |
| Search + graph adjacency (lucid_facts, lucid_objects, lucid_sources) | `backend/api/storage/elasticsearch/` | Index mappings + kNN (PR-1A-3, planned) |

### KnowledgeSpace (Postgres `knowledge_spaces`)

Every FactNode belongs to exactly one KnowledgeSpace. In beta only
`type='personal'` is enabled; `team`, `policy`, and `public` are
valid enum values but blocked at the API layer (Sprint 1B). The
type CHECK constraint is enforced at the database level in
`alembic/versions/0001_initial.py`.

### Fact lifecycle: AtomicFact → FactNode

Two Pydantic models, one per lifecycle stage:

| Model | Stage | Persisted in |
|-------|-------|--------------|
| `AtomicFact` | Structurer output (Sprint 3) | not persisted; passed to the Decide overlay |
| `FactNode` | Post-Validate / Auto-accepted (Sprint 4) | `lucid_facts` ES index |

The v1 design had a separate `PendingFact` stage in a Neo4j queue.
v2 collapses this: Save triggers analysis, the Decide overlay shows
AtomicFacts directly, and Accept / Review-then-Accept / Discard
creates the FactNode or drops it. See `docs/capture-stage-spec.md`
and `docs/validate-stage-spec.md`.

### Forbidden fields on AtomicFact / FactNode (DR-053, C-14)

The fields below were retired with the staleness system (PO
directive 2026-05-21 [변경 2]). Pydantic `extra="forbid"` rejects
them at construction; 6 negative tests in
`backend/tests/unit/test_models_facts.py` lock this down.

```
valid_until     — retired (no expiry triggers in v2)
is_stale        — retired
stale_at        — retired
```

`valid_from` is kept as **context-only** metadata (when a time-bound
claim became true). It never triggers expiry, alerts, or
re-validation jobs.

### Confidence

Not assigned at Structure (DR-028 / Critical Rule 13). When
confidence is surfaced at Validate or Surface, it is **derived** at
read time from publisher_class + validation_method + time freshness
+ consensus signals. The Structurer never emits a `confidence`
value.

### Object classes (13 concrete, `ObjectClass` StrEnum)

```
Concept, Person, Organization, Service, Product, Place, Knowledge,
Event, Procedure, Task, Metric, Resource, Problem
```

`AtomicFact` and `Source` are separate top-level models, not
subclasses of `Object`. The historical "12 ontology classes" count
from `docs/structure-stage-spec.md` §4 included `Entity` as a parent
of 5 subs plus `AtomicFact` + 5 others; v2 flattens the Entity
subtree, so the concrete subclass count is 13.

### Link types (15, plus 1 stored inline)

```
Fact ↔ Object   (5):  ASSERTS_PROPERTY, DESCRIBES_STATE, ADDRESSES,
                       USES, INVOLVES
Object ↔ Object (4):  PART_OF, INSTANCE_OF, LOCATED_IN, HAS_ROLE
Fact ↔ Fact     (6):  SUPPORTS, CONTRADICTS, EXAMPLE_OF,
                       DERIVED_FROM, INTERPRETS, SUPERSEDES
Fact → Source   (+1): stored on `FactNode.source_uids` (a list of
                       UIDs; no LinkRecord needed)
```

`LinkRecord` is the in-Pydantic representation; the persisted form is
ES-side, on the `connected_objects` nested field for Object↔Object
edges and via dedicated relation queries for Fact↔Fact edges. Final
schema lands in PR-1A-3.

### ContradictionPair patterns (A / B / C)

See `backend/api/models/contradiction.py`. Three patterns:

```
A   automatic CONTRADICTS edge (same subject + property + value mismatch)
B   Suspected (same subject + semantically opposite predicate)
C   Context-only (same subject but different time / jurisdiction /
    measurement unit; surfaced as info, not a contradiction)
```

### GatekeepingWarning (DR-050)

Capture-time check. Warns but never blocks. "Save anyway" creates a
FactNode with `override_warning=True`. See
`backend/api/models/contradiction.py::GatekeepingWarning`.

### Source policy (Settings SET-2)

Per-user, per-domain Trusted / Careful policy lives in the Postgres
`source_policies` table, NOT on the capture event. Setting is asked
once in Settings SET-2, never at capture time (PO directive
[변경 3]). See `backend/api/storage/postgres/orm.py::SourcePolicyORM`.

### Schema invariants

```
- FactNode.knowledge_space_id is required; every ES doc carries it
- All UID fields are uuid4 strings (ES `keyword` index)
- All datetime fields are timezone-aware UTC (Pydantic
  `LucidBaseModel` enforces; helpers in `api.models.base`)
```

---

## 4.5 CSVS Stage Specifications and Beta Execution

Complete beta scope and execution plan in docs/:

```
docs/capture-stage-spec.md       Capture (C)    Input entry points
docs/structure-stage-spec.md     Structure (S)  AtomicFact decomposition
docs/validate-stage-spec.md      Validate (V)   HITL judgment
docs/surface-stage-spec.md       Surface (S)    Active surfacing
docs/beta-backlog.md             Beta plan      Sprint decomposition + user strategy
```

### How to use these documents

When implementing any feature, read in this order:
  1. AGENTS.md (this file) — project-wide invariants
  2. docs/beta-backlog.md — current sprint and dependencies
  3. The specific stage spec for the feature you're touching

Do not deviate from beta scope without explicit PO approval. Sprint
dependencies in beta-backlog.md §4 are strict: do not skip ahead even
if a later sprint looks simple, because earlier sprints establish data
contracts that later ones depend on. Sprints sharing a number prefix
(1A/1B, 2A/2B/2C, 4A/4B, 6A/6B/6C/6D) can be executed in parallel.

### Cross-stage invariants

These rules span multiple stages and must be enforced consistently:

1. **Source provenance enforcement**
   No FactNode exists without verifiable source_url + captured_at.
   Untraced capture excluded from beta. See capture-stage-spec.md §3.

2. **Capture mode determines validation path**
   `careful` → PendingFact queue → Validate UI
   `trusted` → immediate FactNode + Auto-accepted tab
   See validate-stage-spec.md §2.

3. **No AI confidence at Structure stage**
   Confidence derived at Validate/Surface from publisher_class,
   validation level (L1-L4), time freshness, consensus signals.
   See structure-stage-spec.md §1.

4. **Surface identity protocol**
   All Lucid responses begin with identity-affirming phrases
   ("As far as I know...", "According to your knowledge graph...").
   All claims cite fn-ID. No LLM general knowledge in answers.
   See surface-stage-spec.md §2.

5. **User on/off control**
   Surface mode is toggle-able per device.
   OFF disables Active Recall, Contradiction toasts, Staleness alerts.
   Capture and queue updates continue in background.
   See surface-stage-spec.md §4.

6. **Wedge discovery posture (NEW)**
   Beta is for wedge discovery, not wedge validation. Do not hard-code
   assumptions about target user segments in code or copy. Earlier
   hypotheses about academic researchers as the primary segment have
   been retracted; archetype emerges from beta usage data.
   See beta-backlog.md §1. (DR-053)

---

## 5. Synergy Layer (C1–C4)

The Synergy Layer is not a separate module. It is what validated facts
do once they accumulate in the graph.

| Code | Capability | Trigger | Density Floor |
|------|-----------|---------|---------------|
| C1 | Contradiction Detection | New fact shares subject with existing | ≥ 3 facts, same subject |
| C2 | Pattern Synthesis | Natural-language query | ≥ 50 facts in queried domain |
| C3 | Contextual Surfacing | Typed text in editor | No floor — works from fact 1 |
| C4 | Connection Suggestion | Background scan, cross-cluster | ≥ 2 separate clusters |

Below a density floor: degrade honestly. Label response as retrieval,
not synthesis. Never fabricate a pattern from too few facts.

### Subject Resolution (for C1 and Object linking)
Two-gate filter — strict order:
1. Primary: exact entity name match via [:MENTIONS] edges
2. Fallback: vector similarity ≥ 0.88 ONLY (conservative — prevents false positives)
Never use similarity below 0.88 for subject-to-Object linking.

### C1 Contradiction Detection Sequencing
ALWAYS post-commit. Never inside the write transaction.
```
1. User accepts fact → ES `lucid_facts` write commits → AtomicFact discarded
2. C1 fires in separate operation (async, non-blocking)
3. Cheap pre-filter: numeric/unit/date mismatch check (no LLM)
4. If pre-filter fires: LLM conflict check (Haiku, prompt-cached)
5. reason_code: UNIT_MISMATCH | TIME_BASIS | VALUE_CONFLICT | NONE
6. If conflict: write [:CONTRADICTS] + ContradictionFlag node
```

### Auto-clear Contradiction Flags
When user discards conflicting fact or resolves mismatch in HITL:
synchronous re-check → if conflict metric below threshold →
automatically delete [:CONTRADICTS] edge + mark flag AUTO_RESOLVED.

### Synergy Worker cadence (DR-017)
The C4 cross-cluster scan runs in a background Synergy Worker, **event-driven
with a debounce**: a fact-commit enqueues a job keyed by `space_id`; a short
debounce (default ~10 min, tunable) coalesces capture bursts into one scan.
The worker scans incrementally from `SynergyJob.cursor` and **no-ops for any
space below the C4 density floor** (≥ 2 clusters). The Worker itself is S3
scope; S0 only needs the `SynergyJob` node with its `cursor` field.

### C2 traversal of synthetic edges (DR-018)
C2 Pattern Synthesis may traverse `EXAMPLE_OF` / `SUPPORTS` edges to expand
the candidate fact set, but at their lower edge weight and clearly labeled.
Every pattern claim must still cite ≥ 1 `DERIVED_FROM`-grounded fact; a
synthetic edge may never be a pattern's sole support. C2 is S2 scope.

### Multi-validator Quorum
```python
async def check_quorum(space: KnowledgeSpace, fact_id: UUID) -> bool:
    accepted_count = count_accepted_validations(fact_id)
    return accepted_count >= space.validation_quorum
    # personal: quorum=1 (instant)
    # team:     quorum=3 (requires consensus)
    # policy:   quorum=dynamic (escalates by review stage)
```

---

### NEGATES vs CONTRADICTS (DCR-001)

C1 contradiction detection considers two distinct cases for the same
Subject + Property pair:

```
NEGATES       Directional. Fact A is the explicit negative statement
              of Fact B ("X is NOT Y" → NEGATES the affirmative).
              The negating party carries `negation_flag=True` and a
              `negation_scope` of 'full' or 'partial'.

CONTRADICTS   Symmetric. Two facts whose claims cannot both be true,
              detected by same-Subject + same-Property + value
              mismatch. CONTRADICTS is content-comparison; NEGATES
              is intrinsic to the fact's own claim.
```

C1 emits CONTRADICTS automatically when the value-mismatch test fires
on a (Subject, Property) pair. NEGATES requires the Structurer to
mark the originating AtomicFact's `negation_flag` at decomposition
time; the link is then created during fact_fact_links extraction
(structure-stage-spec.md §6 step 6).


## 6. API Endpoints

All endpoints are namespaced under KnowledgeSpace.
Replace {sid} with space_id UUID.

```
# Spaces
POST   /api/spaces                    Create KnowledgeSpace
GET    /api/spaces                    List user's spaces
GET    /api/spaces/{sid}              Space detail + stats
PATCH  /api/spaces/{sid}              Update space settings
POST   /api/spaces/{sid}/members      Add member with role

# Capture (all return List[PendingFact])
POST   /api/spaces/{sid}/capture/text   { raw_text, personal_note }
POST   /api/spaces/{sid}/capture/url    { url, personal_note }
POST   /api/spaces/{sid}/capture/file   multipart: file + personal_note

# HITL Validate
GET    /api/spaces/{sid}/validate/queue
POST   /api/spaces/{sid}/validate/decide
         { fact_id, action, edited_claim?, approved_relations? }

# Knowledge Graph
GET    /api/spaces/{sid}/facts         ?domain=&jurisdiction=&limit=
GET    /api/spaces/{sid}/facts/{fid}   Fact + relations + validation history
GET    /api/spaces/{sid}/graph         D3.js format
GET    /api/spaces/{sid}/stats         Node/relation/pending/stale counts

# Search & Query (validated facts ONLY)
POST   /api/spaces/{sid}/search        { query, jurisdiction?, limit }
POST   /api/spaces/{sid}/query         { question }
POST   /api/spaces/{sid}/surface       { context_text }

# Cross-space (future L3)
POST   /api/spaces/{sid}/reference/{target_sid}/facts/{fid}

# B2B Validation API
POST   /api/v1/validate/claim          { claim, jurisdiction? }
GET    /api/health
GET    /api/stats                      Global (anonymized)
```

### API conventions
- Every endpoint: `async def handler(req: RequestModel) -> ResponseModel`.
- Errors: `raise HTTPException(status_code=..., detail="...")`. Korean
  messages in `detail` are fine and expected.
- Extractors never raise — they return `ExtractionResult(success=False, error=...)`.
- All I/O is `async`. Type hints on every signature.

---

## 7. Critical Rules — Never Violate

1. **Validated facts only in answers.** Query and Surface use ONLY validated
   FactNodes from Elasticsearch. Never LLM general knowledge. No relevant fact = honest
   "I don't have validated information on this."

2. **HITL is mandatory.** All extracted facts go to PendingFact queue first.
   No shortcut path to FactNode without L1 validation (and quorum if team/policy).

3. **Atomic facts, not summaries.** Structurer decomposes into individual
   falsifiable claims. One claim = one PendingFact. Summaries are not stored.

4. **personal_note must be prompted.** A fact without context on WHY it was
   saved loses value over time.

5. **Storage layer separation.** Relational state (users, spaces,
   sessions, source policies, surveys, graph_notes) lives in Postgres
   (`backend/api/storage/postgres/`). Facts, objects, sources, and the
   graph live in Elasticsearch (`backend/api/storage/elasticsearch/`).
   Don't cross the boundary — no facts in Postgres, no auth state in ES.

6. **Confidence is enum, not float.** HIGH | MEDIUM | LOW. Human judges
   categorically. Float precision is false precision. Confidence and validation
   are independent axes (see section 4).

7. **Subject resolution: two gates, strict order.** Exact match first.
   Vector fallback only at ≥ 0.88. Never lower.

8. **C1 runs post-commit.** Contradiction detection never blocks a
   FactNode write. ES indexing returns first; the contradiction scan
   fires as a separate operation against the freshly indexed doc.

9. **Below density floor: degrade honestly.** If domain has < 50 facts,
   label as retrieval, not pattern synthesis. Never fabricate a pattern.

10. **No staleness system (DR-053 / C-14).** Time-bound facts are
    permanently true ("Korea base rate 3.5% as of 2024-12 ..."). The
    `valid_from` field is allowed as context-only metadata; `valid_until`
    and `is_stale` are forbidden on AtomicFact and FactNode and are
    rejected by Pydantic `extra="forbid"`. No background staleness
    checker, no Mode 5 Staleness surface.

11. **space_id on every fact and operation.** No fact exists outside a
    KnowledgeSpace. Every API call that touches facts requires space_id.

12. **ToS-safe capture only.** No instaloader (Meta ToS violation). Instagram
    capture via browser extension only (user-visible screen). YouTube: transcript
    API first, yt-dlp only as last resort with local processing.

13. **Confidence is NOT assigned at Structure stage.** It is derived at
    Validate/Surface from publisher authority, validation tier, time freshness,
    and consensus signals. The Structurer never emits a `confidence` value.
    (DR-028. See docs/structure-stage-spec.md §1. NOTE: the AtomicFact
    Pydantic stub in section 4 still carries a `confidence` field from the
    pre-spec model and must be removed in implementation — see CONFLICTS.md.)

14. **Two capture modes: careful and trusted (Settings SET-2).** Per-source
    policy lives in Settings SET-2, not on the capture event (PO directive
    [변경 3]). Careful mode (default) routes the captured AtomicFacts to the
    Decide overlay (Accept all / Review / Discard). Trusted mode auto-accepts
    facts from a user-registered trusted source list straight into the
    `lucid_facts` index with `validation_method='auto'` on the
    ValidationRecord. Auto-accepted facts surface in a separate review tab
    and automatically rejoin the main queue when a contradiction is detected
    or the trust registration is revoked. (DR-027 reframed for v2.
    See `docs/validate-stage-spec.md` §2.)

15. **Surface identity protocol.** Every Lucid response — Active Recall hover
    tooltips, Passive Recall ("Ask Lucid") answers, Gatekeeping warnings — must
    begin with an identity-affirming phrase ("As far as I know...",
    "According to your knowledge graph...", "기흥님 그래프 기준으로...",
    or an equivalent honest-ignorance variant) and must cite `fn-ID` for every
    factual claim. No LLM general knowledge in answers. If no validated fact
    exists, say so honestly and offer to capture. Violating this rule is a
    beta-blocking bug. (DR-047. See docs/surface-stage-spec.md §2 and §6.)

16. **Source provenance is enforced at Capture.** Every FactNode must carry
    a verifiable `source_url` and `captured_at`. Untraced capture inputs
    (screenshots, raw file upload, camera, clipboard auto-detect, voice memo,
    email forward) are excluded from beta scope — they cannot be added through
    any code path. Phase 1 may add policy for untraced inputs after beta data
    is collected. (DR-025, DR-026. See docs/capture-stage-spec.md §3.)

---

## 8. Code Style

- Python 3.11+, type hints everywhere, no exceptions
- `async/await` for all I/O operations
- Pydantic v2 (`model_validator`, `field_validator` syntax)
- Black formatting, line length 88
- Imports: stdlib → third-party → local, alphabetical within groups
- `logging` module only — no `print()` in production code
- No hardcoded strings — constants or config
- Test naming: `test_{what}_{condition}_{expected_result}`
- Korean strings in API responses are fine and expected
- Comments in Korean or English, consistent within a file

---

## 9. Git Conventions

```bash
# Branch: one branch per task
feat/lucid-{feature}
fix/lucid-{bug}
test/lucid-{scope}
refactor/lucid-{scope}

# Commits (Conventional Commits)
feat(spaces): add KnowledgeSpace CRUD with role management
feat(validate): implement multi-validator quorum logic
fix(synergy): run C1 check post-commit not inside transaction
test(structure): add atomic fact decomposer unit tests

# Before every commit
pytest tests/unit/ -v    # must pass
```

---

## 10. Environment Variables

```bash
# Required (v2 stack — Sprint 1A PR-1A-1)
ANTHROPIC_API_KEY=sk-ant-...
DATABASE_URL=postgresql://lucid:lucid@postgres:5432/lucid
POSTGRES_USER=lucid
POSTGRES_PASSWORD=lucid
POSTGRES_DB=lucid
ELASTICSEARCH_URL=http://elasticsearch:9200

# Development
LUCID_MOCK_LLM=false           # true = use tests/mock_llm.py, no API calls
LUCID_ENV=development          # development | staging | production

# Claude model (beta default per PO 2026-05-21; revisited in Sprint 3 A/B)
CLAUDE_MODEL=claude-sonnet-4-5

# Optional
YOUTUBE_TRANSCRIPT_LANG=ko,en  # Preferred transcript languages
MAX_FACTS_PER_CAPTURE=10       # Limit atomic facts per single capture
```

> The retired `NEO4J_*`, `EMBEDDING_MODEL`, and `STALENESS_CHECK_INTERVAL`
> variables are gone. Embedding source for kNN in ES is open (CONFLICTS.md
> C-18, pending Sprint 1A PR-1A-3 PO decision).

---

## 11. What Agents Must NOT Do

- Answer queries using LLM general knowledge — validated facts ONLY
- Create a FactNode without going through PendingFact → HITL → quorum
- Run C1 contradiction detection inside the ES write path (must
  fire post-commit, per Critical Rule 8)
- Use vector similarity below 0.88 for subject-to-Object node linking
- Add Neo4j, FAISS, Qdrant, or any database beyond Postgres +
  Elasticsearch (v2 stack, PR-1A-1; see CONFLICTS.md C-22)
- Add valid_until / is_stale / stale_at to AtomicFact or FactNode
  (DR-053; rejected by Pydantic extra="forbid")
- Ask the user "trust this source?" at capture time — that policy
  lives in Settings SET-2 (PO directive [변경 3])
- Surface anything beyond Mode 0..4 — Mode 5 Staleness was retired
- Use `confidence` as float — always HIGH | MEDIUM | LOW enum, and
  never assigned at Structure (DR-028 / Critical Rule 13)
- Add a `kind` field (fact/opinion/definition) — deferred, DR-011
- Use instaloader — ToS violation, use extension-based capture instead
- Create any fact or route without knowledge_space_id
- Use em-dashes (—) in code comments or docstrings
- Add new production dependencies without checking requirements.txt first

---

## 12. Development Stages (S0–S5)

```
S0  Core loop skeleton      Weeks 1–3    beta
S1  Synergy C1 + C3         Weeks 4–8    beta
S2  Pattern synthesis (C2)  M2–M4        post-beta
S3  Connection suggest (C4) M4–M6
S4  L3 cross-user consensus M6
S5  L2 peer + L4 expert     M12 / M18+
```

> **S0 / S1 boundary.** S0 = the core Capture→Structure→Validate→Surface loop
> skeleton (no synergy). S1 = adds Synergy C1 + C3. The ROADMAP.md task list
> (TASK-001..011) predates this consolidation and tags stages loosely;
> AGENTS.md is authoritative on the S0/S1 split.

### S0 Exit Test
- Full loop: capture text → PendingFacts with subject/confidence
  → HITL accept (quorum=1) → FactNode with DERIVED_FROM edge to Source
- Passes in MOCK mode (LUCID_MOCK_LLM=true) AND real API mode
- Empty query returns "검증된 정보가 없습니다" — never hallucinates
- All routes namespaced under /api/spaces/{sid}/

### S1 Exit Test
- Validating a 3rd conflicting fact raises ContradictionFlag within one cycle
- Flag names lowest-credibility fact and unit/time mismatch
- No fact is ever auto-edited or auto-deleted
- C3 surfacing is async — never blocks editor input (target < 200ms)
- Team space with quorum=3: fact only enters graph after 3 accepts

### Task Parallelism (independent sessions)

| Session | Task | Depends On |
|---------|------|------------|
| A | models/ (all Pydantic models) | nothing |
| B | core/graph/schema.py + service.py | models/ |
| C | core/structure/decomposer.py | models/ |
| D | core/capture/ (all extractors) | models/ |
| E | api/routes/spaces.py | models/, graph/ |
| F | api/routes/validate.py + quorum.py | models/, graph/ |
| G | tests/unit/ | all above |

Always start with models/ — zero dependencies.

---

## 13. Stellar Visual Language

Lucid's knowledge graph uses a stellar (우주/별) metaphor where:
  KnowledgeSpace  = Universe (우주)
  FactNode        = Star (별)
  Knowledge cluster = Constellation (별자리)
  Validation level  = Star brightness (L1 dim → L4 brilliant)
  Star color        = Domain (policy=amber, science=blue, econ=teal, tech=purple)
  CONTRADICTS edge  = Red tension line with pulse animation

Core UX principle — Elastic Navigation:
  When filtered, irrelevant stars RECEDE to 8% opacity.
  They never disappear. Context is always preserved.
  On filter clear, stars spring back elastically.
  This is the key differentiator from Obsidian's graph view.

API requirement for graph endpoint:
  GET /api/spaces/{sid}/graph must return validation_level (1-4),
  is_pending, connection_count, and constellation data.
  See docs/visual-design.md and docs/feature-spec-stellar-graph.md.

Do NOT implement the graph as a static node-link diagram.
Every visual property must encode real data from the FactNode schema.

Full spec: [`docs/visual-design.md`](docs/visual-design.md) and
[`docs/feature-spec-stellar-graph.md`](docs/feature-spec-stellar-graph.md).

---

## 14. Decision Log

Full log in [`docs/decision-log.md`](docs/decision-log.md).

| ID | Decision |
|----|----------|
| O-1 | Build on WisdomDB chassis (Approach B) — resolved |
| O-5 | WisdomDB code lives in this repo (monorepo) — resolved |
| DR-001 | confidence = HIGH/MEDIUM/LOW enum, not float |
| DR-002 | Source node with credibility_tier cached at capture |
| DR-003 | C1 runs post-commit, not inside write transaction |
| DR-004 | Contradiction flags auto-clear on HITL resolution |
| DR-005 | ~~Synergy state in Neo4j~~ **RETRACTED** — v2 uses ES + Postgres |
| DR-006 | ~~FAISS for vector search~~ **RETRACTED** — v2 uses ES dense_vector kNN |
| DR-007 | Subject resolution: exact match → 0.88 vector threshold |
| DR-008 | ~~Embed with LOCAL model~~ **REOPENED** — embedding source TBD in PR-1A-3 (C-18) |
| DR-009 | Cheap pre-filter (numeric/unit/date) before LLM contradiction check |
| DR-010 | LLM calls use prompt caching |
| DR-011 | kind field (fact/opinion/definition) deferred |
| DR-012 | DNA meta-network deferred to M12+ |
| DR-013 | Instagram: browser extension only (no instaloader — ToS) |
| DR-014 | KnowledgeSpace is the core organizational unit (not user) |
| DR-015 | ~~valid_from required for policy/legal facts~~ **RETRACTED** — DR-053 / C-14 |
| DR-016 | space_id on every fact and API operation (ES `knowledge_space_id` keyword field — was Neo4j-indexed in v1) |
| DR-017 | Synergy Worker cadence: event-driven with debounce |
| DR-018 | C2 may traverse EXAMPLE_OF/SUPPORTS, weighted + labeled |
| DR-019 | Stellar metaphor: KnowledgeSpace=Universe, FactNode=Star |
| DR-020 | Elastic Navigation: filtered stars recede, never disappear |
| DR-021 | Star brightness encodes validation level L1-L4 |
| DR-022 | Star color encodes domain (policy/science/econ/tech) |
| DR-023 | Contradiction edges pulse red at 0.5Hz |
| DR-024 | Constellation = emergent cluster via Louvain (not user-defined) |
| DR-025 | Beta capture limited to 2 devices: Chrome Extension + PWA |
| DR-026 | Untraced capture excluded from beta (no source_url) |
| DR-027 | Two capture modes: careful (HITL) and trusted (auto-accept) |
| DR-028 | Confidence NOT assigned at Structure stage |
| DR-029 | 12 Object classes finalized (CASOS Meta-Network aligned) |
| DR-030 | Object Subclass only on Entity and Knowledge in beta |
| DR-031 | Duplicate fact increments source_count on existing FactNode |
| DR-032 | Object matching thresholds: 0.95 auto / 0.85 semi-auto |
| DR-033 | Knowledge nodes accept any noun-form domain in beta |
| DR-034 | Curation: 4 ops in beta (Reclassify Object/Demote/Drop/Tag) |
| DR-035 | Validate beta actions: Accept / Edit / Reject |
| DR-036 | Edit preserves history as alias list (text + edited_at) |
| DR-037 | Duplicate-fact policy user-configurable: Quick/Strict/Hybrid |
| DR-038 | Auto-accepted facts support Edit + Demote + Drop |
| DR-039 | No automatic source trust scoring in beta |
| DR-040 | Validation queue grouped by source (one capture = one group) |
| DR-041 | Visual feedback on Accept: star animation + conditional toast |
| DR-042 | Gamification (streak/badges/score) excluded from beta |
| DR-043 | Surface: 6 modes (On/Off + Active/Passive Recall + 3 background) |
| DR-044 | Active Recall: inline tooltip + dotted underline (no side panel) |
| DR-045 | Active Recall in Lucid app + all Chrome extension text fields |
| DR-046 | Passive Recall (Ask Lucid) is the beta killer feature |
| DR-047 | All Surface responses begin with identity phrase + cite fn-ID |
| DR-048 | Contradiction alerts: queue + Stellar View visual only (no toast) |
| DR-049 | Gatekeeping requires 3 conditions to warn |
| DR-050 | Gatekeeping warns, never blocks; override is recorded in metadata |
| DR-051 | ~~Staleness daily/dynamic~~ **RETRACTED** — DR-053 / C-14 |
| DR-052 | ~~Stale facts shown with label~~ **RETRACTED** — DR-053 / C-14 |

| DR-064 | v2 stack: Postgres + Elasticsearch (nori); Neo4j + FAISS retired | (Sprint 1A PR-1A-1, 2026-05-21) |

Still open: **O-3** — contradiction-flag UI placement (inline vs dedicated view).

---

*Lucid v2.2 | Three contexts, one engine | CSVS loop complete | Be lucid.*
