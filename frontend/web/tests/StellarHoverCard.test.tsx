/**
 * M3-2d StellarHoverCard tests.
 *
 * Single SPO card. fact_type 별 render 분기 + CLAIM 양태 표시 +
 * 단일 카드 회귀 가드 (★ 중복 오버레이 0).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  StellarHoverCard,
  classifyClaimModality,
  computeHoverCardPosition,
} from '@/components/StellarHoverCard';
import type { StellarNode } from '@/lib/syntheticGraph';

const POS = { x: 100, y: 100 };

function makeNode(overrides: Partial<StellarNode> = {}): StellarNode {
  return {
    id: 't-1',
    label: 'L',
    cluster: 0,
    weight: 1,
    x: 0,
    y: 0,
    z: 0,
    subject: '주체',
    predicate: 'supports',
    object: '객체',
    ...overrides,
  };
}

// fix/stellar-ux-self-audit U3 — viewport-aware position clamp policy.
describe('computeHoverCardPosition (★ U3 HoverCard 위치 가드)', () => {
  const VW = { w: 1920, h: 1080 };
  // Default card-size reservation in the helper.
  const CARD = { w: 360, h: 240 };

  it('offsets by +20px from cursor when there is room', () => {
    const { left, top } = computeHoverCardPosition({ x: 100, y: 200 }, VW, CARD);
    expect(left).toBe(120);
    expect(top).toBe(220);
  });

  it('clamps to vw - cardWidth when cursor is near the right edge', () => {
    const { left } = computeHoverCardPosition({ x: 1900, y: 100 }, VW, CARD);
    expect(left).toBeLessThanOrEqual(VW.w - CARD.w);
    expect(left).toBe(VW.w - CARD.w);
  });

  it('clamps to vh - cardHeight when cursor is near the bottom edge', () => {
    const { top } = computeHoverCardPosition({ x: 100, y: 1060 }, VW, CARD);
    expect(top).toBeLessThanOrEqual(VW.h - CARD.h);
    expect(top).toBe(VW.h - CARD.h);
  });

  it('never returns negative left/top (top-left corner safety)', () => {
    const { left, top } = computeHoverCardPosition(
      { x: -100, y: -100 },
      VW,
      CARD,
    );
    expect(left).toBeGreaterThanOrEqual(0);
    expect(top).toBeGreaterThanOrEqual(0);
  });

  // ★ U3 — pointerEvents: 'none' so the card never intercepts mouse events.
  // Without this, the card could land under the cursor and cause mouseleave
  // on the underlying node, ending the hover state and flickering the card.
  it('renders the card with pointerEvents: none (hover-flicker guard)', () => {
    const fact = makeNode();
    render(<StellarHoverCard fact={fact} position={POS} />);
    const card = screen.getByTestId('stellar-hover-card') as HTMLElement;
    // jsdom does not run the layout engine; check the inline style directly.
    expect(card.style.pointerEvents).toBe('none');
  });
});

describe('classifyClaimModality (★ 데이터모델 v2)', () => {
  it('returns "assertion" for 단정 keywords', () => {
    expect(classifyClaimModality('assertion')).toBe('assertion');
    expect(classifyClaimModality('Assert')).toBe('assertion');
  });
  it('returns "judgment" for 판단 keywords', () => {
    expect(classifyClaimModality('judgment')).toBe('judgment');
    expect(classifyClaimModality('judgement')).toBe('judgment');
  });
  it('returns "opinion" for 의견 keywords', () => {
    expect(classifyClaimModality('opinion')).toBe('opinion');
  });
  it('returns null for natural-language verbs (no modality binding)', () => {
    expect(classifyClaimModality('발표했다')).toBeNull();
    expect(classifyClaimModality(null)).toBeNull();
    expect(classifyClaimModality('')).toBeNull();
  });
});

describe('StellarHoverCard — fact_type render branches', () => {
  it('ACTION fact → SPO + roles', () => {
    const fact = makeNode({
      fact_type: 'action',
      subject: '한국은행',
      predicate: 'is_examining',
      object: '환율 변동성',
      roles: { recipient: '시장', location: '서울' },
      as_of: '2026-06-28',
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-fact-type')).toBe('action');
    expect(screen.getByTestId('stellar-hover-card-subject').textContent).toBe('한국은행');
    expect(screen.getByTestId('stellar-hover-card-predicate').textContent).toContain('검토 중인 것은');
    expect(screen.getByTestId('stellar-hover-card-object').textContent).toBe('환율 변동성');
    const rolesText = screen.getByTestId('stellar-hover-card-roles').textContent ?? '';
    expect(rolesText).toContain('recipient: 시장');
    expect(rolesText).toContain('location: 서울');
    expect(screen.getByTestId('stellar-hover-card-foot').textContent).toContain('2026-06-28');
  });

  it('CLAIM fact → speaker + speech_act (자연어 동사) + content + related', () => {
    const fact = makeNode({
      fact_type: 'claim',
      subject: '한국은행',
      speaker_label: '한국은행',
      speech_act: '발표했다',
      content_claim: '환율 변동성 상승 가능성',
      related_entity_uids: ['e1', 'e2'],
      related_entity_labels: ['미국 연준', '환율위원회'],
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-fact-type')).toBe('claim');
    // '발표했다' is not one of the v2 modality keywords → no modality binding.
    expect(card.getAttribute('data-modality')).toBe('');
    expect(screen.getByTestId('stellar-hover-card-speaker').textContent).toBe('한국은행');
    expect(screen.getByTestId('stellar-hover-card-speech-act').textContent).toBe('발표했다');
    expect(screen.getByTestId('stellar-hover-card-content').textContent).toContain(
      '환율 변동성 상승 가능성',
    );
    const related = screen.getByTestId('stellar-hover-card-related').textContent ?? '';
    expect(related).toContain('미국 연준');
    expect(related).toContain('환율위원회');
  });
});

describe('CLAIM 양태 (modality) 3종 — ★ 데이터모델 v2', () => {
  it('assertion → 양태 라벨 "단정"', () => {
    const fact = makeNode({
      fact_type: 'claim',
      speaker_label: 'A',
      speech_act: 'assertion',
      content_claim: 'X 이다',
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-modality')).toBe('assertion');
    const badge = screen.getByTestId('stellar-hover-card-badge');
    expect(badge.textContent).toContain('단정');
    expect(screen.getByTestId('stellar-hover-card-speech-act').textContent).toBe('단정');
  });

  it('judgment → 양태 라벨 "판단"', () => {
    const fact = makeNode({
      fact_type: 'claim',
      speaker_label: 'A',
      speech_act: 'judgment',
      content_claim: 'X 가 옳다',
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-modality')).toBe('judgment');
    expect(screen.getByTestId('stellar-hover-card-badge').textContent).toContain('판단');
    expect(screen.getByTestId('stellar-hover-card-speech-act').textContent).toBe('판단');
  });

  it('opinion → 양태 라벨 "의견"', () => {
    const fact = makeNode({
      fact_type: 'claim',
      speaker_label: 'A',
      speech_act: 'opinion',
      content_claim: 'X 가 좋다',
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-modality')).toBe('opinion');
    expect(screen.getByTestId('stellar-hover-card-badge').textContent).toContain('의견');
    expect(screen.getByTestId('stellar-hover-card-speech-act').textContent).toBe('의견');
  });
});

describe('MEASUREMENT fact', () => {
  it('entity + metric = value unit + as_of foot', () => {
    const fact = makeNode({
      fact_type: 'measurement',
      subject: 'Meta',
      metric: 'MAU',
      measurement_value: 800_000_000,
      measurement_unit: '명',
      as_of: '2026-03',
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-fact-type')).toBe('measurement');
    expect(screen.getByTestId('stellar-hover-card-entity').textContent).toBe('Meta');
    const m = screen.getByTestId('stellar-hover-card-metric').textContent ?? '';
    expect(m).toContain('MAU');
    expect(m).toContain('800000000');
    expect(m).toContain('명');
    expect(screen.getByTestId('stellar-hover-card-foot').textContent).toContain('2026-03');
  });
});

describe('★ 단일 카드 (★ 중복 오버레이 0)', () => {
  it('only one card mounts; no other hover label / tooltip', () => {
    const fact = makeNode({ fact_type: 'action', subject: 'A', object: 'B' });
    const { container } = render(<StellarHoverCard fact={fact} position={POS} />);
    // Exactly one root card.
    const cards = container.querySelectorAll('[data-testid="stellar-hover-card"]');
    expect(cards.length).toBe(1);
    // The OLD hover tooltip testid must not appear.
    expect(container.querySelector('[data-testid="stellar-hover-tooltip"]')).toBeNull();
    // No other "nodeLabel" overlay element.
    expect(container.querySelector('[data-testid="stellar-node-label"]')).toBeNull();
  });
});

// fix/stellar-cards-entity-node-compat (2026-06-29) — STELLAR v2 데이터 모델
// 에서 노드는 (1) entity (kind='entity') 또는 (2) claim (kind='claim') 중
// 하나다. 호버 카드는 node.kind 가 있으면 그 v2 모양을 직접 렌더해야 한다.
describe('v2 entity-node branch (★ fix/stellar-cards-entity-node-compat)', () => {
  it('entity node renders name + entity_type + degree meta', () => {
    const fact = makeNode({
      id: 'uid-jaeho',
      kind: 'entity',
      label: '강재호',
      entity_type: 'person',
      degree: 3,
      // v2 entity 노드는 subject 가 비어 있을 수 있음 — '(주체 없음)' 으로
      // 떨어지면 안 된다.
      subject: undefined,
      predicate: undefined,
      object: undefined,
    });
    const { container } = render(
      <StellarHoverCard fact={fact} position={POS} />,
    );
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-fact-type')).toBe('entity');
    expect(screen.getByTestId('stellar-hover-card-entity-name').textContent).toBe(
      '강재호',
    );
    const meta = screen.getByTestId('stellar-hover-card-entity-meta').textContent ?? '';
    expect(meta).toContain('person');
    expect(meta).toContain('연결 3');
    // ★ regression guard — v2 entity 카드에 '(주체 없음)' 잔재가 없어야 한다.
    expect(container.textContent ?? '').not.toContain('(주체 없음)');
  });

  it('claim node renders speaker + speech_act (modality) + content', () => {
    const fact = makeNode({
      id: 'claim-1',
      kind: 'claim',
      label: '모스 탄 의 단정',
      speaker_label: '모스 탄',
      speech_act: 'assertion',
      content_claim: 'X 이다',
      // v2 claim 노드는 subject 가 비어 있을 수 있음.
      subject: undefined,
      predicate: undefined,
      object: undefined,
    });
    const { container } = render(
      <StellarHoverCard fact={fact} position={POS} />,
    );
    const card = screen.getByTestId('stellar-hover-card');
    expect(card.getAttribute('data-fact-type')).toBe('claim');
    expect(card.getAttribute('data-modality')).toBe('assertion');
    expect(screen.getByTestId('stellar-hover-card-speaker').textContent).toBe(
      '모스 탄',
    );
    expect(screen.getByTestId('stellar-hover-card-speech-act').textContent).toBe(
      '단정',
    );
    expect(screen.getByTestId('stellar-hover-card-content').textContent).toContain(
      'X 이다',
    );
    // ★ regression guard — '(주체 없음)' 노출 0.
    expect(container.textContent ?? '').not.toContain('(주체 없음)');
  });

  it('★ regression guard: no "(주체 없음)" 문자열 in v2 entity card', () => {
    const fact = makeNode({
      id: 'uid-x',
      kind: 'entity',
      label: '',
      entity_type: 'organization',
      degree: 0,
      subject: undefined,
      predicate: undefined,
      object: undefined,
    });
    const { container } = render(
      <StellarHoverCard fact={fact} position={POS} />,
    );
    expect(container.textContent ?? '').not.toContain('(주체 없음)');
  });
});

// ★ fix/hover-full-content-no-deobogi (PO 2026-06-29):
//   옛 V3b 의 '더 보기' hint = UX 거짓 약속 (사용자가 hover 위치 마우스
//   가면 tooltip 사라져 클릭 불가능). hover 도 full content 표시 + hint 제거.
describe('claim hover full content (★ no 더 보기 — PO 2026-06-29)', () => {
  it('claim hover card shows FULL content (no truncate)', () => {
    const longText = 'X'.repeat(150);
    const fact = makeNode({
      fact_type: 'claim',
      speaker_label: 'A',
      speech_act: 'assertion',
      content_claim: longText,
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const content = screen.getByTestId('stellar-hover-card-content');
    expect(content.textContent).toContain(longText);
    // ★ "더 보기" hint 0 (★ 거짓 약속 제거)
    expect(screen.queryByTestId('stellar-hover-card-more-hint')).toBeNull();
    expect(content.textContent).not.toContain('더 보기');
  });

  it('v2 claim node also shows FULL content', () => {
    const longText = 'Y'.repeat(150);
    const fact = makeNode({
      id: 'claim-1',
      kind: 'claim',
      speaker_label: 'A',
      speech_act: 'assertion',
      content_claim: longText,
      subject: undefined,
      predicate: undefined,
      object: undefined,
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const content = screen.getByTestId('stellar-hover-card-content');
    expect(content.textContent).toContain(longText);
    expect(screen.queryByTestId('stellar-hover-card-more-hint')).toBeNull();
  });
});

// ★ V4 (hover/click 일관성 위반 클래스, 2026-06-29) — fact_counts unified.
import { StellarEntityCard } from '@/components/StellarEntityCard';

describe('entity hover fact_counts (★ V4 — hover/click 일관성)', () => {
  function makeEntityNode(overrides: Partial<StellarNode> = {}): StellarNode {
    return {
      id: 'uid-X',
      label: 'X',
      cluster: 0,
      weight: 1,
      kind: 'entity',
      entity_type: 'organization',
      subject: undefined,
      predicate: undefined,
      object: undefined,
      ...overrides,
    };
  }

  it('entity hover with fact_counts → renders 행동/발언/수치 breakdown', () => {
    const fact = makeEntityNode({
      fact_counts: { action: 2, claim: 3, measurement: 1 },
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    const block = screen.getByTestId('stellar-hover-card-entity-fact-counts');
    expect(block.textContent ?? '').toContain('행동 2');
    expect(block.textContent ?? '').toContain('발언 3');
    expect(block.textContent ?? '').toContain('수치 1');
  });

  it('entity hover without fact_counts → falls back to degree + measurements (regression)', () => {
    const fact = makeEntityNode({
      fact_counts: undefined,
      degree: 4,
    });
    render(<StellarHoverCard fact={fact} position={POS} />);
    expect(screen.queryByTestId('stellar-hover-card-entity-fact-counts')).toBeNull();
    const meta = screen.getByTestId('stellar-hover-card-entity-meta').textContent ?? '';
    expect(meta).toContain('연결 4');
  });

  it('★ consistency guard: hover + click read SAME fact_counts → identical numbers', () => {
    const entity = makeEntityNode({
      id: 'uid-Org',
      label: 'Org-1',
      fact_counts: { action: 7, claim: 11, measurement: 5 },
    });
    // Hover render.
    const hover = render(<StellarHoverCard fact={entity} position={POS} />);
    const hoverBlock = hover.getByTestId('stellar-hover-card-entity-fact-counts').textContent ?? '';
    expect(hoverBlock).toContain('행동 7');
    expect(hoverBlock).toContain('발언 11');
    expect(hoverBlock).toContain('수치 5');
    hover.unmount();
    // Click-card render.
    const click = render(
      <StellarEntityCard entity={entity} allFacts={[]} onClose={() => {}} />,
    );
    expect(
      click.getByTestId('stellar-entity-card-count-action').textContent,
    ).toContain('7건');
    expect(
      click.getByTestId('stellar-entity-card-count-claim').textContent,
    ).toContain('11건');
    expect(
      click.getByTestId('stellar-entity-card-count-measurement').textContent,
    ).toContain('5건');
  });
});
