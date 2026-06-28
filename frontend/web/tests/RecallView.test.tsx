import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { RecallView } from '@/components/RecallView';
import type { RecallResponse } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  recall: vi.fn(),
  // B-48b detail panel + retract/restore/detach
  getFactDetail: vi.fn(),
  retractFact: vi.fn(),
  restoreFact: vi.fn(),
  detachSource: vi.fn(),
  // feat/fact-detail-modify — surface-field PATCH
  modifyFact: vi.fn(),
  // feat/recall-search-entity-autocomplete — entity suggestion API
  searchEntitySuggestions: vi.fn(),
  // fix/r1-recall-redesign — AI 브리핑 (on-demand button inside summary box)
  recallBriefing: vi.fn(),
  ApiError: class extends Error {
    status = 0;
    detail: string | undefined;
  },
}));

import * as api from '@/lib/api';

// B-60: default mode is simple, which hides the left filter / right
// facet rails. Tests that assert on the power-rail chrome (facet
// panel, search controls, entity brief, threshold note, drill-down
// chips) must first flip the toggle so the rails mount.
function switchToPowerMode() {
  fireEvent.click(screen.getByTestId('recall-mode-toggle'));
}

const RECALL_HIT: RecallResponse = {
  signature: 'As far as I know — 그래프에 2개 검증 사실이 있습니다',
  total: 2,
  facts: [
    {
      fact_uid: 'fn-1',
      claim: '한국은행 기준금리는 2024년 12월 기준 3.0%였다.',
      claim_en: null,
      subject_uid: 'obj-bok',
      predicate: 'base_rate',
      object_value: '3.0%',
      source_uids: ['https://example.com/article/1'],
      validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
      validator_id: 'user-x',
      validation_method: 'manual',
      knowledge_space_id: 'ks-1',
      negation_flag: false,
      negation_scope: null,
      score: 0.87,
    },
    {
      fact_uid: 'fn-2',
      claim: 'A2 밀크는 A1 대신 A2 베타카제인을 포함한다.',
      claim_en: null,
      subject_uid: 'obj-a2',
      predicate: 'contains',
      object_value: 'A2-beta-casein',
      source_uids: [],
      validated_at: new Date('2026-05-29T10:00:00Z').toISOString(),
      validator_id: 'user-x',
      validation_method: 'manual',
      knowledge_space_id: 'ks-1',
      negation_flag: false,
      negation_scope: null,
      score: 0.75,
    },
  ],
};

const RECALL_EMPTY: RecallResponse = {
  signature: '검증된 사실이 없습니다',
  facts: [],
  total: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  // B-60: clear the persisted mode so each test starts at the simple
  // default (matching a first-time user). Tests that need the power
  // rail call switchToPowerMode() explicitly.
  try {
    window.localStorage.removeItem('lucid.recall.mode');
  } catch {
    // jsdom always provides localStorage; the guard is defensive.
  }
});

describe('RecallView', () => {
  it('renders the prompt, no signature pre-submit', () => {
    render(<RecallView spaceId="ks-1" />);
    expect(screen.getByLabelText('recall query')).toBeInTheDocument();
    expect(screen.queryByTestId('recall-signature')).toBeNull();
  });

  it('submits the query and renders the signature + Korean fact card', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);
    render(<RecallView spaceId="ks-1" />);

    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '한국은행 기준금리' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const sig = await screen.findByTestId('recall-signature');
    expect(sig.textContent).toMatch(/2개 검증 사실/);
    expect(sig.textContent).toMatch(/As far as I know/);
    expect(
      await screen.findByText('한국은행 기준금리는 2024년 12월 기준 3.0%였다.'),
    ).toBeInTheDocument();
  });

  it('renders the empty signature when total=0', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_EMPTY);
    render(<RecallView spaceId="ks-1" />);

    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'unknown question' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    const sig = await screen.findByTestId('recall-signature');
    expect(sig.textContent).toBe('검증된 사실이 없습니다');
    // and no fact cards
    expect(screen.queryByText(/score/)).toBeNull();
  });

  it('Recall button is disabled when the input is empty', () => {
    render(<RecallView spaceId="ks-1" />);
    const btn = screen.getByRole('button', { name: 'Recall' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it('recall fact card shows Korean predicate label, not English canonical (B-56)', async () => {
    // The recall response carries the canonical English predicate
    // (`decided_to_remove`); the rendered card MUST show the Korean
    // label from PREDICATE_LABELS and MUST NOT leak the raw English
    // snake_case key into the visible card body.
    const RECALL_KO_LABEL: RecallResponse = {
      signature: 'As far as I know — 그래프에 1개 검증 사실이 있습니다',
      total: 1,
      facts: [
        {
          fact_uid: 'fn-ko-label',
          claim: '구청은 노후 옹벽을 철거하기로 결정했다.',
          claim_en: null,
          subject_uid: 'obj-gu',
          predicate: 'decided_to_remove',
          object_value: '노후 옹벽',
          source_uids: [],
          validated_at: new Date('2026-06-15T10:00:00Z').toISOString(),
          validator_id: 'user-x',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.88,
        },
      ],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_KO_LABEL);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '철거' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    const card = await screen.findByTestId('recall-fact-fn-ko-label');
    // Korean label is visible inside the card.
    expect(card.textContent).toContain('철거하기로 결정한 것은');
    // The English canonical key is NOT leaked into the rendered card.
    expect(card.textContent).not.toContain('decided_to_remove');
  });

  // feat/recall-card-original-claim — PO directive 7.
  // Old edited facts have `claim` overwritten with the pipe-joined
  // `S | P | O` artefact emitted by FactCard.regenerateClaim() in
  // Decide. The recall card title MUST show the original sentence when
  // available; the pipe artefact is a legacy data shape, not a valid
  // sentence — when detected, render a natural S → P → O surface and
  // flag it with a "(재구성됨)" marker.
  it('renders the original claim verbatim as the card title (no pipes injected)', async () => {
    const RECALL_ORIGINAL: RecallResponse = {
      signature: 'As far as I know — 그래프에 1개 검증 사실이 있습니다',
      total: 1,
      facts: [
        {
          fact_uid: 'fn-original',
          claim: '중국 정부는 미국 기업을 제재했다',
          claim_en: null,
          subject_uid: 'obj-china',
          subject_label: '중국 정부',
          predicate: 'sanctions',
          object_value: 'obj-us-co',
          object_label: '미국 기업',
          source_uids: [],
          validated_at: new Date('2026-06-15T10:00:00Z').toISOString(),
          validator_id: 'user-x',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.91,
        },
      ],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_ORIGINAL);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '중국' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    const card = await screen.findByTestId('recall-fact-fn-original');
    // Original sentence is rendered verbatim.
    expect(card.textContent).toContain('중국 정부는 미국 기업을 제재했다');
    // The card is NOT flagged as reconstructed.
    expect(card.getAttribute('data-claim-reconstructed')).toBe('false');
    expect(
      screen.queryByTestId('recall-fact-fn-original-reconstructed'),
    ).toBeNull();
  });

  it('falls back to S → P → O with a 재구성됨 marker when claim is a pipe artefact', async () => {
    const RECALL_PIPE: RecallResponse = {
      signature: 'As far as I know — 그래프에 1개 검증 사실이 있습니다',
      total: 1,
      facts: [
        {
          fact_uid: 'fn-pipe',
          // PO's exact bug report: edited fact whose `claim` was
          // overwritten with the pipe-joined S | P | O surface.
          claim: '중국 | 나섰다 | 미국 방산·드론·희토류 관련 기업에 대한 추가 제재',
          claim_en: null,
          subject_uid: 'obj-china',
          subject_label: '중국',
          predicate: 'sanctions',
          predicate_label: '제재',
          object_value: 'obj-us-co',
          object_label: '미국 방산·드론·희토류 관련 기업에 대한 추가 제재',
          source_uids: [],
          validated_at: new Date('2026-06-15T10:00:00Z').toISOString(),
          validator_id: 'user-x',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.83,
        },
      ],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_PIPE);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '중국' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    const card = await screen.findByTestId('recall-fact-fn-pipe');
    // The raw pipe artefact is NOT shown as the card title.
    expect(card.textContent).not.toContain(
      '중국 | 나섰다 | 미국 방산·드론·희토류 관련 기업에 대한 추가 제재',
    );
    // The card is flagged as reconstructed and the marker is rendered.
    expect(card.getAttribute('data-claim-reconstructed')).toBe('true');
    expect(
      await screen.findByTestId('recall-fact-fn-pipe-reconstructed'),
    ).toBeInTheDocument();
    // The natural S → P → O surface is used as the title fallback —
    // resolved labels + Korean predicate, joined by "→" not "|".
    expect(card.textContent).toContain('중국');
    expect(card.textContent).toContain('→');
    expect(card.textContent).toContain('제재');
    expect(card.textContent).toContain('미국 방산·드론·희토류 관련 기업에 대한 추가 제재');
  });
});


describe('RecallView — entity label + sort + badges (B-40)', () => {
  const HIT_WITH_LABELS: RecallResponse = {
    signature: 'As far as I know — 그래프에 3개 검증 사실이 있습니다',
    total: 3,
    expanded_count: 1,
    facts: [
      {
        fact_uid: 'fn-entity-link',
        claim: 'Goldman Sachs sponsored the SpaceX IPO.',
        claim_en: null,
        subject_uid: '6895dbc7-a533-4c4d-9b8c-1a2b3c4d5e6f',
        subject_label: 'Goldman Sachs',
        predicate: 'is_underwriter_for',
        object_value: '11111111-2222-3333-4444-555555555555',
        object_label: 'SpaceX IPO',
        source_uids: [],
        validated_at: new Date('2026-06-15T10:00:00Z').toISOString(),
        validator_id: 'user-x',
        validation_method: 'manual',
        knowledge_space_id: 'ks-1',
        negation_flag: false,
        negation_scope: null,
        score: 0.0,
        match_kind: 'entity_link',
      },
      {
        fact_uid: 'fn-embed-high',
        claim: 'SpaceX raised 85.7 billion USD in its IPO.',
        claim_en: null,
        subject_uid: '11111111-2222-3333-4444-555555555555',
        subject_label: 'SpaceX',
        predicate: 'total_funds_raised',
        object_value: '85.7 billion USD',
        object_label: null,
        source_uids: [],
        validated_at: new Date('2026-06-15T09:00:00Z').toISOString(),
        validator_id: 'user-x',
        validation_method: 'manual',
        knowledge_space_id: 'ks-1',
        negation_flag: false,
        negation_scope: null,
        score: 0.92,
        match_kind: 'embedding',
      },
      {
        fact_uid: 'fn-embed-mid',
        claim: 'SpaceX shares listed at $135 on Jan 12, 2026.',
        claim_en: null,
        subject_uid: '11111111-2222-3333-4444-555555555555',
        subject_label: 'SpaceX',
        predicate: 'set_ipo_price',
        object_value: '135 USD per share',
        object_label: null,
        source_uids: [],
        validated_at: new Date('2026-06-15T09:30:00Z').toISOString(),
        validator_id: 'user-x',
        validation_method: 'manual',
        knowledge_space_id: 'ks-1',
        negation_flag: false,
        negation_scope: null,
        score: 0.81,
        match_kind: 'embedding',
      },
    ],
  };

  it('resolves UUID subject_uid to subject_label on every card', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(HIT_WITH_LABELS);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    expect(
      await screen.findByTestId('recall-fact-fn-embed-high-subject'),
    ).toHaveTextContent('SpaceX');
    expect(
      screen.queryByText('11111111-2222-3333-4444-555555555555'),
    ).toBeNull();
  });

  it('renders match_kind badges differentiating embedding vs entity_link', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(HIT_WITH_LABELS);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    expect(await screen.findAllByTestId('recall-badge-embedding')).toHaveLength(2);
    expect(screen.getAllByTestId('recall-badge-entity-link')).toHaveLength(1);
  });

  it('sorts facts by score DESC so high-similarity embedding hits land first', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(HIT_WITH_LABELS);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    await screen.findByTestId('recall-fact-fn-embed-high');
    // Limit to article-shape cards so the score "span" and dd cells
    // don't get caught up in the sort comparison.
    const cards = Array.from(document.querySelectorAll('article[data-testid^="recall-fact-"]'));
    const uidsInOrder = cards.map((c) => c.getAttribute('data-testid')!.replace('recall-fact-', ''));
    expect(uidsInOrder[0]).toBe('fn-embed-high');
    expect(uidsInOrder[1]).toBe('fn-embed-mid');
    expect(uidsInOrder[2]).toBe('fn-entity-link');
  });

  it('shows the threshold note above the result list with expanded count', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(HIT_WITH_LABELS);
    render(<RecallView spaceId="ks-1" />);
    // B-60: threshold note lives in the power rail; flip to power mode.
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const note = await screen.findByTestId('recall-threshold-note');
    expect(note).toHaveTextContent(/0\.72 이상/);
    expect(note).toHaveTextContent(/엔티티 연결로 추가된 1건/);
  });

  it('marks an unresolved UUID subject with the (미해석) marker', async () => {
    const unresolved: RecallResponse = {
      signature: 'As far as I know — 그래프에 1개 검증 사실이 있습니다',
      total: 1,
      facts: [{
        fact_uid: 'fn-orphan',
        claim: 'Some orphan fact.',
        claim_en: null,
        subject_uid: 'deadbeef-1234-5678-9abc-def012345678',
        subject_label: null,
        predicate: 'x',
        object_value: 'literal',
        object_label: null,
        source_uids: [],
        validated_at: new Date().toISOString(),
        validator_id: 'u',
        validation_method: 'manual',
        knowledge_space_id: 'ks-1',
        negation_flag: false,
        negation_scope: null,
        score: 0.85,
        match_kind: 'embedding',
      }],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(unresolved);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'x' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    expect(
      await screen.findByTestId('recall-fact-fn-orphan-subject'),
    ).toHaveTextContent(/\(미해석\)/);
  });
});


