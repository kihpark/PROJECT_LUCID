import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FactCard } from '@/components/FactCard';
import type { FactSummary, ObjectSummary } from '@/lib/types';

// Mock api module
vi.mock('@/lib/api', () => ({
  searchEntitySuggestions: vi.fn(async () => []),
  listPredicates: vi.fn(async () => []),
}));

import * as api from '@/lib/api';

const baseFact: FactSummary = {
  fact_uid: 'fn-1',
  claim: 'AI 가 일자리를 대체한다.',
  claim_en: 'AI will replace jobs.',
  type: 'proposition',
  subject_uid: 'obj-1',
  predicate: 'will_replace',
  object_value: 'jobs',
  negation_flag: false,
  negation_scope: null,
};

const baseObjects: ObjectSummary[] = [
  {
    uid: 'obj-1',
    class: 'organization',
    name: '서울외환시장운영협의회',
    name_en: 'Seoul FX Market Operations Council',
    properties: {},
  },
  {
    uid: 'obj-2',
    class: 'concept',
    name: '운영시간',
    name_en: 'operating hours',
    properties: {},
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (api.listPredicates as ReturnType<typeof vi.fn>).mockResolvedValue([]);
});

describe('FactCard — claim display', () => {
  it('renders the claim in the chosen language', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    expect(screen.getByText('AI will replace jobs.')).toBeInTheDocument();
  });

  it('falls back to KR claim when claim_en missing on en lang', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, claim_en: null }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByText('AI 가 일자리를 대체한다.')).toBeInTheDocument();
  });

  it('does NOT show a negation badge even when negation_flag is true (decide-ux-v3)', () => {
    // decide-ux-v3: PO declared the negation badge unnecessary
    // ("필요 없다"). The negation_flag data is still persisted on
    // the FactNode in storage — substrate for future contradiction
    // detection — but the UI badge is removed.
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'partial' }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId('fact-negation-fn-1')).toBeNull();
    expect(screen.queryByText(/부정 진술/)).toBeNull();
  });
});

describe('FactCard — checkbox model (B-31)', () => {
  it('renders a checked checkbox when action is accept', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('renders a checked checkbox when action is edit', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedClaim="changed"
        lang="en"
        onChange={onChange}
      />,
    );
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('renders an unchecked checkbox when action is discard', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(false);
  });

  it('unchecking emits action discard', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-1'));
    expect(onChange).toHaveBeenCalledWith({ action: 'discard' });
  });

  it('Edit button is disabled on a discarded fact', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    expect(screen.getByText('Edit')).toBeDisabled();
  });

  it('does not render an Accept button (the checkbox replaces it)', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});

describe('FactCard — structured S/P/O editor (B-34)', () => {
  it('Edit click reveals subject / predicate / object inputs', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByText('Edit'));
    rerender(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-edit-subject-fn-1')).toBeInTheDocument();
    expect(screen.getByTestId('fact-edit-predicate-fn-1')).toBeInTheDocument();
    expect(screen.getByTestId('fact-edit-object-fn-1')).toBeInTheDocument();
  });

  it('does not render a free-text claim textarea any more', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.queryByPlaceholderText(/Edited claim/i)).toBeNull();
  });

  it('subject input is a text input (not a select)', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    const subjectInput = screen.getByTestId('fact-edit-subject-fn-1');
    expect(subjectInput.tagName).toBe('INPUT');
    expect(subjectInput).toHaveAttribute('type', 'text');
  });

  it('typing into subject input emits editedSubjectUid as typed literal', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'obj-2' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedSubjectUid: 'obj-2',
      }),
    );
  });

  it('changing the predicate emits the new predicate + regenerated claim', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-predicate-fn-1'), {
      target: { value: 'may_replace' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedPredicate: 'may_replace',
        editedClaim: expect.stringContaining('may_replace'),
      }),
    );
  });

  it('typing a known entity name into object auto-resolves to its uid', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-object-fn-1'), {
      target: { value: '운영시간' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        editedObjectValue: 'obj-2',
      }),
    );
  });

  it('typing a literal value into object keeps it as a literal', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-object-fn-1'), {
      target: { value: '85.7 billion USD' },
    });
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        editedObjectValue: '85.7 billion USD',
      }),
    );
  });

  it('preview line reflects the live triple', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    // decide-frontend-prefer-name: preview surfaces the backend-corrected
    // primary name (obj.name) regardless of UI lang. Previously asserted
    // the English alias (obj.name_en).
    expect(screen.getByTestId('fact-edit-preview-fn-1')).toHaveTextContent(
      /서울외환시장운영협의회\s*\|\s*will_replace\s*\|\s*jobs/,
    );
  });
});

