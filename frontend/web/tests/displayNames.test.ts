/**
 * feat/i18n-ko-display-names-separation (★ PO 2026-06-30) — displayNames
 * helper 의 contract 단위 테스트.
 *
 * ★ 검증:
 *   1. SECTION_LABELS_KO 매핑 = PO 의뢰서 verbatim (HEARTH/HARVEST/DECIDE/
 *      RECALL/STELLAR/LEDGER → 홈/수집/검증/검색/지식그래프/기록).
 *   2. sectionLabelKo() = case-insensitive 입력, unknown 입력 = 입력 그대로.
 *   3. entityTypeLabelKo() = null/empty/unknown → "기타".
 *   4. ★ 코드네임 → 한국어 매핑 양방향 안정 (베타 i18n layer 확장 안전).
 */
import { describe, it, expect } from 'vitest';
import {
  SECTION_LABELS_KO,
  ENTITY_TYPE_LABELS_KO,
  LEGEND_BUCKET_LABELS_KO,
  sectionLabelKo,
  entityTypeLabelKo,
  legendBucketLabelKo,
  factKindLabelKo,
} from '@/lib/displayNames';

describe('displayNames — SECTION_LABELS_KO (PO 2026-06-30 의뢰서 verbatim)', () => {
  it('HEARTH → 홈', () => {
    expect(SECTION_LABELS_KO.HEARTH).toBe('홈');
  });
  it('HARVEST → 수집', () => {
    expect(SECTION_LABELS_KO.HARVEST).toBe('수집');
  });
  it('DECIDE → 검증', () => {
    expect(SECTION_LABELS_KO.DECIDE).toBe('검증');
  });
  it('RECALL → 검색', () => {
    expect(SECTION_LABELS_KO.RECALL).toBe('검색');
  });
  it('STELLAR → 지식그래프', () => {
    expect(SECTION_LABELS_KO.STELLAR).toBe('지식그래프');
  });
  it('LEDGER → 기록', () => {
    expect(SECTION_LABELS_KO.LEDGER).toBe('기록');
  });
});

describe('displayNames — sectionLabelKo helper', () => {
  it('uppercase + lowercase 모두 동일 결과 (case-insensitive)', () => {
    expect(sectionLabelKo('HEARTH')).toBe('홈');
    expect(sectionLabelKo('hearth')).toBe('홈');
    expect(sectionLabelKo('Hearth')).toBe('홈');
  });
  it('알 수 없는 코드 → 입력 그대로 (fallback)', () => {
    expect(sectionLabelKo('UNKNOWN_SECTION')).toBe('UNKNOWN_SECTION');
  });
  it('★ 사용자 노출 영문 코드 0 — 매핑된 6 코드는 영문 token 반환 X', () => {
    const koLabels = ['HEARTH', 'HARVEST', 'DECIDE', 'RECALL', 'STELLAR', 'LEDGER']
      .map((c) => sectionLabelKo(c));
    for (const label of koLabels) {
      expect(label).not.toMatch(/[A-Z]/);
    }
  });
});

describe('displayNames — entityTypeLabelKo helper', () => {
  it('person/organization/group 핵심 매핑', () => {
    expect(entityTypeLabelKo('person')).toBe('사람');
    expect(entityTypeLabelKo('organization')).toBe('조직');
    expect(entityTypeLabelKo('group')).toBe('그룹');
  });
  it('what 묶음 (resource/product/concept/knowledge)', () => {
    expect(entityTypeLabelKo('resource')).toBe('자원');
    expect(entityTypeLabelKo('product')).toBe('제품');
    expect(entityTypeLabelKo('concept')).toBe('개념');
    expect(entityTypeLabelKo('knowledge')).toBe('지식');
  });
  it('null / 빈문자열 / unknown → "기타"', () => {
    expect(entityTypeLabelKo(null)).toBe('기타');
    expect(entityTypeLabelKo(undefined)).toBe('기타');
    expect(entityTypeLabelKo('')).toBe('기타');
    expect(entityTypeLabelKo('완전히_새로운_타입')).toBe('기타');
  });
  it('case-insensitive', () => {
    expect(entityTypeLabelKo('PERSON')).toBe('사람');
    expect(entityTypeLabelKo('Person')).toBe('사람');
  });
});

describe('displayNames — legendBucketLabelKo helper', () => {
  it('LEGEND bucket 6종 매핑', () => {
    expect(legendBucketLabelKo('WHO')).toBe('인물');
    expect(legendBucketLabelKo('WHAT')).toBe('대상');
    expect(legendBucketLabelKo('WHERE')).toBe('장소');
    expect(legendBucketLabelKo('EVENT')).toBe('사건');
    expect(legendBucketLabelKo('CLAIM')).toBe('발언');
    expect(legendBucketLabelKo('unknown')).toBe('기타');
  });
});

describe('displayNames — factKindLabelKo helper', () => {
  it('kind / fact_type → 한국어 헤더 라벨', () => {
    expect(factKindLabelKo('entity')).toBe('엔티티');
    expect(factKindLabelKo('claim')).toBe('발언');
    expect(factKindLabelKo('action')).toBe('행동');
    expect(factKindLabelKo('measurement')).toBe('수치');
  });
});

describe('displayNames — ★ "사용자 노출 영문 코드 0" 가드', () => {
  it('SECTION_LABELS_KO 값 전체에 영문 알파벳 0', () => {
    for (const ko of Object.values(SECTION_LABELS_KO)) {
      expect(ko).not.toMatch(/[A-Za-z]/);
    }
  });
  it('ENTITY_TYPE_LABELS_KO 값 전체에 영문 알파벳 0', () => {
    for (const ko of Object.values(ENTITY_TYPE_LABELS_KO)) {
      expect(ko).not.toMatch(/[A-Za-z]/);
    }
  });
  it('LEGEND_BUCKET_LABELS_KO 값 전체에 영문 알파벳 0', () => {
    for (const ko of Object.values(LEGEND_BUCKET_LABELS_KO)) {
      expect(ko).not.toMatch(/[A-Za-z]/);
    }
  });
});
