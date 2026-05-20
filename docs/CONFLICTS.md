# CSVS Stage Specs — Integration Conflicts

**Branch:** `feat/lucid-beta-backlog` (continues `feat/lucid-csvs-complete`)
**Date:** 2026-05-20 (updated; original 2026-05-20)
**Status:** Open — needs PO review

This file records conflicts surfaced while integrating the four CSVS
stage specifications into AGENTS.md and the decision log:

```
docs/capture-stage-spec.md    (integrated CSVS handoff 1)
docs/structure-stage-spec.md  (integrated CSVS handoff 1)
docs/validate-stage-spec.md   (integrated CSVS handoff 2)
docs/surface-stage-spec.md    (integrated CSVS handoff 2)
docs/beta-backlog.md          (integrated this handoff)
```

The task instruction is: flag conflicts rather than silently overwrite.
Each item below was resolved with the safest defensible call; flagged
here so the PO can confirm or revise.

**Cumulative renumbering offset:** task IDs Y..Z became actual IDs
Y+2..Z+2 across all three handoffs (see C-1, C-7, C-11).

---

## C-1. Decision IDs DR-023 and DR-024 already taken

**Conflict.** The CSVS task specified new decisions numbered DR-023
through DR-032. Both DR-023 and DR-024 were already resolved on
2026-05-19 as stellar visual-language decisions:

```
DR-023  Contradiction edges pulse red at 0.5Hz
DR-024  Constellation = emergent cluster via Louvain (not user-defined)
```

**Resolution applied.** Following the exact precedent recorded in
`docs/decision-log.md` under Notes (2026-05-19 — stellar IDs renumbered
from DR-017..DR-022 to DR-019..DR-024), the CSVS decisions were
renumbered from DR-023..DR-032 to **DR-025..DR-034**. AGENTS.md Section
1.1 and Critical Rules 13-14 cite the renumbered IDs.

Mapping:

| Task ID | Final ID | Decision |
|---------|----------|----------|
| DR-023  | DR-025   | Beta capture limited to 2 devices |
| DR-024  | DR-026   | Untraced capture excluded from beta |
| DR-025  | DR-027   | Two capture modes (careful / trusted) |
| DR-026  | DR-028   | Confidence NOT assigned at Structure |
| DR-027  | DR-029   | 12 Object classes finalized |
| DR-028  | DR-030   | Object Subclass on Entity and Knowledge only |
| DR-029  | DR-031   | Duplicate fact → source_count increment |
| DR-030  | DR-032   | Object matching thresholds (0.95 / 0.85) |
| DR-031  | DR-033   | Knowledge nodes: any noun-form domain |
| DR-032  | DR-034   | Curation: 4 ops in beta |

**PO action.** Confirm the renumbering, or specify an alternative
(e.g., move the stellar decisions to DR-200+ and free up DR-023..DR-024
for capture/structure).

---

## C-2. AtomicFact still carries a `confidence` field

**Conflict.** The Structure spec §1 says explicitly:

> Confidence는 Structure 단계에서 부여하지 않는다.

DR-028 codifies this: confidence is derived at Validate/Surface, not
emitted by the Structurer. But AGENTS.md §4 still defines the AtomicFact
model with:

```python
confidence: Literal["HIGH","MEDIUM","LOW"]  # AI source-credibility estimate
```

and FactNode inherits the same field. Critical Rule 6 also still says
"Confidence is enum, not float."

**Resolution applied.** Critical Rule 13 was added (Confidence NOT at
Structure) and references this conflict via a NOTE pointing to this
file. The AtomicFact / FactNode Pydantic stubs in §4 were left in place
to avoid silently dropping a field that other docs may still reference.

**PO action.** Choose one:

1. **Remove `confidence` from AtomicFact entirely** and rewrite Critical
   Rule 6 to describe the derived signal at Validate/Surface instead.
2. **Keep `confidence` on FactNode only** as the cached derived value,
   computed at validation time. AtomicFact would lose the field.
3. **Keep both fields** and treat the AtomicFact one as a Capture-stage
   source-credibility hint (separate from the Structure ban). This
   requires reconciling the Structure spec wording.

Whichever path, the AGENTS.md AtomicFact and FactNode stubs should be
updated and Critical Rule 6 rewritten.

