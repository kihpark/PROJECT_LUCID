# Feature Spec: Stellar Knowledge Graph

Status: Planned (S1–S2) · Priority: High

---

## Implementation Stack
  Rendering:   D3.js v7 force simulation
  Physics:     d3-force with custom galaxy layout
  Animation:   CSS transitions + requestAnimationFrame
  Data source: GET /api/spaces/{sid}/graph

## API Contract
GET /api/spaces/{sid}/graph returns:
{
  nodes: [{
    id: UUID,
    claim: string,        // truncated to 60 chars for display
    domain: string,
    confidence: "HIGH"|"MEDIUM"|"LOW",
    validation_level: 1|2|3|4,
    is_stale: boolean,
    is_pending: boolean,
    connection_count: int,
    jurisdiction: string[],
    valid_until: string|null
  }],
  edges: [{
    source: UUID,
    target: UUID,
    type: "DERIVED_FROM"|"SUPPORTS"|"EXAMPLE_OF"|"CONTRADICTS"|"REINFORCES",
    weight: float
  }],
  constellations: [{
    id: string,
    label: string,
    fact_ids: UUID[],
    centroid: { x: float, y: float }  // 0-1 normalized
  }]
}

## Component Structure
frontend/
  stellar-graph/
    index.html          Main graph page
    stellar.js          D3 force simulation + rendering
    elastic-filter.js   Filter state + elastic animation
    interactions.js     Hover, click, drag, zoom handlers
    time-scrub.js       Timeline slider component
    constellation.js    Community detection + labeling

## Acceptance Criteria
  AC-1: Stars render with correct brightness per validation level (L1-L4)
  AC-2: Filter apply/clear animates elastically (300ms/400ms)
  AC-3: Contradiction edges pulse red at 0.5Hz
  AC-4: Hover shows fact claim, confidence, validation level
  AC-5: Stale stars (is_stale=true) show gray + orange dashed border
  AC-6: PendingFacts orbit outside main cluster
  AC-7: Zoom in reveals individual star labels
  AC-8: Zoom out shows constellation labels only
  AC-9: Graph loads < 2s for up to 500 nodes
  AC-10: Works in latest Chrome, Safari, Firefox

---

## Schema Dependencies (flagged 2026-05-19)

The API contract above assumes two fields not yet in the AGENTS.md v2.1 data
model. They must be resolved before this endpoint is built:

| Field | Status | Resolution |
|-------|--------|------------|
| `domain` | NOT in AtomicFact / FactNode | Add a `domain` field to the fact model (enum: policy / science / economics / technology / unclassified), set by the Structurer, OR derive it from the linked `Object.object_class`. A schema decision is needed (open item). |
| `validation_level` (1-4) | Derived, not stored | Compute on read from the L1-L4 marks: the highest tier achieved (l4_expert_id set -> 4; l3_agreement_pct -> 3; l2_agreement_pct -> 2; l1_validated -> 1). The graph endpoint returns this derived integer; it is NOT a stored column. |

`is_stale`, `is_pending`, `connection_count`, `jurisdiction`, and `valid_until`
all map cleanly to the existing model. `connection_count` is computed from the
node's outgoing relation count at query time.

The component structure lists `stellar.js`, `elastic-filter.js`, etc. as
separate modules; the S1 prototype (`index.html`) is intentionally a single
self-contained file and is split into those modules when the feature is built.
