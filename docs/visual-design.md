# Lucid — Stellar Knowledge Graph: Visual Design Specification

Status: Draft · Version: 1.0 · Date: 2026-05-19

---

## 1. Core Metaphor

| Physical concept | Lucid concept | Data source |
|-----------------|---------------|-------------|
| Universe (우주) | KnowledgeSpace | space.type |
| Star (별) | FactNode | AtomicFact |
| Constellation (별자리) | Knowledge cluster / cognitive fingerprint | Graph community |
| Star brightness | Validation strength | l1–l4 level |
| Star size | Connection count | degree centrality |
| Star color | Domain / jurisdiction | fact.domain |
| Star pulse (flickering) | is_stale = true | valid_until expired |
| Red tension line | Contradiction | [:CONTRADICTS] edge |
| Star disappearing | — NEVER — | Elastic: always visible |

## 2. Star Visual Properties

### Brightness by Validation Level
  L1 (Personal HITL)       → 30% brightness, small glow
  L2 (Team consensus)       → 55% brightness, visible glow
  L3 (Community anonymous)  → 75% brightness, clear glow
  L4 (Expert certified)     → 100% brightness, blazing + white ring

### Size by Domain Importance
  Base size = 6px
  +1px per outgoing relation (capped at 14px)
  Hub concepts (high betweenness centrality) = largest stars

### Color by Domain
  Policy / Legal    → #f0a500 (amber)
  Science / Research → #4a9eff (blue)
  Economics         → #00d4aa (teal)
  Technology        → #9a7aff (purple)
  Unclassified      → #8888aa (gray)

### Special States
  is_stale = true          → Desaturated gray + orange dashed border + slow pulse
  CONTRADICTS relation     → Red glow + red tension line to conflicting star
  PendingFact (unvalidated) → Dim, flickering, orbiting outside main cluster
  Recently validated        → Bright white flash (2s) then settles to level color

## 3. Constellation (Cognitive Fingerprint)

A constellation is an emergent cluster of connected FactNodes.
It is NOT manually defined by the user.
It forms automatically from graph community detection (Louvain algorithm).

Properties:
  - Each user's constellation arrangement is unique
  - The pattern of connections = cognitive fingerprint
  - Exportable as PNG: "My Knowledge Map" (date-stamped)
  - For team spaces: constellations overlap, showing shared facts
  - For policy spaces: officially validated facts = anchor stars (immovable)

Constellation label:
  - Shown faintly at cluster centroid
  - Derived from top 2 Object nodes by betweenness centrality
  - Examples: "AI Governance", "Behavioral Economics", "Budget Politics"

## 4. Elastic Navigation

The core UX principle that differentiates Lucid from Obsidian.

### The Rule
  When a filter is applied, irrelevant stars do NOT disappear.
  They shrink and recede to 8% opacity.
  When the filter is cleared, they spring back elastically.
  The user always knows the full graph is there.

### Why This Matters
  Obsidian problem: "I filtered and lost my context."
  Lucid solution: "I filtered and saw what I needed without losing the map."

### Filter Types
  Domain filter      → Irrelevant domain stars recede
  Confidence filter  → LOW/MEDIUM stars recede
  Validation filter  → Below-threshold stars recede
  Jurisdiction filter → Non-matching jurisdiction stars recede
  Time filter        → Stars outside the time window recede

### Physics
  On filter apply: target stars animate to 8% opacity + 0.4x scale (300ms ease-out)
  On filter clear: stars animate back to full opacity + 1x scale (400ms spring)
  Stars that pass the filter: brightness increases slightly (1.15x) to emphasize

## 5. Edge Visualization

  DERIVED_FROM (provenance)  → Thin white line, 15% opacity, solid
  SUPPORTS                   → Blue dashed, 30% opacity, weight 0.85
  EXAMPLE_OF                 → Teal dashed, 35% opacity, weight 0.70
  CONTRADICTS                → Red solid, 50% opacity, pulses slowly
  REINFORCES                 → White glow line, 25% opacity

Edge opacity scales with the alpha of connected stars.
If either endpoint is filtered/receded, the edge recedes with it.

## 6. Killer Interactions

### Draft Constellation (C3 Contextual Surfacing)
  When user is drafting in the editor:
    - Stars related to the current sentence light up (2x brightness)
    - Unrelated stars dim slightly
    - Drag a star into the editor → inserts fact + citation
    - The constellation "breathes" with the writing

### Contradiction Pulse
  When a new fact creates a [:CONTRADICTS] edge:
    - Both conflicting stars emit a slow red pulse
    - A red tension line appears between them (animated dots)
    - HITL panel highlights with "⚠ Contradiction detected"
    - When user resolves: tension line dissolves in 1s animation
    - The weaker (lower L-level) star dims

### Time Scrub
  A horizontal timeline slider at the bottom of the graph:
    - Drag left → stars disappear in reverse capture order
    - Shows "when did I learn this?" progression
    - Policy/legal facts: highlights when valid_from / valid_until boundaries cross
    - Stars with expired valid_until turn gray as the slider reaches that date

### Gravity Zoom
  Scroll to zoom in → stars spread apart, labels appear, details visible
  Scroll to zoom out → stars cluster, constellation labels dominate
  Click a constellation label → elastic pull, that cluster fills the view
  Click empty space → springs back to full universe view

## 7. Why Obsidian's Graph Failed (and Why Ours Won't)

Obsidian failure modes:
  1. All nodes look identical — no semantic meaning in visual properties
  2. You cannot act from the graph — it is decorative
  3. Filtering removes nodes — you lose context
  4. Gets cluttered at scale — unusable past ~200 nodes

Lucid's solutions:
  1. Visual properties ARE data (brightness = validation, color = domain)
  2. You CAN act from the graph (drag to cite, click to validate)
  3. Elastic navigation — stars never disappear
  4. Constellation zoom — you navigate levels, not a flat graph

## 8. Density Behavior

< 10 facts:    Show individual stars, no constellation labels
10–50 facts:   Constellations emerge, labeled
50–200 facts:  Full graph with gravity zones, elastic navigation
200+ facts:    Constellation-first view (zoom in to see individual stars)

## 9. Team and Policy Space Differences

Team space:
  - Stars show validator initials as small badges
  - Facts with quorum met: brighter ring
  - Facts pending quorum: dashed border
  - Overlapping constellations = shared knowledge

Policy space:
  - Officially certified facts (L4) = anchor stars (fixed positions)
  - Jurisdiction boundaries shown as faint zone overlays (KR / EU / US)
  - Provenance chain visible on hover (full audit trail)
  - Export: official citation map with institutional signatures
