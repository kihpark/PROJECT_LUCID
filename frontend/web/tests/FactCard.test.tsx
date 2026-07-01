import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FactCard } from '@/components/FactCard';
import type { FactSummary, ObjectSummary } from '@/lib/types';

// Mock api module. ★ REQ-014-B — FactTypeForms 가 ENTITY_TYPE_OPTIONS
//   (10종 entity_type closed set) 를 참조하므로 mock 에 실제 배열을
//   포함시킨다. searchEntitySuggestions / listPredicates 는 vi.fn 로 유지.
vi.mock('@/lib/api', () => ({
  searchEntitySuggestions: vi.fn(async () => []),
  listPredicates: vi.fn(async () => []),
  ENTITY_TYPE_OPTIONS: [
    { value: 'person', label: '사람' },
    { value: 'organization', label: '조직' },
    { value: 'group', label: '그룹' },
    { value: 'knowledge', label: '지식' },
    { value: 'resource', label: '자원' },
    { value: 'task', label: '행위' },
    { value: 'concept', label: '개념' },
    { value: 'event', label: '사건' },
    { value: 'metric', label: '지표' },
    { value: 'location', label: '장소' },
  ],
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

  // ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 1, 2) — UUID 화면 노출 0.
  // 옛: "obj-99 (미해석)" — uid 와 marker 둘 다 노출.
  // 새: "미해결 entity" only — uid 노출 X.
  it('shows "미해결 entity" placeholder when subject_uid is obj-N but not in objects', () => {
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
    // ★ 내부 uid (obj-99) 가 표시되면 안 됨.
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-99');
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('미해결 entity');
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

  // ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 1, 2) — UUID 화면 노출 0.
  // 옛: "deadbeef-... (미해석)" — UUID 가 marker 와 함께 노출.
  // 새: "미해결 entity" only.
  it('flags an unresolved UUID with the "미해결 entity" placeholder (★ UUID X)', () => {
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
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('미해결 entity');
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('deadbeef');
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
    // ★ REQ-004 STAGE 3+4 — "미해결 entity" placeholder (★ UUID X).
    expect(input.value).toBe('미해결 entity');
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

  it('shows the "unresolved entity" / "미해결 entity" placeholder when obj-N has no match in objects', () => {
    // ★ REQ-004 STAGE 3+4 (PO 2026-06-30 결함 1, 2) — UUID 화면 노출 0.
    // 옛: "obj-77 (unresolved)" — uid + marker.
    // 새: "unresolved entity" / "미해결 entity" only (lang 별).
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
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-77');
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('unresolved entity');
  });
});

// ---------------------------------------------------------------------------
// decide-chip-click-bind — LIVE click path (parent-controlled re-render)
// ---------------------------------------------------------------------------
// PO's live repro: type "중국 상무" → chips appear → click "중국 상무부" chip
// → input REVERTS to the typed query and editedSubjectUid is NOT applied.
//
// The previous `decide-ux-v3` test (`clicking a subject chip binds
// editedSubjectUid and fills the input`, line ~901) passed because it
// rendered FactCard standalone with NO controlled parent — the chip
// handler's local setSubjectQuery(chip.label) succeeded and there was
// no re-render with the new editedSubjectUid that would trigger the
// parent-sync useEffect's clobber.
//
// In production, DecideOverlay holds editedSubjectUid in factDecisions and
// passes it back as a prop. On chip click, the chain is:
//   1. onSubjectChipClick fires → setSubjectQuery(chip.label) locally
//   2. emitEdit({subject: chip.entity_id}) → parent onChange
//   3. Parent setFactDecisions → re-renders FactCard with new editedSubjectUid
//   4. currentSubject (= editedSubjectUid) becomes chip.entity_id
//   5. The sync useEffect compares currentSubject !== prevSubjectRef.current
//      → fires resolveEntity(chip.entity_id, labelMap, lang)
//   6. Since chip.entity_id is NOT in the Decision objects (it came from
//      the autocomplete API, not the LLM extraction), resolveEntity returns
//      either the raw uid or the "(unresolved)" marker
//   7. setSubjectQuery(resolved) CLOBBERS the chip's primary_label
//
// Fix: in onSubjectChipClick, pre-arm prevSubjectRef.current to the new
// entity_id BEFORE setting state, so the sync useEffect's strict-inequality
// check is false and skips the resolveEntity overwrite.
// ---------------------------------------------------------------------------
describe('FactCard - decide-chip-click-bind: LIVE click path (parent re-renders)', () => {
  // Helper: render a FactCard wrapped in a parent that actually persists
  // editedSubjectUid / editedObjectValue across re-renders, mimicking
  // DecideOverlay's factDecisions[uid] flow.
  function ControlledFactCard(props: {
    fact: FactSummary;
    objects?: ObjectSummary[];
    initialSubjectUid?: string;
    initialPredicate?: string;
    initialObjectValue?: string;
    spaceId?: string;
    onChangeSpy?: ReturnType<typeof vi.fn>;
  }) {
    const [decision, setDecision] = useState<{
      action: 'accept' | 'edit' | 'discard';
      editedClaim?: string;
      editedSubjectUid?: string;
      editedPredicate?: string;
      editedObjectValue?: string;
    }>({
      action: 'edit',
      editedSubjectUid: props.initialSubjectUid,
      editedPredicate: props.initialPredicate,
      editedObjectValue: props.initialObjectValue,
    });
    return (
      <div>
        <FactCard
          fact={props.fact}
          objects={props.objects}
          action={decision.action}
          editedClaim={decision.editedClaim}
          editedSubjectUid={decision.editedSubjectUid}
          editedPredicate={decision.editedPredicate}
          editedObjectValue={decision.editedObjectValue}
          lang="en"
          spaceId={props.spaceId}
          onChange={(next) => {
            props.onChangeSpy?.(next);
            setDecision({
              action: next.action,
              editedClaim: next.editedClaim,
              editedSubjectUid: next.editedSubjectUid,
              editedPredicate: next.editedPredicate,
              editedObjectValue: next.editedObjectValue,
            });
          }}
        />
        {/* Reflect parent-held uid for assertions */}
        <div data-testid="parent-subject-uid">
          {decision.editedSubjectUid ?? ''}
        </div>
        <div data-testid="parent-object-uid">
          {decision.editedObjectValue ?? ''}
        </div>
      </div>
    );
  }

  it('LIVE subject chip click: input value stays at chip primary_label after parent re-render', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        entity_id: 'uuid-mocchina',
        primary_label: '중국 상무부',
        primary_lang: 'ko',
        score: 1.0,
      },
    ]);

    render(
      <ControlledFactCard
        fact={baseFact}
        objects={baseObjects}
        initialSubjectUid="obj-1"
        initialPredicate="will_replace"
        initialObjectValue="jobs"
        spaceId="ks-1"
      />,
    );

    // 1. User types "중국 상무"
    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: '중국 상무' },
    });

    // 2. Chip appears
    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-mocchina')).toBeInTheDocument();
    });

    // 3. User clicks chip
    fireEvent.click(screen.getByTestId('subject-chip-uuid-mocchina'));

    // 4. After the parent re-renders with the new editedSubjectUid, the
    //    input MUST still show the chip's primary_label, NOT the raw uid
    //    and NOT the typed query. This is the production failure.
    await waitFor(() => {
      const input = screen.getByTestId('fact-edit-subject-fn-1') as HTMLInputElement;
      expect(input.value).toBe('중국 상무부');
    });
    const input = screen.getByTestId('fact-edit-subject-fn-1') as HTMLInputElement;
    expect(input.value).not.toBe('중국 상무');
    expect(input.value).not.toContain('uuid-mocchina');
    expect(input.value).not.toMatch(/unresolved|미해석/);
  });

  it('LIVE subject chip click: parent-held editedSubjectUid is set to the chip entity_id', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        entity_id: 'uuid-mocchina',
        primary_label: '중국 상무부',
        primary_lang: 'ko',
        score: 1.0,
      },
    ]);

    render(
      <ControlledFactCard
        fact={baseFact}
        objects={baseObjects}
        initialSubjectUid="obj-1"
        initialPredicate="will_replace"
        initialObjectValue="jobs"
        spaceId="ks-1"
      />,
    );

    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: '중국' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-mocchina')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('subject-chip-uuid-mocchina'));

    // The parent's editedSubjectUid landed and persisted.
    await waitFor(() => {
      expect(screen.getByTestId('parent-subject-uid')).toHaveTextContent(
        'uuid-mocchina',
      );
    });
  });

  it('LIVE subject chip click: save payload (via onChange) includes the chip entity_id', async () => {
    const onChangeSpy = vi.fn();
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        entity_id: 'uuid-mocchina',
        primary_label: '중국 상무부',
        primary_lang: 'ko',
        score: 1.0,
      },
    ]);

    render(
      <ControlledFactCard
        fact={baseFact}
        objects={baseObjects}
        initialSubjectUid="obj-1"
        initialPredicate="will_replace"
        initialObjectValue="jobs"
        spaceId="ks-1"
        onChangeSpy={onChangeSpy}
      />,
    );

    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: '중국' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-mocchina')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('subject-chip-uuid-mocchina'));

    // The LAST onChange call (after chip-click batched updates settle) MUST
    // carry the chip's entity_id. PO's bug: it carried the typed query
    // ("중국") instead.
    const lastCall = onChangeSpy.mock.calls[onChangeSpy.mock.calls.length - 1]![0];
    expect(lastCall).toMatchObject({
      action: 'edit',
      editedSubjectUid: 'uuid-mocchina',
    });

    // Now click 저장 to lock it in — the parent's state still holds the uid.
    fireEvent.click(screen.getByTestId('fact-save-fn-1'));
    expect(screen.getByTestId('parent-subject-uid')).toHaveTextContent(
      'uuid-mocchina',
    );
  });

  it('LIVE object chip click: same fix on object side — input + uid preserved', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        entity_id: 'uuid-gallium',
        primary_label: '갈륨',
        primary_lang: 'ko',
        score: 1.0,
      },
    ]);

    render(
      <ControlledFactCard
        fact={baseFact}
        objects={baseObjects}
        initialSubjectUid="obj-1"
        initialPredicate="restricted_export_of"
        initialObjectValue="jobs"
        spaceId="ks-1"
      />,
    );

    fireEvent.change(screen.getByTestId('fact-edit-object-fn-1'), {
      target: { value: '갈' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('object-chip-uuid-gallium')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('object-chip-uuid-gallium'));

    await waitFor(() => {
      const input = screen.getByTestId('fact-edit-object-fn-1') as HTMLInputElement;
      expect(input.value).toBe('갈륨');
    });
    expect(screen.getByTestId('parent-object-uid')).toHaveTextContent(
      'uuid-gallium',
    );
  });

  it('LIVE subject chip click: no additional searchEntitySuggestions fires after chip click (gating still works)', async () => {
    (api.searchEntitySuggestions as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        entity_id: 'uuid-mocchina',
        primary_label: '중국 상무부',
        primary_lang: 'ko',
        score: 1.0,
      },
    ]);

    render(
      <ControlledFactCard
        fact={baseFact}
        objects={baseObjects}
        initialSubjectUid="obj-1"
        initialPredicate="will_replace"
        initialObjectValue="jobs"
        spaceId="ks-1"
      />,
    );

    fireEvent.change(screen.getByTestId('fact-edit-subject-fn-1'), {
      target: { value: '중국' },
    });
    await waitFor(() => {
      expect(screen.getByTestId('subject-chip-uuid-mocchina')).toBeInTheDocument();
    });
    const callsBefore = (
      api.searchEntitySuggestions as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    fireEvent.click(screen.getByTestId('subject-chip-uuid-mocchina'));

    // Wait past the debounce window: no new fetch should fire just because
    // the input's value changed to the chip's primary_label (the gating
    // mechanism from decide-ux-v3 must still hold).
    await new Promise((r) => setTimeout(r, 250));
    const callsAfter = (
      api.searchEntitySuggestions as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    expect(callsAfter).toBe(callsBefore);
  });
});

