/**
 * B-62 — Stellar View "real KS" adapter.
 *
 * Today's recall endpoint (DR-089) is a query-driven semantic search; there
 * is NO "list all facts in this space" endpoint. For the Stellar spike we
 * approximate "the whole graph" by:
 *
 *   1. Pulling `/api/home/brief` for the `recent_validated` slice and
 *      `top_cluster` hint (lightweight, always available).
 *   2. Optionally seeding the canvas with a recall fan-out using a generic
 *      Korean stopword query (한국의 / 사실 / 분석 / 보고) so we surface at
 *      least a handful of nodes when the brief is sparse.
 *
 * If the user's KS is cold-start (no facts yet, brief.is_empty === true),
 * we return {nodes:[], links:[]} and the StellarView shows a quiet "graph
 * is empty" hint. This is the explicit fail-soft contract — see the brief.
 *
 * NB: the adapter is pure data — no React, no DOM, no localStorage. The
 * component decides whether to call it (toggle state in localStorage).
 */

import { getHomeBrief, listSpaceFacts, recall } from './api';
import { getCurrentSpace } from './auth';
import { predicateLabel } from './predicateLabels';
import type { HomeBrief, RecallFact, RecallResponse } from './types';
import { attachGraphMetrics } from './syntheticGraph';
import type { StellarGraphData, StellarLink, StellarNode } from './syntheticGraph';

/** Generic queries used to fan out the canvas when the brief is too thin
 *  to fill a galaxy on its own. Each call adds to the union (de-duped on
 *  fact_uid). The choice of queries is intentionally low-signal — we want
 *  to surface what's there, not to bias toward a particular topic. */
const SEED_QUERIES = ['사실', '분석', '보고서', '발표', '체결'];

export interface RealAdapterOptions {
  /** Override the KS used. Defaults to getCurrentSpace(). */
  spaceId?: string | null;
  /** Maximum nodes to surface. Default 200 — plenty for a starter galaxy. */
  maxNodes?: number;
}

interface NodeAccumulator {
  byId: Map<string, StellarNode>;
  links: StellarLink[];
}

// feat/entity-layer-restore (PO 2026-06-23): UUID-shape guard so an
// unresolved entity ref (mget miss on the backend's _enrich_with_labels)
// never surfaces in the UI as the raw UUID. We render "(엔티티 미해결)"
// instead. Literals (numbers, dates, Korean strings) are unaffected
// because they don't match the UUID-4 regex.
const UUID4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function displaySubject(fact: RecallFact): string {
  if (fact.subject_label) return fact.subject_label;
  if (fact.subject_uid && UUID4_RE.test(fact.subject_uid)) {
    return '(엔티티 미해결)';
  }
  return fact.subject_uid || '(주체 없음)';
}

function displayObject(fact: RecallFact): string {
  if (fact.object_label) return fact.object_label;
  if (fact.object_value && UUID4_RE.test(fact.object_value)) {
    return '(엔티티 미해결)';
  }
  return fact.object_value || '(객체 없음)';
}

function pushFactAsNode(acc: NodeAccumulator, fact: RecallFact, clusterHint: number): void {
  if (acc.byId.has(fact.fact_uid)) return;
  const subject = displaySubject(fact);
  const object = displayObject(fact);
  const label = `${subject} · ${predicateLabel(fact.predicate, fact.predicate_label)} · ${object}`;
  const sourceCount = Math.max(1, fact.source_uids?.length ?? 1);
  // B-62-v1 — "검증된 팩트일수록 빛난다" — source count drives the
  // emissive strength. 1 source ≈ 0.35 (visible but quiet), 3+ sources
  // saturate at 1.0 (full glow).
  const validationStrength = Math.max(0.3, Math.min(1, 0.3 + sourceCount * 0.25));
  acc.byId.set(fact.fact_uid, {
    id: fact.fact_uid,
    label,
    cluster: clusterHint,
    weight: sourceCount,
    validationStrength,
    // Position is left at 0 — the force-graph engine spreads on first tick.
    x: 0,
    y: 0,
    z: 0,
    subject,
    predicate: fact.predicate,
    object,
  });
}

function linkBySubjectOverlap(acc: NodeAccumulator): void {
  // Group nodes by subject; emit a chain edge inside each group so the
  // entity-link surface is at least faintly visible in the spike. For the
  // real backend, B-49 facets / B-48 entity-link expansion will replace
  // this stub. The spike's goal is "the user sees clusters", not
  // "the user sees the canonical graph topology".
  const bySubject = new Map<string, string[]>();
  for (const node of acc.byId.values()) {
    const arr = bySubject.get(node.subject) ?? [];
    arr.push(node.id);
    bySubject.set(node.subject, arr);
  }
  for (const ids of bySubject.values()) {
    for (let i = 1; i < ids.length; i += 1) {
      acc.links.push({
        source: ids[i - 1] as string,
        target: ids[i] as string,
        type: 'supports',
      });
    }
  }
}

