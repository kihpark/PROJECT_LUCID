/**
 * M3-2d StellarEdgeFactsList — 엣지 클릭 → fact 리스트 (우패널).
 * PO 의뢰서 verbatim + fix/stellar-cards-entity-node-compat (2026-06-29).
 *
 * 엣지 = 두 entity 사이 관계. 이 패널은 그 관계를 형성하는 모든 fact 를
 * 한 줄씩 나열한다.
 *
 * 각 fact 마다:
 *   - 원문 (surface text)
 *   - SPO (subject + predicate + object)
 *   - as_of (시점)
 *   - provenance (source url + extracted_at)
 *   - speech_act 표시 (CLAIM 이면 양태 표시)
 *
 * ★ PO 정정 (2026-06-28):
 *   link_status (verified/claimed) → 시각 강약 X. 데이터 메타데이터 only.
 *   리스트에 link_status 값을 라벨로 노출하더라도 stroke/색/opacity 어떤
 *   visual signal 도 바뀌지 않는다. unbind 가드 테스트로 검증.
 *
 * ★ fix/stellar-cards-entity-node-compat (PO 2026-06-29):
 *   STELLAR v2 의 link 객체를 직접 받아 그리는 새 경로 추가.
 *   - link prop 이 주어지면 link.predicates / fact_count / roles / link_status
 *     를 요약 렌더 (1 행 per row 가 아니라 link 1 개 = 1 카드).
 *   - 양 끝 이름은 pickEntityName 으로 노출 — '(주체 없음)' / '(객체 없음)' 제거.
 *   - link prop 이 없으면 기존 findFactsForEdge + row 렌더 (백워드 호환).
 */
'use client';

import type { StellarLink, StellarNode } from '@/lib/syntheticGraph';
import { predicateLabel } from '@/lib/predicateLabels';
import { classifyClaimModality, pickEntityName } from './StellarHoverCard';

const ACCENT = '#5EEAD4';
const WHO_COLOR = '#5EEAD4';
const TEXT_PRIMARY = '#eaf1f2';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';
const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';

const MODALITY_KO: Record<'assertion' | 'judgment' | 'opinion', string> = {
  assertion: '단정',
  judgment: '판단',
  opinion: '의견',
};

/** Given two entity-anchor nodes A and B, find every fact whose endpoints
 *  match this pair (A→B or B→A) in `allFacts`. Pure for testability. */
export function findFactsForEdge(
  a: StellarNode,
  b: StellarNode,
  allFacts: StellarNode[],
): StellarNode[] {
  const ak = a.subject_uid ?? a.subject;
  const bk = b.subject_uid ?? b.subject;
  const out: StellarNode[] = [];
  for (const f of allFacts) {
    const sk = f.subject_uid ?? f.subject;
    const ok = f.object_uid ?? f.object;
    if ((sk === ak && ok === bk) || (sk === bk && ok === ak)) {
      out.push(f);
    }
  }
  return out;
}

export interface StellarEdgeFactsListProps {
  /** The two endpoint nodes the edge spans. */
  endpoints: { a: StellarNode; b: StellarNode };
  /** Full fact set so we can filter by the SPO pair (legacy path). */
  allFacts: StellarNode[];
  /** fix/stellar-cards-entity-node-compat — v2 link object. When provided,
   *  the panel renders a single summary card derived from link metadata
   *  instead of one row per fact-node. */
  link?: StellarLink;
  /** Close handler. */
  onClose: () => void;
}

const PANEL_STYLE = {
  position: 'absolute' as const,
  top: 16,
  right: 18,
  zIndex: 20,
  width: 420,
  maxHeight: 'calc(100% - 32px)',
  overflowY: 'auto' as const,
  background: PANEL_BG,
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: 14,
  padding: 18,
  marginTop: 56,
  color: TEXT_PRIMARY,
  boxShadow: '0 24px 60px rgba(0,0,0,0.6)',
  backdropFilter: 'blur(10px)',
};