// v0.2.0 step 1 (fact-claim-layer-v1): Action vs Claim split.
// The FactCard renders a [CLAIM] badge in the header when
// fact_type='claim' and a speaker / speech_act / content_claim
// strip below the claim. Action facts (fact_type='action' or
// undefined for legacy back-compat) render unchanged.
describe('FactCard — claim (v0.2.0 step 1)', () => {
  const claimFact: FactSummary = {
    ...baseFact,
    fact_uid: 'fn-claim-1',
    fact_type: 'claim',
    speaker_uid: 'obj-1',
    speaker_label: '안도걸 의원',
    speech_act: '밝혔다',
    content_claim: '디지털자산기본법 제정에 속도를 낼 것',
    stance: 'neutral',
  };

  it('renders [CLAIM] badge when fact_type=claim', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={claimFact} action="accept" lang="kr" onChange={onChange} />,
    );
    expect(
      screen.getByTestId('fact-claim-badge-fn-claim-1'),
    ).toBeInTheDocument();
  });

  it('renders speaker_label + speech_act + content_claim strip', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={claimFact} action="accept" lang="kr" onChange={onChange} />,
    );
    const strip = screen.getByTestId('fact-claim-strip-fn-claim-1');
    expect(strip).toHaveTextContent('안도걸 의원');
    expect(strip).toHaveTextContent('밝혔다');
    expect(strip).toHaveTextContent('디지털자산기본법 제정에 속도를 낼 것');
  });

  // fact-display-unification — PO claim-display-format spec (recovery
  // spec PR B). Visual contract:
  //   **국가데이터처**[발표했다]: "4월 기준 증가율은…"
  // — bold speaker WITHOUT brackets, brackets AROUND speech_act
  //   (with trailing colon), quotes AROUND content_claim.
  it('renders the PO claim-display-format spec: bold speaker, [speech_act]:, "content_claim"', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={claimFact} action="accept" lang="kr" onChange={onChange} />,
    );
    const strip = screen.getByTestId('fact-claim-strip-fn-claim-1');
    // Speaker wrapped in <strong> with font-bold class (not just font-medium).
    const speaker = strip.querySelector('strong');
    expect(speaker).not.toBeNull();
    expect(speaker!.textContent).toBe('안도걸 의원');
    expect(speaker!.className).toMatch(/font-bold/);
    // The speaker text itself should NOT carry the bracket wrap that
    // the old format used — the old "[안도걸 의원]" rendering is what
    // PO explicitly rejected.
    expect(strip.textContent).not.toContain('[안도걸 의원]');
    // Speech act bracketed with trailing colon — the new spec.
    expect(strip.textContent).toContain('[밝혔다]:');
    // The previous quoted "speech_act": rendering must be gone.
    expect(strip.textContent).not.toContain('"밝혔다":');
    // Content claim wrapped in curly quotes (the strip itself owns the
    // quote marks; the old version rendered content_claim plain).
    expect(strip.textContent).toContain('“디지털자산기본법 제정에 속도를 낼 것”');
  });

  it('does NOT render [CLAIM] badge when fact_type=action', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, fact_type: 'action' }}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId('fact-claim-badge-fn-1')).toBeNull();
  });

  it('does NOT render [CLAIM] badge when fact_type is undefined (legacy)', () => {
    // Back-compat: legacy facts pre-fact-claim-layer-v1 have no
    // fact_type field. They MUST render exactly like action facts —
    // no badge, no claim strip, no UI regression for the dominant
    // case.
    const onChange = vi.fn();
    render(
      <FactCard fact={baseFact} action="accept" lang="kr" onChange={onChange} />,
    );
    expect(screen.queryByTestId('fact-claim-badge-fn-1')).toBeNull();
    expect(screen.queryByTestId('fact-claim-strip-fn-1')).toBeNull();
  });

  it('does NOT render claim strip when fact_type=claim but speaker fields empty', () => {
    // Defensive: if the LLM tags fact_type='claim' but somehow
    // omits the speaker / speech_act / content_claim (out-of-band
    // ingestion path), the strip stays hidden — the badge alone
    // is the type signal, the strip is the optional detail.
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{
          ...baseFact,
          fact_uid: 'fn-claim-empty',
          fact_type: 'claim',
        }}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(
      screen.getByTestId('fact-claim-badge-fn-claim-empty'),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('fact-claim-strip-fn-claim-empty')).toBeNull();
  });
});

