import { describe, expect, it } from 'vitest';
import {
  CLAIM_NODE_COLOR,
  CLAIM_NODE_OPACITY,
  ENTITY_COLORS,
  STELLAR_ACCENT,
  colorForEntityType,
} from '@/lib/stellarColors';

describe('ENTITY_COLORS (★ REQ-013 PO 2026-07-02 palette)', () => {
  it('WHO subtype colors — person / org / group (kept from L2)', () => {
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

  // ★ REQ-013 (PO 2026-07-02): amber family 폐기, 6 상보 hue 로 재배정.
  //   resource=orange / concept=purple / task=rose / knowledge=cyan-blue /
  //   event=violet / metric=emerald. 각각 다른 hue 지대.
  it('★ REQ-013 WHAT 6 소분류 = 6 상보 hue (전부 구분)', () => {
    expect(ENTITY_COLORS.resource).toBe('#F97316');   // orange
    expect(ENTITY_COLORS.product).toBe('#F97316');    // resource alias
    expect(ENTITY_COLORS.concept).toBe('#A855F7');    // purple
    expect(ENTITY_COLORS.task).toBe('#F43F5E');       // rose
    expect(ENTITY_COLORS.knowledge).toBe('#06B6D4');  // cyan-blue
    expect(ENTITY_COLORS.event).toBe('#8B5CF6');      // violet
    expect(ENTITY_COLORS.metric).toBe('#10B981');     // emerald

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

  it('★ REQ-013 WHERE = red (옛 slate 폐기)', () => {
    expect(ENTITY_COLORS.place).toBe('#EF4444');
    expect(ENTITY_COLORS.location).toBe('#EF4444');
  });
});

describe('colorForEntityType (lookup helper)', () => {
  it('returns the mapped color when type is known', () => {
    expect(colorForEntityType('person')).toBe('#5EEAD4');
    expect(colorForEntityType('organization')).toBe('#22D3EE');
    expect(colorForEntityType('group')).toBe('#A3E635');
    expect(colorForEntityType('event')).toBe('#8B5CF6');
    expect(colorForEntityType('metric')).toBe('#10B981');
    expect(colorForEntityType('place')).toBe('#EF4444');
  });

  it('is case-insensitive', () => {
    expect(colorForEntityType('Person')).toBe('#5EEAD4');
    expect(colorForEntityType('ORGANIZATION')).toBe('#22D3EE');
    expect(colorForEntityType('EVENT')).toBe('#8B5CF6');
  });

  it('falls back to STELLAR_ACCENT for unknown / null / undefined', () => {
    expect(colorForEntityType(null)).toBe(STELLAR_ACCENT);
    expect(colorForEntityType(undefined)).toBe(STELLAR_ACCENT);
    expect(colorForEntityType('')).toBe(STELLAR_ACCENT);
    expect(colorForEntityType('unknown_type')).toBe(STELLAR_ACCENT);
  });
});

describe('CLAIM node color (★ REQ-013 PO 2026-07-02)', () => {
  it('★ REQ-013 — mid-gray, distinct from all entity hues', () => {
    // ★ 옛 '#CBD5E1' → 새 '#6B7280' (mid-gray). lime/teal 과 luminance 겹침 해소.
    expect(CLAIM_NODE_COLOR).toBe('#6B7280');
    expect(CLAIM_NODE_COLOR).not.toBe('#5EEAD4'); // WHO / person
    expect(CLAIM_NODE_COLOR).not.toBe('#F97316'); // WHAT / 자원
    expect(CLAIM_NODE_COLOR).not.toBe('#EF4444'); // WHERE / 장소
    expect(CLAIM_NODE_COLOR).not.toBe('#78716C'); // UNKNOWN stone
  });

  it('★ opacity is exactly 1 (PO 정정: 흐림 폐기)', () => {
    expect(CLAIM_NODE_OPACITY).toBe(1);
    const guard: 1 = CLAIM_NODE_OPACITY;
    expect(guard).toBe(1);
  });
});