/**
 * Fetch + normalize the real KS graph slice. Always returns a valid
 * `StellarGraphData` — empty arrays on cold start, partial on success.
 *
 * The caller is expected to handle the loading state; this function
 * resolves once all fan-out calls have either returned or failed. We
 * never throw — fail-soft is the design contract.
 */
export async function loadRealStellarGraph(
  options: RealAdapterOptions = {},
): Promise<StellarGraphData> {
  const spaceId = options.spaceId ?? getCurrentSpace();
  const maxNodes = options.maxNodes ?? 200;
  const acc: NodeAccumulator = { byId: new Map(), links: [] };

  let brief: HomeBrief | null = null;
  try {
    brief = await getHomeBrief();
  } catch {
    // Fail-soft: brief is optional context, not load-bearing.
  }

  // Cluster index 0 = recent validated (the "fresh" galaxy);
  // cluster index 1 = recall fan-out (the broader corpus).
  const topClusterLabel = brief?.top_cluster?.entity_name ?? null;
  const clusters: string[] = ['최근 검증', topClusterLabel ? topClusterLabel : '코퍼스'];

  // B-62 — primary path: GET /api/spaces/{ks}/facts. Returns every
  // validated fact in the KS (capped at server-side 500, default 200).
  // This is the load-bearing fetch — without it the adapter could only
  // surface facts that happened to match the seed-query fan-out below,
  // which left SpaceX / 한국은행 / etc. completely invisible in real
  // mode. PO repro: only 국방부 showed because the seed queries
  // coincidentally hit defence-themed claims.
  let primaryUsed = false;
  if (spaceId) {
    try {
      const list = await listSpaceFacts(spaceId, maxNodes);
      for (const fact of list.facts) {
        // Cluster index 1 = whole-corpus facts; the home-brief recent
        // batch below will overwrite the cluster to 0 for any fact
        // that was also recent-validated, marking it as fresh.
        pushFactAsNode(acc, fact, 1);
        if (acc.byId.size >= maxNodes) break;
      }
      primaryUsed = true;
    } catch {
      // Fail-soft: drop through to the legacy fan-out path. Old
      // backends without the /facts endpoint, or transient ES
      // failures, both end up here.
    }
  }

  // brief.recent_validated overlays the "fresh" cluster on top — if a
  // fact is in both the full list AND the recent list, the recent
  // version wins (cluster 0, higher validationStrength).
  if (brief?.recent_validated) {
    for (const r of brief.recent_validated) {
      const existing = acc.byId.get(r.fact_uid);
      if (existing) {
        // Promote to fresh cluster; keep the rest of the node intact.
        existing.cluster = 0;
        existing.validationStrength = Math.max(
          existing.validationStrength ?? 0.5,
          0.9,
        );
        continue;
      }
      acc.byId.set(r.fact_uid, {
        id: r.fact_uid,
        label: r.claim,
        cluster: 0,
        weight: 3,
        // Recent-validated facts came through HITL — by definition validated.
        validationStrength: 0.9,
        x: 0,
        y: 0,
        z: 0,
        subject: r.subject_label ?? '주체',
        predicate: 'is_recent',
        object: r.claim,
      });
      if (acc.byId.size >= maxNodes) break;
    }
  }

  // Fan-out FALLBACK: only when the primary path failed AND we have
  // room to grow. This keeps the old behaviour around for transient
  // /facts outages but no longer runs in the happy case (so SpaceX
  // etc. now consistently appear).
  if (!primaryUsed && spaceId && acc.byId.size < maxNodes) {
    const fanOut = await Promise.allSettled(
      SEED_QUERIES.map((q) => recall(spaceId, q, { limit: 40 })),
    );
    for (const result of fanOut) {
      if (result.status !== 'fulfilled') continue;
      const resp = result.value as RecallResponse;
      for (const fact of resp.facts) {
        pushFactAsNode(acc, fact, 1);
        if (acc.byId.size >= maxNodes) break;
      }
      if (acc.byId.size >= maxNodes) break;
    }
  }

  linkBySubjectOverlap(acc);

  return attachGraphMetrics({
    nodes: Array.from(acc.byId.values()),
    links: acc.links,
    clusters,
  });
}

/** Exposed for tests so they can build a synthetic "what loadRealStellarGraph
 *  would return if the brief had X" without mocking fetch. */
export function emptyStellarGraph(): StellarGraphData {
  return { nodes: [], links: [], clusters: [] };
}
