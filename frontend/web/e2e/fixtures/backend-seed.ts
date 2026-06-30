/**
 * ★ fix/stellar-6-class-with-screenshots (2026-06-29) — Playwright backend
 * seeding via page.route(). No real backend / docker / ES required.
 *
 * Mocks /api/* responses so the Next.js client side rendered STELLAR view
 * receives a deterministic fact set. Used by the 6 evidence specs that
 * cover N1 / W1 / W2 / W3 / W4 / W5 violation classes.
 */
import type { Page } from '@playwright/test';
import type {
  FactsList,
  HomeBrief,
  RecallFact,
  RecallResponse,
} from '../../lib/types';

/** Lightweight test-fact shape. Not a `Partial<RecallFact>` because the
 *  prod type uses `string | undefined` on uid fields and we want nullable
 *  here for explicit "no entity" seeds. */
export interface TestFact {
  fact_uid: string;
  fact_type: 'action' | 'claim' | 'measurement';
  subject_uid?: string | null;
  subject_label?: string | null;
  subject_entity_type?: string | null;
  object_value?: string | null;
  object_label?: string | null;
  object_entity_type?: string | null;
  predicate?: string;
  claim?: string;
  source_uids?: string[];
  validated_at?: string;
  validator_id?: string;
  speaker_uid?: string | null;
  speaker_label?: string | null;
  speech_act?: string | null;
  content_claim?: string | null;
  metric?: string | null;
  measurement_value?: number | null;
  measurement_unit?: string | null;
  as_of?: string | null;
  related_entity_uids?: string[] | null;
}

export const SEED_SPACE_ID = '00000000-0000-0000-0000-000000000001';
const SEED_USER_ID = 'cb27c5a5-c71a-426f-a412-d6f3c0d2cd93';

/** Neutral placeholder seed — no real names per PO mandate. Covers the
 *  five fact shapes the 6 specs exercise (action entity→entity, claim with
 *  long content, measurement, where-bucket place, unknown-type fallback). */
export const SEED_FACTS: TestFact[] = [
  // 1) ACTION: entity → entity (W1 — gives an action link for edge click)
  {
    fact_uid: '11111111-1111-4111-8111-111111111111',
    fact_type: 'action',
    subject_uid: '21111111-1111-4111-8111-111111111111',
    subject_label: 'Alpha Corp',
    subject_entity_type: 'organization',
    object_value: '22222222-2222-4222-8222-222222222222',
    object_label: 'Beta Foundation',
    object_entity_type: 'organization',
    predicate: '체결',
    claim: 'Alpha Corp 가 Beta Foundation 과 협력 체결',
  },
  // 2) CLAIM with 200+ char content (W4 / W5)
  {
    fact_uid: '11111111-1111-4111-8111-111111111112',
    fact_type: 'claim',
    speaker_uid: '21111111-1111-4111-8111-111111111111',
    speaker_label: 'Alpha Corp',
    speech_act: '발표했다',
    content_claim:
      '본 분기 매출이 작년 동기 대비 크게 증가했으며 이는 신제품 라인의 성공적 출시, 해외 파트너십 확장, 그리고 비용 구조 개선의 합성 효과로 평가된다. 동시에 다음 분기에는 추가 R&D 투자를 통해 차세대 제품 라인업을 강화할 예정이며 시장의 변동성에도 불구하고 지속적 성장 모멘텀을 유지할 것이라고 강조했다.',
    related_entity_uids: ['22222222-2222-4222-8222-222222222222'],
    claim: '매출 증가 발표',
  },
  // 3) MEASUREMENT (W2)
  {
    fact_uid: '11111111-1111-4111-8111-111111111113',
    fact_type: 'measurement',
    subject_uid: '21111111-1111-4111-8111-111111111111',
    subject_label: 'Alpha Corp',
    subject_entity_type: 'organization',
    metric: 'MAU',
    measurement_value: 8500000,
    measurement_unit: '명',
    as_of: '2026-Q2',
    claim: 'Alpha Corp MAU = 8500000 명',
  },
  // 4) WHERE-bucket place (W3)
  {
    fact_uid: '11111111-1111-4111-8111-111111111114',
    fact_type: 'action',
    subject_uid: '23333333-3333-4333-8333-333333333333',
    subject_label: 'Gamma 지역',
    subject_entity_type: 'place',
    object_value: '22222222-2222-4222-8222-222222222222',
    object_label: 'Beta Foundation',
    object_entity_type: 'organization',
    predicate: '위치',
    claim: 'Gamma 지역 에 Beta Foundation 위치',
  },
  // 5) entity_type null fallback (W3 fallback — unknown bucket)
  {
    fact_uid: '11111111-1111-4111-8111-111111111115',
    fact_type: 'action',
    subject_uid: '24444444-4444-4444-8444-444444444444',
    subject_label: 'Delta',
    subject_entity_type: null,
    object_value: '리터럴 객체',
    object_label: null,
    object_entity_type: null,
    predicate: '관련',
    claim: 'Delta 관련 리터럴',
  },
];