describe('FactCard — entity label resolution (B-27 + B-31 regression)', () => {
  it('resolves subject_uid "obj-1" to the Korean name in KR mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent(
      '서울외환시장운영협의회',
    );
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-1');
  });

  it('resolves subject_uid to the backend-corrected name even when lang=en (decide-frontend-prefer-name)', () => {
    // decide-frontend-prefer-name: the backend (feat/spo-decide-payload-wire)
    // places the source-language corrected surface in obj.name. The Decide UI
    // must surface that — not the LLM-raw name_en alias — regardless of UI
    // lang. Previously this test asserted the English name_en, which masked
    // the correction (e.g. "Ministry of Commerce of China" displayed instead
    // of the corrected "중국 상무부").
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent(
      '서울외환시장운영협의회',
    );
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent(
      'Seoul FX Market Operations Council',
    );
  });

  it('shows "(미해석)" marker when subject_uid is obj-N but not in objects', () => {
    const onChange = vi.fn();
    const fact: FactSummary = { ...baseFact, subject_uid: 'obj-99' };
    render(
      <FactCard
        fact={fact}
        objects={baseObjects}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('obj-99');
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(미해석)');
  });

  it('einfomax SpaceX/Goldman Sachs regression: distinct refs resolve to distinct labels', () => {
    const spacexFacts: FactSummary[] = [
      {
        fact_uid: 'fn-1',
        claim: 'SpaceX의 상장 주관사단이 그린슈 옵션을 행사했다.',
        subject_uid: 'obj-2',
        predicate: 'exercised',
        object_value: 'greenshoe option',
      },
      {
        fact_uid: 'fn-2',
        claim: 'SpaceX는 총 857억달러를 조달했다.',
        subject_uid: 'obj-1',
        predicate: 'total_funds_raised',
        object_value: '85.7 billion USD',
      },
    ];
    const spacexObjects: ObjectSummary[] = [
      { uid: 'obj-1', class: 'organization', name: 'SpaceX', name_en: 'SpaceX', properties: {} },
      { uid: 'obj-2', class: 'organization', name: '골드만삭스', name_en: 'Goldman Sachs', properties: {} },
    ];
    const { rerender } = render(
      <FactCard
        fact={spacexFacts[0]!}
        objects={spacexObjects}
        action="accept"
        lang="kr"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('골드만삭스');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-2');
    rerender(
      <FactCard
        fact={spacexFacts[1]!}
        objects={spacexObjects}
        action="accept"
        lang="kr"
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('SpaceX');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-1');
  });
});

describe('FactCard — UUID entity resolution (B-37)', () => {
  it('resolves a UUID subject_uid to the entity name when objects array carries it', () => {
    const onChange = vi.fn();
    const uuidObjects: ObjectSummary[] = [
      {
        uid: '6895dbc7-a533-4c4d-9b8c-1a2b3c4d5e6f',
        class: 'organization',
        name: 'Found Fine Art',
        name_en: 'Found Fine Art',
        properties: {},
      },
    ];
    const fact: FactSummary = {
      ...baseFact,
      subject_uid: '6895dbc7-a533-4c4d-9b8c-1a2b3c4d5e6f',
    };
    render(
      <FactCard
        fact={fact}
        objects={uuidObjects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('Found Fine Art');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('6895dbc7');
  });

  it('flags an unresolved UUID with the same "(미해석)" marker as obj-N', () => {
    const onChange = vi.fn();
    const fact: FactSummary = {
      ...baseFact,
      subject_uid: 'deadbeef-1234-5678-9abc-def012345678',
    };
    render(
      <FactCard
        fact={fact}
        objects={baseObjects}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(미해석)');
  });

  it('Edit subject input shows the resolved label as initial value when entity is known', () => {
    const onChange = vi.fn();
    const uuidObjects: ObjectSummary[] = [
      {
        uid: '11111111-2222-3333-4444-555555555555',
        class: 'organization',
        name: 'Other Entity',
        name_en: 'Other Entity',
        properties: {},
      },
    ];
    const presentUuid = '11111111-2222-3333-4444-555555555555';
    render(
      <FactCard
        fact={{ ...baseFact, subject_uid: presentUuid }}
        objects={uuidObjects}
        action="edit"
        editedSubjectUid={presentUuid}
        editedPredicate={baseFact.predicate!}
        editedObjectValue={baseFact.object_value!}
        lang="en"
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('fact-edit-subject-fn-1') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    // Input should show the human-readable label, not the raw UUID
    expect(input.value).toBe('Other Entity');
  });

  it('Edit subject input shows raw UUID when entity not in objects', () => {
    const onChange = vi.fn();
    const unknownUuid = '99999999-aaaa-bbbb-cccc-dddddddddddd';
    render(
      <FactCard
        fact={{ ...baseFact, subject_uid: unknownUuid }}
        objects={baseObjects}
        action="edit"
        editedSubjectUid={unknownUuid}
        editedPredicate="p"
        editedObjectValue="o"
        lang="kr"
        onChange={onChange}
      />,
    );
    const input = screen.getByTestId('fact-edit-subject-fn-1') as HTMLInputElement;
    expect(input.tagName).toBe('INPUT');
    // Shows the "(미해석)" resolved form
    expect(input.value).toMatch(/미해석|99999999/);
  });
});

describe('FactCard — discard toggle (spo-pending-ux)', () => {
  it('Discard button changes fact to discard state', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByText('Discard'));
    expect(onChange).toHaveBeenCalledWith({ action: 'discard' });
  });

  it('when discarded, button label becomes "취소"', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    expect(screen.getByText('취소')).toBeInTheDocument();
    expect(screen.queryByText('Discard')).toBeNull();
  });

  it('clicking "취소" when discarded reverts to accept', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByText('취소'));
    expect(onChange).toHaveBeenCalledWith({ action: 'accept' });
  });

  it('shows "폐기 예정" badge when discarded', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    expect(screen.getByText('폐기 예정')).toBeInTheDocument();
  });

  it('claim text has line-through when discarded', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    const claim = screen.getByText('AI will replace jobs.');
    expect(claim.className).toContain('line-through');
  });
});

