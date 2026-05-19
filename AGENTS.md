# AGENTS.md — Lucid Project v2.1
# Cross-tool standard: OpenAI Codex · Claude Code · GitHub Copilot · Cursor
# Read this entire file before doing anything. Do not skip sections.
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

```bash
# Requirements: Docker Desktop, Python 3.11+, Node.js 18+
cp .env.example .env              # Add ANTHROPIC_API_KEY
docker-compose up -d              # Neo4j + Backend
cd backend && pip install -r requirements.txt
uvicorn api.main:app --reload     # http://localhost:8000
open frontend/index.html          # No build step needed
```

Verify:
```bash
curl http://localhost:8000/api/health
# {"status":"ok","neo4j":"connected","version":"0.3.0"}
```

Mock-first rule: The full Capture → Structure → Validate → Surface loop
must pass tests using `tests/mock_llm.py` BEFORE any real API calls.
`tests/mock_llm.py` holds deterministic fake Claude responses; it is the
first checkpoint of S0, not the last.

---

## 2. Test Commands

```bash
cd backend

pytest tests/ -v                          # All (run before every commit)
pytest tests/unit/ -v                     # Fast, no external deps (<10s)
pytest tests/integration/ -v              # Requires running Neo4j + Docker
pytest tests/unit/test_structurer.py -v   # Specific module
pytest tests/ --cov=. --cov-report=term-missing  # Coverage

# Mock mode (no API keys needed)
LUCID_MOCK_LLM=true pytest tests/ -v
```

Rules: Never commit code that breaks existing tests.
Every new feature requires tests. Integration tests need live Neo4j.

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
│   │   ├── graph/                 Neo4j operations
│   │   │   ├── service.py         CRUD + search + traversal (space-scoped)
│   │   │   └── schema.py          Cypher constraints/indexes
│   │   ├── embed/                 Vector search (FAISS — not Qdrant)
│   │   │   └── service.py         Embed once at validation (local model)
│   │   ├── surface/               Proactive recall
│   │   │   └── engine.py          C3 contextual surfacing
│   │   └── synergy/               Background intelligence
│   │       ├── contradiction.py   C1 detection (post-commit)
│   │       ├── pattern.py         C2 synthesis (density-gated)
│   │       └── suggestion.py      C4 cross-cluster links
│   ├── models/                    Pydantic models (source of truth)
│   │   ├── space.py               KnowledgeSpace, SpaceMember, SpaceRole
│   │   ├── fact.py                AtomicFact, PendingFact, FactNode
│   │   ├── validation.py          ValidationRecord, ValidationMark
│   │   ├── source.py              Source, ExtractionResult, SourceType
│   │   └── graph.py               GraphData, ObjectNode, Relation
│   ├── tests/
│   │   ├── mock_llm.py            Deterministic fake Claude responses
│   │   ├── unit/                  No external dependencies
│   │   └── integration/           Requires running Neo4j
│   ├── Dockerfile
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

`models/` is the single source of truth. Build it first — it has zero
dependencies and every other module imports from it.

### KnowledgeSpace (the fundamental organizational unit)

```python
class KnowledgeSpace(BaseModel):
    id: UUID
    type: Literal["personal","team","policy","public"]
    name: str
    owner_id: UUID
    members: List[SpaceMember]
    visibility: Literal["private","team","org","public"]
    jurisdiction: List[str]       # ["KR","EU","US","global"]
    languages: List[str]          # ["ko","en"]
    validation_quorum: int        # 1=personal, 3+=team, dynamic=policy
    created_at: str
```

Every FactNode belongs to exactly one KnowledgeSpace.
This single abstraction serves all three user contexts.

> **S0 assumption.** Multi-user auth (JWT) is TASK-014, post-beta. Until then,
> S0 seeds one hardcoded dev user and one default `personal` KnowledgeSpace,
> so `owner_id` / `validator_id` UUIDs are well-defined from day one.

### Fact lifecycle: AtomicFact → PendingFact → FactNode

These are **three distinct Pydantic models**, one per lifecycle stage. Do not
collapse them into one model with a `state` flag.