function buildFullFacts(facts: TestFact[]): RecallFact[] {
  return facts.map((f) => ({
    fact_uid: f.fact_uid,
    claim: f.claim ?? '',
    claim_en: null,
    subject_uid: f.subject_uid ?? '',
    predicate: f.predicate ?? '',
    object_value: f.object_value ?? '',
    source_uids: f.source_uids ?? ['00000000-0000-0000-0000-000000000099'],
    validated_at: f.validated_at ?? '2026-06-29T00:00:00Z',
    validator_id: f.validator_id ?? SEED_USER_ID,
    validation_method: 'manual',
    knowledge_space_id: SEED_SPACE_ID,
    negation_flag: false,
    negation_scope: null,
    score: 1.0,
    subject_label: f.subject_label ?? null,
    object_label: f.object_label ?? null,
    subject_entity_type: f.subject_entity_type ?? null,
    object_entity_type: f.object_entity_type ?? null,
    predicate_label: f.predicate ?? null,
    fact_type: f.fact_type,
    speaker_uid: f.speaker_uid ?? null,
    speaker_label: f.speaker_label ?? null,
    speech_act: f.speech_act ?? null,
    content_claim: f.content_claim ?? null,
    stance: null,
    metric: f.metric ?? null,
    measurement_value: f.measurement_value ?? null,
    measurement_unit: f.measurement_unit ?? null,
    as_of: f.as_of ?? null,
    contradiction_count: 0,
    related_entity_uids: f.related_entity_uids ?? null,
    fact_object_role: null,
    link_status: 'verified',
  }));
}

/**
 * Install page.route() interceptors for /api/* + seed localStorage.
 * Run BEFORE page.goto('/stellar') so the route handlers are in place.
 */