describe('FactCard — edit-mode cancel (spo-pending-ux)', () => {
  it('shows "취소" cancel button in edit mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    // There should be a cancel button (취소) in edit mode
    const cancelButtons = screen.getAllByText('취소');
    expect(cancelButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking cancel in edit mode emits accept action', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    const cancelButtons = screen.getAllByText('취소');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!);
    expect(onChange).toHaveBeenCalledWith({ action: 'accept' });
  });
});

describe('FactCard — edit-mode header (spo-pending-ux)', () => {
  it('shows original text as italic blockquote above inputs in edit mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    const quote = screen.getByText(/AI will replace jobs\./);
    expect(quote.closest('blockquote')).not.toBeNull();
  });
});

describe('FactCard — subject chip click (spo-pending-ux)', () => {
  it('renders suggestion chips and chip click sets editedSubjectUid to entity_id', async () => {
    const onChange = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'uuid-spacex', primary_label: 'SpaceX', primary_lang: 'en', score: 1.0 },
    ]);

    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        spaceId="ks-1"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'SpaceX' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-spacex')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('subject-chip-uuid-spacex'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedSubjectUid: 'uuid-spacex',
      }),
    );
  });
});

describe('FactCard — predicate autocomplete (spo-pending-ux)', () => {
  it('filters cached predicates and chip click sets editedPredicate', async () => {
    const onChange = vi.fn();
    (api.listPredicates as ReturnType<typeof vi.fn>).mockResolvedValue([
      { code: 'plans', label_ko: '계획', label_en: 'plans' },
      { code: 'founded', label_ko: '설립', label_en: 'founded' },
    ]);

    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate=""
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );

    // Wait for predicates to load
    await waitFor(() => {
      expect(api.listPredicates).toHaveBeenCalled();
    });

    fireEvent.change(screen.getByTestId('fact-edit-predicate-fn-1'), {
      target: { value: 'plan' },
    });

    await waitFor(() => {
      expect(screen.getByTestId('predicate-chip-plans')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId('predicate-chip-plans'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedPredicate: 'plans',
      }),
    );
  });
});
describe('FactCard — decide-ux-fix #3: 저장 button', () => {
  it('renders both 취소 and 저장 buttons in edit mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-save-fn-1')).toBeInTheDocument();
    expect(screen.getByText('저장')).toBeInTheDocument();
    const cancelButtons = screen.getAllByText('취소');
    expect(cancelButtons.length).toBeGreaterThanOrEqual(1);
  });

  it('clicking 저장 closes the edit form but keeps action=edit on the card', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-2"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    // form is open: subject input is visible
    expect(screen.getByTestId('fact-edit-subject-fn-1')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fact-save-fn-1'));
    // form closes
    expect(screen.queryByTestId('fact-edit-subject-fn-1')).toBeNull();
    // card stays at action='edit' (data-state on article)
    expect(screen.getByTestId('fact-card-fn-1')).toHaveAttribute('data-state', 'edit');
  });

  it('after 저장 the non-editing view shows the edited subject/predicate/object', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-2"
        editedPredicate="may_replace"
        editedObjectValue="운영시간"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('fact-save-fn-1'));
    // Edited values surface in the read-only dl. decide-frontend-prefer-name:
    // backend-corrected obj.name ("운영시간") wins over obj.name_en
    // ("operating hours") regardless of UI lang.
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('운영시간');
    expect(screen.getByTestId('fact-predicate')).toHaveTextContent('may_replace');
  });

  it('clicking 취소 in edit mode reverts the card and closes the form', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    const cancelButtons = screen.getAllByText('취소');
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!);
    expect(onChange).toHaveBeenCalledWith({ action: 'accept' });
  });

  it('re-clicking Edit while action=edit re-opens a closed form', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    // close the form
    fireEvent.click(screen.getByTestId('fact-save-fn-1'));
    expect(screen.queryByTestId('fact-edit-subject-fn-1')).toBeNull();
    // re-open via Edit click
    fireEvent.click(screen.getByText('Edit'));
    expect(screen.getByTestId('fact-edit-subject-fn-1')).toBeInTheDocument();
  });
});