describe('RecallView — entity brief panel (B-41)', () => {
  const BRIEF_RESPONSE: RecallResponse = {
    signature: 'As far as I know — 그래프에 3개 검증 사실이 있습니다',
    total: 3,
    expanded_count: 2,
    entity_brief: {
      entity_uid: '11111111-2222-3333-4444-555555555555',
      entity_name: 'SpaceX',
      entity_class: 'organization',
      total_facts: 3,
      as_subject: [
        {
          predicate: 'total_funds_raised',
          facts: [
            {
              fact_uid: 'fn-1',
              claim: 'SpaceX raised 85.7 billion USD.',
              predicate: 'total_funds_raised',
              other_uid: '85.7 billion USD',
              other_label: null,
            },
          ],
        },
        {
          predicate: 'set_ipo_price',
          facts: [
            {
              fact_uid: 'fn-2',
              claim: 'SpaceX priced its IPO at 135 USD per share.',
              predicate: 'set_ipo_price',
              other_uid: '135 USD per share',
              other_label: null,
            },
          ],
        },
      ],
      as_object: [
        {
          predicate: 'is_underwriter_for',
          facts: [
            {
              fact_uid: 'fn-3',
              claim: 'Goldman Sachs is an underwriter for SpaceX IPO.',
              predicate: 'is_underwriter_for',
              other_uid: '6895dbc7-a533-4c4d-9b8c-1a2b3c4d5e6f',
              other_label: 'Goldman Sachs',
            },
          ],
        },
      ],
    },
    facts: [
      {
        fact_uid: 'fn-1',
        claim: 'SpaceX raised 85.7 billion USD.',
        claim_en: null,
        subject_uid: '11111111-2222-3333-4444-555555555555',
        subject_label: 'SpaceX',
        predicate: 'total_funds_raised',
        object_value: '85.7 billion USD',
        object_label: null,
        source_uids: [],
        validated_at: new Date('2026-06-15T09:00:00Z').toISOString(),
        validator_id: 'u',
        validation_method: 'manual',
        knowledge_space_id: 'ks-1',
        negation_flag: false,
        negation_scope: null,
        score: 0.92,
        match_kind: 'embedding',
      },
    ],
  };

  it('surfaces the resolved entity name + class in the summary header', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BRIEF_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    // feat/recall-entity-bucket-cleanup — the separate entity-brief
    // panel is gone; the entity-scoped signal lives on the
    // RecallFactTypeSummary box itself.
    const summary = await screen.findByTestId('recall-fact-type-summary');
    expect(summary).toHaveAttribute('data-entity-scoped', 'true');
    expect(screen.getByTestId('recall-summary-entity-name'))
      .toHaveTextContent('SpaceX');
    expect(screen.getByTestId('recall-summary-entity-class'))
      .toHaveTextContent('organization');
    // The deprecated entity-brief panel and its inner role labels are
    // gone from the DOM entirely.
    expect(screen.queryByTestId('entity-brief')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brief-predicate-groups')).not.toBeInTheDocument();
    expect(summary).not.toHaveTextContent(/주어로서/);
    expect(summary).not.toHaveTextContent(/목적어로서/);
    expect(summary).not.toHaveTextContent(/생성 0/);
  });

  it('drops the predicate-grouped brief fact lists from the DOM', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BRIEF_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    // feat/recall-entity-bucket-cleanup — the predicate-grouped fact
    // surface is gone. The same facts are already shown by the main
    // fact list below, ordered by score.
    await screen.findByTestId('recall-fact-type-summary');
    expect(screen.queryByTestId('brief-predicate-groups')).not.toBeInTheDocument();
    expect(screen.queryByTestId('brief-group-subject-total_funds_raised'))
      .not.toBeInTheDocument();
    expect(screen.queryByTestId('brief-group-subject-set_ipo_price'))
      .not.toBeInTheDocument();
    expect(screen.queryByTestId('brief-group-object-is_underwriter_for'))
      .not.toBeInTheDocument();
  });

  it('paints the summary box accent-cool when the response is entity-scoped, with empty hits', async () => {
    const emptyEntity: RecallResponse = {
      signature: '검증된 사실이 없습니다',
      total: 0,
      facts: [],
      entity_brief: {
        entity_uid: 'e-x',
        entity_name: 'Nobody',
        entity_class: 'person',
        total_facts: 0,
        as_subject: [],
        as_object: [],
      },
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(emptyEntity);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'Nobody' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    // feat/recall-entity-bucket-cleanup — the empty-entity message
    // ("이 엔티티에 대한 검증된 사실이 없습니다.") is gone. We still
    // surface the resolved entity_name in the summary header so the
    // user knows what was searched; the per-entity lifetime KS facts
    // count is no longer authoritative for an entity-keyword recall.
    const summary = await screen.findByTestId('recall-fact-type-summary');
    expect(summary).toHaveAttribute('data-entity-scoped', 'true');
    expect(screen.getByTestId('recall-summary-entity-name'))
      .toHaveTextContent('Nobody');
    expect(screen.queryByTestId('entity-brief')).not.toBeInTheDocument();
    expect(summary).not.toHaveTextContent(/이 엔티티에 대한 검증된 사실이 없습니다/);
  });
});


// ---------------------------------------------------------------------------
// feat/recall-entity-fact-type-breakdown — PER-entity 행동 / 발언 / 수치
// chip row inside the brief panel, replacing the role facet (주어로서 /
// 목적어로서) that was meaningless to PO during the 2026-06-24 dogfood.
// ---------------------------------------------------------------------------

