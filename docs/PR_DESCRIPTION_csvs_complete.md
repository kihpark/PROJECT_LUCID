# PR: CSVS loop complete — final integration package

**Branch:** `feat/lucid-csvs-complete`
**Base:** `feat/lucid-csvs-stages` (or `main` once that's merged)

Paste this into the GitHub PR body when opening the PR.

---

## Summary

Lands the final two CSVS stage specifications (Validate and Surface)
and wires all four specs into AGENTS.md as a single coherent reference.
Completes the integration started in the prior `feat/lucid-csvs-stages`
handoff.

- `docs/validate-stage-spec.md` and `docs/surface-stage-spec.md` placed
  verbatim at canonical docs/ location.
- AGENTS.md §4.5 rewritten with the full four-spec reference table plus
  the five cross-stage invariants supplied by the PO.
- Two new Critical Rules added:
  - **15.** Surface identity protocol (every response begins with
    "As far as I know..." or equivalent and cites fn-ID).
  - **16.** Source provenance enforced at Capture (untraced inputs
    excluded from beta).
- `docs/decision-log.md` extended with 18 new resolved decisions
  (DR-035 through DR-052; see Conflicts below for the renumbering).
- AGENTS.md §14 summary table extended through DR-052.
- AGENTS.md version bumped 2.1 -> 2.2.

## Commits

```
docs: add validate stage specification
docs: add surface stage specification
docs: update AGENTS.md Section 4.5 with full CSVS cross-references
docs: append DR-035 through DR-052 to decision log
docs: verify ontology and critical rules consistency
```

(Note: the appended-DR commit message uses the renumbered range
DR-035..DR-052 rather than the task's nominal DR-033..DR-050; see
Conflict C-7 below.)

## Completion criteria — all met

```
[x] All four spec files present in docs/
[x] AGENTS.md Section 4.5 updated with complete CSVS references and
    cross-stage invariants
[x] docs/decision-log.md contains all CSVS decisions (renumbered to
    DR-025..DR-052; original task wanted DR-023..DR-050 — see C-7)
[x] Ontology references verified throughout AGENTS.md (12 classes,
    no Theory, no Material)
[x] Critical Rules section reflects all four stage invariants
    (Rules 1, 13, 14, 15, 16)
[x] Beta scope exclusions documented consistently
[x] All changes committed to feat/lucid-csvs-complete branch
[x] PR description lists unresolved conflicts (this section, below)
```

## Unresolved conflicts (flagged for PO review)

Full detail in `docs/CONFLICTS.md`. Summary table:

| Tag         | Issue | Status |
|-------------|-------|--------|
| C-1         | DR-023, DR-024 collision (first handoff) renumbered to DR-025, DR-026 | needs PO confirm |
| C-2 / C-10  | `confidence` field still on AtomicFact stub in AGENTS.md §4 | needs PO decision |
| C-3         | ObjectNode `object_class` enum expanded to 12 classes (no Theory/Material) | resolved |
| C-4 / C-8   | Edge type vocabulary (AGENTS.md §4 vs Structure spec §5) divergent on about 10 edges | needs dedicated reconciliation branch |
| C-5         | AGENTS.md §14 summary table lag | resolved this PR |
| C-6         | Validate / Surface specs integration | resolved this PR |
| C-7         | DR-033..DR-050 collision renumbered to DR-035..DR-052 (same +2 offset) | needs PO confirm |
| C-9         | Cross-stage invariant 5 mentions Contradiction toasts but toasts are excluded by DR-048 | minor wording, leave or revise |

## Verification done

```bash
# Spec files present
ls docs/{capture,structure,validate,surface}-stage-spec.md   # all 4

# Ontology audit
grep -E "Theory|Material" AGENTS.md                          # empty

# Critical Rules
grep -nE "^1[3-6]\. " AGENTS.md                             # 13, 14, 15, 16

# Decision log
grep -c "^| DR-" docs/decision-log.md                        # 52

# §14 mirror
grep -E "^\| DR-052 " AGENTS.md                             # present

# 5 commits on branch since base
git log feat/lucid-csvs-stages..feat/lucid-csvs-complete --oneline | wc -l
```

## What this PR does NOT do

- Does not modify any of the four spec files (per task: authoritative as-is).
- Does not rewrite the AtomicFact `confidence` field on the model
  (flagged, awaiting PO call).
- Does not reconcile the edge vocabulary divergence (flagged, large
  enough to merit a dedicated `refactor/lucid-edge-vocab` branch).
- Does not push to remote — local commits only.

## Follow-ups

1. PO decision on C-2/C-10 (confidence field).
2. Dedicated branch `refactor/lucid-edge-vocab` for C-8.
3. Optional: revise cross-stage invariant 5 wording (C-9).
4. PO confirms or revises the DR renumbering (C-1, C-7).
