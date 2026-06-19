import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RecallView } from '@/components/RecallView';
import type { RecallResponse } from '@/lib/types';

vi.mock('@/lib/api', () => ({
  recall: vi.fn(),
  // B-48b detail panel + retract/restore/detach
  getFactDetail: vi.fn(),
  retractFact: vi.fn(),
  restoreFact: vi.fn(),
  detachSource: vi.fn(),
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

  it('renders the entity brief panel above the flat fact list', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BRIEF_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const brief = await screen.findByTestId('entity-brief');
    expect(brief).toHaveTextContent('SpaceX');
    expect(brief).toHaveTextContent('organization');
    expect(brief).toHaveTextContent(/3개 검증 사실/);
    expect(brief).toHaveTextContent(/생성 0/);
  });

  it('shows subject-role and object-role groups separately', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BRIEF_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    expect(await screen.findByTestId('brief-as-subject')).toBeInTheDocument();
    expect(screen.getByTestId('brief-as-object')).toBeInTheDocument();
    expect(screen.getByTestId('brief-group-subject-total_funds_raised'))
      .toBeInTheDocument();
    expect(screen.getByTestId('brief-group-subject-set_ipo_price'))
      .toBeInTheDocument();
    expect(screen.getByTestId('brief-group-object-is_underwriter_for'))
      .toBeInTheDocument();
  });

  it('displays the other-entity label when the related side resolved', async () => {
    (api.recall as ReturnType<typeof vi.fn>).mockResolvedValueOnce(BRIEF_RESPONSE);
    render(<RecallView spaceId="ks-1" />);
    switchToPowerMode();
    fireEvent.change(screen.getByLabelText('recall query'), {
      target: { value: 'SpaceX' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Recall' }));
    await waitFor(() => expect(api.recall).toHaveBeenCalled());
    const fact3 = await screen.findByTestId('brief-fact-fn-3');
    expect(fact3).toHaveTextContent('Goldman Sachs');
  });

  it('renders the empty entity case with the no-facts notice', async () => {
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
    const brief = await screen.findByTestId('entity-brief');
    expect(brief).toHaveTextContent('Nobody');
    expect(brief).toHaveTextContent(/검증된 사실이 없습니다/);
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