---

## C-3. ObjectNode `object_class` enum expanded

**Conflict.** AGENTS.md §4 previously listed seven object_class values:

```
Company | Metric | Concept | GeopoliticalRegime | Person | LegalAct | Policy
```

The Structure spec §4 defines the final 12-class Lucid Ontology:

```
AtomicFact | Concept | Entity (Person/Organization/Service/Product/Place)
| Event | Procedure | Knowledge | Task | Metric | Resource | Problem | Source
```

`Company`, `GeopoliticalRegime`, `LegalAct`, `Policy` from the old list
do not appear in the new ontology. `Theory` and `Material` (mentioned in
the task as legacy names to replace with Knowledge / Resource) were not
present in AGENTS.md anywhere — no replacement needed.

**Resolution applied.** AGENTS.md §4 ObjectNode block updated to list
all 12 classes plus the 5 Entity subclasses (DR-029, DR-030). The old
seven-class list was removed.

**PO action.** Confirm that `Company` and `GeopoliticalRegime` map to
`Entity:Organization` and `Entity:Place` respectively, and that
`LegalAct` / `Policy` are folded under `Knowledge` (with the old strings
deprecated). If any existing seed data uses the old strings, a migration
note is needed.

---

## C-4. Edge type vocabulary diverges

**Conflict.** AGENTS.md §4 lists Neo4j edge types:

```
DERIVED_FROM, ASSERTS_STATE, SUPPORTS, EXAMPLE_OF, CONTRADICTS,
REINFORCES, HAS_CONCEPT, MENTIONS
```

Structure spec §5 lists a different/expanded set:

```
ASSERTS_PROPERTY, DESCRIBES_STATE, ADDRESSES, USES, INVOLVES,
PART_OF, INSTANCE_OF, LOCATED_IN, HAS_ROLE,
SUPPORTS, CONTRADICTS, EXAMPLE_OF, DERIVED_FROM,
INTERPRETS, SUPERSEDES, CAPTURED_FROM
```

Notable: `ASSERTS_STATE` (AGENTS.md) vs `ASSERTS_PROPERTY` +
`DESCRIBES_STATE` (spec); `REINFORCES` / `HAS_CONCEPT` / `MENTIONS` are
not in the spec; `INTERPRETS`, `SUPERSEDES`, `CAPTURED_FROM`,
`INSTANCE_OF` and the Object-Object edges are new.

**Resolution applied.** Not touched. AGENTS.md §4 still shows the
original edge list. This is implementation-touching and beyond the
"cross-reference the specs" mandate of this task.

**PO action.** A follow-up task should reconcile the edge vocabulary
before any Structure-stage code lands. Recommend: spec takes precedence,
AGENTS.md §4 edge block gets updated, the Synergy section (§5) gets
re-checked for any references to dropped edges.

---

## C-5. Section 14 (AGENTS.md decision log summary table) — RESOLVED

**Conflict (lightweight).** AGENTS.md §14 held a summary table that ended
at DR-024 after the first handoff while the full log was current through
DR-034 (now DR-052 after this handoff).

**Resolution applied (this handoff).** §14 was extended in the
consistency pass (Operation 4) to mirror docs/decision-log.md through
DR-052. The duplication is intentional — §14 is a single-screen quick
reference for agents; the full log carries rationales. PO action: none.

---

## C-6. Validate / Surface specs — INTEGRATED

Validate and Surface specs landed in this handoff. AGENTS.md §4.5 was
expanded to reference all four specs and now includes the five
cross-stage invariants (source provenance, capture mode -> validation
path, no confidence at Structure, Surface identity protocol, user
on/off control). Two new Critical Rules (15 and 16) codify the Surface
identity protocol and Capture provenance enforcement. PO action: none,
but see C-7 through C-10 for new flagged items surfaced by the
integration.

---

*If a resolution above is wrong, edit the offending file, update this
file's status, and remove the corresponding entry.*


---

## C-7. DR-033..DR-050 renumbered to DR-035..DR-052

**Conflict.** The CSVS Complete handoff specified that the Validate and
Surface decisions would be numbered DR-033..DR-050. After the first
handoff's renumbering, DR-033 and DR-034 were already taken:

