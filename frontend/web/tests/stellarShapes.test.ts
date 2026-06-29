import { describe, expect, it } from 'vitest';
import {
  CLAIM_SHAPE,
  DEFAULT_SHAPE,
  ENTITY_SHAPES,
  SHAPE_LABEL,
  shapeForEntityType,
} from '@/lib/stellarShapes';

describe('ENTITY_SHAPES (M3-2b + ★ L2 PO 2026-06-29 shape vocab)', () => {
  // ★ L2 (PO 2026-06-29): WHO 묶음 안에서 person / organization / group
  //   을 형태로 분리. 모두 sphere/cube/diamond 로 시각 구분 가능.
  it('★ L2 — distinguishes WHO subtypes by shape (person / org / group)', () => {
    expect(ENTITY_SHAPES.person).toBe('sphere');
    expect(ENTITY_SHAPES.organization).toBe('cube');
    expect(ENTITY_SHAPES.group).toBe('diamond');
    // 세 형태가 서로 다름을 명시.
    const whoShapes = new Set([
      ENTITY_SHAPES.person,
      ENTITY_SHAPES.organization,
      ENTITY_SHAPES.group,
    ]);
    expect(whoShapes.size).toBe(3);
  });

  it('maps WHAT types to sphere (★ L2 — default WHAT 묶음)', () => {
    expect(ENTITY_SHAPES.product).toBe('sphere');
    expect(ENTITY_SHAPES.resource).toBe('sphere');
    expect(ENTITY_SHAPES.concept).toBe('sphere');
    expect(ENTITY_SHAPES.knowledge).toBe('sphere');
  });

  it('maps EVENT to roundedSquare', () => {
    expect(ENTITY_SHAPES.event).toBe('roundedSquare');
  });

  it('maps WHERE to pin', () => {
    expect(ENTITY_SHAPES.place).toBe('pin');
  });
});

describe('shapeForEntityType (lookup helper)', () => {
  it('returns the mapped shape', () => {
    expect(shapeForEntityType('person')).toBe('sphere');
    expect(shapeForEntityType('organization')).toBe('cube');
    expect(shapeForEntityType('group')).toBe('diamond');
    expect(shapeForEntityType('event')).toBe('roundedSquare');
    expect(shapeForEntityType('place')).toBe('pin');
  });

  it('is case-insensitive', () => {
    expect(shapeForEntityType('PERSON')).toBe('sphere');
    expect(shapeForEntityType('Organization')).toBe('cube');
    expect(shapeForEntityType('Group')).toBe('diamond');
  });

  it('falls back to DEFAULT_SHAPE for unknown / null', () => {
    expect(shapeForEntityType(null)).toBe(DEFAULT_SHAPE);
    expect(shapeForEntityType(undefined)).toBe(DEFAULT_SHAPE);
    expect(shapeForEntityType('zzz')).toBe(DEFAULT_SHAPE);
  });
});

describe('CLAIM_SHAPE (작은 점 — 단 또렷)', () => {
  it('is "dot" — the small-but-clear marker', () => {
    expect(CLAIM_SHAPE).toBe('dot');
  });
});

describe('SHAPE_LABEL (★ L1/L2 — legend swatch character vocabulary)', () => {
  it('maps every shape variant to a non-empty label', () => {
    expect(SHAPE_LABEL.sphere.length).toBeGreaterThan(0);
    expect(SHAPE_LABEL.cube.length).toBeGreaterThan(0);
    expect(SHAPE_LABEL.diamond.length).toBeGreaterThan(0);
    expect(SHAPE_LABEL.roundedSquare.length).toBeGreaterThan(0);
    expect(SHAPE_LABEL.pin.length).toBeGreaterThan(0);
    expect(SHAPE_LABEL.dot.length).toBeGreaterThan(0);
  });
});