function PanelHeader({
  count,
  onClose,
}: {
  count: number;
  onClose: () => void;
}) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginBottom: 12,
      }}
    >
      <span
        style={{
          color: ACCENT,
          fontSize: 11,
          letterSpacing: '0.08em',
          fontWeight: 600,
        }}
      >
        지식그래프 · 관계 · {count}건
      </span>
      <button
        type="button"
        data-testid="stellar-edge-facts-close"
        onClick={onClose}
        aria-label="close"
        style={{
          background: 'transparent',
          border: 'none',
          color: TEXT_DIM,
          fontSize: 18,
          cursor: 'pointer',
          lineHeight: 1,
          padding: 4,
        }}
      >
        ×
      </button>
    </header>
  );
}

function EndpointsLine({
  aName,
  bName,
}: {
  aName: string;
  bName: string;
}) {
  return (
    <div
      data-testid="stellar-edge-facts-endpoints"
      style={{ fontSize: 13, color: TEXT_BODY, lineHeight: 1.5, marginBottom: 14 }}
    >
      <span style={{ color: WHO_COLOR, fontWeight: 600 }}>{aName}</span>
      <span style={{ color: TEXT_DIM, margin: '0 6px' }}>↔</span>
      <span style={{ color: WHO_COLOR, fontWeight: 600 }}>{bName}</span>
    </div>
  );
}