describe('FactCard - decide-ux-v3: negation badge removed', () => {
  it('renders NO negation badge when negation_flag=true, scope=full', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'full' }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId('fact-negation-fn-1')).toBeNull();
  });

  it('renders NO negation badge when negation_flag=true, scope=partial', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'partial' }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId('fact-negation-fn-1')).toBeNull();
  });

  it('no user-visible 부정 진술 text appears anywhere on the card', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'full' }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.queryByText(/부정 진술/)).toBeNull();
  });

  it('fact.negation_flag data is still readable on the fact object (substrate preserved)', () => {
    // Smoke check: a fact carrying negation_flag still renders fully —
    // the field stays on FactSummary; only the UI badge is gone.
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'full' }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    // Card still renders normally:
    expect(screen.getByTestId('fact-card-fn-1')).toBeInTheDocument();
    expect(screen.getByTestId('fact-claim-fn-1')).toHaveTextContent(
      'AI will replace jobs.',
    );
  });
});

describe('FactCard - decide-ux-v2 (3): edit-mode entity chips', () => {
  it('renders subject entity-suggest chips when typing in edit mode', async () => {
    const onChange = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'uuid-acme', primary_label: 'ACME Corp', primary_lang: 'en', score: 0.9 },
    ]);
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        spaceId="ks-1"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'ACME' },
    });
    await waitFor(() => {
      expect(api.searchEntitySuggestions).toHaveBeenCalledWith('ACME', 'ks-1', 5);
    });
    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-acme')).toBeInTheDocument();
    });
  });

  it('clicking a subject chip binds editedSubjectUid and fills the input', async () => {
    const onChange = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'uuid-acme', primary_label: 'ACME Corp', primary_lang: 'en', score: 0.9 },
    ]);
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        spaceId="ks-1"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'ACME' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-acme')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('subject-chip-uuid-acme'));
    const input = screen.getByTestId('fact-edit-subject-fn-1') as HTMLInputElement;
    expect(input.value).toBe('ACME Corp');
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'edit',
        editedSubjectUid: 'uuid-acme',
      }),
    );
  });

  it('does not call searchEntitySuggestions when spaceId is missing', async () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'ACME' },
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(api.searchEntitySuggestions).not.toHaveBeenCalled();
  });
});