// v0.2.0 step 2 (fact-measurement-layer-v1): measurement bucket.
// The FactCard renders a [MEASUREMENT] badge in the header when
// fact_type='measurement' and a metric / value / unit / as_of strip
// below the claim. Action / claim / legacy facts render unchanged.
describe('FactCard — measurement (v0.2.0 step 2)', () => {
  const measurementFact: FactSummary = {
    ...baseFact,
    fact_uid: 'fn-measure-1',
    fact_type: 'measurement',
    claim: 'ChatGPT 의 MAU 는 2026년 3월 기준 8억 명이다.',
    metric: 'MAU',
    measurement_value: 800000000,
    measurement_unit: '명',
    as_of: '2026-03',
  };

  it('renders [MEASUREMENT] badge when fact_type=measurement', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={measurementFact} action="accept" lang="kr" onChange={onChange} />,
    );
    expect(
      screen.getByTestId('fact-measurement-badge-fn-measure-1'),
    ).toBeInTheDocument();
  });

  it('renders metric + value + unit + as_of strip', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={measurementFact} action="accept" lang="kr" onChange={onChange} />,
    );
    const strip = screen.getByTestId('fact-measurement-strip-fn-measure-1');
    expect(strip).toHaveTextContent('MAU');
    expect(strip).toHaveTextContent('명');
    expect(strip).toHaveTextContent('2026-03');
  });

  it('formats measurement_value with locale thousand separators', () => {
    // 800,000,000 should not render as the raw "800000000" — the locale
    // commas give the number scannability. Browser default locale on
    // jsdom is en-US so the separator is a comma.
    const onChange = vi.fn();
    render(
      <FactCard fact={measurementFact} action="accept" lang="kr" onChange={onChange} />,
    );
    const valueNode = screen.getByTestId('fact-measurement-value-fn-measure-1');
    expect(valueNode.textContent).toContain(',');
    // Round-trip parse confirms the displayed number equals the value
    // we passed in (modulo formatting). Parsing strips commas back out.
    expect(Number(valueNode.textContent!.replace(/,/g, ''))).toBe(800000000);
  });

  it('does NOT render [MEASUREMENT] badge when fact_type=action', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, fact_type: 'action' }}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.queryByTestId('fact-measurement-badge-fn-1')).toBeNull();
    expect(screen.queryByTestId('fact-measurement-strip-fn-1')).toBeNull();
  });

  it('does NOT render [MEASUREMENT] badge when fact_type is undefined (legacy)', () => {
    // Back-compat: legacy facts pre-measurement-layer have no fact_type
    // field. They MUST render exactly like action facts — no measurement
    // badge, no measurement strip.
    const onChange = vi.fn();
    render(
      <FactCard fact={baseFact} action="accept" lang="kr" onChange={onChange} />,
    );
    expect(screen.queryByTestId('fact-measurement-badge-fn-1')).toBeNull();
    expect(screen.queryByTestId('fact-measurement-strip-fn-1')).toBeNull();
  });

  it('renders strip even when measurement_value is zero', () => {
    // Defensive: `!measurement_value` would hide a zero strip, which
    // is a legitimate value (강수량 0 mm, deficit 0). The strip's
    // visibility check uses `!== null && !== undefined`.
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{
          ...measurementFact,
          fact_uid: 'fn-zero',
          measurement_value: 0,
        }}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-measurement-strip-fn-zero')).toBeInTheDocument();
    expect(screen.getByTestId('fact-measurement-value-fn-zero')).toHaveTextContent('0');
  });

  // v0.2.0 step 2.5 (feat/measurement-completeness, PO 2026-06-24):
  // chip + 원문 동반. The measurement strip ([MEASUREMENT] ...) must
  // coexist with the original claim sentence — never replace it. PO
  // directive: surface = faithful, structure = metadata on top. The
  // [MEASUREMENT] prefix establishes the strip as a derived view.
  it('renders BOTH the original claim AND the measurement strip (chip+claim coexist)', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={measurementFact} action="accept" lang="kr" onChange={onChange} />,
    );
    // Original claim sentence must be in the DOM
    const claimNode = screen.getByTestId('fact-claim-fn-measure-1');
    expect(claimNode.textContent).toContain('ChatGPT');
    expect(claimNode.textContent).toContain('8억 명');
    expect(claimNode.textContent).toContain('2026년 3월');
    // And the measurement strip is ALSO present, prefixed with [MEASUREMENT]
    expect(screen.getByTestId('fact-measurement-strip-fn-measure-1')).toBeInTheDocument();
    expect(screen.getByTestId('fact-measurement-prefix-fn-measure-1')).toHaveTextContent('[MEASUREMENT]');
  });

  it('renders the PO 노사 case with verbatim claim alongside the [MEASUREMENT] chip', () => {
    // PO's verbatim live evidence (2026-06-24). The 원문 must be visible
    // ON THE CARD — chip+strip cannot replace the sentence the user saw
    // in the source article.
    const onChange = vi.fn();
    const nosoFact: FactSummary = {
      ...baseFact,
      fact_uid: 'fn-noso',
      fact_type: 'measurement',
      claim: '노사 양측의 최초 요구안 차이는 시급 기준 1680원이다.',
      metric: '노사 양측의 최초 요구안 차이 (시급 기준)',
      measurement_value: 1680,
      measurement_unit: '원',
      as_of: null,
    };
    render(
      <FactCard fact={nosoFact} action="accept" lang="kr" onChange={onChange} />,
    );
    // Original claim
    const claimNode = screen.getByTestId('fact-claim-fn-noso');
    expect(claimNode.textContent).toContain('노사 양측의');
    expect(claimNode.textContent).toContain('시급 기준');
    expect(claimNode.textContent).toContain('1680원');
    // Chip prefix + rich metric
    expect(screen.getByTestId('fact-measurement-prefix-fn-noso')).toHaveTextContent('[MEASUREMENT]');
    const metricNode = screen.getByTestId('fact-measurement-metric-fn-noso');
    expect(metricNode.textContent).toContain('노사 양측의 최초 요구안 차이');
    // null as_of must NOT render the (...) wrapper
    expect(screen.queryByTestId('fact-measurement-asof-fn-noso')).toBeNull();
  });

  it('renders strip with only metric + as_of (no value/unit) when LLM partial', () => {
    // Defensive: if the LLM tags fact_type='measurement' but only
    // emits metric + as_of (unit / value extracted poorly), the strip
    // still renders the available fields — the badge alone is the
    // type signal; missing sub-fields just get omitted.
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{
          ...baseFact,
          fact_uid: 'fn-partial',
          fact_type: 'measurement',
          metric: '실업률',
          as_of: '2026-06',
          measurement_value: null,
          measurement_unit: null,
        }}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-measurement-badge-fn-partial')).toBeInTheDocument();
    const strip = screen.getByTestId('fact-measurement-strip-fn-partial');
    expect(strip).toHaveTextContent('실업률');
    expect(strip).toHaveTextContent('2026-06');
  });
});