export function StellarEdgeFactsList({
  endpoints,
  allFacts,
  link,
  onClose,
}: StellarEdgeFactsListProps) {
  const aName = pickEntityName(endpoints.a);
  const bName = pickEntityName(endpoints.b);

  // fix/stellar-cards-entity-node-compat — v2 link-driven summary path.
  if (link) {
    const factCount =
      typeof link.fact_count === 'number' && link.fact_count > 0
        ? link.fact_count
        : 1;
    const predicateList: string[] = (() => {
      if (link.predicates && link.predicates.length > 0) {
        return link.predicates;
      }
      if (link.predicate) return [link.predicate];
      return [];
    })();
    const roles = link.roles && Object.keys(link.roles).length > 0
      ? link.roles
      : null;
    return (
      <aside
        data-testid="stellar-edge-facts-list"
        role="dialog"
        aria-label="edge facts"
        style={PANEL_STYLE}
      >
        <PanelHeader count={factCount} onClose={onClose} />
        <EndpointsLine aName={aName} bName={bName} />
        <div
          data-testid="stellar-edge-facts-summary"
          data-link-kind={link.kind ?? ''}
          style={{ fontSize: 12, color: TEXT_BODY, lineHeight: 1.6 }}
        >
          <span data-testid="stellar-edge-facts-fact-count">{factCount}건의 fact</span>
        </div>
        {predicateList.length > 0 ? (
          <ul
            data-testid="stellar-edge-facts-predicates"
            style={{
              listStyle: 'none',
              padding: 0,
              margin: '10px 0 0 0',
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
            }}
          >
            {predicateList.map((p, i) => (
              <li
                key={`${p}-${i}`}
                data-testid="stellar-edge-facts-predicate"
                style={{
                  padding: '3px 8px',
                  border: `1px solid ${PANEL_BORDER}`,
                  borderRadius: 999,
                  color: ACCENT,
                  fontSize: 11,
                  fontWeight: 600,
                  background: 'rgba(94,234,212,0.06)',
                }}
              >
                {predicateLabel(p)}
              </li>
            ))}
          </ul>
        ) : null}
        {roles ? (
          <div
            data-testid="stellar-edge-facts-roles"
            style={{
              color: TEXT_DIM,
              fontSize: 10,
              marginTop: 10,
              lineHeight: 1.5,
            }}
          >
            roles:{' '}
            {Object.entries(roles)
              .map(([k, v]) => k + ': ' + v)
              .join(', ')}
          </div>
        ) : null}
        {link.link_status ? (
          <div
            data-testid="stellar-edge-facts-link-status"
            data-link-status={link.link_status}
            style={{ color: TEXT_DIM, fontSize: 10, marginTop: 8 }}
          >
            · {link.link_status}
          </div>
        ) : null}
      </aside>
    );
  }

  // Legacy / synthetic path — 1 fact = 1 node + findFactsForEdge.
  const facts = findFactsForEdge(endpoints.a, endpoints.b, allFacts);

  return (
    <aside
      data-testid="stellar-edge-facts-list"
      role="dialog"
      aria-label="edge facts"
      style={PANEL_STYLE}
    >
      <PanelHeader count={facts.length} onClose={onClose} />
      <EndpointsLine aName={aName} bName={bName} />

      {facts.length === 0 ? (
        <div
          data-testid="stellar-edge-facts-empty"
          style={{ color: TEXT_DIM, fontSize: 12, padding: '12px 0' }}
        >
          이 두 노드 사이에 직접 fact 가 없습니다.
        </div>
      ) : (
        <ul
          data-testid="stellar-edge-facts-rows"
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {facts.map((f, i) => {
            const ft = f.fact_type ?? 'action';
            const modality =
              ft === 'claim' ? classifyClaimModality(f.speech_act) : null;
            return (
              <li
                key={`${f.id}-${i}`}
                data-testid="stellar-edge-facts-row"
                data-fact-type={ft}
                data-modality={modality ?? ''}
                style={{
                  padding: 10,
                  border: `1px solid ${PANEL_BORDER}`,
                  borderRadius: 8,
                  background: 'rgba(0,0,0,0.18)',
                }}
              >
                {/* 원문 (surface text) — 의뢰서 verbatim. */}
                {f.surface_text ? (
                  <div
                    data-testid="stellar-edge-facts-row-surface"
                    style={{
                      fontSize: 12,
                      color: TEXT_BODY,
                      marginBottom: 6,
                      fontStyle: 'italic',
                      lineHeight: 1.5,
                    }}
                  >
                    “{f.surface_text}”
                  </div>
                ) : null}

                {/* SPO line */}
                <div
                  data-testid="stellar-edge-facts-row-spo"
                  style={{ fontSize: 12, lineHeight: 1.5 }}
                >
                  <span style={{ color: WHO_COLOR, fontWeight: 600 }}>
                    {f.subject}
                  </span>
                  <span style={{ color: ACCENT, margin: '0 6px' }}>
                    {predicateLabel(f.predicate ?? '')}
                  </span>
                  <span style={{ color: TEXT_BODY }}>{f.object}</span>
                </div>

                {/* speech_act 양태 — CLAIM 만. */}
                {ft === 'claim' && modality ? (
                  <div
                    data-testid="stellar-edge-facts-row-modality"
                    style={{
                      fontSize: 10,
                      color: ACCENT,
                      marginTop: 4,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                    }}
                  >
                    발언 · {MODALITY_KO[modality]}
                  </div>
                ) : null}
                {ft === 'claim' && !modality && f.speech_act ? (
                  <div
                    data-testid="stellar-edge-facts-row-speech-act"
                    style={{
                      fontSize: 10,
                      color: ACCENT,
                      marginTop: 4,
                      letterSpacing: '0.08em',
                    }}
                  >
                    발언 · {f.speech_act}
                  </div>
                ) : null}

                {/* as_of + provenance (source url + extracted_at) */}
                <div
                  data-testid="stellar-edge-facts-row-foot"
                  style={{
                    marginTop: 8,
                    fontSize: 10,
                    color: TEXT_DIM,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 8,
                  }}
                >
                  {f.as_of ? (
                    <span data-testid="stellar-edge-facts-row-asof">
                      · {f.as_of}
                    </span>
                  ) : null}
                  {f.source_url ? (
                    <a
                      data-testid="stellar-edge-facts-row-source"
                      href={f.source_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{ color: TEXT_DIM, textDecoration: 'underline' }}
                    >
                      · 출처
                    </a>
                  ) : null}
                  {f.extracted_at ? (
                    <span data-testid="stellar-edge-facts-row-extracted">
                      · {f.extracted_at}
                    </span>
                  ) : null}
                  {/* ★ link_status: 데이터 메타데이터 라벨만. 시각 강약 X. */}
                  {f.link_status ? (
                    <span
                      data-testid="stellar-edge-facts-row-link-status"
                      data-link-status={f.link_status}
                      style={{ color: TEXT_DIM }}
                    >
                      · {f.link_status}
                    </span>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

export default StellarEdgeFactsList;