```
DR-033  Knowledge nodes accept any noun-form domain in beta
DR-034  Curation operations in beta: 4 ops only
```

**Resolution applied.** Continuing the +2 offset from the first handoff,
the Validate/Surface decisions were renumbered DR-033..DR-050 →
**DR-035..DR-052**. Section 4.5 cross-stage invariants do not reference
DR IDs by number, so no in-line citation edits were needed. AGENTS.md
Critical Rules 15-16 cite the renumbered IDs (DR-047, DR-025, DR-026).

**PO action.** Confirm the renumbering is acceptable (it preserves all
prior numbering and follows the exact precedent set on 2026-05-19), OR
specify a different scheme (e.g., move stellar visual decisions
DR-019..DR-024 to a separate DR-200+ block and free up DR-023..DR-050
for CSVS).

Mapping (this handoff):

| Task ID | Final ID | Decision |
|---------|----------|----------|
| DR-033  | DR-035   | Validate beta actions: Accept / Edit / Reject |
| DR-034  | DR-036   | Edit preserves history as alias list |
| DR-035  | DR-037   | Duplicate-fact policy user-configurable |
| DR-036  | DR-038   | Auto-accepted facts: Edit + Demote + Drop |
| DR-037  | DR-039   | No automatic source trust scoring |
| DR-038  | DR-040   | Validation queue grouped by source |
| DR-039  | DR-041   | Visual feedback on Accept |
| DR-040  | DR-042   | Gamification excluded |
| DR-041  | DR-043   | Surface 6 modes |
| DR-042  | DR-044   | Active Recall: inline tooltip |
| DR-043  | DR-045   | Active Recall: Lucid app + Chrome extension |
| DR-044  | DR-046   | Passive Recall is killer feature |
| DR-045  | DR-047   | Identity phrase + fn-ID required |
| DR-046  | DR-048   | Contradiction: queue + Stellar only |
| DR-047  | DR-049   | Gatekeeping: 3 conditions |
| DR-048  | DR-050   | Gatekeeping warns, never blocks |
| DR-049  | DR-051   | Staleness: daily + dynamic |
| DR-050  | DR-052   | Stale shown with label |

---

## C-8. Edge type vocabulary — still divergent (carryover from C-4)

**Conflict (unchanged from first handoff).** Structure spec §5 defines
an edge vocabulary that diverges from the one in AGENTS.md §4. Validate
spec §5 (Accept body: Fact-Object and Fact-Fact relations formed) and
Surface spec §6 (Passive Recall responses cite fn-ID) both depend on
the Structure-spec vocabulary being canonical. The divergence is now
load-bearing on three specs, not just one.

**Concrete divergences:**

| AGENTS.md §4 (current) | Structure spec §5 (canonical)            |
|------------------------|-------------------------------------------|
| ASSERTS_STATE          | ASSERTS_PROPERTY + DESCRIBES_STATE        |
| HAS_CONCEPT            | (dropped; use PART_OF Object-to-Object)   |
| MENTIONS               | (dropped; use INVOLVES Fact-to-Entity)    |
| REINFORCES             | (dropped; not in new vocab)               |
| -                      | ADDRESSES (Fact-to-Problem) - missing     |
| -                      | USES (Fact-to-Resource) - missing         |
| -                      | INVOLVES (Fact-to-Person/Org) - missing   |
| -                      | PART_OF, INSTANCE_OF, LOCATED_IN,         |
|                        | HAS_ROLE (Object-Object) - missing        |
| -                      | INTERPRETS, SUPERSEDES (Fact-Fact)        |
| DERIVED_FROM (F-to-Src)| CAPTURED_FROM (F-to-Src) - renamed?       |

**Resolution applied.** Not touched. AGENTS.md §4 edge list is
unchanged. This is implementation-touching and a silent rewrite would
break C1 contradiction detection, the [:MENTIONS] / [:CONTRADICTS]
references in §5 Synergy text, and the DERIVED_FROM references in
§5/§12 of AGENTS.md.

**PO action.** This needs a dedicated reconciliation pass before any
Structure-stage code lands:

1. Decide whether DERIVED_FROM is renamed to CAPTURED_FROM or both
   names coexist (the Structure spec uses CAPTURED_FROM but DR-016
   and Critical Rule 1 implicitly assume DERIVED_FROM).
