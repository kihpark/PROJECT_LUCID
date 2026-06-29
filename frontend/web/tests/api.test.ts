/**
 * ★ fix/entitycard-fact-count-and-dot-suggestion — api layer unit tests.
 *
 * The PO live report:
 *   "둘다(강재호/희망제작소) 검색하면 '.' 이라는 엔티티가 추천되고 검색되지 않는다"
 *
 * Root cause:
 *   backend/api/routes/entities.py::suggest_entities only drops empty `name`
 *   strings — a stray "." that upstream entity extraction kept as an entity
 *   sneaks through. `match_phrase_prefix` ranks it surprisingly high because
 *   IDF is low for a 1-char doc. Frontend renders `{s.primary_label}` verbatim
 *   in RecallView.tsx ~2388, so the user sees a "." item that returns nothing.
 *
 * Fix (frontend-only, per PO constraint):
 *   isMeaningfulLabel filters punctuation-only / whitespace-only labels at the
 *   api boundary so BOTH RecallView and FactCard get the protection.
 */
import { describe, expect, it } from 'vitest';
import { isMeaningfulLabel } from '@/lib/api';

describe('isMeaningfulLabel (★ fix/entitycard-fact-count-and-dot-suggestion)', () => {
  it('empty string → false', () => {
    expect(isMeaningfulLabel('')).toBe(false);
  });

  it('null / undefined → false', () => {
    expect(isMeaningfulLabel(null)).toBe(false);
    expect(isMeaningfulLabel(undefined)).toBe(false);
  });

  it('whitespace-only → false', () => {
    expect(isMeaningfulLabel(' ')).toBe(false);
    expect(isMeaningfulLabel('   ')).toBe(false);
    expect(isMeaningfulLabel('\t\n')).toBe(false);
  });

  it('★ punctuation-only ("." "..." ",;:") → false — the PO bug case', () => {
    expect(isMeaningfulLabel('.')).toBe(false);
    expect(isMeaningfulLabel('..')).toBe(false);
    expect(isMeaningfulLabel('...')).toBe(false);
    expect(isMeaningfulLabel(',;:')).toBe(false);
    expect(isMeaningfulLabel('()')).toBe(false);
    expect(isMeaningfulLabel('!?')).toBe(false);
  });

  it('Korean (hangul) → true', () => {
    expect(isMeaningfulLabel('강재호')).toBe(true);
    expect(isMeaningfulLabel('희망제작소')).toBe(true);
  });

  it('Latin alphabet → true', () => {
    expect(isMeaningfulLabel('Apple')).toBe(true);
    expect(isMeaningfulLabel('SpaceX')).toBe(true);
  });

  it('single digit "1" → true (could be a version / year / iteration)', () => {
    expect(isMeaningfulLabel('1')).toBe(true);
  });

  it('whitespace padding does not break a real label', () => {
    expect(isMeaningfulLabel('  강재호  ')).toBe(true);
  });

  it('mixed punctuation + at least one letter → true (e.g. "A.")', () => {
    // Real labels can carry trailing punctuation. As long as at least one
    // alphanumeric/CJK char is present the suggestion is meaningful.
    expect(isMeaningfulLabel('A.')).toBe(true);
    expect(isMeaningfulLabel('1.5')).toBe(true);
  });
});