describe('FactCard - decide-ux-v2 (4): claim preservation after save', () => {
  it('view-mode claim renders the ORIGINAL sentence, not pipe-joined S|P|O', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedClaim="Seoul FX Market Operations Council | may_replace | operating hours"
        editedSubjectUid="obj-1"
        editedPredicate="may_replace"
        editedObjectValue="obj-2"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('fact-save-fn-1'));
    const claim = screen.getByTestId('fact-claim-fn-1');
    expect(claim).toHaveTextContent('AI will replace jobs.');
    expect(claim.textContent).not.toMatch(/\|/);
  });

  it('view-mode in accept state shows original claim (regression guard)', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    const claim = screen.getByTestId('fact-claim-fn-1');
    expect(claim).toHaveTextContent('AI will replace jobs.');
    expect(claim.textContent).not.toMatch(/\|/);
  });
});

// ---------------------------------------------------------------------------
// decide-ux-v3 — autocomplete LIVE-path coverage
// ---------------------------------------------------------------------------
// PO observed "edit subject 타이핑 시 실시간 ES 제안이 안 뜸." The prior PR
// claimed wiring + tests pass, but live path didn't fire. This block walks
// the full handler chain (onChange → setState → debounce → useEffect →
// searchEntitySuggestions → setSuggestions → render) end-to-end, and pins
// the fix that:
//
//   (a) the auto-fetch on edit-open is now suppressed unless the user has
//       actually typed in the input (subjectUserTyped flag), so the chip
//       area no longer surfaces a duplicate-of-current-selection chip;
//   (b) the API IS called on the first real keystroke;
//   (c) chips render after debounce settles.
// ---------------------------------------------------------------------------
describe('FactCard - decide-ux-v3: autocomplete LIVE path', () => {
  it('does NOT fetch suggestions on edit-open before the user types', async () => {
    const onChange = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'uuid-x', primary_label: 'X', primary_lang: 'en', score: 1.0 },
    ]);
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        spaceId="ks-1"
        onChange={onChange}
      />,
    );
    // Wait past the debounce window without typing.
    await new Promise((r) => setTimeout(r, 250));
    expect(api.searchEntitySuggestions).not.toHaveBeenCalled();
    // And no chip is rendered (we don't surface a duplicate of the current
    // selection back to the user).
    expect(screen.queryByTestId('subject-chip-uuid-x')).toBeNull();
  });

  it('LIVE path: typing -> debounce -> API call -> setState -> chips render', async () => {
    const onChange = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'uuid-acme', primary_label: 'ACME Corp', primary_lang: 'en', score: 0.9 },
      { entity_id: 'uuid-acme2', primary_label: 'ACME Inc', primary_lang: 'en', score: 0.85 },
      { entity_id: 'uuid-acme3', primary_label: 'ACME LLC', primary_lang: 'en', score: 0.8 },
    ]);
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        spaceId="ks-1"
        onChange={onChange}
      />,
    );

    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'ACME' },
    });

    // Debounce + microtask flush
    await waitFor(() => {
      expect(api.searchEntitySuggestions).toHaveBeenCalledWith('ACME', 'ks-1', 5);
    });

    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-acme')).toBeInTheDocument();
      expect(screen.getByTestId('subject-chip-uuid-acme2')).toBeInTheDocument();
      expect(screen.getByTestId('subject-chip-uuid-acme3')).toBeInTheDocument();
    });
  });

  it('chip-click suppresses an immediate re-fetch (subjectUserTyped resets)', async () => {
    const onChange = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { entity_id: 'uuid-acme', primary_label: 'ACME Corp', primary_lang: 'en', score: 0.9 },
    ]);
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        action="edit"
        editedSubjectUid="obj-1"
        editedPredicate="will_replace"
        editedObjectValue="jobs"
        lang="en"
        spaceId="ks-1"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: 'ACME' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-acme')).toBeInTheDocument();
    });
    const calls0 = (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mock.calls.length;
    fireEvent.click(screen.getByTestId('subject-chip-uuid-acme'));
    // After chip-click, wait past the debounce window — no new API call
    // should fire just because the input's value changed to the chip label.
    await new Promise((r) => setTimeout(r, 250));
    const calls1 = (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(calls1).toBe(calls0);
  });
});

