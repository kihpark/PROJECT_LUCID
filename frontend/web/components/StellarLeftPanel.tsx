/**
 * fix/stellar-leftpanel-simplify — left panel reduced to ENTITY only.
 *
 * 2026-06-28 PO 명령: "좌패널 단순화 부탁".
 * Direct quote precedent (dogfood): "노드 엔티티 별 구분이 제일 먼저
 * 필요해 보임. ... 좌패널 복잡함."
 *
 * Drastic simplification: ENTITY 토글 (WHO / WHAT / WHERE) 만 남기고
 * 옛 fact_type / as_of / link_status 섹션은 제거. 데이터 레이어 자체
 * (link_status, fact_type, as_of 필드) 는 변경 없음 — 좌패널 UI 만
 * 단순화된다. CLAIM 토글 (우상단) 이 fact_type 분기를 이미 담당하고,
 * as_of / link_status 는 사용자 가치가 낮아 PO 가 명시적으로 잘라냈다.
 *
 * Phase 2 (옵션): 필요 시 "고급 필터" accordion 으로 재도입 가능. 다만
 * 이번 PR scope 밖.
 *
 * Rendered surface:
 *   1. ENTITY — WHO / WHAT / WHERE 체크박스 (M3-2b 색 어휘와 1:1 매칭).
 *
 * 디자인 noise (옛 fact_type / as_of / link_status) 가 사라지면서
 * 좌패널은 한 번 보고 직관적으로 이해할 수 있는 단일 의도 surface 가
 * 된다 (PO 단순화 원칙).
 */

// fix/stellar-ux-self-audit U2 — `unknown` is now a first-class bucket. The
// left-panel renders four toggles (WHO / WHAT / WHERE / 기타·unknown) so the
// user can hide entity nodes whose entity_type is missing or unmapped — the
// previous behaviour silently passed unknown-type nodes through regardless
// of the three known toggles, leaving no user control surface for them.
export type EntityBucket = 'who' | 'what' | 'where' | 'unknown';
// 옛 타입 alias 보존 — StellarView 가 데이터 필터 (CLAIM 토글, link_status
// metadata) 에서 계속 쓸 수 있도록 export 만 남긴다. 좌패널 UI 에는 더 이상
// 안 보임.
export type FactTypeFilter = 'action' | 'claim' | 'measurement';
export type LinkStatusFilter = 'all' | 'verified' | 'claimed';

export interface StellarLeftPanelProps {
  entityBuckets: Record<EntityBucket, boolean>;
  onEntityBucketChange: (bucket: EntityBucket, checked: boolean) => void;
}

const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';
const ACCENT = '#3fe0c6';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';

const sectionHeaderStyle: React.CSSProperties = {
  color: TEXT_DIM,
  fontSize: 10,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  fontWeight: 600,
  marginBottom: 8,
};

const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  color: TEXT_BODY,
  fontSize: 12,
  padding: '3px 0',
  cursor: 'pointer',
};

// feat/i18n-ko-display-names-separation (★ PO 2026-06-30) — ★ 사용자
// 노출 영문 코드 (WHO/WHAT/WHERE) 0. 내부 식별자 (`who`, `what`, …) 와
// data-testid (`stellar-filter-entity-who`) 는 코드명 유지.
const ENTITY_BUCKET_LABEL: Record<EntityBucket, string> = {
  who: '인물 (사람·조직)',
  what: '대상 (개념·사건)',
  where: '장소',
  // fix/stellar-ux-self-audit U2 — explicit bucket for entity_type missing
  // or unmapped. Previously the filter passed these through regardless of
  // the three known toggles → user could not hide them.
  unknown: '기타',
};

export function StellarLeftPanel(props: StellarLeftPanelProps): React.ReactElement {
  return (
    <div
      data-testid="stellar-left-panel"
      style={{
        position: 'absolute',
        top: 260,
        left: 16,
        zIndex: 10,
        width: 220,
        padding: '14px 14px 16px',
        borderRadius: 12,
        background: PANEL_BG,
        border: `1px solid ${PANEL_BORDER}`,
        color: TEXT_BODY,
        fontFamily: 'Pretendard, sans-serif',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        boxShadow: '0 12px 30px rgba(0,0,0,0.45)',
      }}
    >
      <div>
        <div style={{ ...sectionHeaderStyle, color: ACCENT }}>필터</div>
      </div>

      {/* Section 1 — Entity bucket (★ 유일하게 남은 섹션). */}
      <div>
        <div style={sectionHeaderStyle}>엔티티</div>
        {(Object.keys(ENTITY_BUCKET_LABEL) as EntityBucket[]).map((bucket) => (
          <label key={bucket} style={rowStyle}>
            <input
              type="checkbox"
              data-testid={`stellar-filter-entity-${bucket}`}
              checked={props.entityBuckets[bucket]}
              onChange={(e) => props.onEntityBucketChange(bucket, e.target.checked)}
              style={{ accentColor: ACCENT }}
            />
            <span>{ENTITY_BUCKET_LABEL[bucket]}</span>
          </label>
        ))}
      </div>
    </div>
  );
}

export default StellarLeftPanel;
