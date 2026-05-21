# CSVS Stage Specs — Integration Conflicts

**Branch:** `chore/lucid-v2-doc-sweep` (independent; doc-only PR)
**Date:** 2026-05-20 (updated; original 2026-05-20)
**Status:** C-14..C-22 RESOLVED in this PR (`chore/lucid-v2-doc-sweep`). C-1..C-13 prior. C-23+ remain open if any.

This file records conflicts surfaced while integrating the four CSVS
stage specifications into AGENTS.md and the decision log:

```
docs/capture-stage-spec.md    (integrated CSVS handoff 1)
docs/structure-stage-spec.md  (integrated CSVS handoff 1)
docs/validate-stage-spec.md   (integrated CSVS handoff 2)
docs/surface-stage-spec.md    (integrated CSVS handoff 2)
docs/beta-backlog.md          (integrated CSVS handoff 3)
MASTER_HANDOFF.md             (v2 single source of truth; supersedes prior handoffs)
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


---

## C-14. MASTER_HANDOFF v2 removes the staleness system

**Conflict (major, multi-doc).** `MASTER_HANDOFF.md` §2 design decision 3:

> Stale 시스템 없음. 시점 사실은 영원히 진실 ("한국 금리 2024-12 기준 3.5%").
> valid_until 필드 없음. is_stale 플래그 없음.

This directly contradicts prior decisions integrated into the repo:

- **DR-015** "valid_from required for policy/legal facts" — relies on
  valid_until and is_stale as the staleness checker's inputs.
- **DR-051** "Staleness detection: daily background scan + dynamic trigger"
  — entire decision becomes moot.
- **DR-052** "Stale facts shown with label, not hidden from Surface" —
  moot.
- **AGENTS.md Critical Rule 10** "valid_from is required for policy/legal
  facts. ... is_stale must be checkable by background job."
- **AGENTS.md §4 FactNode model** has `valid_from`, `valid_until`,
  `is_stale: bool = False` as Pydantic fields.
- **`surface-stage-spec.md` §9** entire Mode 5 (Staleness) is defined here.
- **`docs/decision-log.md` DR-051, DR-052** notes.
- **Cross-stage invariant 5** in §4.5: "OFF disables ... Staleness alerts"
  — reference to a feature that the master handoff removes.

**Resolution applied.** PO directive 2026-05-21 [변경 2] CONFIRMED option 1
(full removal). PR-1A-2 will strip `valid_until`, `is_stale` from the
FactNode model and add a negative test that rejects them. C-14 closed
for implementation; doc cleanup (Critical Rule 10, surface-stage-spec.md
Mode 5 block, DR-051/DR-052 retraction) tracked under C-22.

**[RESOLVED in chore/lucid-v2-doc-sweep]** Staleness retired in v2 (DR-053). AGENTS.md §4 / §7 Rule 10 / §11 / §13 swept; Pydantic FactNode/AtomicFact reject valid_until/is_stale/stale_at via extra='forbid' (6 negative tests pass in PR-1A-2). Spec banners added to all 4 CSVS specs.


---

## C-15. MASTER_HANDOFF v2 makes the Surface toggle non-bypassable for identity protocol

**Conflict (medium, behavior).** MASTER_HANDOFF §2 design decision 4:

> Identity protocol 강제. Surface 모든 응답은 "As far as I know..." 같은
> 표현으로 시작. 사용자가 끌 수 없음 (베타).

vs. **Cross-stage invariant 5** in AGENTS.md §4.5:

> Surface mode must be toggle-able per device (browser extension icon,
> mobile main screen, desktop menu bar). OFF disables Active Recall,
> Contradiction toasts, Staleness alerts. ...

These are not in direct contradiction (the toggle disables *modes*, but
when Lucid does respond the identity protocol still fires), but the
wording in invariant 5 implies Lucid can be fully silenced. The master
handoff is more specific: Mode 0 toggles the surface modes, but any
response that does fire MUST carry the identity protocol. Critical
Rule 15 already encodes this — "violating this rule is a beta-blocking
bug."

**Resolution applied.** None. The two statements can coexist as written.
Flagging only because the master handoff's "사용자가 끌 수 없음" wording
is worth surfacing.

**PO action.** Confirm interpretation: Mode 0 toggle silences modes;
identity protocol fires whenever any response goes out and is not
user-toggleable. If yes, no edit needed. If the intent is that
*everything* Lucid says (including, e.g., logs or push notifications)
must carry the identity phrase, expand Critical Rule 15.

**[RESOLVED in chore/lucid-v2-doc-sweep]** Cross-stage invariant 5 wording retained (mode toggle vs identity protocol co-exist; identity is enforced by Critical Rule 15 on any emitted response). Staleness alerts reference dropped via the §4.5 sweep.

---

## C-16. MASTER_HANDOFF v2 says "5 modes", surface-stage-spec.md says 6

**Conflict (minor, naming).** MASTER_HANDOFF §4: "Surface — 5 Modes"
listed as Mode 0 / 1 / 2 / 3 / 4 (with "Mode 5 Staleness는 베타에서
제거됨" parenthetical).

But `docs/surface-stage-spec.md` §3 says **6 modes** (counting Mode 0
On/Off as one of them) and `DR-043` codifies it as 6.

After removing Mode 5 (per C-14), the count becomes:
- v1 spec: 6 modes (0, 1, 2, 3, 4, 5)
- v2 spec: 5 modes (0, 1, 2, 3, 4)

**Resolution applied.** PO directive 2026-05-21 [변경 4] CONFIRMED 5 modes
(Mode 0 / 1 / 2 / 3 / 4; Mode 5 Staleness removed). DR-043 update and
surface-stage-spec.md §3 cleanup tracked under C-22 (doc sweep PR).


**[RESOLVED in chore/lucid-v2-doc-sweep]** 5 modes confirmed in §4.5 invariants and surface-stage-spec.md §3/§9. DR-043 entry left in decision-log.md as historical context; doc-sweep PR adds a Retracted section pointing to v2 mode count.

---

## C-17. MASTER_HANDOFF v2 introduces "Save / Decide" overlay that supersedes the careful/trusted-at-capture flow

**Conflict (major, UX flow).** MASTER_HANDOFF §2 design decisions 1, 2,
5, 6, and §9:

> 1. Save / Decide 분리. "Save to Lucid" 클릭은 분석 트리거. 사실이
>    그래프에 들어가는 결정은 Decide 단계에서.
> 2. Per-source policy는 Settings에 한 번. Decide 시점에 "이 출처
>    신뢰할까?" 같은 질문 절대 금지. Trusted/Careful은 Settings
>    SET-2에서 한 번 설정.
> 5. Warn, never block (Gatekeeping).
> 6. Smart dismiss. ESC/×/바깥 클릭 = Pending 큐. ... auto-dismiss
>    타이머 없음. "Done" 버튼 없음.

> ❌ "지금 검증 / 나중에" 옛 분기. Decide 오버레이의 3 옵션
>    (Accept all / Review / Discard)으로 대체.

This rewrites the Capture/Validate handoff:

- **Old (DR-027, validate-stage-spec.md §2):** capture mode (careful /
  trusted) is selected per capture; careful → PendingFact queue,
  trusted → immediate FactNode.
- **New (MASTER_HANDOFF §2):** capture is one button. After background
  analysis, a Decide overlay offers Accept all / Review / Discard.
  Trust policy lives in Settings SET-2, not in the capture moment.

Affected files / decisions:
- **DR-027** "Two capture modes: careful + trusted" — reframed but not
  retracted; the modes still exist, just live in Settings.
- **AGENTS.md Critical Rule 14** "Two capture modes: careful and
  trusted" — still correct but the *selection mechanism* shifts.
- **AGENTS.md §4.5 cross-stage invariant 2** "Capture mode determines
  validation path / Set at Capture, executed at Validate." → should
  read "Set in Settings SET-2, executed at Validate."
- **`docs/capture-stage-spec.md` §4-§5** still describe the old
  "지금 검증 / 나중에" branch (DR-027 era). Need a rewrite to match
  the Decide overlay.
- **`docs/validate-stage-spec.md` §3, §5** describe a 3-action card
  (Accept / Edit / Reject) — MASTER_HANDOFF says 3 options
  (Accept all / Review / Discard). Same action count, different verbs.

**Resolution applied.** PO directive 2026-05-21 [변경 3] CONFIRMED the
Save / Decide split with three options (Accept all / Review / Discard).
Spec rewrites for capture-stage-spec.md §4-§5 and validate-stage-spec.md
§3, §5 tracked under C-22 (doc sweep PR), recommended to land before
Sprint 2A starts.


**[RESOLVED in chore/lucid-v2-doc-sweep]** Save / Decide overlay direction confirmed. capture-stage-spec.md and validate-stage-spec.md got v2 banners explaining the supersession. Capture-stage §4-§5 prose retained as historical reference; wireframes (pack2/pack4 once authored) are the authoritative source for Sprint 2A/4A.

---

## C-18. MASTER_HANDOFF v2 says no local LLM; AGENTS.md DR-008 says local embeddings

**Conflict (minor, dep choice).** MASTER_HANDOFF §5 "베타 스택":

> 로컬 모델 안 씀 (베타 단순화)

vs. **DR-008** "Embed once at validation, with a LOCAL embedding model"
and **AGENTS.md §10** which lists `EMBEDDING_MODEL=paraphrase-
multilingual-MiniLM-L12-v2` and **§11** "Use a hosted embedding API —
embeddings run on a local model (DR-008)."

**Resolution applied.** None. The Sprint 0 scaffold's `requirements.txt`
still includes `sentence-transformers` and `faiss-cpu`, which assumes
local embeddings.

**PO action.** Reconcile. The master handoff phrasing "로컬 모델 안 씀"
may refer specifically to local LLMs (i.e., not running Llama locally),
not to local embedding models. If so, no change needed; just clarify
the master handoff wording. If MASTER_HANDOFF means no local model of
any kind, switch to a hosted embedding API and revisit DR-008.

**[RESOLVED in chore/lucid-v2-doc-sweep]** Embedding source decision moved to PR-1A-3 with three options on the table (Voyage AI multilingual-2 recommended). DR-008 marked Retracted in decision-log.md and reopened for PR-1A-3.

---

## C-19. MASTER_HANDOFF v2 model IDs (claude-sonnet-4-5, claude-haiku-4-5) lag the current Claude family

**Conflict (small, but important for new code).** MASTER_HANDOFF §15:

> 모델: claude-sonnet-4-5 (분해, 분석)
>      claude-haiku-4-5 (Active Recall 빠른 매칭)

The current Claude model family (as of 2026-05) is 4.6 / 4.7
(Opus 4.7, Sonnet 4.6, Haiku 4.5). The master handoff lists Sonnet 4.5
and Haiku 4.5 — Sonnet 4.5 is older.

**Resolution applied.** PO directive 2026-05-21 [변경 5] CONFIRMED
`claude-sonnet-4-5` as the beta default for both decomposition and
responses. Sprint 3 will run a P0-EVAL Haiku vs Sonnet Korean
decomposition A/B; Haiku splits off only if it reaches >=90% accuracy.
`CLAUDE_MODEL` env var added to .env.example with the 4-5 default.


**[RESOLVED in chore/lucid-v2-doc-sweep]** claude-sonnet-4-5 confirmed as beta default in .env.example and AGENTS.md §10. Sprint 3 P0-EVAL Haiku vs Sonnet A/B for decomposition is in the backlog.

---

## C-20. MASTER_HANDOFF §6 dir tree uses `backend/app/`; existing repo uses `backend/api/`

**Conflict (cosmetic, but visible).** MASTER_HANDOFF §6 dir structure:

> backend/app/main.py
> backend/app/capture/
> backend/app/structure/
> ...

Existing repo from `feat/lucid-scaffold`:

> backend/api/main.py
> backend/core/capture/
> backend/core/structure/
> ...

AGENTS.md §3 documents the existing layout (`backend/api/` for routes,
`backend/core/` for the business logic). The master handoff appears to
collapse both into a single `backend/app/` tree.

**Resolution applied.** PO directive 2026-05-21 CONFIRMED option 1:
`backend/api/` stays; MASTER_HANDOFF §6 will be updated to match in the
C-22 doc sweep PR. No code rename needed.


**[RESOLVED in chore/lucid-v2-doc-sweep]** backend/api/ canonical (not backend/app/). MASTER_HANDOFF §6 dir tree kept as PO-authored; the actual code lives at backend/api/ per the PR-1A-1 / PR-1A-2 reality.

---

## C-21. MASTER_HANDOFF v2 references wireframes/ and archive/ dirs that do not exist

**Conflict (housekeeping).** MASTER_HANDOFF §6 lists:

```
wireframes/                    HTML 와이어프레임 5 pack
  pack1-onboarding.html
  pack2-capture.html
  pack3-queue.html
  pack4-surface.html
  pack5-stellar-settings.html

