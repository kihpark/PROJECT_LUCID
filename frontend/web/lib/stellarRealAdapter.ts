/**
 * feat/stellar-entity-edge-remodel-v2 (PO 2026-06-29) — STELLAR real adapter
 * rewritten as an ENTITY-NODE / ACTION-EDGE graph.
 *
 * Core (PO brief verbatim):
 *   fact 를 노드로 그리지 말 것. entity 가 노드, fact_type 이 그래프 역할.
 *
 * fact_type 별 그래프 역할:
 *   ACTION       -> subject_uid -[predicate]-> object_value(UUID) 엣지.
 *                  role 은 엣지 속성. literal object 는 엣지 생략.
 *   CLAIM        -> claim 노드 (id=fact_uid, kind="claim").
 *                  speaker(entity) -speaker-> claim 노드 -claim_related->
 *                  related_entity_uids (entity 들).
 *   MEASUREMENT  -> entity 의 속성. subject_uid entity 에 measurement 푸시,
 *                  별도 노드 X.
 *
 * 노드 크기 = entity degree. 색 = entity_type. claim 노드 = CLAIM_NODE_COLOR.
 *
 * ----------------------------------------------------------------------------
 * Discovery (STEP 0 — verbatim from 2026-06-29 audit):
 *
 *   Frontend RecallFact carries: subject_uid / subject_label /
 *   subject_entity_type / object_value / object_label / object_entity_type /
 *   predicate / predicate_label / fact_type / speaker_label / speech_act /
 *   content_claim / stance / metric / measurement_value / measurement_unit /
 *   as_of. MISSING: speaker_uid, related_entity_uids, fact_object_role,
 *   link_status — backend ES doc has them but _hit_to_fact does NOT surface
 *   (backend/api/routes/recall.py).
 *
 *   Decision: this PR does NOT touch backend (PO constraint). The 4 fields
 *   are added to types.ts/RecallFact as optional and the adapter reads them
 *   defensively.
 *
 *   FALLBACK policy:
 *     - speaker_uid absent -> stub id "claim-speaker:" + normalize(label).
 *     - related_entity_uids absent -> claim node only has the speaker edge.
 *     - fact_object_role absent -> link.roles = null.
 *     - link_status absent -> undefined. NEVER influences visuals.
 * ----------------------------------------------------------------------------
 */

import { getHomeBrief, isMeaningfulLabel, listSpaceFacts, recall } from './api';
import { getCurrentSpace } from './auth';
import type { HomeBrief, RecallFact, RecallResponse } from './types';
import { attachGraphMetrics } from './syntheticGraph';
import type {
  StellarGraphData,
  StellarLink,
  StellarMeasurement,
  StellarNode,
} from './syntheticGraph';

const UUID4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isEntityRef(v: string | null | undefined): boolean {
  return typeof v === 'string' && UUID4_RE.test(v);
}

function speakerStubId(speakerLabel: string | null | undefined): string | null {
  if (!speakerLabel) return null;
  const normalized = speakerLabel.trim().toLowerCase();
  if (!normalized) return null;
  return `claim-speaker:${normalized}`;
}

const SEED_QUERIES = ['사실', '분석', '보고서', '발표', '체결'];

export interface RealAdapterOptions {
  spaceId?: string | null;
  maxNodes?: number;
}

interface AccState {
  entities: Map<string, StellarNode>;
  claims: StellarNode[];
  links: StellarLink[];
  actionEdgeIndex: Map<string, StellarLink>;
}

// ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 1, 2) — UUID 화면 노출 0.
// STELLAR 노드 라벨도 backend resolve 결과를 그대로 쓴다. 옛: label 이
// 없으면 `uid.slice(0, 8)` 로 UUID prefix 8 chars 를 표시 → ★ UUID 노출.
// fix: "미해결 entity" 로 교체.
const UNRESOLVED_ENTITY_LABEL = '미해결 entity';

function ensureEntity(
  acc: AccState,
  uid: string,
  label: string | null | undefined,
  entityType: string | null | undefined,
): StellarNode {
  // ★ REQ-013 (PO 2026-07-02) — "." bug 2차 방어선.
  //   Backend suggest_entities 가 이미 punctuation-only labels 를 걸러내지만
  //   listSpaceFacts / recall 응답에는 subject_label 이 여전히 "." 로 올 수
  //   있다 (다른 API path). 여기서 label meaningful 아니면 UNRESOLVED 로
  //   교체 → STELLAR 노드 label 에 "." 이 들어가면 SearchBar 자동완성 에
  //   surface 될 여지가 원천 차단.
  const safeLabel = isMeaningfulLabel(label) ? label : null;
  const existing = acc.entities.get(uid);
  if (existing) {
    if (!existing.label || existing.label === UNRESOLVED_ENTITY_LABEL) {
      if (safeLabel) existing.label = safeLabel;
    }
    if (!existing.entity_type && entityType) {
      existing.entity_type = entityType;
      existing.subject_entity_type =
        existing.subject_entity_type ?? entityType ?? null;
    }
    return existing;
  }
  const node: StellarNode = {
    id: uid,
    label: safeLabel || UNRESOLVED_ENTITY_LABEL,
    kind: 'entity',
    cluster: 0,
    weight: 1,
    entity_type: entityType ?? null,
    subject_entity_type: entityType ?? null,
    object_entity_type: null,
    subject_uid: uid,
    object_uid: null,
    measurements: [],
    fact_type: null,
    // ★ fix/entitycard-fact-count-and-dot-suggestion — fact_type 별 정확 카운트.
    //   Initialised to all-zeros so processFact can bump independently of edges.
    fact_counts: { action: 0, claim: 0, measurement: 0 },
  };
  acc.entities.set(uid, node);
  return node;
}