export async function wipeAndSeed(
  page: Page,
  facts: TestFact[],
): Promise<void> {
  // ★ REQ-004 STAGE 3+4 (PO 2026-06-30) — /ledger 같은 서버 컴포넌트는
  // `next/headers().get('cookie')` 로 spaceId 를 읽는다. addInitScript
  // 의 `document.cookie` 는 클라이언트 사이드에서만 설정되어 서버 fetch
  // 에는 안 실린다. context.addCookies 로 브라우저 레벨에 설정해야
  // 서버에 전달된다.
  await page.context().addCookies([
    {
      name: 'lucid_space_id',
      value: SEED_SPACE_ID,
      domain: 'localhost',
      path: '/',
      sameSite: 'Lax',
    },
  ]);

  // 1. Seed localStorage / cookie BEFORE navigation so getCurrentSpace()
  //    finds the space id and StellarView reads 'real' mode.
  await page.addInitScript((spaceId: string) => {
    try {
      window.localStorage.setItem('lucid_space_id', spaceId);
      document.cookie = `lucid_space_id=${spaceId}; path=/; SameSite=Lax`;
      // Ensure STELLAR uses real mode and the v2 migration is marked done
      // so the first-visit migration won't wipe the source key.
      window.localStorage.setItem('lucid.stellar.source:migrated:v2', '1');
      window.localStorage.setItem('lucid.stellar.source', 'real');
    } catch {
      /* fail-soft */
    }
  }, SEED_SPACE_ID);

  const fullFacts = buildFullFacts(facts);

  // Playwright route matchers run in REVERSE registration order — the
  // last `page.route()` call is checked first. Register the broad
  // catchall FIRST so the more specific handlers below take precedence
  // for paths they match.

  // ── Catchall (low precedence) ───────────────────────────────────────
  await page.route(/\/api\//, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
      body: '{}',
    });
  });

  // ── /api/spaces/me — list of spaces. ────────────────────────────────
  await page.route(/\/api\/spaces\/me$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify([
        {
          id: SEED_SPACE_ID,
          type: 'personal',
          name: 'Seed Space',
          user_id: SEED_USER_ID,
        },
      ]),
    });
  });

  // ── /api/auth/me — satisfies AppShell auth gate. ────────────────────
  await page.route(/\/api\/auth\/me$/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify({
        id: SEED_USER_ID,
        email: 'kihpark85@gmail.com',
        current_space_id: SEED_SPACE_ID,
      }),
    });
  });

  // ── /api/home/brief ────────────────────────────────────────────────
  await page.route(/\/api\/home\/brief(\?.*)?$/, async (route) => {
    const body: HomeBrief = {
      totals: {
        facts: fullFacts.length,
        entities: 0,
        sources: 1,
        this_week_validated: fullFacts.length,
      },
      pending_validation: 0,
      recent_validated: [],
      top_cluster: null,
      is_empty: fullFacts.length === 0,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify(body),
    });
  });

  // ── /api/spaces/{ks}/recall ────────────────────────────────────────
  await page.route(/\/api\/spaces\/[^/]+\/recall(\?.*)?$/, async (route) => {
    const body: RecallResponse = {
      signature: 'seed',
      facts: fullFacts,
      total: fullFacts.length,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify(body),
    });
  });

  // ── /api/spaces/{ks}/ledger — LEDGER view source ───────────────────
  // ★ REQ-004 STAGE 3+4 (PO 2026-06-30) — ledger 표시층 e2e 검증에 필요.
  await page.route(/\/api\/spaces\/[^/]+\/ledger(\?.*)?$/, async (route) => {
    const ledgerItems = fullFacts.map((f) => ({
      fact_uid: f.fact_uid,
      claim: f.claim,
      claim_en: null,
      subject_uid: f.subject_uid,
      subject_label: f.subject_label,
      predicate: f.predicate,
      predicate_label: f.predicate_label,
      object_value: f.object_value,
      object_label: f.object_label,
      source_uids: f.source_uids,
      validated_at: f.validated_at,
      knowledge_space_id: f.knowledge_space_id,
      fact_type: f.fact_type,
      speaker_label: f.speaker_label,
      speech_act: f.speech_act,
      content_claim: f.content_claim,
      metric: f.metric,
      measurement_value: f.measurement_value,
      measurement_unit: f.measurement_unit,
      as_of: f.as_of,
    }));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify({
        facts: ledgerItems,
        total: ledgerItems.length,
        limit: 20,
        offset: 0,
      }),
    });
  });

  // ── /api/spaces/{ks}/facts — primary listing for the real adapter ──
  await page.route(/\/api\/spaces\/[^/]+\/facts(\?.*)?$/, async (route) => {
    const url = new URL(route.request().url());
    // /facts/{uid} or /facts/{uid}/notes — fall through with 404.
    if (/\/facts\/[^/?]+/.test(url.pathname)) {
      await route.fulfill({ status: 404, body: '{}' });
      return;
    }
    const body: FactsList = {
      facts: fullFacts,
      total: fullFacts.length,
      truncated: false,
    };
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': '*',
      },
      body: JSON.stringify(body),
    });
  });
}