describe('RecallView — entity brief fact_type breakdown', () => {
  const SHARED_ENTITY_UID = 'ent-birth-metric';

  // Mixed-type response: the entity is touched by 1 action, 2 claim,
  // and 3 measurement facts. The brief total matches (6).
  const MIXED_RESPONSE: RecallResponse = {
    signature: 'As far as I know — 그래프에 6개 검증 사실이 있습니다',
    total: 6,
    entity_brief: {
      entity_uid: SHARED_ENTITY_UID,
      entity_name: '출생아 수',
      entity_class: 'concept',
      total_facts: 6,
      as_subject: [
        {
          predicate: 'measured_as',
          facts: [
            { fact_uid: 'm-1', claim: '출생아 수는 230,000명.', predicate: 'measured_as', other_uid: '230000', other_label: null },
          ],
        },
      ],
      as_object: [],
    },
    facets: {
      entities: { organization: [], person: [], place: [], other: [] },
      predicates: [],
      fact_types: { action: 1, claim: 2, measurement: 3 },
    },
    facts: [
      {
        fact_uid: 'a-1', claim: '통계청이 출생아 수를 집계했다.', claim_en: null,
        subject_uid: 'ent-stat', subject_label: '통계청',
        predicate: 'reports', object_value: SHARED_ENTITY_UID, object_label: '출생아 수',
        source_uids: [], validated_at: new Date('2026-06-15T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.92, match_kind: 'embedding',
        fact_type: 'action',
      },
      {
        fact_uid: 'c-1', claim: '장관이 "출생아 수 반등"이라 말했다.', claim_en: null,
        subject_uid: 'ent-minister', subject_label: '장관',
        predicate: 'says', object_value: SHARED_ENTITY_UID, object_label: '출생아 수',
        source_uids: [], validated_at: new Date('2026-06-16T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.90, match_kind: 'embedding',
        fact_type: 'claim',
      },
      {
        fact_uid: 'c-2', claim: '대통령이 "출생아 수 위기"라 말했다.', claim_en: null,
        subject_uid: 'ent-president', subject_label: '대통령',
        predicate: 'says', object_value: SHARED_ENTITY_UID, object_label: '출생아 수',
        source_uids: [], validated_at: new Date('2026-06-17T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.89, match_kind: 'embedding',
        fact_type: 'claim',
      },
      {
        fact_uid: 'm-1', claim: '출생아 수는 230,000명.', claim_en: null,
        subject_uid: SHARED_ENTITY_UID, subject_label: '출생아 수',
        predicate: 'measured_as', object_value: '230000', object_label: null,
        source_uids: [], validated_at: new Date('2026-06-18T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.91, match_kind: 'embedding',
        fact_type: 'measurement',
      },
      {
        fact_uid: 'm-2', claim: '출생아 수는 225,000명.', claim_en: null,
        subject_uid: SHARED_ENTITY_UID, subject_label: '출생아 수',
        predicate: 'measured_as', object_value: '225000', object_label: null,
        source_uids: [], validated_at: new Date('2026-06-19T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.88, match_kind: 'embedding',
        fact_type: 'measurement',
      },
      {
        fact_uid: 'm-3', claim: '출생아 수는 240,000명.', claim_en: null,
        subject_uid: SHARED_ENTITY_UID, subject_label: '출생아 수',
        predicate: 'measured_as', object_value: '240000', object_label: null,
        source_uids: [], validated_at: new Date('2026-06-20T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.85, match_kind: 'embedding',
        fact_type: 'measurement',
      },
    ],
  };

  // Single-type legacy response: every fact has fact_type=undefined
  // (= 'action' by codebase convention). The chip row should still
  // render all three buckets so the visual hierarchy stays constant.
  const LEGACY_ACTION_ONLY: RecallResponse = {
    signature: 'As far as I know — 그래프에 2개 검증 사실이 있습니다',
    total: 2,
    entity_brief: {
      entity_uid: 'ent-legacy',
      entity_name: 'Legacy',
      entity_class: 'organization',
      total_facts: 2,
      as_subject: [],
      as_object: [],
    },
    facts: [
      {
        fact_uid: 'l-1', claim: 'Legacy did X.', claim_en: null,
        subject_uid: 'ent-legacy', subject_label: 'Legacy',
        predicate: 'did', object_value: 'X', object_label: null,
        source_uids: [], validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.80, match_kind: 'embedding',
      },
      {
        fact_uid: 'l-2', claim: 'Legacy did Y.', claim_en: null,
        subject_uid: 'ent-legacy', subject_label: 'Legacy',
        predicate: 'did', object_value: 'Y', object_label: null,
        source_uids: [], validated_at: new Date('2026-06-02T10:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.79, match_kind: 'embedding',
      },
    ],
  };

  it('renders three fact_type chips (행동 / 발언 / 수치) on the merged summary box', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(MIXED_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '출생아' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    // feat/recall-entity-bucket-cleanup — the per-entity chip row
    // ("brief-fact-type-*") was merged into the page-level summary
    // ("recall-summary-chip-*"). For the dogfood entity-keyword case
    // (every hit touches the resolved entity), the two count sources
    // are equivalent, so no information is lost.
    const summary = await screen.findByTestId('recall-fact-type-summary');
    expect(screen.getByTestId('recall-summary-chip-action')).toBeInTheDocument();
    expect(screen.getByTestId('recall-summary-chip-claim')).toBeInTheDocument();
    expect(screen.getByTestId('recall-summary-chip-measurement')).toBeInTheDocument();
    expect(summary).toHaveTextContent('행동');
    expect(summary).toHaveTextContent('발언');
    expect(summary).toHaveTextContent('수치');
    // fix/terminology-unify-balhwa-balhweon — 과거 '발화' 표기 잔재 0.
    expect(summary.textContent ?? '').not.toContain('발화');
    // The deleted per-entity chip-row testids are gone from the DOM.
    expect(screen.queryByTestId('brief-fact-type-breakdown')).not.toBeInTheDocument();
  });

  it('counts the page-level fact_type breakdown from response facets', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(MIXED_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '출생아' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    await screen.findByTestId('recall-fact-type-summary');
    // 1 action, 2 claim, 3 measurement — facets.fact_types from the
    // response is the count source (equal to the per-entity breakdown
    // for the dogfood entity-keyword case).
    expect(screen.getByTestId('recall-summary-count-action'))
      .toHaveTextContent('1');
    expect(screen.getByTestId('recall-summary-count-claim'))
      .toHaveTextContent('2');
    expect(screen.getByTestId('recall-summary-count-measurement'))
      .toHaveTextContent('3');
  });

  it('clicking a summary chip flips the fact_type filter for an entity-scoped recall', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(MIXED_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '출생아' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const summary = await screen.findByTestId('recall-fact-type-summary');
    expect(summary).toHaveAttribute('data-active-filter', '');
    expect(summary).toHaveAttribute('data-entity-scoped', 'true');
    // Click 발언 chip → summary box flips to active 'claim'.
    fireEvent.click(screen.getByTestId('recall-summary-chip-claim'));
    expect(screen.getByTestId('recall-fact-type-summary'))
      .toHaveAttribute('data-active-filter', 'claim');
    expect(screen.getByTestId('recall-summary-chip-claim'))
      .toHaveAttribute('data-active', 'true');
    // Click again → filter clears.
    fireEvent.click(screen.getByTestId('recall-summary-chip-claim'));
    expect(screen.getByTestId('recall-fact-type-summary'))
      .toHaveAttribute('data-active-filter', '');
  });

  it('renders zero-count chips disabled and visually muted on the merged summary box', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(LEGACY_ACTION_ONLY);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'Legacy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    await screen.findByTestId('recall-fact-type-summary');
    // LEGACY_ACTION_ONLY has no facets payload, so all chip counts on
    // the page-level summary are 0 — matching the codebase convention
    // that a missing facets bucket means "we don't know" (not "1+").
    // All three chips render but disabled.
    expect(screen.getByTestId('recall-summary-count-action'))
      .toHaveTextContent('0');
    expect(screen.getByTestId('recall-summary-count-claim'))
      .toHaveTextContent('0');
    expect(screen.getByTestId('recall-summary-count-measurement'))
      .toHaveTextContent('0');
    const actionChip = screen.getByTestId('recall-summary-chip-action');
    const claimChip = screen.getByTestId('recall-summary-chip-claim');
    const measurementChip = screen.getByTestId('recall-summary-chip-measurement');
    expect(actionChip).toBeDisabled();
    expect(claimChip).toBeDisabled();
    expect(measurementChip).toBeDisabled();
    expect(claimChip).toHaveAttribute('data-empty', 'true');
    expect(measurementChip).toHaveAttribute('data-empty', 'true');
  });

  it('no longer renders the deleted "주어로서 / 목적어로서 / 생성 0" role labels', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(MIXED_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '출생아' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const summary = await screen.findByTestId('recall-fact-type-summary');
    expect(summary).not.toHaveTextContent(/주어로서/);
    expect(summary).not.toHaveTextContent(/목적어로서/);
    expect(summary).not.toHaveTextContent(/생성 0/);
    expect(screen.queryByTestId('entity-brief')).not.toBeInTheDocument();
  });
});


describe('RecallView — facets + drill-down (B-49)', () => {
  const FACETED: RecallResponse = {
    signature: 'As far as I know — 그래프에 4개 검증 사실이 있습니다',
    total: 4,
    facts: [
      {
        fact_uid: 'fn-a', claim: 'SpaceX raised 85.7B USD.', claim_en: null,
        subject_uid: 'uid-spacex', subject_label: 'SpaceX',
        predicate: 'total_funds_raised',
        object_value: '85.7 billion USD', object_label: null,
        source_uids: [], validated_at: new Date('2026-06-15T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.91, match_kind: 'embedding',
      },
    ],
    facets: {
      entities: {
        organization: [
          { uid: 'uid-spacex', name: 'SpaceX', count: 3 },
          { uid: 'uid-goldman', name: 'Goldman Sachs', count: 2 },
        ],
        person: [
          { uid: 'uid-elon', name: 'Elon Musk', count: 1 },
        ],
        place: [],
        other: [],
      },
      predicates: [
        { name: 'total_funds_raised', count: 1 },
        { name: 'is_underwriter_for', count: 2 },
      ],
    },
  };

  it('renders the right-rail facet panel with class buckets', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    expect(await screen.findByTestId('facet-panel')).toBeInTheDocument();
    expect(screen.getByTestId('facet-bucket-organization')).toHaveTextContent('SpaceX');
    expect(screen.getByTestId('facet-bucket-organization')).toHaveTextContent('Goldman Sachs');
    expect(screen.getByTestId('facet-bucket-person')).toHaveTextContent('Elon Musk');
    expect(screen.getByTestId('facet-bucket-place')).toHaveTextContent('(없음)');
    expect(screen.getByTestId('facet-predicate-total_funds_raised')).toBeInTheDocument();
  });

  it('clicking an entity bar triggers a second recall call with entity filter', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));

    // Mock the second response (drill-down).
    const DRILLDOWN: RecallResponse = {
      ...FACETED,
      signature: 'As far as I know — 그래프에 2개 검증 사실이 있습니다',
      total: 2,
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(DRILLDOWN);

    fireEvent.click(await screen.findByTestId('facet-entity-uid-spacex'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(2));

    const secondCall = (api.recall as ReturnType<typeof vi.fn>).mock.calls[1];
    expect(secondCall[0]).toBe('ks-1');
    expect(secondCall[1]).toBe('SpaceX');
    expect(secondCall[2]).toEqual(expect.objectContaining({ entity: ['uid-spacex'] }));
  });

  it('renders an active filter chip after drill-down + removes on ✕', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));

    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(await screen.findByTestId('facet-entity-uid-goldman'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(2));

    const chip = await screen.findByTestId('filter-chip-uid-goldman');
    expect(chip).toHaveTextContent('Goldman Sachs');
    expect(chip).toHaveTextContent('조직');

    // ✕ removes only that chip and triggers a fresh recall.
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(screen.getByTestId('filter-chip-uid-goldman-remove'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(3));
    expect((api.recall as ReturnType<typeof vi.fn>).mock.calls[2][2]).toEqual(expect.objectContaining({ entity: [] }));
  });

  it('"모두 지우기" wipes the entity filter array', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));

    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(await screen.findByTestId('facet-entity-uid-spacex'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(2));

    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(await screen.findByTestId('facet-entity-uid-goldman'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(3));

    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(screen.getByTestId('filter-clear-all'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(4));
    expect((api.recall as ReturnType<typeof vi.fn>).mock.calls[3][2]).toEqual(expect.objectContaining({ entity: [] }));
    expect(screen.queryByTestId('active-filter-chips')).toBeNull();
  });

  it('toggling an entity bar twice removes it (idempotent toggle)', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));

    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(await screen.findByTestId('facet-entity-uid-spacex'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(2));
    expect((api.recall as ReturnType<typeof vi.fn>).mock.calls[1][2]).toEqual(expect.objectContaining({ entity: ['uid-spacex'] }));

    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(await screen.findByTestId('facet-entity-uid-spacex'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(3));
    expect((api.recall as ReturnType<typeof vi.fn>).mock.calls[2][2]).toEqual(expect.objectContaining({ entity: [] }));
  });
});

describe('RecallView — left search controls (B-50)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ★ helper: render + run an initial recall so the controls have a
  // submittedQuery to attach to. Subsequent control changes will
  // re-fire recall against that query.
  // B-60: the search controls live in the power rail, so flip into
  // power mode immediately after render — the toggle has no effect on
  // the recall call shape (mode is pure layout).
  async function bootstrap() {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));
    // B-50-fix: initial call carries default controls. `matchKinds`
    // is intentionally absent — embedding is the search mode and
    // entity-link expansion always runs server-side.
    const firstOpts = (api.recall as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(firstOpts).toEqual(
      expect.objectContaining({
        entity: [],
        scoreThreshold: 0.72,
      }),
    );
    expect(firstOpts).not.toHaveProperty('matchKinds');
  }

  it('renders the four control groups in the left rail', async () => {
    await bootstrap();
    expect(screen.getByTestId('search-controls')).toBeInTheDocument();
    expect(screen.getByTestId('control-threshold-slider')).toBeInTheDocument();
    expect(screen.getByTestId('control-date-from')).toBeInTheDocument();
    expect(screen.getByTestId('control-date-to')).toBeInTheDocument();
    expect(screen.getByTestId('control-match-embedding')).toBeInTheDocument();
    expect(screen.getByTestId('control-match-entity-link')).toBeInTheDocument();
    expect(screen.getByTestId('control-keyword2')).toBeInTheDocument();
    // ★ default threshold value rendered next to the slider
    expect(screen.getByTestId('control-threshold-value')).toHaveTextContent('0.72');
  });

  it('★ similarity slider change re-fires recall with score_threshold', async () => {
    await bootstrap();
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);
    fireEvent.change(screen.getByTestId('control-threshold-slider'), {
      target: { value: '0.85' },
    });
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(2));
    const opts = (api.recall as ReturnType<typeof vi.fn>).mock.calls[1][2];
    expect(opts.scoreThreshold).toBeCloseTo(0.85, 2);
    // and the rendered value updates in step
    expect(screen.getByTestId('control-threshold-value')).toHaveTextContent('0.85');
  });

  it('★ date range change re-fires recall with date_from/date_to ISO', async () => {
    await bootstrap();
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);
    fireEvent.change(screen.getByTestId('control-date-from'), {
      target: { value: '2026-01-01' },
    });
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(2));
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);
    fireEvent.change(screen.getByTestId('control-date-to'), {
      target: { value: '2026-12-31' },
    });
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(3));
    const opts = (api.recall as ReturnType<typeof vi.fn>).mock.calls[2][2];
    // start-of-day on date_from, end-of-day on date_to — inclusive window
    expect(opts.dateFrom).toBe('2026-01-01T00:00:00Z');
    expect(opts.dateTo).toBe('2026-12-31T23:59:59Z');
  });

  it('★ 유사도 체크박스는 검색 모드라 항상 켜져 있고 비활성화', async () => {
    await bootstrap();
    const embeddingCheckbox = screen.getByTestId(
      'control-match-embedding-checkbox',
    ) as HTMLInputElement;
    expect(embeddingCheckbox).toBeDisabled();
    expect(embeddingCheckbox.checked).toBe(true);
  });

  it('★ 🔗 엔티티 연결 토글은 클라이언트 표시 필터 (재검색 안 함)', async () => {
    // Hand-craft a hit with one embedding + one entity_link fact so we
    // can prove the latter disappears from the rendered list when the
    // toggle is off — without any second recall round-trip.
    const MIXED: RecallResponse = {
      signature: 'As far as I know — 그래프에 2개 검증 사실이 있습니다',
      total: 2,
      facts: [
        {
          fact_uid: 'fn-emb',
          claim: '한국은행 기준금리는 3.0%였다.',
          claim_en: null,
          subject_uid: 'uid-bok',
          predicate: 'base_rate',
          object_value: '3.0%',
          source_uids: [],
          validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
          validator_id: 'u',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.92,
          match_kind: 'embedding',
        },
        {
          fact_uid: 'fn-link',
          claim: 'BOK governor announced the decision.',
          claim_en: null,
          subject_uid: 'uid-gov',
          predicate: 'announced',
          object_value: 'rate decision',
          source_uids: [],
          validated_at: new Date('2026-06-02T10:00:00Z').toISOString(),
          validator_id: 'u',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.0,
          match_kind: 'entity_link',
        },
      ],
    };

    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(MIXED);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'BoK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));

    // Both rendered initially.
    expect(screen.getByTestId('recall-fact-fn-emb')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-fn-link')).toBeInTheDocument();

    // Toggle off — the entity-link row disappears WITHOUT any
    // additional API call.
    fireEvent.click(screen.getByTestId('control-match-entity-link-checkbox'));
    await waitFor(() =>
      expect(screen.queryByTestId('recall-fact-fn-link')).toBeNull(),
    );
    expect(screen.getByTestId('recall-fact-fn-emb')).toBeInTheDocument();
    expect(api.recall).toHaveBeenCalledTimes(1);

    // Toggle back on — the row returns, still no extra call.
    fireEvent.click(screen.getByTestId('control-match-entity-link-checkbox'));
    expect(screen.getByTestId('recall-fact-fn-link')).toBeInTheDocument();
    expect(api.recall).toHaveBeenCalledTimes(1);
  });

  it('★ secondary keyword filters in-result without a second recall call', async () => {
    await bootstrap();
    // After the initial recall, BOTH RECALL_HIT facts are rendered.
    expect(screen.getByTestId('recall-fact-fn-1')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-fn-2')).toBeInTheDocument();

    // Typing a keyword that matches only fn-1 hides fn-2 — no API call.
    fireEvent.change(screen.getByTestId('control-keyword2'), {
      target: { value: '기준금리' },
    });
    await waitFor(() =>
      expect(screen.queryByTestId('recall-fact-fn-2')).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId('recall-fact-fn-1')).toBeInTheDocument();
    // Still exactly one call (the initial recall).
    expect(api.recall).toHaveBeenCalledTimes(1);
  });

  it('★ secondary keyword that matches nothing shows the empty hint', async () => {
    await bootstrap();
    fireEvent.change(screen.getByTestId('control-keyword2'), {
      target: { value: 'zzz-no-such-claim' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('recall-keyword-empty')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('recall-fact-fn-1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('recall-fact-fn-2')).not.toBeInTheDocument();
  });

  it('★ control changes preserve the active entity filter (AND combine)', async () => {
    // Use a self-contained faceted response so a drill-down chip can
    // be applied; the goal is to prove the entity filter survives a
    // later control change (AND-combine, not OR/reset).
    const FACETED: RecallResponse = {
      signature: 'As far as I know — 그래프에 1개 검증 사실이 있습니다',
      total: 1,
      facts: [{
        fact_uid: 'fn-a', claim: 'SpaceX raised 85.7B USD.', claim_en: null,
        subject_uid: 'uid-spacex', subject_label: 'SpaceX',
        predicate: 'total_funds_raised',
        object_value: '85.7 billion USD', object_label: null,
        source_uids: [], validated_at: new Date('2026-06-15T09:00:00Z').toISOString(),
        validator_id: 'u', validation_method: 'manual', knowledge_space_id: 'ks-1',
        negation_flag: false, negation_scope: null, score: 0.91, match_kind: 'embedding',
      }],
      facets: {
        entities: {
          organization: [{ uid: 'uid-spacex', name: 'SpaceX', count: 1 }],
          person: [], place: [], other: [],
        },
        predicates: [{ name: 'total_funds_raised', count: 1 }],
      },
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'SpaceX' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));

    // Drill into uid-spacex
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.click(await screen.findByTestId('facet-entity-uid-spacex'));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(2));

    // Now change the threshold — entity filter MUST survive
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(FACETED);
    fireEvent.change(screen.getByTestId('control-threshold-slider'), {
      target: { value: '0.80' },
    });
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(3));
    const opts = (api.recall as ReturnType<typeof vi.fn>).mock.calls[2][2];
    expect(opts).toEqual(
      expect.objectContaining({
        entity: ['uid-spacex'],
        scoreThreshold: 0.8,
      }),
    );
  });
});


describe('RecallView — fact detail panel (B-48b)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const detailWithTwoSources = {
    fact: {
      fact_uid: 'fn-1',
      claim: '한국은행 기준금리는 2024년 12월 기준 3.0%였다.',
      claim_en: null,
      subject_uid: 'uid-bok',
      subject_label: '한국은행',
      predicate: 'base_rate',
      object_value: '3.0%',
      object_label: null,
      validated_at: '2026-06-01T10:00:00Z',
      retracted_at: null,
      retracted_by: null,
      edit_history: [],
    },
    entities: [
      { uid: 'uid-bok', name: '한국은행', class: 'organization', role: 'subject', aliases: [] },
    ],
    sources: [
      {
        source_uid: 'src-A',
        source_job_id: 'job-A',
        url: 'https://hankyung.com/a/1',
        domain: 'hankyung.com',
        captured_at: '2026-05-28T10:00:00Z',
        source_type: 'web_article',
        snapshot_available: true,
      },
      {
        source_uid: 'src-B',
        source_job_id: 'job-B',
        url: 'https://yna.co.kr/b/2',
        domain: 'yna.co.kr',
        captured_at: '2026-05-30T10:00:00Z',
        source_type: 'web_article',
        snapshot_available: false,
      },
    ],
  };

  // B-60: a few tests below assert the facet panel stays mounted with
  // the modal open. Flip into power mode in the shared bootstrap so
  // the right rail is present from the first assertion.
  async function bootstrap() {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), { target: { value: 'BoK' } });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));
  }

  it('★ clicking a fact card opens the detail modal with sources + trust badge', async () => {
    await bootstrap();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    // B-48c: facet panel stays visible always; modal opens on top.
    expect(screen.getByTestId('facet-panel')).toBeInTheDocument();
    expect(screen.queryByTestId('fact-detail-modal')).toBeNull();

    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await waitFor(() => expect(api.getFactDetail).toHaveBeenCalledWith('ks-1', 'fn-1'));

    // Modal renders ABOVE the facet panel — the facet stays mounted
    // so the user's drill-down state is never thrown away.
    expect(screen.getByTestId('facet-panel')).toBeInTheDocument();
    const modal = await screen.findByTestId('fact-detail-modal');
    expect(modal).toBeInTheDocument();
    expect(modal).toHaveAttribute('role', 'dialog');
    expect(modal).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByTestId('fact-detail-claim')).toHaveTextContent('한국은행 기준금리');
    // ★ both sources listed with their domains
    expect(screen.getByTestId('fact-detail-source-src-A')).toHaveTextContent('hankyung.com');
    expect(screen.getByTestId('fact-detail-source-src-B')).toHaveTextContent('yna.co.kr');
    // ★ trust badge surfaces for ≥2 sources
    expect(screen.getByTestId('fact-detail-trust-badge')).toBeInTheDocument();
  });

  it('★ X 닫기 버튼은 모달만 닫고 facet 패널은 그대로', async () => {
    await bootstrap();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');

    fireEvent.click(screen.getByTestId('fact-detail-close'));
    expect(screen.queryByTestId('fact-detail-modal')).toBeNull();
    expect(screen.getByTestId('facet-panel')).toBeInTheDocument();
  });

  it('★ ESC 키로 모달 닫기', async () => {
    await bootstrap();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('fact-detail-modal')).toBeNull(),
    );
    expect(screen.getByTestId('facet-panel')).toBeInTheDocument();
  });

  it('★ 바깥 클릭(backdrop)으로 모달 닫기', async () => {
    await bootstrap();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    const modal = await screen.findByTestId('fact-detail-modal');

    // Click the backdrop itself (the overlay div, not its content).
    fireEvent.click(modal);
    expect(screen.queryByTestId('fact-detail-modal')).toBeNull();
  });

  it('모달 내용을 클릭해도 닫히지 않는다', async () => {
    await bootstrap();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');

    // Click the inner content — it bubbles to the backdrop but the
    // close handler only fires when target === currentTarget.
    fireEvent.click(screen.getByTestId('fact-detail-modal-content'));
    expect(screen.queryByTestId('fact-detail-modal')).toBeInTheDocument();
  });

  it('★ "이 출처만 떼기" calls detachSource and refreshes', async () => {
    await bootstrap();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');

    // After detach, the refresh fetches a body with one fewer source.
    const afterDetach = {
      ...detailWithTwoSources,
      sources: [detailWithTwoSources.sources[1]],
    };
    (api.detachSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fact_uid: 'fn-1', retracted_at: null,
      source_uids: ['src-B'], auto_retracted: false,
    });
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(afterDetach);
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);

    fireEvent.click(screen.getByTestId('fact-detail-detach-src-A'));
    await waitFor(() =>
      expect(api.detachSource).toHaveBeenCalledWith('ks-1', 'fn-1', 'src-A'),
    );
    // The trust badge should disappear when count drops to 1.
    await waitFor(() =>
      expect(screen.queryByTestId('fact-detail-trust-badge')).toBeNull(),
    );
    expect(screen.queryByTestId('fact-detail-source-src-A')).toBeNull();
    expect(screen.getByTestId('fact-detail-source-src-B')).toBeInTheDocument();
  });

  it('★ "사실 철회" triggers retract + retracted banner appears on refresh', async () => {
    await bootstrap();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');

    const retracted = {
      ...detailWithTwoSources,
      fact: {
        ...detailWithTwoSources.fact,
        retracted_at: '2026-06-18T05:00:00Z',
        retracted_by: 'u-1',
      },
    };
    (api.retractFact as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fact_uid: 'fn-1', retracted_at: '2026-06-18T05:00:00Z',
      source_uids: ['src-A','src-B'], auto_retracted: false,
    });
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(retracted);
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);

    fireEvent.click(screen.getByTestId('fact-detail-retract'));
    await waitFor(() => expect(api.retractFact).toHaveBeenCalledWith('ks-1', 'fn-1'));
    expect(await screen.findByTestId('fact-detail-retracted-banner')).toBeInTheDocument();
    // The button swaps to "복구" on the retracted state.
    expect(screen.getByTestId('fact-detail-restore')).toBeInTheDocument();
    expect(screen.queryByTestId('fact-detail-retract')).toBeNull();
  });

  it('★ "복구" reverses retract', async () => {
    await bootstrap();
    const retracted = {
      ...detailWithTwoSources,
      fact: {
        ...detailWithTwoSources.fact,
        retracted_at: '2026-06-18T05:00:00Z',
        retracted_by: 'u-1',
      },
    };
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(retracted);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');
    expect(screen.getByTestId('fact-detail-restore')).toBeInTheDocument();

    (api.restoreFact as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fact_uid: 'fn-1', retracted_at: null,
      source_uids: ['src-A','src-B'], auto_retracted: false,
    });
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailWithTwoSources);
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);

    fireEvent.click(screen.getByTestId('fact-detail-restore'));
    await waitFor(() => expect(api.restoreFact).toHaveBeenCalledWith('ks-1', 'fn-1'));
    await waitFor(() =>
      expect(screen.queryByTestId('fact-detail-retracted-banner')).toBeNull(),
    );
    expect(screen.getByTestId('fact-detail-retract')).toBeInTheDocument();
  });

  it('detaching the last source flips the panel into retracted state', async () => {
    await bootstrap();
    const oneSource = {
      ...detailWithTwoSources,
      sources: [detailWithTwoSources.sources[0]],
    };
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(oneSource);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');

    // Detach returns auto_retracted=true; refresh shows retracted + no sources.
    const afterAuto = {
      ...detailWithTwoSources,
      fact: {
        ...detailWithTwoSources.fact,
        retracted_at: '2026-06-18T05:00:00Z',
        retracted_by: 'u-1',
      },
      sources: [],
    };
    (api.detachSource as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fact_uid: 'fn-1', retracted_at: '2026-06-18T05:00:00Z',
      source_uids: [], auto_retracted: true,
    });
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(afterAuto);
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT);

    fireEvent.click(screen.getByTestId('fact-detail-detach-src-A'));
    await waitFor(() => expect(api.detachSource).toHaveBeenCalled());
    expect(await screen.findByTestId('fact-detail-retracted-banner')).toBeInTheDocument();
    expect(screen.getByTestId('fact-detail-restore')).toBeInTheDocument();
  });

  it('shows no trust badge for a single-source fact', async () => {
    await bootstrap();
    const oneSource = {
      ...detailWithTwoSources,
      sources: [detailWithTwoSources.sources[0]],
    };
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(oneSource);
    fireEvent.click(screen.getByTestId('recall-fact-fn-1-open-detail'));
    await screen.findByTestId('fact-detail-modal');
    expect(screen.queryByTestId('fact-detail-trust-badge')).toBeNull();
    expect(screen.getByTestId('fact-detail-source-src-A')).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// B-60 — simple / power mode toggle. Simple is the default; the
// search-controls rail and the facet rail are only mounted in power
// mode. Both modes share the same recall response (no extra API
// calls), and the predicate Korean label survives the simple-mode
// shrink because the FactCard component is reused verbatim.
// ---------------------------------------------------------------------------

describe('RecallView — B-60 simple/power mode toggle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A response that exercises the Korean predicate label so we can
  // sanity-check the B-56 wire in simple mode.
  const SIMPLE_KO: RecallResponse = {
    signature: 'As far as I know — 그래프에 1개 검증 사실이 있습니다',
    total: 1,
    facts: [
      {
        fact_uid: 'fn-simple-ko',
        claim: '구청은 노후 옹벽을 철거하기로 결정했다.',
        claim_en: null,
        subject_uid: 'obj-gu',
        predicate: 'decided_to_remove',
        object_value: '노후 옹벽',
        source_uids: [],
        validated_at: new Date('2026-06-15T10:00:00Z').toISOString(),
        validator_id: 'user-x',
        validation_method: 'manual',
        knowledge_space_id: 'ks-1',
        negation_flag: false,
        negation_scope: null,
        score: 0.88,
      },
    ],
  };

  it('default mode is simple — left filter panel is NOT in the document on first render', () => {
    render(<RecallView spaceId="ks-1" />);
    // The search input is always present (it lives in the shell).
    expect(screen.getByLabelText('recall query')).toBeInTheDocument();
    // The toggle button is present and announces "going to power".
    const toggle = screen.getByTestId('recall-mode-toggle');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    // Power-mode rails are not mounted.
    expect(screen.queryByTestId('search-controls')).toBeNull();
    expect(screen.queryByTestId('facet-panel')).toBeNull();
    expect(screen.queryByTestId('recall-power-body')).toBeNull();
  });

  it('toggle switches to power mode — left filter panel APPEARS after click', () => {
    render(<RecallView spaceId="ks-1" />);
    expect(screen.queryByTestId('search-controls')).toBeNull();
    fireEvent.click(screen.getByTestId('recall-mode-toggle'));
    expect(screen.getByTestId('search-controls')).toBeInTheDocument();
    expect(screen.getByTestId('recall-power-body')).toBeInTheDocument();
    // aria-pressed flips to true so screen readers know the state changed.
    expect(screen.getByTestId('recall-mode-toggle')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('toggle back to simple — left filter panel disappears again', () => {
    render(<RecallView spaceId="ks-1" />);
    fireEvent.click(screen.getByTestId('recall-mode-toggle'));
    expect(screen.getByTestId('search-controls')).toBeInTheDocument();
    // Click again → simple.
    fireEvent.click(screen.getByTestId('recall-mode-toggle'));
    expect(screen.queryByTestId('search-controls')).toBeNull();
    expect(screen.queryByTestId('facet-panel')).toBeNull();
    expect(screen.queryByTestId('recall-power-body')).toBeNull();
    expect(screen.getByTestId('recall-mode-toggle')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('predicate Korean label still displays in simple mode (B-56 wire survives)', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SIMPLE_KO);
    render(<RecallView spaceId="ks-1" />);
    // Stay in simple mode — do NOT click the toggle.
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '철거' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const card = await screen.findByTestId('recall-fact-fn-simple-ko');
    // Korean label is visible — the predicateLabel() helper rendered.
    expect(card.textContent).toContain('철거하기로 결정한 것은');
    // The English canonical key is NOT leaked.
    expect(card.textContent).not.toContain('decided_to_remove');
    // We never mounted the power rails.
    expect(screen.queryByTestId('search-controls')).toBeNull();
    expect(screen.queryByTestId('facet-panel')).toBeNull();
  });

  it('fact card click opens FactDetailModal in BOTH modes', async () => {
    const detail = {
      fact: {
        fact_uid: 'fn-simple-ko',
        claim: '구청은 노후 옹벽을 철거하기로 결정했다.',
        claim_en: null,
        subject_uid: 'obj-gu',
        subject_label: '구청',
        predicate: 'decided_to_remove',
        object_value: '노후 옹벽',
        object_label: null,
        validated_at: '2026-06-15T10:00:00Z',
        retracted_at: null,
        retracted_by: null,
        edit_history: [],
      },
      entities: [
        { uid: 'obj-gu', name: '구청', class: 'organization', role: 'subject', aliases: [] },
      ],
      sources: [],
    };

    // --- 1) simple mode: click the card → modal opens.
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(SIMPLE_KO);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '철거' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detail);
    fireEvent.click(
      await screen.findByTestId('recall-fact-fn-simple-ko-open-detail'),
    );
    await waitFor(() =>
      expect(api.getFactDetail).toHaveBeenCalledWith('ks-1', 'fn-simple-ko'),
    );
    expect(await screen.findByTestId('fact-detail-modal')).toBeInTheDocument();

    // Close the modal so the next assertion starts clean.
    fireEvent.click(screen.getByTestId('fact-detail-close'));
    expect(screen.queryByTestId('fact-detail-modal')).toBeNull();

    // --- 2) flip to power mode: modal still opens from the same card.
    fireEvent.click(screen.getByTestId('recall-mode-toggle'));
    expect(screen.getByTestId('search-controls')).toBeInTheDocument();
    expect(screen.getByTestId('facet-panel')).toBeInTheDocument();
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detail);
    fireEvent.click(
      screen.getByTestId('recall-fact-fn-simple-ko-open-detail'),
    );
    await waitFor(() => expect(api.getFactDetail).toHaveBeenCalledTimes(2));
    expect(await screen.findByTestId('fact-detail-modal')).toBeInTheDocument();
  });
});


// ---------------------------------------------------------------------------
// feat/fact-detail-modify — PO directive 2026-06-22.
// The Recall Fact-detail modal must let the user correct surface-level
// errors in place (typo in claim, off gloss for predicate). Identity
// fields (subject_uid / predicate_code / validation_method) stay
// immutable here — structural changes require a retract + re-validate
// path which lives in Decide.
// ---------------------------------------------------------------------------

describe('RecallView — fact detail MODIFY (feat/fact-detail-modify)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const RECALL_HIT_FOR_MODIFY: RecallResponse = {
    signature: 'As far as I know — 그래프에 1개 검증 사실이 있습니다',
    total: 1,
    facts: [
      {
        fact_uid: 'fn-edit-1',
        claim: 'SpaceX는 7,500만 달러를 조달했다.',
        claim_en: null,
        subject_uid: 'uid-spacex',
        subject_label: 'SpaceX',
        predicate: 'raised',
        object_value: '75M USD',
        object_label: null,
        source_uids: [],
        validated_at: '2026-06-15T10:00:00Z',
        validator_id: 'u-1',
        validation_method: 'manual',
        knowledge_space_id: 'ks-1',
        negation_flag: false,
        negation_scope: null,
        score: 0.91,
      },
    ],
  };

  const detailToEdit = {
    fact: {
      fact_uid: 'fn-edit-1',
      claim: 'SpaceX는 7,500만 달러를 조달했다.',
      claim_en: null,
      subject_uid: 'uid-spacex',
      subject_label: 'SpaceX',
      predicate: 'raised',
      object_value: '75M USD',
      object_label: null,
      validated_at: '2026-06-15T10:00:00Z',
      retracted_at: null,
      retracted_by: null,
      edit_history: [],
    },
    entities: [
      { uid: 'uid-spacex', name: 'SpaceX', class: 'organization',
        role: 'subject' as const, aliases: [] },
    ],
    sources: [],
  };

  async function openDetail() {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT_FOR_MODIFY);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(detailToEdit);
    fireEvent.click(
      await screen.findByTestId('recall-fact-fn-edit-1-open-detail'),
    );
    await screen.findByTestId('fact-detail-modal');
  }

  it('★ 수정 버튼이 상세 모달에 노출된다 (read mode)', async () => {
    await openDetail();
    expect(screen.getByTestId('fact-detail-edit')).toBeInTheDocument();
    // Read-mode chrome present.
    expect(screen.getByTestId('fact-detail-subject')).toBeInTheDocument();
    expect(screen.getByTestId('fact-detail-object')).toBeInTheDocument();
    // Edit form NOT rendered until 수정 click.
    expect(screen.queryByTestId('fact-detail-edit-form')).toBeNull();
  });

  it('★ 수정 클릭 → 편집 모드 진입 (form 렌더, S/P/O chip 사라짐)', async () => {
    await openDetail();
    fireEvent.click(screen.getByTestId('fact-detail-edit'));

    // Form fields show up.
    expect(screen.getByTestId('fact-detail-edit-form')).toBeInTheDocument();
    expect(screen.getByTestId('fact-detail-edit-claim')).toBeInTheDocument();
    expect(screen.getByTestId('fact-detail-edit-predicate')).toBeInTheDocument();
    expect(screen.getByTestId('fact-detail-edit-object')).toBeInTheDocument();

    // Subject (identity) is NOT editable — the chip is replaced by
    // the form so the read-mode subject testid is gone.
    expect(screen.queryByTestId('fact-detail-subject')).toBeNull();

    // 수정 button itself disappears while editing.
    expect(screen.queryByTestId('fact-detail-edit')).toBeNull();
  });

  it('★ 저장 클릭 → modifyFact API call 발생, 모달은 갱신된 detail 로 swap', async () => {
    await openDetail();
    fireEvent.click(screen.getByTestId('fact-detail-edit'));

    // Edit the claim.
    const claimInput = screen.getByTestId('fact-detail-edit-claim');
    fireEvent.change(claimInput, {
      target: { value: 'SpaceX는 8,500만 달러를 조달했다.' },
    });

    const refreshedDetail = {
      ...detailToEdit,
      fact: {
        ...detailToEdit.fact,
        claim: 'SpaceX는 8,500만 달러를 조달했다.',
      },
    };
    (api.modifyFact as ReturnType<typeof vi.fn>).mockResolvedValueOnce(refreshedDetail);
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT_FOR_MODIFY);

    fireEvent.click(screen.getByTestId('fact-detail-edit-save'));

    await waitFor(() =>
      expect(api.modifyFact).toHaveBeenCalledWith(
        'ks-1', 'fn-edit-1',
        expect.objectContaining({ claim: 'SpaceX는 8,500만 달러를 조달했다.' }),
      ),
    );
    // Modal swaps to refreshed detail; the edit form disappears.
    await waitFor(() =>
      expect(screen.queryByTestId('fact-detail-edit-form')).toBeNull(),
    );
    expect(screen.getByTestId('fact-detail-claim')).toHaveTextContent(
      '8,500만 달러',
    );
  });

  it('★ 취소 클릭 → API 호출 없이 read mode 로 복귀', async () => {
    await openDetail();
    fireEvent.click(screen.getByTestId('fact-detail-edit'));

    fireEvent.change(screen.getByTestId('fact-detail-edit-claim'), {
      target: { value: '다른 텍스트로 변경' },
    });

    fireEvent.click(screen.getByTestId('fact-detail-edit-cancel'));

    // Edit form gone, read-mode chrome back.
    expect(screen.queryByTestId('fact-detail-edit-form')).toBeNull();
    expect(screen.getByTestId('fact-detail-subject')).toBeInTheDocument();
    expect(screen.getByTestId('fact-detail-edit')).toBeInTheDocument();
    // No PATCH was made.
    expect(api.modifyFact).not.toHaveBeenCalled();
  });

  it('편집 모드에서 사실 철회 버튼은 비활성화 — 두 액션이 동시에 일어나지 않음', async () => {
    await openDetail();
    fireEvent.click(screen.getByTestId('fact-detail-edit'));
    const retractBtn = screen.getByTestId('fact-detail-retract') as HTMLButtonElement;
    expect(retractBtn.disabled).toBe(true);
  });

  it('철회된 사실에서는 수정 버튼이 노출되지 않는다', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(RECALL_HIT_FOR_MODIFY);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalledTimes(1));

    const retracted = {
      ...detailToEdit,
      fact: {
        ...detailToEdit.fact,
        retracted_at: '2026-06-20T05:00:00Z',
        retracted_by: 'u-1',
      },
    };
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(retracted);
    fireEvent.click(
      await screen.findByTestId('recall-fact-fn-edit-1-open-detail'),
    );
    await screen.findByTestId('fact-detail-modal');

    // Retracted banner present, 수정 button absent — must restore first.
    expect(screen.getByTestId('fact-detail-retracted-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('fact-detail-edit')).toBeNull();
    expect(screen.getByTestId('fact-detail-restore')).toBeInTheDocument();
  });

  it('수정하지 않고 저장 클릭 시 PATCH 호출 없이 read mode 로 복귀 (no-op)', async () => {
    await openDetail();
    fireEvent.click(screen.getByTestId('fact-detail-edit'));
    // No field change — submit immediately.
    fireEvent.click(screen.getByTestId('fact-detail-edit-save'));

    // Should NOT have called modifyFact.
    expect(api.modifyFact).not.toHaveBeenCalled();
    // Returns to read mode.
    await waitFor(() =>
      expect(screen.queryByTestId('fact-detail-edit-form')).toBeNull(),
    );
    expect(screen.getByTestId('fact-detail-edit')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// feat/recall-fact-type-summary — fact_type 별 요약 박스 + chip 필터 +
// 페이지네이션. PO live evidence (2026-06-24): "'삼성전기' 검색하면
// 주어로서(action 층위), claim 몇 건, measurement 몇 건 이런게 요약 박스에
// 나와야 하고 나머지는 페이지네이션 리스트업 하는게 맞다."
// ---------------------------------------------------------------------------

// Helper: build a RecallFact stub. Defaults to action layer.
function makeFact(
  uid: string,
  factType: 'action' | 'claim' | 'measurement' | null = 'action',
  score = 0.8,
): import('@/lib/types').RecallFact {
  return {
    fact_uid: uid,
    claim: `${uid} — 삼성전기 관련 사실 (${factType ?? 'legacy'})`,
    claim_en: null,
    subject_uid: 'obj-sem',
    subject_label: '삼성전기',
    predicate: 'reported',
    object_value: '실적',
    source_uids: [],
    validated_at: new Date('2026-06-15T10:00:00Z').toISOString(),
    validator_id: 'user-x',
    validation_method: 'manual',
    knowledge_space_id: 'ks-1',
    negation_flag: false,
    negation_scope: null,
    score,
    fact_type: factType,
  };
}

describe('RecallView — fact_type summary box + pagination', () => {
  function buildResponse(opts: {
    actions: number;
    claims: number;
    measurements: number;
  }): RecallResponse {
    const facts: import('@/lib/types').RecallFact[] = [];
    for (let i = 0; i < opts.actions; i++) {
      facts.push(makeFact(`a-${i}`, 'action', 0.9 - i * 0.001));
    }
    for (let i = 0; i < opts.claims; i++) {
      facts.push(makeFact(`c-${i}`, 'claim', 0.85 - i * 0.001));
    }
    for (let i = 0; i < opts.measurements; i++) {
      facts.push(makeFact(`m-${i}`, 'measurement', 0.8 - i * 0.001));
    }
    const total = opts.actions + opts.claims + opts.measurements;
    return {
      signature: `As far as I know — 그래프에 ${total}개 검증 사실이 있습니다`,
      total,
      facts,
      facets: {
        entities: {
          organization: [
            { uid: 'obj-sem', name: '삼성전기', count: total },
          ],
          person: [],
          place: [],
          other: [],
        },
        predicates: [{ name: 'reported', count: total }],
        fact_types: {
          action: opts.actions,
          claim: opts.claims,
          measurement: opts.measurements,
        },
      },
    };
  }

  async function search(query = '삼성전기') {
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: query },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await screen.findByTestId('recall-fact-type-summary');
  }

  it('renders the summary box with action / claim / measurement counts', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse({ actions: 8, claims: 3, measurements: 1 }),
    );
    render(<RecallView spaceId="ks-1" />);
    await search();

    const summary = screen.getByTestId('recall-fact-type-summary');
    // Total chip pseudo-element shows the overall count from the
    // envelope's `total`, not just the visible page.
    expect(screen.getByTestId('recall-summary-total').textContent).toMatch(/12/);
    // Each layer chip shows its Korean label + the count from facets.
    expect(screen.getByTestId('recall-summary-count-action').textContent).toBe('8');
    expect(screen.getByTestId('recall-summary-count-claim').textContent).toBe('3');
    expect(screen.getByTestId('recall-summary-count-measurement').textContent).toBe('1');
    expect(summary.textContent).toContain('행동');
    expect(summary.textContent).toContain('발언');
    expect(summary.textContent).toContain('수치');
    // The PO's verbatim search term is echoed in the summary header so
    // the user has a clear "for this query" anchor.
    expect(summary.textContent).toContain('삼성전기');
  });

  it('clicking a fact_type chip filters the list to that layer', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse({ actions: 2, claims: 2, measurements: 1 }),
    );
    render(<RecallView spaceId="ks-1" />);
    await search();

    // Before filter: all 5 cards are in the DOM (within PAGE_SIZE).
    expect(screen.getByTestId('recall-fact-a-0')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-c-0')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-m-0')).toBeInTheDocument();

    // Click the claim chip.
    fireEvent.click(screen.getByTestId('recall-summary-chip-claim'));

    // Now only claim cards remain — action and measurement vanish.
    expect(screen.queryByTestId('recall-fact-a-0')).toBeNull();
    expect(screen.queryByTestId('recall-fact-m-0')).toBeNull();
    expect(screen.getByTestId('recall-fact-c-0')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-c-1')).toBeInTheDocument();

    // The clicked chip is marked active and the summary box exposes
    // the active filter as a data attribute so styling / tests can
    // both read it without DOM walking.
    expect(
      screen.getByTestId('recall-fact-type-summary').getAttribute('data-active-filter'),
    ).toBe('claim');
    expect(
      screen.getByTestId('recall-summary-chip-claim').getAttribute('data-active'),
    ).toBe('true');

    // Click the same chip again → filter clears, all cards return.
    fireEvent.click(screen.getByTestId('recall-summary-chip-claim'));
    expect(screen.getByTestId('recall-fact-a-0')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-m-0')).toBeInTheDocument();
    expect(
      screen.getByTestId('recall-fact-type-summary').getAttribute('data-active-filter'),
    ).toBe('');
  });

  it('renders a "더 보기" pagination control when results exceed the page size', async () => {
    // 25 action facts → first page is 20, "more" yields 5.
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse({ actions: 25, claims: 0, measurements: 0 }),
    );
    render(<RecallView spaceId="ks-1" />);
    await search();

    // First page: cards a-0 .. a-19 visible; a-20 .. a-24 not yet.
    expect(screen.getByTestId('recall-fact-a-0')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-a-19')).toBeInTheDocument();
    expect(screen.queryByTestId('recall-fact-a-20')).toBeNull();
    // Progress shows 20/25 — the underlying VISIBLE total (post-filter),
    // not the envelope total.
    expect(screen.getByTestId('recall-pagination-progress').textContent).toContain('20/25');
    const more = screen.getByTestId('recall-pagination-more');
    expect(more).toBeInTheDocument();

    fireEvent.click(more);

    // After "더 보기": a-20 .. a-24 enter the DOM; the more button
    // disappears because shown === total.
    expect(screen.getByTestId('recall-fact-a-24')).toBeInTheDocument();
    expect(screen.queryByTestId('recall-pagination-more')).toBeNull();
    expect(screen.getByTestId('recall-pagination-progress').textContent).toContain('25/25');
  });

  it('a new search resets the layer filter and pagination window', async () => {
    // First query: filter to claim, then run a second query.
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse({ actions: 5, claims: 5, measurements: 0 }),
    );
    render(<RecallView spaceId="ks-1" />);
    await search('삼성전기');
    fireEvent.click(screen.getByTestId('recall-summary-chip-claim'));
    expect(
      screen.getByTestId('recall-fact-type-summary').getAttribute('data-active-filter'),
    ).toBe('claim');

    // Run a second, distinct query — the filter should clear.
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse({ actions: 3, claims: 1, measurements: 2 }),
    );
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'LG에너지솔루션' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));

    await waitFor(() =>
      expect(
        screen.getByTestId('recall-fact-type-summary').getAttribute('data-active-filter'),
      ).toBe(''),
    );
    // Counts reflect the second response (3 actions / 1 claim / 2 measurements).
    expect(screen.getByTestId('recall-summary-count-action').textContent).toBe('3');
    expect(screen.getByTestId('recall-summary-count-claim').textContent).toBe('1');
    expect(screen.getByTestId('recall-summary-count-measurement').textContent).toBe('2');
    // The summary header echoes the new query.
    expect(
      screen.getByTestId('recall-fact-type-summary').textContent,
    ).toContain('LG에너지솔루션');
  });

  it('disables a layer chip when its count is 0 (no empty-filter trap)', async () => {
    // Only action facts: claim + measurement chips should be disabled.
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      buildResponse({ actions: 4, claims: 0, measurements: 0 }),
    );
    render(<RecallView spaceId="ks-1" />);
    await search();

    const claimChip = screen.getByTestId('recall-summary-chip-claim') as HTMLButtonElement;
    const measChip = screen.getByTestId('recall-summary-chip-measurement') as HTMLButtonElement;
    const actionChip = screen.getByTestId('recall-summary-chip-action') as HTMLButtonElement;
    expect(claimChip.disabled).toBe(true);
    expect(measChip.disabled).toBe(true);
    expect(actionChip.disabled).toBe(false);
    expect(claimChip.getAttribute('data-empty')).toBe('true');
    expect(measChip.getAttribute('data-empty')).toBe('true');
    expect(actionChip.getAttribute('data-empty')).toBe('false');

    // Clicking the disabled chip is a no-op — the active filter never
    // flips to 'claim' because the chip won't dispatch onClick.
    fireEvent.click(claimChip);
    expect(
      screen.getByTestId('recall-fact-type-summary').getAttribute('data-active-filter'),
    ).toBe('');
  });

  it('hides the pagination footer entirely when there are no results', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      signature: '검증된 사실이 없습니다',
      facts: [],
      total: 0,
      facets: {
        entities: { organization: [], person: [], place: [], other: [] },
        predicates: [],
        fact_types: { action: 0, claim: 0, measurement: 0 },
      },
    });
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '결과없는검색어' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await screen.findByTestId('recall-fact-type-summary');

    // The summary box still renders — it announces the all-zero state
    // so the user understands the query returned nothing in any layer.
    expect(screen.getByTestId('recall-summary-count-action').textContent).toBe('0');
    expect(screen.getByTestId('recall-summary-count-claim').textContent).toBe('0');
    expect(screen.getByTestId('recall-summary-count-measurement').textContent).toBe('0');
    // All chips are disabled.
    expect(
      (screen.getByTestId('recall-summary-chip-action') as HTMLButtonElement).disabled,
    ).toBe(true);
    // Pagination footer never mounts because total === 0.
    expect(screen.queryByTestId('recall-pagination')).toBeNull();
  });

  it('treats legacy facts (fact_type undefined / null) as action under the filter', async () => {
    // The backend signals 4 actions, but one of the facts has
    // fact_type=null (legacy capture before fact-claim-layer-v1).
    // The action chip filter must still include it.
    const response: RecallResponse = {
      signature: 'As far as I know — 그래프에 4개 검증 사실이 있습니다',
      total: 4,
      facts: [
        makeFact('legacy-1', null, 0.9),
        makeFact('a-modern', 'action', 0.85),
        makeFact('c-modern', 'claim', 0.8),
        makeFact('m-modern', 'measurement', 0.75),
      ],
      facets: {
        entities: {
          organization: [{ uid: 'obj-sem', name: '삼성전기', count: 4 }],
          person: [],
          place: [],
          other: [],
        },
        predicates: [{ name: 'reported', count: 4 }],
        fact_types: { action: 2, claim: 1, measurement: 1 },
      },
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    render(<RecallView spaceId="ks-1" />);
    await search();

    // Filter to action.
    fireEvent.click(screen.getByTestId('recall-summary-chip-action'));
    // Both the legacy and the modern action fact survive the filter.
    expect(screen.getByTestId('recall-fact-legacy-1')).toBeInTheDocument();
    expect(screen.getByTestId('recall-fact-a-modern')).toBeInTheDocument();
    // Claim and measurement rows are filtered out.
    expect(screen.queryByTestId('recall-fact-c-modern')).toBeNull();
    expect(screen.queryByTestId('recall-fact-m-modern')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// fact-display-unification — regression guards.
//
// PO escalation (2026-06-24): Decide and Recall used to render fact cards
// via TWO completely separate components, so the same fact looked totally
// different. This block pins three things:
//   (a) Recall list card renders the shared [CLAIM] / [MEASUREMENT] badge
//       AND the per-type strip (speaker / metric) — same surface Decide
//       has had since v0.2.0 step 1/2.
//   (b) Legacy facts (fact_type undefined / null) render with NO badge
//       and NO strip — back-compat guard for the dominant case.
//   (c) Recall list card and Recall detail modal both render the layer
//       signal so the same fact is consistent across all three surfaces.
// ---------------------------------------------------------------------------

describe('RecallView — fact-display-unification (Recall card uses shared badge+strip)', () => {
  const search = async () => {
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '검색' },
    });
    // The "Recall" string appears in multiple places (heading + button);
    // pin to the submit button specifically.
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() =>
      expect(screen.getByTestId('recall-signature')).toBeInTheDocument(),
    );
  };

  it('renders [CLAIM] badge + speaker/speech_act/content strip on the recall card', async () => {
    const response: RecallResponse = {
      signature: 'sig',
      total: 1,
      facts: [
        {
          fact_uid: 'fn-claim-r1',
          claim: '한국은행이 WGBI 추종자금 관련 발언을 했다.',
          claim_en: null,
          subject_uid: 'obj-bok',
          predicate: 'said',
          object_value: 'wgbi-statement',
          source_uids: [],
          validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
          validator_id: 'u',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.9,
          fact_type: 'claim',
          speaker_label: '한국은행',
          speech_act: '말했다',
          content_claim: 'WGBI 추종자금이 들어왔다.',
        },
      ],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    render(<RecallView spaceId="ks-1" />);
    await search();

    // Shared badge present on the recall card.
    expect(screen.getByTestId('fact-claim-badge-fn-claim-r1')).toBeInTheDocument();
    // Shared strip carries the PO format markers.
    const strip = screen.getByTestId('fact-claim-strip-fn-claim-r1');
    const speaker = strip.querySelector('strong');
    expect(speaker).not.toBeNull();
    expect(speaker!.textContent).toBe('한국은행');
    expect(speaker!.className).toMatch(/font-bold/);
    expect(strip.textContent).toContain('[말했다]:');
    expect(strip.textContent).toContain('“WGBI 추종자금이 들어왔다.”');
  });

  it('renders [MEASUREMENT] badge + metric/value/unit/as_of strip on the recall card', async () => {
    const response: RecallResponse = {
      signature: 'sig',
      total: 1,
      facts: [
        {
          fact_uid: 'fn-measure-r1',
          claim: 'ChatGPT MAU 는 8억 명이다.',
          claim_en: null,
          subject_uid: 'obj-cgpt',
          predicate: 'has_metric',
          object_value: '800000000',
          source_uids: [],
          validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
          validator_id: 'u',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.9,
          fact_type: 'measurement',
          metric: 'MAU',
          measurement_value: 800000000,
          measurement_unit: '명',
          as_of: '2026-03',
        },
      ],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    render(<RecallView spaceId="ks-1" />);
    await search();

    expect(screen.getByTestId('fact-measurement-badge-fn-measure-r1')).toBeInTheDocument();
    const strip = screen.getByTestId('fact-measurement-strip-fn-measure-r1');
    expect(strip).toHaveTextContent('MAU');
    expect(strip).toHaveTextContent('명');
    expect(strip).toHaveTextContent('2026-03');
    expect(screen.getByTestId('fact-measurement-prefix-fn-measure-r1')).toHaveTextContent('[MEASUREMENT]');
  });

  it('legacy facts (fact_type undefined) render with NO badge and NO strip on recall card', async () => {
    const response: RecallResponse = {
      signature: 'sig',
      total: 1,
      facts: [
        {
          fact_uid: 'fn-legacy',
          claim: '레거시 사실',
          claim_en: null,
          subject_uid: 'obj-x',
          predicate: 'did',
          object_value: 'y',
          source_uids: [],
          validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
          validator_id: 'u',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.9,
          // No fact_type field — legacy case.
        },
      ],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    render(<RecallView spaceId="ks-1" />);
    await search();

    // Card renders, but no fact_type signal.
    expect(screen.getByTestId('recall-fact-fn-legacy')).toBeInTheDocument();
    expect(screen.queryByTestId('fact-claim-badge-fn-legacy')).toBeNull();
    expect(screen.queryByTestId('fact-measurement-badge-fn-legacy')).toBeNull();
    expect(screen.queryByTestId('fact-claim-strip-fn-legacy')).toBeNull();
    expect(screen.queryByTestId('fact-measurement-strip-fn-legacy')).toBeNull();
  });

  it('detail modal renders [MEASUREMENT] badge + strip when the fact is a measurement', async () => {
    // PO (d) — the modal used to render a measurement fact as a plain
    // SPO arrow row with no badge / no strip. After unification + the
    // FactDetailHeader wire widening, the modal must carry the same
    // signal as the list card.
    const response: RecallResponse = {
      signature: 'sig',
      total: 1,
      facts: [
        {
          fact_uid: 'fn-modal-measure',
          claim: '검색 결과',
          claim_en: null,
          subject_uid: 'obj-cgpt',
          predicate: 'has_metric',
          object_value: '800000000',
          source_uids: [],
          validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
          validator_id: 'u',
          validation_method: 'manual',
          knowledge_space_id: 'ks-1',
          negation_flag: false,
          negation_scope: null,
          score: 0.9,
          fact_type: 'measurement',
          metric: 'MAU',
          measurement_value: 800000000,
          measurement_unit: '명',
          as_of: '2026-03',
        },
      ],
    };
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    (api.getFactDetail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      fact: {
        fact_uid: 'fn-modal-measure',
        claim: 'ChatGPT MAU 는 8억 명이다.',
        claim_en: null,
        subject_uid: 'obj-cgpt',
        subject_label: 'ChatGPT',
        predicate: 'has_metric',
        object_value: '800000000',
        object_label: null,
        validated_at: new Date('2026-06-01T10:00:00Z').toISOString(),
        // fact-display-unification — layer fields on the modal wire.
        fact_type: 'measurement',
        metric: 'MAU',
        measurement_value: 800000000,
        measurement_unit: '명',
        as_of: '2026-03',
      },
      entities: [],
      sources: [],
    });
    render(<RecallView spaceId="ks-1" />);
    await search();

    // Open the detail modal.
    fireEvent.click(
      screen.getByTestId('recall-fact-fn-modal-measure-open-detail'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('fact-detail-modal')).toBeInTheDocument(),
    );

    // Modal carries the shared badge AND the shared strip. Both the
    // card and modal render the same factUid, so scope queries to the
    // modal subtree to avoid the duplicate-testid match.
    const modal = screen.getByTestId('fact-detail-modal');
    expect(
      within(modal).getByTestId('fact-measurement-badge-fn-modal-measure'),
    ).toBeInTheDocument();
    const strip = within(modal).getByTestId(
      'fact-measurement-strip-fn-modal-measure',
    );
    expect(strip).toHaveTextContent('MAU');
    expect(strip).toHaveTextContent('명');
    expect(strip).toHaveTextContent('2026-03');
  });
});


// ---------------------------------------------------------------------------
// feat/recall-search-entity-autocomplete — PO dogfood directive 2026-06-24.
//
// The Recall search input now surfaces an entity autocomplete dropdown
// backed by the same /entities/suggest endpoint that FactCard's subject /
// object chip autocomplete uses. PO's "type 한, see 한국은행, click, get
// the recall" — picking a suggestion fills the input AND fires Recall
// immediately. Keyboard support: ↑↓ to move, Enter to pick, Esc to close.
// ---------------------------------------------------------------------------

describe('RecallView entity autocomplete', () => {
  beforeEach(() => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockReset();
  });

  it('does not fetch suggestions when the input is empty (initial mount)', async () => {
    render(<RecallView spaceId="ks-1" />);
    // Wait a tick to let any debounce fire — it should not.
    await new Promise((r) => setTimeout(r, 250));
    expect(api.searchEntitySuggestions).not.toHaveBeenCalled();
  });

  it('fetches and renders entity suggestions as the user types', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'obj-bok', primary_label: '한국은행', primary_lang: 'ko', score: 8.2 },
      { entity_id: 'obj-kr', primary_label: '한국', primary_lang: 'ko', score: 5.1 },
    ]);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '한' },
    });
    await waitFor(() => expect(api.searchEntitySuggestions).toHaveBeenCalled());
    expect(await screen.findByTestId('recall-entity-suggestions')).toBeInTheDocument();
    expect(await screen.findByTestId('recall-entity-suggestion-obj-bok')).toHaveTextContent('한국은행');
  });

  it('clicking a suggestion fills the input and fires Recall with the picked label', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'obj-bok', primary_label: '한국은행', primary_lang: 'ko', score: 8.2 },
    ]);
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValue(RECALL_HIT);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '한' },
    });
    const item = await screen.findByTestId('recall-entity-suggestion-obj-bok');
    fireEvent.mouseDown(item);
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const recallCall = (api.recall as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recallCall[1]).toBe('한국은행');
    // Suggestions dropdown closes after pick.
    await waitFor(() =>
      expect(screen.queryByTestId('recall-entity-suggestions')).toBeNull(),
    );
  });

  it('arrow keys move the active suggestion, Enter picks it', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'obj-a', primary_label: '한국은행', primary_lang: 'ko', score: 8.2 },
      { entity_id: 'obj-b', primary_label: '한국전력', primary_lang: 'ko', score: 6.0 },
    ]);
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValue(RECALL_HIT);
    render(<RecallView spaceId="ks-1" />);
    const input = screen.getByLabelText('recall query');
    fireEvent.change(input, { target: { value: '한' } });
    await screen.findByTestId('recall-entity-suggestions');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    // Second item should now be active.
    await waitFor(() => {
      expect(
        screen.getByTestId('recall-entity-suggestion-obj-b'),
      ).toHaveAttribute('data-active', 'true');
    });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const recallCall = (api.recall as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recallCall[1]).toBe('한국전력');
  });

  it('Esc closes the suggestions dropdown', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'obj-a', primary_label: '한국은행', primary_lang: 'ko', score: 8.2 },
    ]);
    render(<RecallView spaceId="ks-1" />);
    const input = screen.getByLabelText('recall query');
    fireEvent.change(input, { target: { value: '한' } });
    await screen.findByTestId('recall-entity-suggestions');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('recall-entity-suggestions')).toBeNull(),
    );
  });
});

