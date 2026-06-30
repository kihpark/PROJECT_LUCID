/**
 * fix/recall-facet-bucket-expand (★ M-Dogfood ⑤⑪ — PO 2026-06-30) —
 * /recall 우측 facet rail 10 bucket render + 한국어 라벨 e2e 검증.
 *
 * 옛 root cause: backend 의 _OBJECT_CLASS_BUCKET 가 organization /
 * person / place 3 class 만 1:1 매핑하고 나머지 (concept / resource /
 * event / metric / knowledge / group / task / location) 는 모두 "other"
 * 로 떨어져 "기타" 비대를 만들었다. dogfood 사용자가 박원갑 (person)
 * 이 "기타" 밑에 묻혀 표시된다고 보고한 게 이 픽스의 동기.
 *
 * v3 fix: 10 class 1:1 + legacy `place` → `location` alias.
 *
 * 검증:
 *   1. /recall 진입 → 10 bucket render 가능 (count > 0 인 것만 표시)
 *   2. ★ 박원갑 (person class) → "사람" bucket (★ "기타" X)
 *   3. ★ "기타" (other) 비대 0 — v3 class 들은 자기 bucket 으로 갔다
 *   4. screenshot 의무 (★ PO 2026-06-30)
 */
import { test, expect } from '@playwright/test';
import type { Route } from '@playwright/test';
import { SEED_SPACE_ID, wipeAndSeed } from './fixtures/backend-seed';
import type { RecallResponse, RecallFact, RecallFacets } from '../lib/types';
import { captureEvidence } from './helpers/screenshot';

// v3 10 class — PO 의뢰서 verbatim. ★ 옛 시절 7 class 가 "기타" 로
// 떨어졌으나 이제 1:1 자기 bucket 에 들어간다.
const V3_BUCKETS = [
  { class: 'person', name: '박원갑', label: '사람' },
  { class: 'organization', name: '한국은행', label: '조직' },
  { class: 'group', name: 'KB 금융그룹', label: '그룹' },
  { class: 'knowledge', name: 'Active Recall 이론', label: '지식' },
  { class: 'resource', name: '보고서.pdf', label: '자원' },
  { class: 'task', name: '기준금리 인하 결정', label: '행위' },
  { class: 'concept', name: '통화정책', label: '개념' },
  { class: 'event', name: 'FOMC 회의', label: '사건' },
  { class: 'metric', name: 'MAU', label: '지표' },
  { class: 'location', name: '서울', label: '장소' },
] as const;

function _uid(idx: number): string {
  // UUID4-shaped — backend 와 동일 (★ 노출되지 않으나 정합성).
  return `${'1'.repeat(8)}-1111-4111-8111-${String(idx).padStart(12, '0')}`;
}