2. Confirm ASSERTS_PROPERTY + DESCRIBES_STATE supersede
   ASSERTS_STATE everywhere.
3. Decide the fate of REINFORCES, HAS_CONCEPT, MENTIONS - drop,
   or keep as synergy-layer-only edges.
4. AGENTS.md §4 Edge Types block gets a full rewrite and §5 Synergy
   text gets a sweep for orphaned edge references.

A follow-up branch (refactor/lucid-edge-vocab) is the natural home.

---

## C-9. Cross-stage invariant 5 wording — toast vs no-toast

**Conflict (minor wording).** AGENTS.md §4.5 cross-stage invariant 5
(verbatim from the task) reads:

> OFF disables Active Recall, Contradiction toasts, Staleness alerts.

But DR-048 (this handoff) and Surface spec §7 explicitly exclude
contradiction toasts from beta. So in beta, "OFF disables Contradiction
toasts" is a no-op - there are no toasts to disable.

**Resolution applied.** Text kept verbatim per the task ("Do NOT alter
content of the four specification files"). The PO-supplied invariant
text is in AGENTS.md as-is.

**PO action.** Either (a) reword invariant 5 to "OFF disables Active
Recall, Contradiction badges and Stellar-View visual flags, Staleness
alerts; background detection continues without surfacing", or (b) leave
it as-is on the basis that Phase 1 may add contradiction toasts as a
user-opt-in, in which case the invariant is forward-looking.

---

## C-10. AtomicFact confidence field — still unreconciled (carryover from C-2)

**Conflict (unchanged from first handoff).** AGENTS.md §4 AtomicFact /
FactNode Pydantic stubs still carry confidence: Literal[HIGH,MEDIUM,LOW].
Structure spec §1 (DR-028, Critical Rule 13) says confidence is NOT
assigned at Structure. Validate spec §6 reframes confidence as derived
metadata shown at validation time (publisher class, time validity,
related facts), not a value on the fact.

**Resolution applied.** Stubs left in place; Critical Rule 13 references
this conflict via a NOTE pointing to CONFLICTS.md. Cross-stage invariant
3 reinforces the same point.

**PO action.** Same as C-2 - choose one of the three reconciliations
(remove from AtomicFact entirely / move to FactNode as the derived
cached value / keep both as separate concepts). Implementation work to
update Pydantic models and any seed data follows the chosen path.


---

## C-11. DR-051..DR-061 renumbered to DR-053..DR-063

**Conflict.** The Beta Backlog handoff specified that the beta execution
decisions would be numbered DR-051..DR-061. After the prior CSVS Complete
handoff, DR-051 and DR-052 were already taken:

```
DR-051  Staleness detection: daily background scan + dynamic trigger
DR-052  Stale facts shown with label, not hidden from Surface
```

**Resolution applied.** Same +2 offset for the third time. The beta
backlog decisions are now **DR-053..DR-063**. AGENTS.md §4.5 invariant 6
cites DR-053; no other in-line citation updates were needed in this
handoff.

The +2 offset has now stabilized across three handoffs and is the
de-facto convention. If the PO wants the task-supplied IDs to be the
canonical ones, the existing decisions at DR-023..DR-024, DR-033..DR-034,
DR-051..DR-052 would need to be moved (probably to a separate DR-200+
visual-language block).

Mapping (this handoff):

| Task ID | Final ID | Decision |
|---------|----------|----------|
| DR-051  | DR-053   | Beta is wedge discovery, not validation |
| DR-052  | DR-054   | Universal recruitment + self-selection |
| DR-053  | DR-055   | Beta target: 30-40 users |
| DR-054  | DR-056   | Archetype: 5 dimensions |
| DR-055  | DR-057   | Sprint-based decomposition |
| DR-056  | DR-058   | 15 sprints total (see C-13) |
| DR-057  | DR-059   | Sprint definition level C |
| DR-058  | DR-060   | P0/P1 launch-gate classification |
| DR-059  | DR-061   | Beta launch criteria (all 4 required) |
| DR-060  | DR-062   | Phase 1 expansion via family/academic |
| DR-061  | DR-063   | Marketing message validated in beta |

---

## C-12. Stale "researcher" / segment-fix references in older docs

**Conflict.** DR-053 explicitly retracts the assumption that academic
researchers are the primary target segment. Beta is wedge **discovery**,
not validation. But several older docs and one AGENTS.md cell still
encode the retracted assumption. Per the task ("flag them — do not
silently overwrite"), nothing was edited; each occurrence is listed
here for the PO to decide.

**Found (10 locations across 7 files):**

| File | Line | Context | Severity |
|------|------|---------|----------|
| AGENTS.md | 27 | Three-contexts table: "Personal \| Individual researcher \| ..." | High — appears in the project's first table |
| AGENTS.md | 288 | `validator_role: str # "researcher" \| "official" \| "expert"` | Low — enum value, not a target-segment claim |
| LUCID_UNIFIED.md | 88 | "학술연구자, 금융애널리스트, 저널리스트, 정책실무자" — 4 named target segments | High — pitch doc still names the four old segments |
| LUCID_CONTEXT_PROMPT.md | 126 | "첫 고객: ... ① 학술·산업 연구자 ② 금융·전략 애널리스트 ③ 저널리스트·콘텐츠 제작자 ④ 정책·법무 실무자" | High — context prompt for future agents still names the four segments |
| docs/demo-scenario.md | 97 | "Persona: a researcher studying the LLM industry" | Medium — demo narrative |
| docs/integration-architecture.md | 454 | "cannot copy a researcher's accumulated, personal, validated graph" | Low — incidental |
| docs/synergy/01-use-case-spec.md | 48 | "an academic or industry researcher, a strategy/financial..." | Medium — use-case persona doc |
| docs/synergy/02-narrative-memo.md | (~20 occurrences across lines 38-220) | Narrative uses "researcher" as the consistent example persona | Medium — narrative memo |
| docs/synergy/04-scenarios-visual.md | 170 | "The researcher is writing paper P-06" | Medium — same narrative tradition |
| docs/beta-backlog.md | 20 | "이전 가정(학술 연구자 중심)은 무효화되었다" | Not stale — this is the doc that retracts the assumption |

**Resolution applied.** None. All occurrences preserved as-is.

**PO action.** For each High-severity item, decide:

1. **AGENTS.md line 27 "Individual researcher"** — replace with
   "Individual knowledge worker", "Individual user", or leave as an
   illustrative example (this row is the *Personal* context, so it
   names one possible Personal-context user, not "the target user").
   Recommend: change to "Individual user" or "Individual knowledge
   worker" to remove the segment lock-in.

2. **LUCID_UNIFIED.md line 88 and LUCID_CONTEXT_PROMPT.md line 126** —
   these are pitch/context docs that future agents will read. The
   "first-customer" list of four segments is now a hypothesis retracted
   by DR-053. Recommend: rewrite to "knowledge workers whose
   professional credibility depends on factual accuracy — to be refined
   by beta wedge-discovery data" (or similar non-committal phrasing).

For Medium-severity items (narrative/demo docs), recommend leaving as
illustrative examples but adding a one-line note that the persona is
illustrative and the actual wedge will be determined by beta data.

The Low-severity items (AGENTS.md `validator_role` enum, incidental
mentions) can stay; they don't encode target-segment claims.

---

## C-13. Sprint count: task says 12, listed IDs total 15

**Conflict (PO-side internal inconsistency).** The task's DR-056 text
reads:

> 12 sprints total (0, 1A, 1B, 2A, 2B, 2C, 3, 4A, 4B, 5, 6A, 6B, 6C, 6D, 7)

But the listed IDs total **15**, not 12 (count of comma-separated entries
in the parenthesis). The task description body also says "12 Sprints
(Sprint 0 through Sprint 7)" — Sprint 0 through Sprint 7 is 8 top-level
numbers, also not 12. And `docs/beta-backlog.md` §4 clearly lists 15
sub-sprints.

**Resolution applied.** Stored as DR-058 with the correct count: "15
sprints total". The list of IDs is preserved verbatim from the task.
A note in DR-058 references this CONFLICTS.md entry.

**PO action.** Confirm the intended number is 15 (matches the backlog
spec) or specify which sprints to drop to reach 12.