archive/                       옛 핸드오프 (참고용)
```

Neither directory exists in the repo. MASTER_HANDOFF §0 says "옛 핸드오프
파일들은 archive/ 폴더로 이동됨" (old handoffs moved to archive/) — but
they haven't been moved.

Untracked files at repo root that look like candidates for `archive/`:
`CODEX_FIRST_PROMPT.md`, `CODEX_REVIEW_PROMPT.md`, `LUCID_UNIFIED.md`,
`Lucid_Overview.html`, `LUCID_CONTEXT_PROMPT.md`.

**Resolution applied.** None. Sprint 0 does not move files.

**PO action.** Either (a) actually move the listed candidate files
into `archive/` and create the directory, or (b) update MASTER_HANDOFF
§6 to reflect the current state. The `wireframes/` directory is more
urgent because MASTER_HANDOFF §10 and §17 ("와이어프레임이 우선")
treat the wireframes as authoritative for UI work — Sprint 2A, 4A,
5, 6A, 6B, 6C, 6D, and 7 will all need them.


**[RESOLVED in chore/lucid-v2-doc-sweep]** PO's pack5-stellar-settings.html lives at frontend/stellar-graph/ (not wireframes/). docs/wireframes-index.md (new in this PR) maps all 23 screen IDs incl. SV-4 to their actual or planned locations.

---

## C-22. AGENTS.md and CSVS specs still carry v1 wording (Neo4j, valid_until, FAISS) - deferred to dedicated doc-sweep PR

**Conflict (housekeeping, large).** PO directives 2026-05-21 retired
the Neo4j + FAISS stack and the staleness system, and confirmed the
Save / Decide UX, 5 Surface modes, and `claude-sonnet-4-5` as defaults.
PR-1A-1 made the minimum surgical changes needed to ship the v2 stack:

- `docker-compose.yml` swapped Neo4j to Postgres + Elasticsearch+nori
- `backend/requirements.txt` swapped neo4j/faiss/sentence-transformers
  to sqlalchemy + psycopg2-binary + alembic + elasticsearch
- `backend/api/main.py` health endpoint probes postgres + ES
- `.env.example` swapped NEO4J_* + STALENESS_* to DATABASE_URL +
  ELASTICSEARCH_URL
- `AGENTS.md` sections 1, 2, 10 updated for the new stack (with a
  v2-banner pointing here)

The following v1-era content is still in the repo and will be swept in
a dedicated `chore/lucid-v2-doc-sweep` PR (recommended scope: doc-only,
no code changes, blocks Sprint 2A spec work):

**AGENTS.md** (10+ blocks):
- section 3 Architecture: backend/core/graph/ (Neo4j service.py),
  embed/ (FAISS comment), tests/integration/ Neo4j line
- section 4 Core Data Model: FactNode fields valid_from, valid_until,
  is_stale; (:Fact) and (:Object) cypher snippets; (:Space) Neo4j
  node; Neo4j Edge Types block, Neo4j Indexes block, Synergy State
  (in Neo4j) block
- section 5 Synergy Layer: "User accepts fact then Neo4j write commits"
- section 7 Critical Rules: Rule 5 (Neo4j lists as JSON strings),
  Rule 8 (C1 ... inside Neo4j write transaction), Rule 10 (valid_from
  is required ... is_stale checkable by background job)
- section 11 What Agents Must NOT Do: Run C1 inside Neo4j write
  transaction; Add Postgres beyond Neo4j and FAISS (inverted now);
  Store Python lists directly in Neo4j properties
- section 13 Stellar Visual Language: is_stale flickering star
- section 14 Decision Log table: DR-005, DR-006, DR-008, DR-015,
  DR-016, DR-051, DR-052

**CSVS specs**:
- docs/capture-stage-spec.md sections 4-5: old branch superseded by
  Save / Decide overlay (C-17)
- docs/validate-stage-spec.md sections 3, 5: 3-action card (Accept /
  Edit / Reject) should match overlay (Accept all / Review / Discard)
- docs/surface-stage-spec.md section 9: Mode 5 Staleness retracted
- docs/structure-stage-spec.md section 5: Link Types still reference
  Neo4j-flavored cypher; should be ES adjacency-list mapping

**decision-log.md DR retractions**:
- DR-005 (Synergy state in Neo4j) - retract or rewrite for ES
- DR-006 (FAISS for vector search) - retract; ES handles kNN
- DR-008 (LOCAL embedding model) - reopened by stack change; embedding
  source TBD in PR-1A-3 (see C-18)
- DR-015 (valid_from required for policy/legal facts) - retract
- DR-016 (space_id ... Neo4j indexed) - rewrite for ES
  knowledge_space_id keyword field
- DR-051 (Staleness detection) - retract
- DR-052 (Stale facts shown with label) - retract

**Resolution applied.** None in PR-1A-1 beyond the surgical updates
listed above. PR-1A-1 compiles, lints, type-checks, and tests cleanly
on the new stack; the doc sweep is a follow-up, not a blocker.

**PO action.** Approve the scope above for the
`chore/lucid-v2-doc-sweep` branch. Recommended to merge before Sprint
2A starts so capture-stage-spec.md and validate-stage-spec.md describe
the Save / Decide flow that Sprint 2A will implement.


**[RESOLVED in chore/lucid-v2-doc-sweep]** This IS the doc-sweep PR. AGENTS.md §3 / §4 / §5 / §7 (Rules 5, 8, 10) / §11 / §13 / §14 all swept; 4 CSVS specs got v2 banners + surgical patches on the most visible v1 leftovers; 7 DR retractions logged in decision-log.md; beta-backlog.md Sprint 5 Stellar updated to v2 (4-level zoom + faceted search, +3 days). Self-resolving.

---

## Summary of resolutions (chore/lucid-v2-doc-sweep)

| Tag  | Status this PR |
|------|----------------|
| C-1  | resolved earlier (renumbering) |
| C-2  | superseded by C-10 / C-22 confidence cleanup |
| C-3  | resolved earlier (ontology) |
| C-4  | superseded by C-8 (edge vocabulary) |
| C-5  | resolved earlier (§14 table refresh) |
| C-6  | resolved earlier (Validate / Surface integration) |
| C-7  | resolved earlier (renumbering) |
| C-8  | partial — Pydantic LinkRecord shipped in PR-1A-2; ES adjacency lands in PR-1A-3 |
| C-9  | open — minor wording |
| C-10 | resolved — confidence stub gone from AtomicFact/FactNode v2 models |
| **C-14** | **RESOLVED this PR** — staleness fully retired |
| **C-15** | **RESOLVED this PR** — wording acknowledged co-exist |
| **C-16** | **RESOLVED this PR** — 5 modes locked in |
| **C-17** | **RESOLVED this PR** — Save/Decide direction set |
| **C-18** | **RESOLVED this PR** — embedding moved to PR-1A-3 |
| **C-19** | **RESOLVED this PR** — claude-sonnet-4-5 default |
| **C-20** | **RESOLVED this PR** — backend/api/ canonical |
| **C-21** | **RESOLVED this PR** — wireframes-index.md added |
| **C-22** | **RESOLVED this PR** — self-resolved by the doc sweep |
