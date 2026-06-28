/**
 * M3-2c — StellarLeftPanel: left-panel filter bar for the Stellar view.
 *
 * Surfaces four data-only filters that gate which nodes / links the
 * renderer receives. NONE of these filters touches the renderer's
 * visual style — per the 2026-06-28 PO correction:
 *
 *   ★ All facts = verified = solid lines (M3-2b consistency).
 *   ★ link_status is DATA METADATA ONLY — no opacity, no dashed
 *     lines, no color change derived from it.
 *   ★ CLAIM toggle off (top-right) HIDES claim nodes (filter out),
 *     NOT a visual dim. The link_status filter here is the same
 *     kind of HIDE — drops links from the data set, never restyles
 *     the survivors.
 *
 * Filters rendered:
 *   1. Entity bucket — WHO / WHAT / WHERE checkboxes.
 *   2. fact_type    — action / claim / measurement checkboxes.
 *   3. as_of range  — from / to date inputs (measurement-shaped).
 *   4. link_status  — all / verified / claimed select (★ data only).
 *
 * The parent (StellarView) owns the state; this component is a
 * controlled render surface so the filter logic stays colocated
 * with the activeData → filteredData useMemo.
 */

export type EntityBucket = 'who' | 'what' | 'where';
export type FactTypeFilter = 'action' | 'claim' | 'measurement';
export type LinkStatusFilter = 'all' | 'verified' | 'claimed';

export interface StellarLeftPanelProps {
  entityBuckets: Record<EntityBucket, boolean>;
  onEntityBucketChange: (bucket: EntityBucket, checked: boolean) => void;
  factTypes: Record<FactTypeFilter, boolean>;
  onFactTypeChange: (factType: FactTypeFilter, checked: boolean) => void;
  asOfFrom: string;
  asOfTo: string;
  onAsOfFromChange: (v: string) => void;
  onAsOfToChange: (v: string) => void;
  linkStatus: LinkStatusFilter;
  onLinkStatusChange: (v: LinkStatusFilter) => void;
}

const PANEL_BG = 'rgba(12,19,22,0.92)';
const PANEL_BORDER = '#1c272b';
const ACCENT = '#3fe0c6';
const TEXT_BODY = '#cdd9da';
const TEXT_DIM = '#647479';
const TEXT_PRIMARY = '#eaf1f2';

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

const inputStyle: React.CSSProperties = {
  background: 'rgba(13,20,23,0.85)',
  border: `1px solid ${PANEL_BORDER}`,
  borderRadius: 6,
  color: TEXT_PRIMARY,
  fontSize: 12,
  padding: '6px 8px',
  outline: 'none',
  width: '100%',
  fontFamily: 'Pretendard, sans-serif',
  colorScheme: 'dark',
};

const ENTITY_BUCKET_LABEL: Record<EntityBucket, string> = {
  who: 'WHO · 사람/조직',
  what: 'WHAT · 개념/사건',
  where: 'WHERE · 장소',
};

const FACT_TYPE_LABEL: Record<FactTypeFilter, string> = {
  action: 'action · 행위',
  claim: 'claim · 발언',
  measurement: 'measurement · 수치',
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
        width: 260,
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
        <div style={{ ...sectionHeaderStyle, color: ACCENT }}>FILTER · 좌패널</div>
      </div>

      {/* Section 1 — Entity bucket */}
      <div>
        <div style={sectionHeaderStyle}>ENTITY</div>
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

      {/* Section 2 — fact_type */}
      <div>
        <div style={sectionHeaderStyle}>FACT TYPE</div>
        {(Object.keys(FACT_TYPE_LABEL) as FactTypeFilter[]).map((ft) => (
          <label key={ft} style={rowStyle}>
            <input
              type="checkbox"
              data-testid={`stellar-filter-fact-type-${ft}`}
              checked={props.factTypes[ft]}
              onChange={(e) => props.onFactTypeChange(ft, e.target.checked)}
              style={{ accentColor: ACCENT }}
            />
            <span>{FACT_TYPE_LABEL[ft]}</span>
          </label>
        ))}
      </div>

      {/* Section 3 — as_of date range */}
      <div>
        <div style={sectionHeaderStyle}>AS_OF · 시점</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: TEXT_DIM }}>
            <span style={{ width: 32 }}>from</span>
            <input
              type="date"
              data-testid="stellar-filter-as-of-from"
              value={props.asOfFrom}
              onChange={(e) => props.onAsOfFromChange(e.target.value)}
              style={inputStyle}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: TEXT_DIM }}>
            <span style={{ width: 32 }}>to</span>
            <input
              type="date"
              data-testid="stellar-filter-as-of-to"
              value={props.asOfTo}
              onChange={(e) => props.onAsOfToChange(e.target.value)}
              style={inputStyle}
            />
          </label>
        </div>
      </div>

      {/* Section 4 — link_status. ★ DATA-ONLY (2026-06-28 PO correction).
        * MUST NOT bind to any visual style. The select changes what
        * the renderer sees, never how the renderer draws it. */}
      <div>
        <div style={sectionHeaderStyle}>LINK STATUS · 데이터만</div>
        <select
          data-testid="stellar-filter-link-status"
          value={props.linkStatus}
          onChange={(e) => props.onLinkStatusChange(e.target.value as LinkStatusFilter)}
          style={inputStyle}
        >
          <option value="all">all · 전부</option>
          <option value="verified">verified · 확정</option>
          <option value="claimed">claimed · 주장</option>
        </select>
      </div>
    </div>
  );
}

export default StellarLeftPanel;
