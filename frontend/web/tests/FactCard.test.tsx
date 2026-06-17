import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FactCard } from '@/components/FactCard';
import type { FactSummary, ObjectSummary } from '@/lib/types';

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

  it('shows a negation warning when negation_flag is true', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, negation_flag: true, negation_scope: 'partial' }}
        action="accept"
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('negation_flag');
    expect(screen.getByRole('status')).toHaveTextContent('partial');
  });
});

describe('FactCard — checkbox model (B-31)', () => {
  it('renders a checked checkbox when action is accept', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    const cb = screen.getByTestId('fact-checkbox-fn-1') as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it('renders a checked checkbox when action is edit (editing still keeps the fact)', () => {
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

  it('re-checking a discarded fact restores accept', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="discard" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-1'));
    expect(onChange).toHaveBeenCalledWith({ action: 'accept' });
  });

  it('re-checking a discarded fact restores the editedClaim when one exists', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        action="discard"
        editedClaim="my refinement"
        lang="en"
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId('fact-checkbox-fn-1'));
    expect(onChange).toHaveBeenCalledWith({
      action: 'edit',
      editedClaim: 'my refinement',
    });
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

describe('FactCard — Edit textarea (regression)', () => {
  it('switches to edit mode on Edit click', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} action="accept" lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByText('Edit'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'edit' }),
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

  it('resolves subject_uid to name_en in EN mode', () => {
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

  it('einfomax SpaceX/Goldman Sachs regression: two different obj refs resolve to two different names', () => {
    // The einfomax SpaceX IPO article (B-31 reproduction case) emitted
    // facts whose subject_uid was obj-1 (SpaceX) on one fact and
    // obj-2 (Goldman Sachs) on another. The PO saw raw "obj-N" on
    // screen and assumed they were the same entity. This test pins the
    // resolver: each obj-N MUST resolve to its own distinct label, and
    // raw "obj-N" MUST NOT leak when the objects array carries them.
    const spacexFacts: FactSummary[] = [
      {
        fact_uid: 'fn-1',
        claim: 'SpaceX의 상장 주관사단이 그린슈 옵션을 행사했다.',
        subject_uid: 'obj-2', // Goldman Sachs (the underwriting bank)
        predicate: 'exercised',
        object_value: 'greenshoe option',
      },
      {
        fact_uid: 'fn-2',
        claim: 'SpaceX는 총 857억달러를 조달했다.',
        subject_uid: 'obj-1', // SpaceX itself
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