// ---------------------------------------------------------------------------
// fix/recall-left-panel-filters — left-panel claim/measurement checkbox UX.
//
// PO report (2026-06-26): the left-panel "화자 인용만 (claim)" and
// "수치만 (measurement)" checkboxes appeared broken. Root cause was UX
// silent-fail: when the post-filter list became empty, the generic
// '표시할 결과가 없습니다.' message gave no signal that a checkbox was
// responsible. These tests pin the contract:
//   (1) claimOnly checkbox filters the list to fact_type='claim'.
//   (2) measurementOnly checkbox filters the list to fact_type='measurement'.
//   (3) When claimOnly is on but no claim facts exist, the empty message
//       names the checkbox so the PO knows the filter is the cause.
// ---------------------------------------------------------------------------

describe('RecallView — left-panel fact_type filters REMOVED (fix/r1-recall-redesign)', () => {
  // PO directive (2026-06-24):
  //   "좌패널 fact_type 필터 제거: '화자 인용만 / 수치만' = 중앙 칩과
  //    중복 → 제거. 유사도임계·검증일자·키워드·엔티티연결(서버재검색)은
  //    유지."
  //
  // The old describe block above used to drive these two checkboxes and
  // assert filter behaviour. Now the only fact_type filter is the chip
  // row inside RecallFactTypeSummary — exercised by the 'fact_type
  // summary box + pagination' describe block above. These tests pin
  // the REMOVAL: the left-panel checkboxes are gone, the remaining
  // controls are still there.

  function buildMixed(opts: {
    actions: number;
    claims: number;
    measurements: number;
  }): RecallResponse {
    const facts: import('@/lib/types').RecallFact[] = [];
    for (let i = 0; i < opts.actions; i++) {
      facts.push(makeFact(`a-${i}`, 'action', 0.9 - i * 0.001));
    }
    for (let i = 0; i < opts.claims; i++) {
      facts.push(makeFact(`c-${i}`, 'claim', 0.85 - i * 0.001));
    }
    for (let i = 0; i < opts.measurements; i++) {
      facts.push(makeFact(`m-${i}`, 'measurement', 0.8 - i * 0.001));
    }
    const total = opts.actions + opts.claims + opts.measurements;
    return {
      signature: `As far as I know — 그래프에 ${total}개 검증 사실이 있습니다`,
      total,
      facts,
      facets: {
        entities: {
          organization: [{ uid: 'obj-sem', name: '삼성전기', count: total }],
          person: [],
          place: [],
          other: [],
        },
        predicates: [{ name: 'reported', count: total }],
        fact_types: {
          action: opts.actions,
          claim: opts.claims,
          measurement: opts.measurements,
        },
      },
    };
  }

  async function bootstrap(response: RecallResponse) {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: '삼성전기' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await screen.findByTestId('recall-fact-type-summary');
  }

  it('the 화자 인용만 / 수치만 left-panel checkboxes are NOT rendered', async () => {
    await bootstrap(buildMixed({ actions: 2, claims: 2, measurements: 1 }));

    // The whole "duplicate" surface is gone — chip row is the only
    // fact_type filter affordance.
    expect(screen.queryByTestId('control-claim-only')).toBeNull();
    expect(screen.queryByTestId('control-claim-only-checkbox')).toBeNull();
    expect(screen.queryByTestId('control-measurement-only')).toBeNull();
    expect(screen.queryByTestId('control-measurement-only-checkbox')).toBeNull();
  });

  it('the retained left-panel controls (threshold, date, keyword, entity-link) are still rendered', async () => {
    await bootstrap(buildMixed({ actions: 2, claims: 2, measurements: 1 }));

    // PO directive: "유사도임계·검증일자·키워드·엔티티연결(서버재검색)
    // 은 유지." Pin every one of those so a future cleanup PR can't
    // accidentally widen the removal scope.
    expect(screen.getByTestId('control-threshold-slider')).toBeInTheDocument();
    expect(screen.getByTestId('control-date-from')).toBeInTheDocument();
    expect(screen.getByTestId('control-date-to')).toBeInTheDocument();
    expect(screen.getByTestId('control-keyword2')).toBeInTheDocument();
    expect(screen.getByTestId('control-match-entity-link-checkbox')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// fix/r1-recall-redesign — AI 브리핑 (on-demand button inside summary box).
//
// PO directive (2026-06-24):
//   "빈 요약박스 → AI 브리핑: '검색 결과 요약 · OOO' 가 칩만 있고 텍스트
//    없음 → entity 개관 브리핑 추가. 검증 fact 만 근거(grounding P1·P2).
//    ORACLE 질문응답과 구분(개관 vs 질문). 비용가드(캐싱/온디맨드 버튼)."
//
// Cost guard contract this block pins:
//   1. The trigger button renders inside the summary box (not auto-fired).
//   2. Clicking the button fires apiRecallBriefing — not on render, not
//      on search, ONLY on click. That's the "온디맨드" guard.
//   3. The grounded response renders briefing text + a grounding line.
//   4. An ungrounded response surfaces a "검증된 사실로 개관을 만들지
//      못했습니다" notice instead of pretending the briefing succeeded.
//   5. A 0-fact recall renders an empty-state notice and the trigger
//      button does NOT appear (no LLM call possible).
// ---------------------------------------------------------------------------

describe('RecallView — AI 브리핑 (fix/r1-recall-redesign)', () => {
  function summaryResponse(total: number): RecallResponse {
    return {
      signature: total === 0
        ? '검증된 사실이 없습니다'
        : `As far as I know — 그래프에 ${total}개 검증 사실이 있습니다`,
      total,
      facts: total === 0
        ? []
        : [
            {
              fact_uid: `briefing-${total}`,
              claim: '브리핑 대상 사실.',
              claim_en: null,
              subject_uid: 'obj-sem',
              predicate: 'reports',
              object_value: '실적',
              source_uids: [],
              validated_at: new Date('2026-06-01T00:00:00Z').toISOString(),
              validator_id: 'u-1',
              validation_method: 'manual',
              knowledge_space_id: 'ks-1',
              negation_flag: false,
              negation_scope: null,
              score: 0.9,
            },
          ],
      facets: {
        entities: {
          organization: total === 0
            ? []
            : [{ uid: 'obj-sem', name: '삼성전기', count: total }],
          person: [],
          place: [],
          other: [],
        },
        predicates: total === 0 ? [] : [{ name: 'reports', count: total }],
        fact_types: { action: total, claim: 0, measurement: 0 },
      },
    };
  }

  async function searchWith(response: RecallResponse, query = '삼성전기') {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(response);
    render(<RecallView spaceId="ks-1" />);
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: query },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await screen.findByTestId('recall-fact-type-summary');
  }

  it('renders the "AI 브리핑 보기" trigger inside the summary box and does NOT auto-fire (cost guard)', async () => {
    await searchWith(summaryResponse(2));

    // The button is present.
    const btn = screen.getByTestId('recall-summary-briefing-trigger');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toContain('AI 브리핑 보기');
    // The cost guard: search alone NEVER calls the briefing endpoint —
    // a user click is required.
    expect(api.recallBriefing as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('clicking the trigger calls apiRecallBriefing and renders the grounded briefing text', async () => {
    await searchWith(summaryResponse(2), '삼성전기');

    (api.recallBriefing as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      briefing: '삼성전기는 실적을 보고했다.',
      fact_uids: ['briefing-2'],
      grounded: true,
      cached: false,
      fact_count: 1,
    });

    fireEvent.click(screen.getByTestId('recall-summary-briefing-trigger'));

    // Briefing text renders inside the summary box.
    const text = await screen.findByTestId('recall-summary-briefing-text');
    expect(text.textContent).toContain('삼성전기는 실적을 보고했다.');
    // Grounding footer announces P1·P2 evidence count.
    expect(
      screen.getByTestId('recall-summary-briefing-grounding').textContent,
    ).toContain('검증된 사실 1건');
    // API was called with the submitted query.
    expect(api.recallBriefing as ReturnType<typeof vi.fn>)
      .toHaveBeenCalledWith('ks-1', '삼성전기', []);
  });

  it('renders an ungrounded notice when the LLM cannot anchor the briefing', async () => {
    await searchWith(summaryResponse(2));

    (api.recallBriefing as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      briefing: '',
      fact_uids: [],
      grounded: false,
      cached: false,
      fact_count: 1,
    });

    fireEvent.click(screen.getByTestId('recall-summary-briefing-trigger'));

    await screen.findByTestId('recall-summary-briefing-ungrounded');
    // The grounded-only text container never renders.
    expect(screen.queryByTestId('recall-summary-briefing-text')).toBeNull();
  });

  it('renders an empty-state notice (and NO trigger button) when the recall returned 0 facts', async () => {
    await searchWith(summaryResponse(0), '없는검색');

    // The "no facts to summarise" notice replaces the button entirely.
    expect(screen.getByTestId('recall-summary-briefing-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('recall-summary-briefing-trigger')).toBeNull();
    // Cost guard hard contract: the briefing endpoint is NEVER called.
    expect(api.recallBriefing as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('a new search clears the previous briefing so stale text does not bleed into the new result', async () => {
    await searchWith(summaryResponse(2), '삼성전기');

    (api.recallBriefing as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      briefing: '삼성전기 개관.',
      fact_uids: ['briefing-2'],
      grounded: true,
      cached: false,
      fact_count: 1,
    });
    fireEvent.click(screen.getByTestId('recall-summary-briefing-trigger'));
    await screen.findByTestId('recall-summary-briefing-text');

    // Run a fresh search — the briefing text from the previous query
    // must be wiped, and the trigger button must come back.
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      summaryResponse(2),
    );
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'LG에너지솔루션' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await screen.findByTestId('recall-fact-type-summary');

    await waitFor(() => {
      expect(screen.queryByTestId('recall-summary-briefing-text')).toBeNull();
    });
    expect(screen.getByTestId('recall-summary-briefing-trigger')).toBeInTheDocument();
  });
});