| Model | Stage | Adds over the previous stage |
|-------|-------|------------------------------|
| `AtomicFact` | Structurer output | The raw decomposed claim payload. No id, no validation. |
| `PendingFact` | In the HITL queue | `+ id, space_id, created_at, queue_status`. Awaiting L1. |
| `FactNode` | Persisted in Neo4j | `+ validation marks, validated_at, graph metadata`. Validated. |

`PendingFact` and `FactNode` reuse `AtomicFact`'s claim fields by composition
(an `AtomicFact` field) or inheritance — implementer's choice — but the three
class names must exist and be importable from `models/fact.py`.

### AtomicFact (the fundamental knowledge unit)

```python
class AtomicFact(BaseModel):
    claim: str                    # Single falsifiable statement, max 200 chars
    subject: str                  # Primary entity (normalized)
    predicate: str                # Relationship verb
    object: str                   # Target entity or value
    confidence: Literal["HIGH","MEDIUM","LOW"]  # AI source-credibility estimate

    # Provenance
    source_url: str
    source_title: str
    source_type: str              # youtube|web|image|audio|pdf|text
    personal_note: str            # Why this was saved

    # Geopolitical context
    jurisdiction: List[str]       # ["KR"] | ["EU"] | ["global"] etc.
    language: str                 # "ko" | "en"
```

`FactNode` extends the above with:

```python
    id: UUID
    space_id: UUID                # Parent KnowledgeSpace — REQUIRED (DR-016)

    # Temporal validity (valid_from REQUIRED for policy/legal facts — DR-015)
    valid_from: Optional[str]     # ISO date — when this fact became true
    valid_until: Optional[str]    # ISO date — when this fact expires/needs review
    is_stale: bool = False        # Set by the background staleness checker

    # Validation marks (L1 always required; L2-L4 are future)
    l1_validated: bool = False
    l1_validated_at: Optional[str]
    l2_agreement_pct: Optional[float]   # M12
    l3_agreement_pct: Optional[float]   # M6
    l4_expert_id: Optional[str]         # M18+

    confidence: Literal["HIGH","MEDIUM","LOW"]  # carried from AtomicFact
    created_at: str
    validated_at: Optional[str]
```

### ValidationMark

```python
ValidationMark = Literal["L1","L2","L3","L4"]
# A tier label, used by core/validate/marker.py to apply a validation mark
# to a FactNode. L1 = self HITL (M0), L3 = system aggregate (M6),
# L2 = trust network (M12), L4 = expert certification (M18+).
```

### ValidationRecord (who validated what and when)

```python
class ValidationRecord(BaseModel):
    id: UUID
    fact_id: UUID
    space_id: UUID
    validator_id: UUID
    validator_role: str           # "researcher"|"official"|"expert"
    action: Literal["accept","edit","reject"]
    edited_claim: Optional[str]
    validated_at: str
    institutional_affiliation: Optional[str]  # "국회입법조사처"
    l4_credential: Optional[str]             # Expert cert ID
```

### Confidence vs. Validation — two independent axes

`confidence` (HIGH/MEDIUM/LOW) is the AI's estimate of **source credibility**.
A validation mark (L1-L4) is **human judgment on truth**. They are independent:
a HIGH-confidence fact can be rejected by a human; a LOW-confidence fact can be
accepted. Never conflate the two, and never derive one from the other.

### ObjectNode (OPL-inspired — replaces the old ConceptNode)

```python
# In Neo4j:
(:Object {
    uid: UUID,
    name: str,                    # Normalized entity name
    object_class: str,            # "Company"|"Metric"|"Concept"|
                                  # "GeopoliticalRegime"|"Person"|
                                  # "LegalAct"|"Policy"
    observed_properties: JSON     # Latest known property values
})
```

`models/graph.py` carries a Pydantic `ObjectNode` mirroring this node.
`ConceptNode` is removed — anywhere a stale doc still says `ConceptNode`,
read `ObjectNode`.

### SpaceNode

```python
(:Space {
    uid: UUID,
    type: str,                    # personal|team|policy|public
    name: str,
    owner_id: UUID,
    visibility: str,
    validation_quorum: int,
    created_at: str
})
```

KnowledgeSpace persists as a first-class `(:Space)` Neo4j node (the beta runs
on Neo4j only — DR-005). Every `(:Fact)` and `(:PendingFact)` carries a
`space_id` property; queries are space-scoped through it.