// ---------------------------------------------------------------------------
// decide-claim-format-apply — PO dogfood evidence 2026-06-24.
//
// After fact-display-unification (62993df) the FactTypeStrip was already
// rendering the PO-spec layout (**speaker** [speech_act]: "content") in
// both Decide and Recall. PO still observed that Decide claim cards
// showed the OLD rejected layout [speaker]"speech_act":content above the
// strip, while Recall did not.
//
// Root cause: Decide forces lang='en' on FactCard, so displayClaim()
// returned `fact.claim_en`. The LLM populates claim_en for claim facts
// with a synthesized template that mirrors the rejected layout, and
// Decide rendered it verbatim as the card title before the strip below.
// Recall renders `fact.claim` (the original natural sentence) directly,
// so it was unaffected.
//
// Fix: displayClaim() now prefers `fact.claim` for claim facts
// regardless of UI lang. The card title becomes the original sentence
// — identical to what Recall already shows — and FactTypeStrip remains
// the single source of the PO-spec structured rendering.
// ---------------------------------------------------------------------------
describe('FactCard — decide-claim-format-apply: claim title prefers fact.claim', () => {
  const oldFormatTemplate = '[안도걸 의원]"밝혔다":디지털자산기본법 제정에 속도를 낼 것';
  const naturalKr = '안도걸 의원은 디지털자산기본법 제정에 속도를 낼 것이라고 밝혔다.';
  const claimFactWithTemplatedEn: FactSummary = {
    fact_uid: 'fn-claim-decide',
    claim: naturalKr,
    claim_en: oldFormatTemplate,
    type: 'proposition',
    subject_uid: 'obj-1',
    predicate: '밝혔다',
    object_value: '디지털자산기본법 제정에 속도를 낼 것',
    fact_type: 'claim',
    speaker_uid: 'obj-1',
    speaker_label: '안도걸 의원',
    speech_act: '밝혔다',
    content_claim: '디지털자산기본법 제정에 속도를 낼 것',
    stance: 'neutral',
  };

  it('Decide (lang=en) renders fact.claim, NOT the templated claim_en', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={claimFactWithTemplatedEn}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    const title = screen.getByTestId('fact-claim-fn-claim-decide');
    // Title surfaces the original natural sentence — identical to Recall.
    expect(title).toHaveTextContent(naturalKr);
    // The OLD format template (bracketed speaker + quoted speech_act +
    // plain content) MUST NOT appear in the title.
    expect(title.textContent).not.toContain(oldFormatTemplate);
    expect(title.textContent).not.toMatch(/\[안도걸 의원\]/);
    expect(title.textContent).not.toMatch(/"밝혔다":/);
  });

  it('Recall-style (lang=kr) renders fact.claim (regression guard — Recall was already correct)', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={claimFactWithTemplatedEn}
        action="accept"
        lang="kr"
        onChange={onChange}
      />,
    );
    const title = screen.getByTestId('fact-claim-fn-claim-decide');
    expect(title).toHaveTextContent(naturalKr);
    expect(title.textContent).not.toContain(oldFormatTemplate);
  });

  it('Decide claim card shows the PO-spec strip identical to Recall (**speaker** [speech_act]: "content")', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={claimFactWithTemplatedEn}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    const strip = screen.getByTestId('fact-claim-strip-fn-claim-decide');
    const speaker = strip.querySelector('strong');
    expect(speaker).not.toBeNull();
    expect(speaker!.textContent).toBe('안도걸 의원');
    expect(speaker!.className).toMatch(/font-bold/);
    expect(strip.textContent).toContain('[밝혔다]:');
    expect(strip.textContent).toContain('“디지털자산기본법 제정에 속도를 낼 것”');
    // Same negative guards as the unified PO format test for FactCard.
    expect(strip.textContent).not.toContain('[안도걸 의원]');
    expect(strip.textContent).not.toContain('"밝혔다":');
  });

  it('non-claim facts still prefer claim_en when lang=en (regression guard)', () => {
    // For action / measurement / legacy facts the existing lang behavior
    // is preserved — only claim facts get the override. This protects
    // the dominant Decide path that the PO has been happy with.
    const onChange = vi.fn();
    const actionFact: FactSummary = {
      ...claimFactWithTemplatedEn,
      fact_uid: 'fn-action-en',
      fact_type: 'action',
      claim: '안도걸 의원은 디지털자산기본법 제정에 속도를 낼 것이라고 밝혔다.',
      claim_en: 'Rep. Ahn Do-geol said he will speed up the Digital Asset Framework Act.',
      speaker_label: null,
      speech_act: null,
      content_claim: null,
    };
    render(
      <FactCard
        fact={actionFact}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-claim-fn-action-en')).toHaveTextContent(
      'Rep. Ahn Do-geol said he will speed up the Digital Asset Framework Act.',
    );
  });
});
