# Decision Log — Lucid

> Canonical record of architecture and product decisions. AGENTS.md section 13
> carries the summary table; this file carries the rationale.
> Last updated: 2026-05-19.

## Resolved

| ID | Decision | Rationale |
|----|----------|-----------|
| O-1 | Approach B: build on the WisdomDB chassis | WisdomDB owns the capital-intensive infra (Neo4j, browser extension, multimodal extraction). Student's reusable contribution is ~220 lines of prompts plus one invariant. |
| O-5 | WisdomDB code lives in this repo (monorepo) | Approach B adds Lucid modules INTO WisdomDB's backend; a separate repo is incompatible. AGENTS.md section 3, ROADMAP, and docker-compose all assume one tree. Import WisdomDB as a baseline commit. |
| DR-001 | confidence is HIGH/MEDIUM/LOW enum, not float | Human judges categorically; float precision is false precision. |
| DR-002 | Source node with credibility_tier cached at capture | Avoid repeated lookups on a hot path. |
| DR-003 | C1 runs post-commit, not inside the write transaction | Holding a graph transaction across an LLM call risks lock contention and timeout. |
| DR-004 | Contradiction flags auto-clear on HITL resolution | Reduce manual overhead. |
| DR-005 | Synergy state in Neo4j for beta (not Postgres) | One database for the beta. |
| DR-006 | FAISS for vector search in beta (not Qdrant) | Operational simplicity. |
| DR-007 | Subject resolution: exact match then 0.88 vector threshold | Prevent cross-topic false positives. |
| DR-008 | Embed once at validation, with a LOCAL embedding model | C3 embeds drafting passages on a debounce; a hosted embedding API on that hot path is an unbounded recurring cost. Use a local multilingual model (Korean + English ICP). |
| DR-009 | Cheap pre-filter (numeric/unit/date) before the LLM contradiction check | Cost control. |
| DR-010 | LLM calls use prompt caching | Cost control. |
| DR-011 | kind field (fact/opinion/definition) deferred | Classification risk outweighs value at this stage. |
| DR-012 | DNA meta-network deferred to M12+ | Needs data density first. |
| DR-013 | Instagram capture via browser extension only (no instaloader) | instaloader violates Meta ToS. |
| DR-014 | KnowledgeSpace is the core organizational unit (not the user) | One abstraction serves the personal, team, and policy contexts. |
| DR-015 | valid_from required for policy/legal facts | Policy and legal facts expire; staleness must be checkable by a background job. |
| DR-016 | space_id on every fact and API operation; Neo4j indexed | Every query is space-scoped; without an index each query is a full graph scan. |
| DR-017 | Synergy Worker cadence: event-driven with a debounce | A fact-commit enqueues a job keyed by space_id; a ~10 min debounce coalesces capture bursts into one scan; the worker scans incrementally from SynergyJob.cursor and no-ops below the C4 density floor. Beats nightly cron (stale, wastes scans on idle users) and on-idle detection (unreliable for a server-side job). Worker is S3 scope; S0 only reserves the SynergyJob.cursor field. |
| DR-018 | C2 may traverse EXAMPLE_OF/SUPPORTS edges, weighted and labeled | These edges are human-confirmed but not source-derived. C2 uses them to expand the candidate set at their lower edge weight, clearly labeled; every pattern claim must still cite at least one DERIVED_FROM-grounded fact, and a synthetic edge may never be a pattern's sole support. C2 is S2 scope. |
| DR-019 | Stellar metaphor: KnowledgeSpace=Universe, FactNode=Star, cluster=Constellation | Founder visual-language decision, 2026-05-19. See docs/visual-design.md. |
| DR-020 | Elastic Navigation: filtered stars recede to 8% opacity, never disappear | UX principle - context is always preserved, unlike Obsidian's node-removal filter. |
| DR-021 | Star brightness encodes validation level (L1 dim to L4 brilliant) | Visual language - every visual property encodes real data. |
| DR-022 | Star color encodes domain (policy=amber, science=blue, economics=teal, technology=purple) | Visual language. Requires a domain field on the fact model (flagged in feature-spec). |
| DR-023 | Contradiction edges pulse red at 0.5Hz | UX feedback for [:CONTRADICTS] edges. |
| DR-024 | Constellation = emergent cluster via Louvain community detection, not user-defined | Algorithm - the cognitive fingerprint forms automatically. |

## Open

| ID | Question | Blocks |
|----|----------|--------|
| O-3 | Contradiction-flag UI placement — inline vs. dedicated view | S1 polish |

## Notes

- 2026-05-19: the former `AGENTS.md` (v0.3) and `AGENTS_v2.md` were consolidated
  into a single canonical `AGENTS.md` (v2.1). `AGENTS_v2.md` was removed.
- `docs/integration-architecture.md` predates DR-005/DR-006 and still describes a
  Neo4j + Qdrant + Postgres polyglot store; the beta runs on Neo4j + FAISS only.
  That document needs a revision pass to match (tracked; not yet done).
- `ROADMAP.md` and `CODEX_FIRST_PROMPT.md` predate the KnowledgeSpace model and
  the v2.1 consolidation (non-namespaced routes, ConceptNode, instaloader in the
  dependency list). They need a sync pass before their task prompts are used.
- 2026-05-19: the Stellar Knowledge Graph task originally specified DR-017..DR-022
  for the stellar decisions, but those IDs were already taken (DR-017 Synergy
  Worker cadence, DR-018 C2 traversal). The stellar decisions were renumbered to
  DR-019..DR-024 to avoid overwriting them.
