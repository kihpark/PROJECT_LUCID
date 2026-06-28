import { describe, expect, it } from 'vitest';
import {
  CLAIM_NODE_COLOR,
  CLAIM_NODE_OPACITY,
  ENTITY_COLORS,
  STELLAR_ACCENT,
  colorForEntityType,
} from '@/lib/stellarColors';

describe('ENTITY_COLORS (M3-2b mapping)', () => {
  it('maps WHO entity types to teal', () => {
    expect(ENTITY_COLORS.person).toBe('#5EEAD4');
    expect(ENTITY_COLORS.organization).toBe('#5EEAD4');
    expect(ENTITY_COLORS.group).toBe('#5EEAD4');
  });

  it('maps WHAT entity types to amber/gold', () => {
    expect(ENTITY_COLORS.product).toBe('#F5C36B');
    expect(ENTITY_COLORS.resource).toBe('#F5C36B');
    expect(ENTITY_COLORS.concept).toBe('#F5C36B');
    expect(ENTITY_COLORS.knowledge).toBe('#F5C36B');
  });

  it('maps WHAT-EVENT to violet', () => {
    expect(ENTITY_COLORS.event).toBe('#A78BFA');
  });

  it('maps WHERE to slate/blue-gray', () => {
    expect(ENTITY_COLORS.place).toBe('#7A8CA3');
  });
});

describe('colorForEntityType (lookup helper)', () => {
  it('returns the mapped color when type is known', () => {
    expect(colorForEntityType('person')).toBe('#5EEAD4');
    expect(colorForEntityType('event')).toBe('#A78BFA');
    expect(colorForEntityType('place')).toBe('#7A8CA3');
  });

  it('is case-insensitive', () => {
    expect(colorForEntityType('Person')).toBe('#5EEAD4');
    expect(colorForEntityType('EVENT')).toBe('#A78BFA');
  });

  it('falls back to STELLAR_ACCENT for unknown / null / undefined', () => {
    expect(colorForEntityType(null)).toBe(STELLAR_ACCENT);
    expect(colorForEntityType(undefined)).toBe(STELLAR_ACCENT);
    expect(colorForEntityType('')).toBe(STELLAR_ACCENT);
    expect(colorForEntityType('unknown_type')).toBe(STELLAR_ACCENT);
  });
});

describe('CLAIM node color (★ PO 정정: 또렷, 흐림 X)', () => {
  it('uses the teal family, NOT a dim grey', () => {
    expect(CLAIM_NODE_COLOR).toBe('#5EEAD4');
    // ★ guard: must not be a grey de-emphasis token.
    expect(CLAIM_NODE_COLOR).not.toMatch(/^#?[6-9a-f]{6}$/i);
  });

  it('★ opacity is exactly 1 (PO 정정: 흐림 폐기)', () => {
    expect(CLAIM_NODE_OPACITY).toBe(1);
    // Compile-time check: the const is typed as the literal 1.
    const guard: 1 = CLAIM_NODE_OPACITY;
    expect(guard).toBe(1);
  });
});