// ---------------------------------------------------------------------------
// decide-frontend-prefer-name — backend-corrected name precedence
// ---------------------------------------------------------------------------
// PO observed: a captured Korean article had perfect Korean in objects.name
// ("중국 상무부") but the Decide UI displayed the LLM-raw English
// ("Ministry of Commerce of China"). Root cause: resolveEntity's
// `lang === 'en'` branch returned obj.name_en, defeating the backend's
// _match_object correction. The content language is the source language;
// obj.name is always the primary surface. obj.name_en is at best a fallback.
// ---------------------------------------------------------------------------
describe('FactCard - decide-frontend-prefer-name: prefer backend-corrected name', () => {
  it('prefers obj.name over obj.name_en for Korean entities even when lang=en', () => {
    const onChange = vi.fn();
    const fact: FactSummary = {
      ...baseFact,
      subject_uid: 'obj-mocchina',
      predicate: 'restricted_export_of',
      object_value: 'gallium',
    };
    const objects: ObjectSummary[] = [
      {
        uid: 'obj-mocchina',
        class: 'organization',
        name: '중국 상무부',
        name_en: 'Ministry of Commerce of China',
        properties: {},
      },
    ];
    render(
      <FactCard
        fact={fact}
        objects={objects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('중국 상무부');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent(
      'Ministry of Commerce of China',
    );
  });

  it('falls back to obj.name_en when obj.name is empty', () => {
    const onChange = vi.fn();
    const fact: FactSummary = {
      ...baseFact,
      subject_uid: 'obj-openai',
    };
    const objects: ObjectSummary[] = [
      {
        uid: 'obj-openai',
        class: 'organization',
        name: '',
        name_en: 'OpenAI',
        properties: {},
      },
    ];
    render(
      <FactCard
        fact={fact}
        objects={objects}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('OpenAI');
  });

  it('still shows the (미해석)/(unresolved) marker when obj-N has no match in objects', () => {
    // Regression guard for the lang parameter's remaining role: the marker
    // micro-strings ("(unresolved)" vs "(미해석)") still toggle on lang;
    // only the entity-surface choice no longer does.
    const onChange = vi.fn();
    const fact: FactSummary = { ...baseFact, subject_uid: 'obj-77' };
    render(
      <FactCard
        fact={fact}
        objects={[]}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('obj-77');
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(unresolved)');
  });
});

