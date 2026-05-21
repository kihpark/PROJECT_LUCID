# Wireframes Index

**Version:** v1 (2026-05-21)
**Status:** Pack 5 (Stellar + Settings, with SV-4) shipped. Packs 1-4 TBD.
**Source of truth:** Per `MASTER_HANDOFF.md` §17 priority — wireframes >
v2 spec > MASTER_HANDOFF > beta-backlog. This index maps each screen
ID to its wireframe file (or `TBD` if not yet authored) and to the
component path that Sprint X will implement.

When implementing any UI feature, check this index first to locate
the canonical wireframe; if a pack is `TBD`, work from
`MASTER_HANDOFF.md` §10 and the relevant CSVS spec until the
wireframe pack lands.

---

## 23 screens

| ID | Title | Pack file | Sprint | Component path |
|----|-------|-----------|--------|----------------|
| O-1 | Landing | pack1-onboarding.html (TBD) | Sprint 7 | `frontend/src/pages/landing.tsx` |
| O-2 | Archetype Survey | pack1-onboarding.html (TBD) | Sprint 7 | `frontend/src/pages/signup/survey.tsx` |
| O-3 | First Save Tutorial | pack1-onboarding.html (TBD) | Sprint 7 | `frontend/src/pages/onboarding/tutorial.tsx` |
| O-4 | Initial Settings | pack1-onboarding.html (TBD) | Sprint 7 | `frontend/src/pages/onboarding/settings.tsx` |
| C-1 | Right-click capture | pack2-capture.html (TBD) | Sprint 2A | `extension/content/context-menu.ts` |
| C-2 | Analysis toast | pack2-capture.html (TBD) | Sprint 2A | `extension/content/toast.ts` |
| C-3 | Decide Summary overlay | pack2-capture.html (TBD) | Sprint 4A | `extension/content/decide-overlay.tsx` |
| C-4 | Decide Review overlay | pack2-capture.html (TBD) | Sprint 4A | `extension/content/decide-review.tsx` |
| C-5 | PWA Home (share target) | pack2-capture.html (TBD) | Sprint 2B | `pwa/src/pages/home.tsx` |
| C-6 | Save-failure result | pack2-capture.html (TBD) | Sprint 4A | `extension/content/empty-result.tsx` |
| Q-1 | Pending Queue list | pack3-queue.html (TBD) | Sprint 4A | `frontend/src/pages/pending/list.tsx` |
| Q-2 | Group reopened from queue | pack3-queue.html (TBD) | Sprint 4A | reuse Decide overlay |
| Q-3 | Auto-accepted tab | pack3-queue.html (TBD) | Sprint 4A | `frontend/src/pages/auto-accepted/list.tsx` |
| S-1 | Active Recall (inline) | pack4-surface.html (TBD) | Sprint 6A | `extension/content/active-recall.ts` |
| S-2 | "See All" related-facts panel | pack4-surface.html (TBD) | Sprint 6A | `extension/content/see-all-panel.tsx` |
| S-3 | Ask Lucid (Passive Recall) | pack4-surface.html (TBD) | Sprint 6B | `frontend/src/components/ask-lucid.tsx` |
| S-4 | Contradiction queue | pack4-surface.html (TBD) | Sprint 6C | `frontend/src/pages/contradictions/list.tsx` |
| S-5 | Gatekeeping dialog | pack4-surface.html (TBD) | Sprint 6D | `extension/content/gatekeep-dialog.tsx` |
| SV-1 | Stellar Overview (L0 Galaxy) | `frontend/stellar-graph/pack5-stellar-settings.html` | Sprint 5 | `frontend/src/pages/stellar/overview.tsx` |
| SV-2 | Filtered Stellar (L1 Constellation) | `frontend/stellar-graph/pack5-stellar-settings.html` | Sprint 5 | reuse Stellar with filter prop |
| SV-3 | Contradiction visualization | `frontend/stellar-graph/pack5-stellar-settings.html` | Sprint 5 | reuse Stellar with contradiction layer |
| **SV-4** | **Star System View (L2 — 1-hop + side panel)** *(new 2026-05-21)* | `frontend/stellar-graph/pack5-stellar-settings.html` | Sprint 5 | `frontend/src/pages/stellar/star-system.tsx` |
| SET-1 | Main Settings | `frontend/stellar-graph/pack5-stellar-settings.html` | Sprint 7 | `frontend/src/pages/settings/main.tsx` |
| SET-2 | Trusted Sources (per-source policy) | `frontend/stellar-graph/pack5-stellar-settings.html` | Sprint 7 | `frontend/src/pages/settings/sources.tsx` |

**Total: 23 screens.** SV-4 is the new addition vs prior versions
(previous total: 22).

---

## Pack file locations (current vs target)

| Pack | Current location | Target location (MASTER_HANDOFF §6) |
|------|------------------|-------------------------------------|
| Pack 1 — Onboarding (O-1..O-4) | not yet authored | `wireframes/pack1-onboarding.html` |
| Pack 2 — Capture (C-1..C-6) | not yet authored | `wireframes/pack2-capture.html` |
| Pack 3 — Queue (Q-1..Q-3) | not yet authored | `wireframes/pack3-queue.html` |
| Pack 4 — Surface (S-1..S-5) | not yet authored | `wireframes/pack4-surface.html` |
| Pack 5 — Stellar + Settings (SV-1..SV-4, SET-1, SET-2) | `frontend/stellar-graph/pack5-stellar-settings.html` | `wireframes/pack5-stellar-settings.html` |

Note: Pack 5 currently lives under `frontend/stellar-graph/` instead
of the `wireframes/` directory shown in MASTER_HANDOFF §6. Either
move it once Packs 1-4 are authored or update MASTER_HANDOFF §6 to
match (CONFLICTS.md C-21).

---

## Screen ID conventions

- **O-X** = Onboarding screens (Sprint 7)
- **C-X** = Capture screens (Sprint 2A / 2B / 4A)
- **Q-X** = Queue / Pending screens (Sprint 4A)
- **S-X** = Surface screens (Sprint 6A / 6B / 6C / 6D)
- **SV-X** = Stellar View screens (Sprint 5)
- **SET-X** = Settings screens (Sprint 7)

When adding a new wireframe screen, pick the next sequential ID in
its category (e.g., the next Onboarding screen is O-5).

---

## Stellar View zoom levels (Sprint 5)

The 4-level Stellar zoom (PO directive 2026-05-21, see
`docs/beta-backlog.md` Sprint 5) maps to wireframes as follows:

| Level | What you see | Wireframe |
|-------|--------------|-----------|
| L0 | Galaxy overview — entire user's universe | SV-1 |
| L1 | Constellation — filtered subset | SV-2 |
| L2 | Star System — one fact + 1-hop neighbors + side panel | SV-4 |
| L3 | Atom view — single fact + all relations (P1) | not yet wireframed |

`SV-3` (Contradiction visualization) is a special overlay that can
fire at any zoom level; it is not a separate level.

---

*To regenerate this index from MASTER_HANDOFF §10, see the doc-sweep
script in `chore/lucid-v2-doc-sweep`.*
