# Decision Log — Lucid

> Canonical record of architecture and product decisions. AGENTS.md section 13
> carries the summary table; this file carries the rationale.
> Last updated: 2026-05-20.

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
| DR-025 | Beta capture limited to 2 devices: Chrome Extension + PWA | Provenance enforcement — every captured fact must carry a verifiable source_url; only Chrome Extension and PWA Share Target structurally guarantee this. See docs/capture-stage-spec.md. |
| DR-026 | Untraced capture (screenshots, file upload, camera, clipboard, voice memo, email forward) excluded from beta | Source URL must exist — untraced inputs undermine validation infrastructure; Phase 1 policy options (force user input / AI inference / separate untraced queue / permanent exclusion) deferred. |
| DR-027 | Two capture modes: careful (HITL required) and trusted (auto-accept from registered trusted sources) | User policy expression — users decide per-source whether a capture goes through HITL or straight to FactNode. Auto-accepted facts stay in a separate review tab and rejoin the main queue on contradiction, trust revocation, or valid_until expiry. |
| DR-028 | Confidence is NOT assigned at the Structure stage | Avoid AI bias on validation — confidence is derived at Validate/Surface from publisher authority, validation tier, time freshness, and consensus signals. The Structurer never emits a confidence value. Supersedes the AtomicFact `confidence` field carried over from the pre-spec model (cleanup tracked in CONFLICTS.md). |
| DR-029 | 12 Object classes finalized: AtomicFact, Concept, Entity, Event, Procedure, Knowledge, Task, Metric, Resource, Problem, Source (Entity parent has 5 subclasses) | CASOS Meta-Network alignment — Agent/Knowledge/Task/Resource axes all explicitly represented for academic analysis compatibility. |
| DR-030 | Object Subclass applied only to Entity (Person/Organization/Service/Product/Place) and Knowledge (free-text domain) in beta | Minimize cognitive load — Procedure, Resource, Event, Task, Metric, Problem stay as single classes with free-text name in beta. Subclassing for those classes deferred to Phase 1+ pending real-world data. |
| DR-031 | Duplicate fact from a different source increments source_count on the existing FactNode | Quantitative reinforcement — multi-source agreement automatically strengthens signal without creating duplicate nodes. Exact duplicates from the same source are ignored. |
| DR-032 | Object matching thresholds: auto-merge (>0.95), semi-auto with user confirmation (0.85-0.95), keep separate (<0.85) | Hybrid approach — automation handles clear cases (case/spacing/transliteration variants) without bothering the user, ambiguous middle band asks for confirmation, low similarity stays separate and is mergeable via Curation. |
| DR-033 | Knowledge nodes accept any noun-form domain (academic, professional, social, applied) | Free expansion in beta — no domain whitelist; Q2 matching algorithm consolidates synonyms organically; revisit in Phase 1 once distribution data is in. |
| DR-034 | Curation operations in beta: Reclassify Object, Demote Fact, Drop Fact, Tag/Untag (4 ops only) | 4 ops only — Merge Objects, Split Object, Reclassify Fact, and Cross-space Move deferred to post-beta to keep curation surface tight. |
| DR-035 | Validate offers 3 actions in beta: Accept / Edit / Reject | Minimize cognitive load — Skip and Bulk-accept deferred to Phase 1. See validate-stage-spec.md §5 and §11. |
| DR-036 | Edit preserves history as alias list (text + edited_at pairs) | Search robustness + simplicity — `claim` holds the latest text, `aliases[]` retains prior phrasings so the search index still hits the original wording. See validate-stage-spec.md §14 Q1. |
| DR-037 | Duplicate-fact policy is user-configurable: Quick / Strict / Hybrid | User autonomy on validation rigor — Quick auto-increments `source_count` and skips validation, Strict re-validates every duplicate, Hybrid does quick for same source / strict for new source. See validate-stage-spec.md §14 Q2. |
| DR-038 | Auto-accepted (trusted) facts support Edit + Demote + Drop in beta | Full curation capability — even auto-accepted facts must be editable, demotable to PendingFact, or droppable from the Auto-accepted tab. See validate-stage-spec.md §7 and §14 Q3. |
| DR-039 | No automatic source trust scoring in beta | User manages trusted sources manually — `trusted` mode applies only to user-registered sources; automatic source-quality scoring is deferred (would compromise user autonomy). See validate-stage-spec.md §14 Q4. |
| DR-040 | Validation queue grouped by source (one capture = one group) | Context coherence — N facts from the same lecture/article share context and must be reviewed together. See validate-stage-spec.md §4. |
| DR-041 | Visual feedback on Accept: star animation + conditional insight toast | Minimum gamification — star appears in mini-graph thumbnail on Accept; toast only fires on graph inflection (≥3 connected facts) or new constellation formation, max 2 per session. See validate-stage-spec.md §8. |
| DR-042 | Streak / badges / score gamification excluded from beta | Focus on epistemic substance — gamification reviewed for Phase 1+. See validate-stage-spec.md §11. |
| DR-043 | Surface includes 6 modes: On/Off, Active Recall, Passive Recall, Contradiction, Gatekeeping, Staleness | Comprehensive scope — Mode 0 (On/Off) gates the other five. See surface-stage-spec.md §3. |
| DR-044 | Active Recall uses inline tooltip + dotted underline, not side panel | Information embedded in text — keywords get dotted underline, hover shows top-3 related facts inline; "See all" opens a separate panel only for navigation. See surface-stage-spec.md §5 and §14 Q1. |
| DR-045 | Active Recall works in Lucid app + all Chrome extension text fields | Maximum reach without native apps — Gmail, Google Docs, Notion(web), Slack/Twitter/Discord composers, generic textarea/contenteditable. Desktop native apps and mobile keyboards deferred. See surface-stage-spec.md §5 and §14 Q2. |
| DR-046 | Passive Recall (Ask Lucid) is the beta killer feature | Identity-affirming QnA — text-only in beta; voice ("Hey Lucid") deferred to Phase 1. See surface-stage-spec.md §6. |
| DR-047 | All Surface responses begin with an identity phrase ("As far as I know..." or equivalent) and cite fn-ID for every claim | Epistemic commitment enforcement — separates Lucid from ChatGPT-style answer machines; violating this is a beta-blocking bug. See surface-stage-spec.md §2 and §6, and §14 Q6. |
| DR-048 | Contradiction alerts: queue + Stellar View visual only, no toast | Protect user workflow — toast alerts are too disruptive for the contradiction firehose; user discovers contradictions via main-screen badge and red tension lines in Stellar View. See surface-stage-spec.md §7 and §14 Q4. |
| DR-049 | Gatekeeping requires 3 conditions: contradicting facts + stronger authority + more recent verification | Conservative blocking — all three conditions must hold before Lucid warns; normal fact evolution (e.g., updated statistics from the same source) does NOT trigger a warning. See surface-stage-spec.md §8. |
| DR-050 | Gatekeeping warns, never blocks. "Save anyway" is recorded as `override_warning: true` in metadata | User autonomy — Lucid surfaces conflicts but the user always decides. Overridden facts get a yellow border in Stellar View for post-hoc review. See surface-stage-spec.md §8 and §14 Q5. |
| DR-051 | Staleness detection: daily background scan + dynamic trigger at Surface time | Hybrid approach — daily cron flags `is_stale=true` on facts past `valid_until`; if a stale fact is surfaced via Active/Passive Recall before the next scan, the dynamic trigger flags it immediately. See surface-stage-spec.md §9. |
| DR-052 | Stale facts shown with label, not hidden from Surface | Honest degradation — staleness is visible (label + de-saturated star + slow flicker in Stellar View), and the user chooses re-validate / drop / keep-as-historical. Hiding would silently drop coverage. See surface-stage-spec.md §9. |
| DR-053 | Beta is wedge discovery, not wedge validation | Honest pitch principle — earlier hypotheses about academic researchers as the primary target have been retracted; usage data determines the wedge. See beta-backlog.md §0. |
| DR-054 | Universal recruitment + self-selection screening, NOT family/academic channels | Phase 1 expansion preservation — family/academic networks are strategic capital reserved for Phase 1 once the wedge archetype is identified. See beta-backlog.md §1.1. |
| DR-055 | Beta target: 30-40 users, quality over quantity | Better fewer real signals — 30 retained users beat 70 names; floor is 30, not the 50 figure that appeared in earlier drafts. See beta-backlog.md §1.1 and §1.4. |
| DR-056 | Archetype measured along 5 dimensions: consumption intensity, validation frequency, surface usage pattern, domain diversity, device environment | Multi-dim wedge discovery — segment is not asked at signup; it is inferred from behavior along these axes. See beta-backlog.md §1.2. |
| DR-057 | Sprint-based decomposition, NOT week-based | Codex/Claude Code parallelism — sprints are dependency-ordered units of work sized to one Claude Code session = one PR. Calendar time is not the unit. See beta-backlog.md §4. |
| DR-058 | 15 sprints total (0, 1A, 1B, 2A, 2B, 2C, 3, 4A, 4B, 5, 6A, 6B, 6C, 6D, 7) | Dependency-driven structure — sub-letters (1A/1B etc.) mark parallel-safe siblings; numeric jumps mark dependency boundaries. (NOTE: the PO's task text said "12 sprints" but the listed IDs total 15; flagged in CONFLICTS.md C-13. The 15-sprint structure here matches beta-backlog.md §4 verbatim.) |
| DR-059 | Sprint definition level C: goal + scope + dependencies + DoD + tests + demo | Codex-autonomous execution — each sprint carries enough context for a Claude Code session to execute without follow-up clarification. See beta-backlog.md §5. |
| DR-060 | P0 = beta launch required; P1 = continuous deployment during beta | Launch gate clarity — only P0 sprints block the beta launch gate; P1 items deploy continuously once their dependencies are satisfied. See beta-backlog.md §3. |
| DR-061 | Beta launch criteria: 30+ users AND 60%+ retention AND NPS 40+ AND identified wedge archetype | All four required — partial achievement triggers hypothesis review, not Phase 1 entry. See beta-backlog.md §1.4. |
| DR-062 | Phase 1 expansion uses family/academic channels matched to discovered wedge | Strategic capital preservation — the channels held back during beta deploy in Phase 1 against the wedge archetype that beta data identified. See beta-backlog.md §1.3. |
| DR-063 | Marketing message validation is part of beta data collection | Brand message test in field — the four headline messages tracked in beta-backlog.md §8 are themselves a hypothesis tested against user response. |

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
- 2026-05-20: the CSVS Stage Specifications task originally specified DR-023..DR-032
  for the Capture and Structure decisions, but DR-023 (contradiction edge pulse)
  and DR-024 (Louvain constellation) were already resolved. Following the same
  precedent above, the CSVS decisions were renumbered to DR-025..DR-034. AGENTS.md
  Section 1.1 and Critical Rules 13-14 cite the renumbered IDs. See CONFLICTS.md.
- 2026-05-20: the CSVS Complete handoff specified DR-033..DR-050 for the
  Validate and Surface decisions, but DR-033 (Knowledge nodes) and DR-034
  (Curation 4 ops) were already taken by the prior CSVS handoff. Applying
  the same +2 offset, the Validate/Surface decisions were renumbered to
  DR-035..DR-052. AGENTS.md Section 4.5 cross-stage invariants do not
  reference DR IDs directly, so no in-line citation updates are required.
  Cumulative renumbering history is now: task IDs Y..Z map to actual IDs
  Y+2..Z+2 across both CSVS handoffs. See CONFLICTS.md.
- 2026-05-20: the Beta Backlog handoff specified DR-051..DR-061 for the
  beta execution decisions, but DR-051 (Staleness daily/dynamic) and
  DR-052 (Stale shown with label) were already taken by the CSVS Complete
  handoff. Same +2 offset applied a third time: the beta backlog decisions
  are now DR-053..DR-063. AGENTS.md §4.5 invariant 6 cites DR-053; no
  other in-line citation updates needed. The +2 offset is now cumulative
  across three handoffs.
