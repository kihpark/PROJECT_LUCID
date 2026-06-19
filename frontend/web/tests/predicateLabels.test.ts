import { describe, it, expect } from 'vitest';
import { PREDICATE_LABELS, predicateLabel } from '@/lib/predicateLabels';

describe('predicateLabel — display layer (B-56)', () => {
  it('returns the Korean label for a covered predicate', () => {
    // The seed map covers this predicate (verified against B-56 live
    // diagnosis — `decided_to_remove` is in the lucid_facts head).
    expect(predicateLabel('decided_to_remove')).toBe('철거하기로 결정한 것은');
  });

  it('falls back to the canonical English string for an uncovered predicate', () => {
    // No magic, no empty string — uncovered renders verbatim.
    expect(predicateLabel('weird_unknown_predicate')).toBe('weird_unknown_predicate');
  });

  it('returns the empty string as-is', () => {
    // Defensive: empty input must not throw and must not be padded.
    expect(predicateLabel('')).toBe('');
  });

  it('covers at least the top 10 live predicates observed in the B-56 diagnosis', () => {
    // Hardcoded from the actual ES aggregation run during B-56 against
    // lucid_facts. If any of these keys is dropped from the seed map,
    // this assertion catches the regression on the user's most-visible
    // predicates.
    const top10FromDiagnosis = [
      'operates',
      'trading_value',
      'is_examining',
      'secured_allocation',
      'allocated_shares_to',
      'allocation_received',
      'allocation_status',
      'allocation_value',
      'allows',
      'can_add_stock_timing',
    ];
    for (const key of top10FromDiagnosis) {
      expect(PREDICATE_LABELS[key], `${key} should be in PREDICATE_LABELS`)
        .toBeDefined();
    }
  });

  it('every entry in the seed map has a non-empty Korean label', () => {
    const entries = Object.entries(PREDICATE_LABELS);
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, entry] of entries) {
      expect(typeof entry.ko, `${key}.ko should be a string`).toBe('string');
      expect(entry.ko.length, `${key}.ko must be non-empty`).toBeGreaterThan(0);
    }
  });
});
