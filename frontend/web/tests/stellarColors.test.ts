import { describe, expect, it } from 'vitest';
import {
  CLAIM_NODE_COLOR,
  CLAIM_NODE_OPACITY,
  ENTITY_COLORS,
  STELLAR_ACCENT,
  colorForEntityType,
} from '@/lib/stellarColors';

describe('ENTITY_COLORS (M3-2b + ★ L2 PO 2026-06-29 mapping)', () => {
  // ★ L2 (PO 2026-06-29): WHO 묶음 안에서 person / organization / group
  //   의 색을 미세하게 분리. shape 채널은 stellarShapes 가 담당하지만 색도
  //   sub-channel 로 추가 — 정상 시각 사용자에게도 인지 부담을 더 줄인다.
  it('★ L2 — WHO subtype colors are distinct (person / org / group)', () => {
    expect(ENTITY_COLORS.person).toBe('#5EEAD4');
    expect(ENTITY_COLORS.organization).toBe('#22D3EE');
    expect(ENTITY_COLORS.group).toBe('#A3E635');
    const whoSet = new Set<string>([
      ENTITY_COLORS.person,
      ENTITY_COLORS.organization,
      ENTITY_COLORS.group,
    ]);
    expect(whoSet.size).toBe(3);
  });

  // ★ 2026-07-01 (PO verbatim: "자원/개념/행위/지식/사건/지표 전부 구분되게.
  //   일부만 태그 X. 형태·명도·라벨 전부 구분되게. 색 = amber family 유지").
  //   WHAT 6 소분류 = amber family 6 명도. resource = base #F5C36B,
  //   나머지는 amber-400/500/600/700/800 (더 어두워지는 순).
  it('★ WHAT 6 소분류 = amber family 6 명도 (전부 구분)', () => {
    expect(ENTITY_COLORS.resource).toBe('#F5C36B');   // amber-300 (base)
    expect(ENTITY_COLORS.product).toBe('#F5C36B');    // resource alias
    expect(ENTITY_COLORS.concept).toBe('#E5A94B');    // amber-400
    expect(ENTITY_COLORS.task).toBe('#D69235');       // amber-500
    expect(ENTITY_COLORS.knowledge).toBe('#C77B1F');  // amber-600
    expect(ENTITY_COLORS.event).toBe('#B86408');      // amber-700 (★ 옛 violet 폐기)
    expect(ENTITY_COLORS.metric).toBe('#A94D00');     // amber-800

    // 6 명도가 서로 다름 (product = resource alias 이므로 5 unique + 1 alias).
    const whatSet = new Set<string>([
      ENTITY_COLORS.resource,
      ENTITY_COLORS.concept,
      ENTITY_COLORS.task,
      ENTITY_COLORS.knowledge,
      ENTITY_COLORS.event,
      ENTITY_COLORS.metric,
    ]);
    expect(whatSet.size).toBe(6);
  });

  it('maps WHERE to slate/blue-gray', () => {
    expect(ENTITY_COLORS.place).toBe('#7A8CA3');
  });
});

describe('colorForEntityType (lookup helper)', () => {
  it('returns the mapped color when type is known', () => {
    expect(colorForEntityType('person')).toBe('#5EEAD4');
    expect(colorForEntityType('organization')).toBe('#22D3EE');
    expect(colorForEntityType('group')).toBe('#A3E635');
    // ★ 2026-07-01 — event 는 amber family 로 이동 (violet 폐기).
    expect(colorForEntityType('event')).toBe('#B86408');
    expect(colorForEntityType('metric')).toBe('#A94D00');
    expect(colorForEntityType('place')).toBe('#7A8CA3');
  });

  it('is case-insensitive', () => {
    expect(colorForEntityType('Person')).toBe('#5EEAD4');
    expect(colorForEntityType('ORGANIZATION')).toBe('#22D3EE');
    expect(colorForEntityType('EVENT')).toBe('#B86408');
  });

  it('falls back to STELLAR_ACCENT for unknown / null / undefined', () => {
    expect(colorForEntityType(null)).toBe(STELLAR_ACCENT);
    expect(colorForEntityType(undefined)).toBe(STELLAR_ACCENT);
    expect(colorForEntityType('')).toBe(STELLAR_ACCENT);
    expect(colorForEntityType('unknown_type')).toBe(STELLAR_ACCENT);
  });
});

describe('CLAIM node color (★ PO 2026-06-29: entity 와 시각 구분)', () => {
  it('★ NOT the WHO teal — distinct from any entity color', () => {
    // ★ 옛 '#5EEAD4' = WHO teal 과 동일 → 사용자 시각 구분 불가
    // ★ 새 light cool grey → channel-agnostic neutral
    expect(CLAIM_NODE_COLOR).toBe('#CBD5E1');
    expect(CLAIM_NODE_COLOR).not.toBe('#5EEAD4'); // ★ WHO 와 겹치면 안 됨
    expect(CLAIM_NODE_COLOR).not.toBe('#F5C36B'); // ★ WHAT / 자원
    expect(CLAIM_NODE_COLOR).not.toBe('#B86408'); // ★ WHAT / 사건 (amber-700)
    expect(CLAIM_NODE_COLOR).not.toBe('#7A8CA3'); // ★ WHERE
  });

  it('★ opacity is exactly 1 (PO 정정: 흐림 폐기)', () => {
    expect(CLAIM_NODE_OPACITY).toBe(1);
    // Compile-time check: the const is typed as the literal 1.
    const guard: 1 = CLAIM_NODE_OPACITY;
    expect(guard).toBe(1);
  });
});