### SourceNode

```python
(:Source {
    uid: UUID,
    ref_url: str,
    publisher_class: str,         # "primary"|"peer_reviewed"|
                                  # "reputable_secondary"|"user_generated"
    credibility_tier: str,        # "HIGH"|"MEDIUM"|"LOW" — cached at capture
    captured_at: str
})
```

### Neo4j Edge Types

```cypher
-- Provenance (immutable, weight 1.0)
(:Fact)-[:DERIVED_FROM { weight: 1.0 }]->(:Source)

-- State assertions (Fact -> Object property link)
(:Fact)-[:ASSERTS_STATE { property: str, value: str, unit: str }]->(:Object)

-- Synergy edges (human-confirmed, lower traversal weight)
(:Fact)-[:SUPPORTS    { weight: 0.85 }]->(:Fact)
(:Fact)-[:EXAMPLE_OF  { weight: 0.70 }]->(:Fact)
(:Fact)-[:CONTRADICTS { reason_code: str }]->(:Fact)
(:Fact)-[:REINFORCES  { weight_bump: float }]->(:Fact)

-- Concept links
(:Fact)-[:HAS_CONCEPT]->(:Object)
(:Fact)-[:MENTIONS]->(:Object)
```

DERIVED_FROM is immutable provenance. SUPPORTS/EXAMPLE_OF are human-confirmed
synthetic edges with lower traversal weight. Surface and Query modules always
prefer DERIVED_FROM paths over synthetic edges.

### Neo4j Indexes & Constraints (required — DR-016)

```cypher
CREATE CONSTRAINT space_id   IF NOT EXISTS FOR (s:Space)  REQUIRE s.uid IS UNIQUE;
CREATE CONSTRAINT fact_id    IF NOT EXISTS FOR (f:Fact)   REQUIRE f.id  IS UNIQUE;
CREATE CONSTRAINT object_uid IF NOT EXISTS FOR (o:Object) REQUIRE o.uid IS UNIQUE;
CREATE CONSTRAINT source_uid IF NOT EXISTS FOR (s:Source) REQUIRE s.uid IS UNIQUE;

CREATE INDEX fact_space   IF NOT EXISTS FOR (f:Fact)   ON (f.space_id);
CREATE INDEX fact_subject IF NOT EXISTS FOR (f:Fact)   ON (f.subject);
CREATE INDEX fact_l1      IF NOT EXISTS FOR (f:Fact)   ON (f.l1_validated);
CREATE INDEX source_tier  IF NOT EXISTS FOR (s:Source) ON (s.credibility_tier);
```

Every query is space-scoped (`WHERE n.space_id = $space_id`); every Synergy
retrieval filters on `l1_validated`; C1 looks up facts by `subject`. Without
these indexes each is a full graph scan.

### Synergy State (stored in Neo4j as nodes for beta — DR-005)

```
(:ContradictionFlag {
    subject_key: str, participating_fact_ids: JSON,
    min_credibility_tier: str, reason_code: str,
    state: "ACTIVE"|"AUTO_RESOLVED", updated_at: str
})

(:ConnectionSuggestion {
    fact_a_id: UUID, fact_b_id: UUID,
    predicted_relation: str, confidence_score: float,
    state: "PENDING"|"ACCEPTED"|"SKIPPED"
})

(:SynergyJob {
    cursor: str,    # Last processed fact ID — enables incremental scans
    last_run_at: str, status: str
})
```

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
1. User accepts fact → Neo4j write commits → PendingFact deleted
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
   FactNodes from Neo4j. Never LLM general knowledge. No relevant fact = honest
   "I don't have validated information on this."

2. **HITL is mandatory.** All extracted facts go to PendingFact queue first.
   No shortcut path to FactNode without L1 validation (and quorum if team/policy).

3. **Atomic facts, not summaries.** Structurer decomposes into individual
   falsifiable claims. One claim = one PendingFact. Summaries are not stored.

4. **personal_note must be prompted.** A fact without context on WHY it was
   saved loses value over time.

5. **Neo4j lists as JSON strings.** Always serialize before storing, deserialize
   after reading. Never store Python lists directly.

6. **Confidence is enum, not float.** HIGH | MEDIUM | LOW. Human judges
   categorically. Float precision is false precision. Confidence and validation
   are independent axes (see section 4).