/** ★ fix/entitycard-fact-count-and-dot-suggestion — bump a fact_type bucket
 *  on an entity node, INDEPENDENT of whether a link edge is created. Pure
 *  additive: never touches link/edge generation. */
function bumpFactCount(
  entity: StellarNode,
  kind: 'action' | 'claim' | 'measurement',
): void {
  if (!entity.fact_counts) {
    entity.fact_counts = { action: 0, claim: 0, measurement: 0 };
  }
  entity.fact_counts[kind] += 1;
}

function actionEdgeKey(srcId: string, tgtId: string): string {
  return `action:${srcId}->${tgtId}`;
}

function pushClaimRelated(
  acc: AccState,
  claimNodeId: string,
  relatedEntityId: string,
  linkStatus: string | null | undefined,
): void {
  acc.links.push({
    source: claimNodeId,
    target: relatedEntityId,
    kind: 'claim_related',
    predicate: 'related to',
    fact_count: 1,
    link_status:
      (linkStatus as 'verified' | 'claimed' | null | undefined) ?? null,
  });
}

function processFact(acc: AccState, fact: RecallFact): void {
  const factType = fact.fact_type ?? 'action';

  if (factType === 'measurement') {
    if (!isEntityRef(fact.subject_uid)) return;
    const subj = ensureEntity(
      acc,
      fact.subject_uid as string,
      fact.subject_label,
      fact.subject_entity_type,
    );
    const m: StellarMeasurement = {
      metric: fact.metric ?? null,
      value:
        typeof fact.measurement_value === 'number'
          ? fact.measurement_value
          : null,
      unit: fact.measurement_unit ?? null,
      as_of: fact.as_of ?? null,
      fact_uid: fact.fact_uid,
    };
    if (!subj.measurements) subj.measurements = [];
    subj.measurements.push(m);
    // ★ fix/entitycard-fact-count-and-dot-suggestion — subject entity 의
    //   measurement count++ (measurement attribute push 와 별개로 카운트).
    bumpFactCount(subj, 'measurement');
    return;
  }

  if (factType === 'claim') {
    const claimLabel = (fact.content_claim || fact.claim || 'claim').trim();
    const claimNode: StellarNode = {
      id: fact.fact_uid,
      label:
        claimLabel.length > 30 ? claimLabel.slice(0, 29) + '...' : claimLabel,
      kind: 'claim',
      cluster: 1,
      weight: Math.max(1, fact.source_uids?.length ?? 1),
      fact_type: 'claim',
      entity_type: null,
      subject_uid: null,
      object_uid: null,
      speaker_label: fact.speaker_label ?? null,
      speech_act: fact.speech_act ?? null,
      content_claim: fact.content_claim ?? null,
      link_status:
        (fact.link_status as 'verified' | 'claimed' | null | undefined) ?? null,
    };
    acc.claims.push(claimNode);

    let speakerId: string | null = null;
    let speakerNode: StellarNode | null = null;
    if (isEntityRef(fact.speaker_uid)) {
      // ★ REQ-014-D (PO 2026-07-02) — speaker_entity_type 회복.
      //   옛: ensureEntity(uid, label, null) → 화자 노드 entity_type=null →
      //   StellarEntityCard 이 "기타" 로 표시. 사용자가 EntityTypeDropdown
      //   에서 "사람" 저장을 눌러도 backend 는 이미 person 이므로 변화가
      //   없고 UI 는 계속 기타 → "저장 안 됨" 처럼 보임.
      //   fix: backend 가 새로 채워보내는 fact.speaker_entity_type 을 그대로
      //   ensureEntity 로 전달 → 화자 노드가 색·타입을 갖는다.
      const speaker = ensureEntity(
        acc,
        fact.speaker_uid as string,
        fact.speaker_label,
        fact.speaker_entity_type ?? null,
      );
      speakerId = speaker.id;
      speakerNode = speaker;
    } else {
      const stub = speakerStubId(fact.speaker_label);
      if (stub) {
        // stub speakers (label-only) 은 uid resolve 실패 → entity_type 도 없음.
        const speaker = ensureEntity(
          acc,
          stub,
          fact.speaker_label,
          fact.speaker_entity_type ?? null,
        );
        speakerId = speaker.id;
        speakerNode = speaker;
      }
    }
    if (speakerId) {
      acc.links.push({
        source: speakerId,
        target: claimNode.id,
        kind: 'speaker',
        predicate: fact.speech_act || 'speaker',
        fact_count: 1,
        link_status:
          (fact.link_status as 'verified' | 'claimed' | null | undefined) ??
          null,
      });
    }
    // ★ fix/entitycard-fact-count-and-dot-suggestion — speaker entity (real
    //   uid 또는 stub) 의 claim count++. INDEPENDENT 하게 edge 무관 누적.
    if (speakerNode) bumpFactCount(speakerNode, 'claim');

    for (const relUid of fact.related_entity_uids ?? []) {
      if (!isEntityRef(relUid)) continue;
      const rel = ensureEntity(acc, relUid, null, null);
      pushClaimRelated(acc, claimNode.id, rel.id, fact.link_status ?? null);
      // ★ fix/entitycard-fact-count-and-dot-suggestion — related entity 도
      //   claim count++ (해당 claim 의 참여자).
      bumpFactCount(rel, 'claim');
    }
    return;
  }

  // ACTION
  if (!isEntityRef(fact.subject_uid)) return;
  const subj = ensureEntity(
    acc,
    fact.subject_uid as string,
    fact.subject_label,
    fact.subject_entity_type,
  );
  // ★ fix/entitycard-fact-count-and-dot-suggestion — ALWAYS bump subject 의
  //   action count, even when object is a literal (강재호 / 이로운몰 설립
  //   시나리오). link 가 만들어지지 않더라도 fact 는 존재한다.
  bumpFactCount(subj, 'action');
  if (!isEntityRef(fact.object_value)) {
    subj.weight = (subj.weight ?? 1) + 1;
    return;
  }
  const obj = ensureEntity(
    acc,
    fact.object_value as string,
    fact.object_label,
    fact.object_entity_type,
  );
  // ★ fix/entitycard-fact-count-and-dot-suggestion — object 가 entity ref 인
  //   경우에는 object 의 action count 도 누적.
  bumpFactCount(obj, 'action');
  const key = actionEdgeKey(subj.id, obj.id);
  const existing = acc.actionEdgeIndex.get(key);
  if (existing) {
    existing.fact_count = (existing.fact_count ?? 1) + 1;
    if (fact.predicate) {
      existing.predicates = [...(existing.predicates ?? []), fact.predicate];
    }
    if (!existing.roles && fact.fact_object_role) {
      existing.roles = fact.fact_object_role;
    }
    return;
  }
  const link: StellarLink = {
    source: subj.id,
    target: obj.id,
    kind: 'action',
    predicate: fact.predicate,
    predicates: fact.predicate ? [fact.predicate] : null,
    fact_count: 1,
    roles: fact.fact_object_role ?? null,
    link_status:
      (fact.link_status as 'verified' | 'claimed' | null | undefined) ?? null,
  };
  acc.links.push(link);
  acc.actionEdgeIndex.set(key, link);
}

