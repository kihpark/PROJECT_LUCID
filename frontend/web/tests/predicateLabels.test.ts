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

  // --- B-62 natural-spo-display: server-resolved label wins ---------------

  it('B-62 — server-resolved predicate_label wins over the curated map', () => {
    // The canonical key is in PREDICATE_LABELS (so it would normally map
    // to the Korean reading). When the server sends a richer English
    // gloss via predicate_label, the helper MUST return the gloss as-is.
    expect(predicateLabel('decided_to_remove', 'plans bond issuance')).toBe(
      'plans bond issuance',
    );
  });

  it('B-62 — predicate_label trumps even uncovered canonical inputs', () => {
    // Uncovered canonical AND a non-empty predicate_label: gloss wins.
    expect(predicateLabel('weird_unknown_predicate', 'discusses')).toBe(
      'discusses',
    );
  });

  it('B-62 — null predicate_label falls back to the curated map', () => {
    // Null means "server did not resolve a gloss" — fall back to the
    // legacy curated KO map.
    expect(predicateLabel('decided_to_remove', null)).toBe('철거하기로 결정한 것은');
  });

  it('B-62 — undefined predicate_label falls back to the curated map', () => {
    expect(predicateLabel('decided_to_remove', undefined)).toBe(
      '철거하기로 결정한 것은',
    );
  });

  it('B-62 — empty predicate_label falls back to the curated map', () => {
    // Empty string is treated as absent so the user does not see a blank
    // predicate cell.
    expect(predicateLabel('decided_to_remove', '')).toBe('철거하기로 결정한 것은');
  });

  it('B-62 — empty predicate_label + uncovered canonical echoes the canonical', () => {
    expect(predicateLabel('weird_unknown_predicate', '')).toBe(
      'weird_unknown_predicate',
    );
  });
});
