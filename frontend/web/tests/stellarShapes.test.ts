import { describe, expect, it } from 'vitest';
import {
  CLAIM_SHAPE,
  DEFAULT_SHAPE,
  ENTITY_SHAPES,
  shapeForEntityType,
} from '@/lib/stellarShapes';

describe('ENTITY_SHAPES (M3-2b color-blind-safe shape vocab)', () => {
  it('maps WHO types to circle', () => {
    expect(ENTITY_SHAPES.person).toBe('circle');
    expect(ENTITY_SHAPES.organization).toBe('circle');
    expect(ENTITY_SHAPES.group).toBe('circle');
  });

  it('maps WHAT types to roundedSquare', () => {
    expect(ENTITY_SHAPES.product).toBe('roundedSquare');
    expect(ENTITY_SHAPES.resource).toBe('roundedSquare');
    expect(ENTITY_SHAPES.concept).toBe('roundedSquare');
    expect(ENTITY_SHAPES.knowledge).toBe('roundedSquare');
  });

  it('maps WHAT-EVENT to diamond', () => {
    expect(ENTITY_SHAPES.event).toBe('diamond');
  });

  it('maps WHERE to pin', () => {
    expect(ENTITY_SHAPES.place).toBe('pin');
  });
});

describe('shapeForEntityType (lookup helper)', () => {
  it('returns the mapped shape', () => {
    expect(shapeForEntityType('person')).toBe('circle');
    expect(shapeForEntityType('product')).toBe('roundedSquare');
    expect(shapeForEntityType('event')).toBe('diamond');
    expect(shapeForEntityType('place')).toBe('pin');
  });

  it('is case-insensitive', () => {
    expect(shapeForEntityType('PERSON')).toBe('circle');
    expect(shapeForEntityType('Event')).toBe('diamond');
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
