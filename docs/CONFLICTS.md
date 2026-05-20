# CSVS Stage Specs — Integration Conflicts

**Branch:** `feat/lucid-csvs-stages`
**Date:** 2026-05-20
**Status:** Open — needs PO review

This file records conflicts surfaced while integrating
`docs/capture-stage-spec.md` and `docs/structure-stage-spec.md` into
AGENTS.md and the decision log. The task instruction was: flag conflicts
rather than silently overwrite. Each item below was resolved with the
safest defensible call; flagged here so the PO can confirm or revise.

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

## C-5. Section 14 (AGENTS.md decision log summary table) not updated

**Conflict (lightweight).** AGENTS.md §14 holds a summary table of all
DRs and ends at DR-024. The full log lives in `docs/decision-log.md`,
which is now current through DR-034.

**Resolution applied.** Not updated — the task did not explicitly request
it, and §14 is a denormalized convenience copy.

**PO action.** Either (a) update §14 to mirror decision-log.md through
DR-034, or (b) explicitly mark §14 as a sample/excerpt and point readers
to decision-log.md as the source of truth.

---

## C-6. Validate / Surface specs pending

Per the task and Section 4.5, the Validate and Surface stage
specifications are not yet finalized. Section 4.5 is structured so that
adding two more spec references is a mechanical edit. CONFLICTS.md
should be revisited when those specs land — they will likely surface
similar tensions around HITL flow, ValidationMark assignment, and the
derived confidence signal.

---

*If a resolution above is wrong, edit the offending file, update this
file's status, and remove the corresponding entry.*