7. **Subject resolution: two gates, strict order.** Exact match first.
   Vector fallback only at ≥ 0.88. Never lower.

8. **C1 runs post-commit.** Contradiction detection never runs inside the
   Neo4j write transaction. Always a separate async operation after commit.

9. **Below density floor: degrade honestly.** If domain has < 50 facts,
   label as retrieval, not pattern synthesis. Never fabricate a pattern.

10. **valid_from is required for policy/legal facts.** Any fact referencing
    a law, regulation, or policy MUST have valid_from set. valid_until is
    strongly recommended. is_stale must be checkable by background job.

11. **space_id on every fact and operation.** No fact exists outside a
    KnowledgeSpace. Every API call that touches facts requires space_id.

12. **ToS-safe capture only.** No instaloader (Meta ToS violation). Instagram
    capture via browser extension only (user-visible screen). YouTube: transcript
    API first, yt-dlp only as last resort with local processing.

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
# Required
ANTHROPIC_API_KEY=sk-ant-...
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=lucid2026

# Development
LUCID_MOCK_LLM=false           # true = use tests/mock_llm.py, no API calls
LUCID_ENV=development          # development | staging | production

# Embeddings — local model only, no hosted embedding API (DR-008)
EMBEDDING_MODEL=paraphrase-multilingual-MiniLM-L12-v2  # ko+en, runs locally

# Optional
YOUTUBE_TRANSCRIPT_LANG=ko,en  # Preferred transcript languages
MAX_FACTS_PER_CAPTURE=10       # Limit atomic facts per single capture
STALENESS_CHECK_INTERVAL=86400 # Seconds between staleness scans
```

---

## 11. What Agents Must NOT Do

- Answer queries using LLM general knowledge — validated facts ONLY
- Create a FactNode without going through PendingFact → HITL → quorum
- Run C1 contradiction detection inside a Neo4j write transaction
- Use vector similarity below 0.88 for subject-to-Object node linking
- Add Qdrant, Postgres, or any database beyond Neo4j and FAISS (beta)
- Use a hosted embedding API — embeddings run on a local model (DR-008)
- Use `confidence` as float — always HIGH | MEDIUM | LOW enum
- Add a `kind` field (fact/opinion/definition) — deferred, DR-011
- Use instaloader — ToS violation, use extension-based capture instead
- Store Python lists directly in Neo4j properties — serialize to JSON string
- Create any fact or route without space_id
- Write policy/legal facts without valid_from field
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

## 13. Decision Log

Full log in [`docs/decision-log.md`](docs/decision-log.md).

| ID | Decision |
|----|----------|
| O-1 | Build on WisdomDB chassis (Approach B) — resolved |
| O-5 | WisdomDB code lives in this repo (monorepo) — resolved |
| DR-001 | confidence = HIGH/MEDIUM/LOW enum, not float |
| DR-002 | Source node with credibility_tier cached at capture |
| DR-003 | C1 runs post-commit, not inside write transaction |
| DR-004 | Contradiction flags auto-clear on HITL resolution |
| DR-005 | Synergy state in Neo4j for beta (not Postgres) |
| DR-006 | FAISS for vector search in beta (not Qdrant) |
| DR-007 | Subject resolution: exact match → 0.88 vector threshold |
| DR-008 | Embed once at validation, with a LOCAL embedding model |
| DR-009 | Cheap pre-filter (numeric/unit/date) before LLM contradiction check |
| DR-010 | LLM calls use prompt caching |
| DR-011 | kind field (fact/opinion/definition) deferred |
| DR-012 | DNA meta-network deferred to M12+ |
| DR-013 | Instagram: browser extension only (no instaloader — ToS) |
| DR-014 | KnowledgeSpace is the core organizational unit (not user) |
| DR-015 | valid_from required for policy/legal facts |
| DR-016 | space_id on every fact and API operation; Neo4j indexed |
| DR-017 | Synergy Worker cadence: event-driven with debounce |
| DR-018 | C2 may traverse EXAMPLE_OF/SUPPORTS, weighted + labeled |

Still open: **O-3** — contradiction-flag UI placement (inline vs dedicated view).

---

*Lucid v2.1 | Three contexts, one engine | Be lucid.*