function applyBriefOverlay(acc: AccState, brief: HomeBrief | null): void {
  if (!brief?.recent_validated) return;
  for (const r of brief.recent_validated) {
    const subjectUid =
      (r as { subject_uid?: string | null }).subject_uid ?? null;
    if (!subjectUid) continue;
    const node = acc.entities.get(subjectUid);
    if (!node) continue;
    node.cluster = 0;
    node.validationStrength = Math.max(node.validationStrength ?? 0.5, 0.9);
  }
}

export async function loadRealStellarGraph(
  options: RealAdapterOptions = {},
): Promise<StellarGraphData> {
  const spaceId = options.spaceId ?? getCurrentSpace();
  const maxNodes = options.maxNodes ?? 200;
  const acc: AccState = {
    entities: new Map(),
    claims: [],
    links: [],
    actionEdgeIndex: new Map(),
  };

  let brief: HomeBrief | null = null;
  try {
    brief = await getHomeBrief();
  } catch {
    // Fail-soft.
  }

  const topClusterLabel = brief?.top_cluster?.entity_name ?? null;
  const clusters: string[] = ['최근 검증', topClusterLabel ?? '코퍼스'];

  let primaryUsed = false;
  if (spaceId) {
    try {
      const list = await listSpaceFacts(spaceId, maxNodes);
      for (const fact of list.facts) {
        processFact(acc, fact);
        if (acc.entities.size >= maxNodes) break;
      }
      primaryUsed = true;
    } catch {
      // Drop through to fan-out.
    }
  }

  if (!primaryUsed && spaceId && acc.entities.size < maxNodes) {
    const fanOut = await Promise.allSettled(
      SEED_QUERIES.map((q) => recall(spaceId, q, { limit: 40 })),
    );
    for (const result of fanOut) {
      if (result.status !== 'fulfilled') continue;
      const resp = result.value as RecallResponse;
      for (const fact of resp.facts) {
        processFact(acc, fact);
        if (acc.entities.size >= maxNodes) break;
      }
      if (acc.entities.size >= maxNodes) break;
    }
  }

  applyBriefOverlay(acc, brief);

  const nodes = [...acc.entities.values(), ...acc.claims];
  return attachGraphMetrics({ nodes, links: acc.links, clusters });
}

export function emptyStellarGraph(): StellarGraphData {
  return { nodes: [], links: [], clusters: [] };
}