test.describe('★ M-Dogfood ⑤⑪ — recall facet 10 bucket (★ 기타 비대 해소)', () => {
  test.beforeEach(async ({ page }) => {
    // backend-seed 의 기본 wipeAndSeed 만 호출 — auth/spaces/me 등 공통 mock
    // 설치 후 facet 응답을 우리가 덮어쓴다 (★ playwright 가 마지막 등록부터
    // 매칭).
    await wipeAndSeed(page, []);

    // 10 class 각각 1개씩 fact 시드 (subject_uid = entity uid). 백엔드
    // /recall mock 을 우리 facet 응답으로 덮어쓴다.
    const facts: RecallFact[] = V3_BUCKETS.map((b, idx) => ({
      fact_uid: _uid(100 + idx),
      claim: `${b.name} 관련 검증 사실 ${idx + 1}`,
      claim_en: null,
      subject_uid: _uid(idx + 1),
      predicate: '관련',
      object_value: '리터럴',
      source_uids: ['00000000-0000-0000-0000-000000000099'],
      validated_at: '2026-06-29T00:00:00Z',
      validator_id: 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93',
      validation_method: 'manual',
      knowledge_space_id: SEED_SPACE_ID,
      negation_flag: false,
      negation_scope: null,
      score: 1.0,
      subject_label: b.name,
      object_label: null,
      subject_entity_type: b.class,
      object_entity_type: null,
      predicate_label: '관련',
      fact_type: 'action',
      speaker_uid: null,
      speaker_label: null,
      speech_act: null,
      content_claim: null,
      stance: null,
      metric: null,
      measurement_value: null,
      measurement_unit: null,
      as_of: null,
      contradiction_count: 0,
      related_entity_uids: null,
      fact_object_role: null,
      link_status: 'verified',
    }));

    // ★ 10 bucket 모두 1개씩 — count > 0 이므로 모두 render 되어야 한다.
    const facets: RecallFacets = {
      entities: {
        person: [{ uid: _uid(1), name: '박원갑', count: 1 }],
        organization: [{ uid: _uid(2), name: '한국은행', count: 1 }],
        group: [{ uid: _uid(3), name: 'KB 금융그룹', count: 1 }],
        knowledge: [{ uid: _uid(4), name: 'Active Recall 이론', count: 1 }],
        resource: [{ uid: _uid(5), name: '보고서.pdf', count: 1 }],
        task: [{ uid: _uid(6), name: '기준금리 인하 결정', count: 1 }],
        concept: [{ uid: _uid(7), name: '통화정책', count: 1 }],
        event: [{ uid: _uid(8), name: 'FOMC 회의', count: 1 }],
        metric: [{ uid: _uid(9), name: 'MAU', count: 1 }],
        location: [{ uid: _uid(10), name: '서울', count: 1 }],
        // ★ "other" 는 빈 배열 — v3 class 들은 모두 자기 bucket 에 들어가
        // "기타" 비대가 0 임을 검증한다.
        other: [],
      },
      predicates: [{ name: '관련', count: 10 }],
      fact_types: { action: 10, claim: 0, measurement: 0 },
    };

    const recallResponse: RecallResponse = {
      signature: 'As far as I know — 그래프에 10개 검증 사실이 있습니다',
      facts,
      total: facts.length,
      facets,
    };

    // ★ playwright route 매처는 REVERSE 등록 순서 — 마지막 등록이
    // 최우선. backend-seed 가 이미 catch-all 과 /recall mock 을 설치했으므로
    // 여기서 더 구체적인 mock 을 등록하면 우선 매칭.
    await page.route(/\/api\/spaces\/[^/]+\/recall(\?.*)?$/, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
        },
        body: JSON.stringify(recallResponse),
      });
    });
  });

  test('★ /recall → 10 bucket facet panel + 박원갑 "사람" + 기타 비대 0', async ({ page }) => {
    await page.goto('/recall');
    await page.waitForLoadState('networkidle');

    // ★ power mode 진입 (★ facet rail 은 power mode 에서만 보임).
    const modeToggle = page.getByTestId('recall-mode-toggle');
    await modeToggle.click();

    // 쿼리 입력 → 검색 (★ recall 트리거).
    const input = page.getByLabel('recall query');
    await input.fill('전체');
    await page.getByRole('button', { name: '검색' }).click();

    // facet panel 등장 대기.
    const panel = page.getByTestId('facet-panel');
    await expect(panel).toBeVisible({ timeout: 5000 });

    await captureEvidence(page, 'recall-facet-10-buckets', '01-panel-rendered');

    // ★ 10 bucket 모두 render — 각 bucket testid 존재 + 한국어 라벨 + 이름 포함.
    for (const b of V3_BUCKETS) {
      const bucket = page.getByTestId(`facet-bucket-${b.class}`);
      await expect(bucket).toBeVisible();
      await expect(bucket).toContainText(b.label);
      await expect(bucket).toContainText(b.name);
    }

    // ★ M-Dogfood ⑤⑪ 핵심 회귀 가드 — 박원갑 (person class) 은 "사람"
    // bucket 에 들어가야 한다. "기타" 안에 박원갑 X.
    const personBucket = page.getByTestId('facet-bucket-person');
    await expect(personBucket).toContainText('박원갑');
    await expect(personBucket).toContainText('사람');

    // ★ "기타" (other) 는 render 자체가 되지 않아야 한다 (★ "기타" 비대 0).
    // count=0 인 bucket 은 FacetPanel 이 skip 한다 (★ 비대 가드).
    const otherBucket = page.getByTestId('facet-bucket-other');
    await expect(otherBucket).toHaveCount(0);

    // ★ 박원갑이 "기타" bucket 어디에도 없음 (★ 안전망 검증).
    const otherCount = await otherBucket.count();
    expect(otherCount).toBe(0);

    await captureEvidence(page, 'recall-facet-10-buckets', '02-park-in-person-not-other');
  });

  test('★ count=0 bucket 은 render skip (★ "기타" 비대 가드)', async ({ page }) => {
    // ★ 이전 테스트 setUp 의 facet 응답을 덮어써서 일부 bucket 을 0 으로.
    const sparseFacets: RecallFacets = {
      entities: {
        person: [{ uid: _uid(1), name: '박원갑', count: 1 }],
        organization: [{ uid: _uid(2), name: '한국은행', count: 1 }],
        group: [],
        knowledge: [],
        resource: [],
        task: [],
        concept: [],
        event: [],
        metric: [],
        location: [],
        other: [],
      },
      predicates: [],
      fact_types: { action: 2, claim: 0, measurement: 0 },
    };
    const sparseResp: RecallResponse = {
      signature: 'As far as I know — 그래프에 2개 검증 사실이 있습니다',
      facts: [],
      total: 2,
      facets: sparseFacets,
    };
    await page.route(/\/api\/spaces\/[^/]+\/recall(\?.*)?$/, async (route: Route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(sparseResp),
      });
    });

    await page.goto('/recall');
    await page.waitForLoadState('networkidle');
    await page.getByTestId('recall-mode-toggle').click();
    await page.getByLabel('recall query').fill('전체');
    await page.getByRole('button', { name: '검색' }).click();
    await expect(page.getByTestId('facet-panel')).toBeVisible({ timeout: 5000 });

    // ★ 2 bucket 만 render — 나머지 8 + other 는 모두 hidden (★ 비대 가드).
    await expect(page.getByTestId('facet-bucket-person')).toBeVisible();
    await expect(page.getByTestId('facet-bucket-organization')).toBeVisible();
    for (const empty of ['group', 'knowledge', 'resource', 'task', 'concept', 'event', 'metric', 'location', 'other']) {
      await expect(page.getByTestId(`facet-bucket-${empty}`)).toHaveCount(0);
    }

    await captureEvidence(page, 'recall-facet-10-buckets', '03-empty-buckets-skipped');
  });
});
