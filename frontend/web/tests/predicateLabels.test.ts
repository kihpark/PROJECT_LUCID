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

  // --- fix/recall-predicate-and-entity-type (PO 2026-06-26) ------------------
  // The OPL RELATED_TO fallback used to write predicate_label = "related to"
  // for every Korean speech-act predicate the deterministic mapper did
  // not cover ("답했다", "덧붙였다", "주장했다", …). On legacy facts
  // already in ES, that "related to" string is persisted and would
  // otherwise leak onto every recall card. The helper recovers the
  // verb from the canonical surface (the raw original_surface stored
  // on the fact's `predicate` field) so the card shows what the user
  // actually wrote.

  it('fix/recall-predicate — falls back to canonical when predicate_label is the legacy "related to"', () => {
    // PO repro: subject_uid="한성숙", predicate="답했다",
    // predicate_label="related to". The card MUST show "답했다", not
    // "related to".
    expect(predicateLabel('답했다', 'related to')).toBe('답했다');
  });

  it('fix/recall-predicate — "related to" fallback is case-insensitive', () => {
    expect(predicateLabel('답했다', 'Related To')).toBe('답했다');
    expect(predicateLabel('답했다', 'RELATED TO')).toBe('답했다');
  });

  it('fix/recall-predicate — "related to" fallback tolerates surrounding whitespace', () => {
    expect(predicateLabel('답했다', '  related to  ')).toBe('답했다');
  });

  it('fix/recall-predicate — covered canonical + "related to" prefers the curated KO map', () => {
    // Even when the legacy backend wrote predicate_label="related to",
    // a canonical predicate already in PREDICATE_LABELS gives a nicer
    // Korean reading than the raw English snake_case.
    expect(predicateLabel('decided_to_remove', 'related to')).toBe(
      '철거하기로 결정한 것은',
    );
  });

  it('fix/recall-predicate — any non-"related to" label still wins (regression guard for B-62)', () => {
    // The new guard must not over-trigger: a real server-resolved label
    // like "answers" / "states" still wins over the curated map.
    expect(predicateLabel('답했다', 'answers')).toBe('answers');
  });
});
