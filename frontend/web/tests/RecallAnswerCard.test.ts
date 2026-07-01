/**
 * ★ REQ-011-v2 dogfood-3 fix (PO 2026-07-01) — sufficient bar 4 단계 명세.
 *
 * PO 재확인 verbatim:
 *   "기준 정의(fact수? 출처다양성?) 명시하거나 제거. 정의 없는 지표 금지."
 *
 * 결정 = fact 수 기준 4 단계:
 *   · 1건 → 1/4 "부족"
 *   · 2-4건 → 2/4 "낮음"
 *   · 5-10건 → 3/4 "충분"
 *   · 11건+ → 4/4 "풍부"
 *
 * 본 스펙은 경계값 및 fallback 안정성을 단위 수준에서 못 박는다 (e2e 는
 * DOM 렌더까지 함께 검증).
 */
import { describe, it, expect } from 'vitest';
import { sufficiencyLevelForFacts } from '@/components/RecallAnswerCard';

describe('RecallAnswerCard — sufficiencyLevelForFacts (dogfood-3 fix)', () => {
  it('0건 → 부족 (안전지대: 검색 결과 없으면 카드 자체가 없지만 defensive)', () => {
    const r = sufficiencyLevelForFacts(0);
    expect(r.filled).toBe(1);
    expect(r.label).toBe('부족');
    expect(r.key).toBe('insufficient');
  });

  it('1건 → 부족 (1/4)', () => {
    const r = sufficiencyLevelForFacts(1);
    expect(r.filled).toBe(1);
    expect(r.label).toBe('부족');
    expect(r.key).toBe('insufficient');
  });

  it('2건 → 낮음 (2/4) — 경계 하한', () => {
    const r = sufficiencyLevelForFacts(2);
    expect(r.filled).toBe(2);
    expect(r.label).toBe('낮음');
    expect(r.key).toBe('low');
  });

  it('4건 → 낮음 (2/4) — 경계 상한', () => {
    const r = sufficiencyLevelForFacts(4);
    expect(r.filled).toBe(2);
    expect(r.label).toBe('낮음');
    expect(r.key).toBe('low');
  });

  it('5건 → 충분 (3/4) — 경계 하한', () => {
    const r = sufficiencyLevelForFacts(5);
    expect(r.filled).toBe(3);
    expect(r.label).toBe('충분');
    expect(r.key).toBe('sufficient');
  });

  it('10건 → 충분 (3/4) — 경계 상한', () => {
    const r = sufficiencyLevelForFacts(10);
    expect(r.filled).toBe(3);
    expect(r.label).toBe('충분');
    expect(r.key).toBe('sufficient');
  });

  it('11건 → 풍부 (4/4) — 경계 하한', () => {
    const r = sufficiencyLevelForFacts(11);
    expect(r.filled).toBe(4);
    expect(r.label).toBe('풍부');
    expect(r.key).toBe('abundant');
  });

  it('50건 → 풍부 (4/4)', () => {
    const r = sufficiencyLevelForFacts(50);
    expect(r.filled).toBe(4);
    expect(r.label).toBe('풍부');
    expect(r.key).toBe('abundant');
  });

  it('★ label 은 한국어만 (사용자 노출 영문 코드 0)', () => {
    for (const n of [1, 3, 7, 15]) {
      const r = sufficiencyLevelForFacts(n);
      expect(r.label).not.toMatch(/[A-Za-z]/);
    }
  });
});
