'use client';

/**
 * ★ REQ-011-v1 (★ PO 2026-06-30) — Recall 전면 리디자인.
 *
 * 옛 구조 폐기 (검색 결과 list + facet panel + B-60 simple/power 모드 토글).
 * 새 구조 = 분석형 2 단 grid (좌 렌즈 / 우 답변·근거).
 *
 * 의뢰서 §2 verbatim:
 *   "루트 배경 #070a0e. 상단 sticky 헤더 (높이 60) +
 *    그 아래 2 단 그리드 grid-template-columns: 340px 1fr,
 *    max-width: 1440px 중앙 정렬."
 *
 * ★ 데이터 의존 분리 (의뢰서 §0):
 *   - 분석형 레이아웃 / 不知 상태 = 지금 구현 (실작동)
 *   - 사실/신뢰지표/근거 그래프 = 자리 + 예시 데이터 (★ v1)
 *   - 안심 문구 = ★ PO 결정 1: brief.totals 실데이터
 *   - 최근 recall = ★ PO 결정 2: v1 예시 / v2 endpoint
 *   - Q&A 합성 = ★ PO 결정 3: HEARTH 동일 endpoint (★ v1 = 자리)
 *
 * 옛 API 호출 path (recall, recallBriefing, fact mutations) = 상위 페이지
 * 에서 후속 라우팅으로 복원 가능 — REQ-011 단계는 새 디자인 화면 단독.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useHomeBrief } from '@/lib/useHomeBrief';
import {
  EXAMPLE_ENTITIES,
  EXAMPLE_PREDICATES,
  EXAMPLE_RECENT_RECALL,
  type RecallExampleQuery,
  type RecallExampleAnswerQuery,
} from '@/lib/recall-history';
import {
  isMeaningfulLabel,
  searchEntitySuggestions,
} from '@/lib/api';
import { entityTypeLabelKo } from '@/lib/displayNames';
import type { EntitySuggestion } from '@/lib/types';
import { RecallAnswerCard } from './RecallAnswerCard';
import { RecallEvidenceCard } from './RecallEvidenceCard';
import { RecallExampleBanner } from './RecallExampleBanner';
import { RecallMiniGraph } from './RecallMiniGraph';
import { RecallUnknownState } from './RecallUnknownState';

interface Props {
  spaceId: string;
}

const COLORS = {
  bg: '#070a0e',
  bgAside: '#070a0e',
  bgInput: '#0c1316',
  borderInput: '#1c2a2e',
  borderAside: '#111a1d',
  teal: '#2DD4BF',
  tealMint: '#5fe6d3',
  tealLight: '#9af0e0',
  textPrimary: '#f1f6f7',
  textBody: '#cbd6d8',
  textSecondary: '#7d8e92',
  textDim: '#566569',
  textFaint: '#4c5d61',
  textInk: '#06201c',
};

function pickActive(
  qid: string,
): RecallExampleQuery | undefined {
  return EXAMPLE_RECENT_RECALL.find((q) => q.qid === qid);
}

export function RecallView({ spaceId }: Props) {
  // ★ PO 결정 1 — brief.totals 실데이터 (안심 문구 + 不知 대비 카드).
  //
  // ★ M-Dogfood-C 가드 (PO 2026-07-01): 옛 코드는 `brief?.totals.facts` 였
  //   는데 mock 환경 일부에서 brief 가 `{}` (totals 미포함) 으로 도달하면
  //   `.facts` 가 undefined 에서 throw → 페이지 전체 runtime error. 추가
  //   `?.` 한 단계로 totals 미포함 케이스를 안전하게 처리. ★ 비즈니스 동작
  //   변화 0 (totals 있는 정상 응답은 그대로).
  const { brief } = useHomeBrief();
  const factsCount = brief?.totals?.facts ?? 0;
  const entitiesCount = brief?.totals?.entities ?? 0;
  const sourcesCount = brief?.totals?.sources ?? 0;

  // 활성 질의 = 시안 default q1 (SpaceX 답변).
  const [activeQid, setActiveQid] = useState<string>('q1');
  const [advanced, setAdvanced] = useState(false);
  const [showStatus, setShowStatus] = useState(true); // ★ 예시 배너 default ON.
  const [queryDraft, setQueryDraft] = useState<string>('');

  // ★ M-Dogfood-C (PO 2026-07-01) — 옛 SearchBar 의 자동완성을 신규 디자인
  //   에도 복원. 핵심은 lib/api::isMeaningfulLabel 회귀 가드 — 백엔드가 "."
  //   같은 무의미 라벨을 흘려보내도 frontend 가 filter 해 dropdown 에 0건.
  //   searchEntitySuggestions 자체가 isMeaningfulLabel 을 적용하므로 호출
  //   부는 결과만 받으면 자동으로 안전.
  const [suggestions, setSuggestions] = useState<EntitySuggestion[]>([]);
  const [showSuggest, setShowSuggest] = useState(false);
  const suggestSeqRef = useRef(0);

  const active = pickActive(activeQid);

  const pickRecent = useCallback((qid: string) => {
    setActiveQid(qid);
  }, []);

  // ★ Debounce 200ms — 옛 SearchBar 와 동일 호흡. seq guard 로 out-of-order
  //   응답 충돌 방지 (사용자가 빠르게 입력 시 마지막 query 의 결과만 반영).
  useEffect(() => {
    const trimmed = queryDraft.trim();
    if (!spaceId || !trimmed || !isMeaningfulLabel(trimmed)) {
      setSuggestions([]);
      return;
    }
    const seq = ++suggestSeqRef.current;
    const timer = window.setTimeout(() => {
      searchEntitySuggestions(trimmed, spaceId, 5)
        .then((items) => {
          if (suggestSeqRef.current !== seq) return;
          // Belt + suspenders: api.ts 가 이미 isMeaningfulLabel 로 필터링하지만
          // 한 번 더 컴포넌트에서 가드한다 (★ 회귀 가드 — api 회귀 시에도
          // dropdown 에 "." 표시 0).
          setSuggestions(
            items.filter((it) => isMeaningfulLabel(it.primary_label)),
          );
        })
        .catch(() => {
          if (suggestSeqRef.current !== seq) return;
          setSuggestions([]);
        });
    }, 200);
    return () => window.clearTimeout(timer);
  }, [queryDraft, spaceId]);

  const isUnknown = active?.state === 'unknown';
  const isKnown = active?.state === 'answer';

  return (
    <div
      data-testid="recall-redesign-root"
      data-recall-version="v2-req011"
      style={{ minHeight: '100vh', background: COLORS.bg }}
    >
      <div
        data-testid="recall-redesign-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '340px 1fr',
          alignItems: 'start',
          maxWidth: 1440,
          margin: '0 auto',
        }}
      >
        {/* LEFT — 질문 + 그래프 렌즈. */}
        <aside
          data-testid="recall-aside"
          style={{
            position: 'sticky',
            top: 60, // ★ AppShell 헤더 (60px) 아래.
            height: 'calc(100vh - 60px)',
            overflowY: 'auto',
            borderRight: `1px solid ${COLORS.borderAside}`,
            padding: '22px 20px 40px',
          }}
        >
          {/* RECALL 라벨. */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginBottom: 14,
            }}
          >
            <span
              className="font-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.16em',
                color: COLORS.tealMint,
              }}
            >
              RECALL
            </span>
            <span style={{ fontSize: 11, color: COLORS.textFaint }}>
              · 검증된 것만 답합니다
            </span>
          </div>

          {/* 질문 입력. */}
          <div style={{ position: 'relative', marginBottom: 8 }}>
            <input
              data-testid="recall-input"
              value={queryDraft}
              onChange={(e) => {
                setQueryDraft(e.target.value);
                setShowSuggest(true);
              }}
              placeholder="무엇이든 물어보세요"
              style={{
                width: '100%',
                height: 48,
                borderRadius: 12,
                background: COLORS.bgInput,
                border: `1px solid ${COLORS.borderInput}`,
                padding: '0 44px 0 14px',
                fontSize: 14,
                color: '#e6eef0',
                fontFamily: 'inherit',
                outline: 'none',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor =
                  'rgba(45,212,191,0.55)';
                e.currentTarget.style.boxShadow =
                  '0 0 0 3px rgba(45,212,191,0.1)';
                setShowSuggest(true);
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = COLORS.borderInput;
                e.currentTarget.style.boxShadow = 'none';
                // 약간 딜레이 — dropdown 내부 클릭이 onBlur 보다 먼저 실행되도록.
                window.setTimeout(() => setShowSuggest(false), 120);
              }}
            />
            <button
              type="button"
              data-testid="recall-submit"
              aria-label="질문 보내기"
              style={{
                position: 'absolute',
                right: 7,
                top: 7,
                width: 34,
                height: 34,
                borderRadius: 9,
                border: 'none',
                cursor: 'pointer',
                background: COLORS.teal,
                color: COLORS.textInk,
                fontSize: 15,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              →
            </button>
            {/* ★ M-Dogfood-C (PO 2026-07-01) — 자동완성 dropdown. 옛 SearchBar
             *  와 동일 형상. isMeaningfulLabel 가드가 api 와 컴포넌트 양쪽에
             *  걸려 있어 "." 가 dropdown 에 등장하면 회귀 (e2e:
             *  req011-dot-suggestion-regression.spec.ts). */}
            {showSuggest && suggestions.length > 0 ? (
              <ul
                data-testid="recall-suggest-dropdown"
                style={{
                  position: 'absolute',
                  top: 52,
                  left: 0,
                  right: 0,
                  margin: 0,
                  padding: '4px 0',
                  listStyle: 'none',
                  background: COLORS.bgInput,
                  border: `1px solid ${COLORS.borderInput}`,
                  borderRadius: 10,
                  boxShadow: '0 6px 18px rgba(0,0,0,0.45)',
                  maxHeight: 260,
                  overflowY: 'auto',
                  zIndex: 20,
                }}
              >
                {suggestions.map((s) => (
                  <li
                    key={s.entity_id}
                    data-testid="recall-suggest-item"
                    data-primary-label={s.primary_label}
                    onMouseDown={(e) => {
                      // ★ onMouseDown (not onClick) so the selection commits
                      //   BEFORE input.onBlur fires.
                      e.preventDefault();
                      setQueryDraft(s.primary_label);
                      setShowSuggest(false);
                    }}
                    style={{
                      padding: '7px 12px',
                      fontSize: 13,
                      color: COLORS.textBody,
                      cursor: 'pointer',
                    }}
                  >
                    {s.primary_label}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>

          {/* ★ 안심 문구 = brief.totals 실데이터 (PO 결정 1). */}
          <div
            data-testid="recall-scope-line"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              fontSize: 11.5,
              color: COLORS.textFaint,
              marginBottom: 22,
              paddingLeft: 2,
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: COLORS.teal,
                boxShadow: `0 0 7px ${COLORS.teal}`,
              }}
            />
            <span>
              <span data-testid="recall-scope-facts">{factsCount}</span> 사실 ·{' '}
              <span data-testid="recall-scope-entities">{entitiesCount}</span> 엔티티 ·{' '}
              <span data-testid="recall-scope-sources">{sourcesCount}</span> 출처 안에서 찾습니다
            </span>
          </div>

          {/* 최근 recall. */}
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.04em',
              color: '#5e7074',
              fontWeight: 600,
              marginBottom: 9,
            }}
          >
            최근 recall
          </div>
          <div
            data-testid="recall-recent-list"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 3,
              marginBottom: 24,
            }}
          >
            {EXAMPLE_RECENT_RECALL.map((rec) => {
              const isActiveRec = rec.qid === activeQid;
              const meta = `${rec.factsLabel} · ${rec.when}`;
              return (
                <button
                  key={rec.qid}
                  type="button"
                  data-testid={`recall-recent-${rec.qid}`}
                  data-active={isActiveRec ? 'true' : 'false'}
                  onClick={() => pickRecent(rec.qid)}
                  style={{
                    position: 'relative',
                    textAlign: 'left',
                    background: isActiveRec
                      ? 'rgba(45,212,191,0.07)'
                      : 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    padding: '9px 12px 9px 13px',
                    borderRadius: 9,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 3,
                    overflow: 'hidden',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    if (!isActiveRec) {
                      e.currentTarget.style.background = '#0e1619';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isActiveRec) {
                      e.currentTarget.style.background = 'transparent';
                    }
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      left: 0,
                      top: 6,
                      bottom: 6,
                      width: 2.5,
                      borderRadius: 2,
                      background: isActiveRec ? COLORS.teal : 'transparent',
                    }}
                  />
                  <span
                    style={{
                      position: 'relative',
                      fontSize: 13,
                      color: COLORS.textBody,
                      lineHeight: 1.35,
                    }}
                  >
                    {rec.q}
                  </span>
                  <span
                    className="font-mono"
                    style={{
                      position: 'relative',
                      fontSize: 10.5,
                      color: rec.metaColor,
                    }}
                  >
                    {meta}
                  </span>
                </button>
              );
            })}
          </div>

          {/* 그래프 렌즈 헤더. */}
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.04em',
              color: '#5e7074',
              fontWeight: 600,
              marginBottom: 11,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>그래프 렌즈</span>
            <span
              className="font-mono"
              style={{ fontSize: 9, color: '#3c4d51' }}
            >
              LENS
            </span>
          </div>

          {/* 대상 칩. */}
          <div
            style={{
              fontSize: 11.5,
              color: '#6a7c80',
              margin: '0 0 8px',
            }}
          >
            대상
          </div>
          <div
            data-testid="recall-facet-entities"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginBottom: 18,
            }}
          >
            {EXAMPLE_ENTITIES.map((e) => (
              <span
                key={e.name}
                data-testid="recall-facet-entity-chip"
                data-entity-name={e.name}
                data-entity-type={e.entity_type}
                data-entity-type-ko={entityTypeLabelKo(e.entity_type)}
                data-entity-count={e.count}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: '#bccacd',
                  background: '#0e1619',
                  border: '1px solid #18262a',
                  borderRadius: 8,
                  padding: '5px 9px',
                  cursor: 'pointer',
                }}
              >
                {e.name}
                {/* ★ M-Dogfood-C (PO 2026-07-01) — entity_type 한국어 배지.
                 *  facet 패널 회귀 시 박원갑이 "사람" 으로 분류되지 않으면
                 *  req011-recall-facet-regression spec 가 즉시 잡는다. */}
                <span
                  data-testid="recall-facet-entity-type"
                  style={{
                    fontSize: 10,
                    color: '#7d8e92',
                    border: '1px solid #18262a',
                    borderRadius: 4,
                    padding: '0 4px',
                  }}
                >
                  {entityTypeLabelKo(e.entity_type)}
                </span>
                <span
                  className="font-mono"
                  style={{ fontSize: 10, color: '#5a8f86' }}
                >
                  {e.count}
                </span>
              </span>
            ))}
          </div>

          {/* 관계 칩. */}
          <div
            style={{
              fontSize: 11.5,
              color: '#6a7c80',
              margin: '0 0 8px',
            }}
          >
            관계
          </div>
          <div
            data-testid="recall-facet-predicates"
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginBottom: 20,
            }}
          >
            {EXAMPLE_PREDICATES.map((p) => (
              <span
                key={p.name}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  color: '#9fb0b3',
                  background: 'transparent',
                  border: '1px solid #18262a',
                  borderRadius: 20,
                  padding: '4px 11px',
                  cursor: 'pointer',
                }}
              >
                {p.name}
                <span
                  className="font-mono"
                  style={{ fontSize: 10, color: COLORS.textDim }}
                >
                  {p.count}
                </span>
              </span>
            ))}
          </div>

          {/* 고급 토글. */}
          <button
            type="button"
            data-testid="recall-advanced-toggle"
            onClick={() => setAdvanced((v) => !v)}
            style={{
              width: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              background: 'none',
              border: 'none',
              borderTop: '1px solid #131e21',
              cursor: 'pointer',
              padding: '14px 2px 10px',
              color: COLORS.textSecondary,
              fontSize: 12,
              fontFamily: 'inherit',
            }}
          >
            <span>고급 — 정확도 · 기간</span>
            <span style={{ fontSize: 11, color: COLORS.textFaint }}>
              {advanced ? '닫기 ▲' : '열기 ▼'}
            </span>
          </button>
          {advanced && (
            <div
              data-testid="recall-advanced-panel"
              style={{ padding: '6px 2px 0' }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  fontSize: 12,
                  color: '#9fb0b3',
                  marginBottom: 9,
                }}
              >
                <span>정확도</span>
                <span
                  className="font-mono"
                  style={{ fontSize: 11, color: COLORS.tealMint }}
                >
                  균형
                </span>
              </div>
              <div
                style={{
                  position: 'relative',
                  height: 5,
                  borderRadius: 3,
                  background: '#16242a',
                  marginBottom: 6,
                }}
              >
                <div
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: '62%',
                    borderRadius: 3,
                    background:
                      'linear-gradient(90deg,#1d8a7c,#2DD4BF)',
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: '62%',
                    top: '50%',
                    width: 13,
                    height: 13,
                    borderRadius: '50%',
                    background: COLORS.teal,
                    transform: 'translate(-50%,-50%)',
                    boxShadow: '0 0 10px rgba(45,212,191,0.5)',
                  }}
                />
              </div>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontSize: 10.5,
                  color: COLORS.textFaint,
                  marginBottom: 18,
                }}
              >
                <span>넓게</span>
                <span>엄격하게</span>
              </div>
              <div
                style={{
                  fontSize: 12,
                  color: '#9fb0b3',
                  marginBottom: 8,
                }}
              >
                검증 기간
              </div>
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    color: COLORS.textInk,
                    background: COLORS.teal,
                    borderRadius: 8,
                    padding: '6px 11px',
                    cursor: 'pointer',
                  }}
                >
                  전체
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: '#9fb0b3',
                    background: '#0e1619',
                    border: '1px solid #18262a',
                    borderRadius: 8,
                    padding: '6px 11px',
                    cursor: 'pointer',
                  }}
                >
                  최근 7일
                </span>
                <span
                  style={{
                    fontSize: 12,
                    color: '#9fb0b3',
                    background: '#0e1619',
                    border: '1px solid #18262a',
                    borderRadius: 8,
                    padding: '6px 11px',
                    cursor: 'pointer',
                  }}
                >
                  이번 달
                </span>
              </div>
            </div>
          )}
        </aside>

        {/* RIGHT — 답변 / 不知. */}
        <main
          data-testid="recall-main"
          style={{
            padding: '30px 34px 60px',
            minHeight: 'calc(100vh - 60px)',
          }}
        >
          {isKnown && active && (
            <RecallKnownPanel
              query={active as RecallExampleAnswerQuery}
              showStatus={showStatus}
              onCloseBanner={() => setShowStatus(false)}
            />
          )}
          {isUnknown && active && (
            <RecallUnknownState
              queryText={active.q}
              factsCount={factsCount}
              entitiesCount={entitiesCount}
              onCapture={() => {
                /* ★ v1 = 자리만 (★ 후속 = /pending 또는 캡처 모달). */
              }}
              onAskAgain={() => {
                setQueryDraft('');
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

interface KnownPanelProps {
  query: RecallExampleAnswerQuery;
  showStatus: boolean;
  onCloseBanner: () => void;
}

function RecallKnownPanel({
  query,
  showStatus,
  onCloseBanner,
}: KnownPanelProps) {
  return (
    <div data-testid="recall-known-panel">
      {/* 질의 에코. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 6,
        }}
      >
        <span
          style={{
            marginTop: 4,
            width: 9,
            height: 9,
            borderRadius: '50%',
            flex: 'none',
            background: COLORS.teal,
            boxShadow: `0 0 9px ${COLORS.teal}`,
          }}
        />
        <h1
          data-testid="recall-query-echo"
          style={{
            margin: 0,
            fontSize: 27,
            fontWeight: 600,
            letterSpacing: '-0.02em',
            color: COLORS.textPrimary,
            lineHeight: 1.3,
          }}
        >
          {query.q}
        </h1>
      </div>
      <div
        className="font-mono"
        data-testid="recall-trust-meta"
        style={{
          fontSize: 11,
          letterSpacing: '0.04em',
          color: COLORS.textDim,
          margin: '0 0 14px',
          paddingLeft: 21,
        }}
      >
        검증된 사실 {query.conf.facts}건 · 출처 {query.conf.sources}곳 근거 ·{' '}
        {query.when}
      </div>

      <RecallExampleBanner show={showStatus} onToggle={onCloseBanner} />

      <RecallAnswerCard
        answerText={query.answer}
        chips={query.chips}
        confFacts={query.conf.facts}
      />

      {/* 하단 2 열 그리드: 근거 사실 + 근거 그래프. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 18,
          alignItems: 'start',
        }}
      >
        {/* 근거 사실. */}
        <section data-testid="recall-evidence-list">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 11,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.textBody,
              }}
            >
              근거 사실
            </span>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 7,
              }}
            >
              <span style={{ fontSize: 10.5, color: '#5e7074' }}>
                대상 클릭 → 상세뷰
              </span>
              <span
                className="font-mono"
                style={{
                  fontSize: 8.5,
                  letterSpacing: '0.06em',
                  color: COLORS.textDim,
                  border: '1px solid #1f2e2c',
                  borderRadius: 4,
                  padding: '1px 5px',
                }}
              >
                후속
              </span>
            </span>
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            {query.facts.map((f, i) => (
              <RecallEvidenceCard
                key={`${f.s}-${f.p}-${i}`}
                fact={f}
                onSubjectClick={() => {
                  /* ★ v1 = 자리만 (entity 상세뷰 = REQ-004 후속). */
                }}
              />
            ))}
          </div>
        </section>

        {/* 근거 그래프. */}
        <section data-testid="recall-evidence-graph">
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 11,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: COLORS.textBody,
              }}
            >
              근거 그래프
            </span>
            <span
              title="STELLAR 안정(REQ-004) 후 연결"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: 11,
                color: '#5e7074',
                cursor: 'default',
              }}
            >
              Stellar에서 펼쳐보기 →
              <span
                className="font-mono"
                style={{
                  fontSize: 8.5,
                  letterSpacing: '0.06em',
                  color: COLORS.textDim,
                  border: '1px solid #1f2e2c',
                  borderRadius: 4,
                  padding: '1px 5px',
                }}
              >
                후속
              </span>
            </span>
          </div>
          <RecallMiniGraph
            center={query.graph.center}
            nodes={query.graph.nodes}
          />
          {/* 경계 노트. */}
          <div
            data-testid="recall-boundary-note"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              marginTop: 13,
              background: 'rgba(20,15,11,0.5)',
              border: '1px solid #2a2018',
              borderRadius: 12,
              padding: '13px 15px',
            }}
          >
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 8,
                flex: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'rgba(185,138,106,0.12)',
                color: '#c79976',
                fontSize: 14,
              }}
            >
              ?
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#d3c4b4' }}>
                경계 —{' '}
                <b style={{ color: '#e6d3bf' }}>{query.boundary}</b>는 아직
                그래프 밖입니다
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: '#7a6a58',
                  marginTop: 2,
                }}
              >
                모르는 것을 아는 척하지 않습니다
              </div>
            </div>
            <button
              type="button"
              data-testid="recall-boundary-capture"
              style={{
                flex: 'none',
                fontSize: 12.5,
                color: COLORS.textInk,
                background: '#c79976',
                fontWeight: 600,
                border: 'none',
                borderRadius: 9,
                padding: '8px 13px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              캡처 →
            </button>
          </div>
        </section>
      </div>
    </div>
  );
}

// Re-export for tests that previously imported via the bare module path.
export default RecallView;
