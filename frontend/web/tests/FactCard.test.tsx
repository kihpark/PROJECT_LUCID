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

describe('FactCard', () => {
  it('renders the claim in the chosen language', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={baseFact} lang="en" onChange={onChange} />,
    );
    expect(screen.getByText('AI will replace jobs.')).toBeInTheDocument();
  });

  it('falls back to KR claim when claim_en missing on en lang', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={{ ...baseFact, claim_en: null }}
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
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('negation_flag');
    expect(screen.getByRole('status')).toHaveTextContent('partial');
  });

  it('switches to edit mode and emits an editedClaim onChange', () => {
    const onChange = vi.fn();
    render(
      <FactCard fact={baseFact} lang="en" onChange={onChange} />,
    );
    fireEvent.click(screen.getByText('Edit'));
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'edit' }),
    );
  });

  it('emits accept then discard sequence', () => {
    const onChange = vi.fn();
    render(<FactCard fact={baseFact} lang="en" onChange={onChange} />);
    fireEvent.click(screen.getByText('Accept'));
    fireEvent.click(screen.getByText('Discard'));
    expect(onChange).toHaveBeenNthCalledWith(1, { action: 'accept' });
    expect(onChange).toHaveBeenNthCalledWith(2, { action: 'discard' });
  });
});

describe('FactCard — subject/object label resolution (B-27)', () => {
  it('resolves subject_uid "obj-1" to the Korean name when KR mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        lang="kr"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent(
      '서울외환시장운영협의회',
    );
    // raw ref must not leak
    expect(screen.getByTestId('fact-subject')).not.toHaveTextContent('obj-1');
  });

  it('resolves subject_uid to name_en when EN mode', () => {
    const onChange = vi.fn();
    render(
      <FactCard
        fact={baseFact}
        objects={baseObjects}
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent(
      'Seoul FX Market Operations Council',
    );
  });

  it('falls back to KR name when EN mode but name_en missing', () => {
    const onChange = vi.fn();
    const objects: ObjectSummary[] = [
      { uid: 'obj-1', class: 'organization', name: '한국은행', properties: {} },
    ];
    render(
      <FactCard
        fact={baseFact}
        objects={objects}
        lang="en"
        onChange={onChange}
      />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('한국은행');
  });

  it('also resolves object_value when it is an obj-N ref', () => {
    const onChange = vi.fn();
    const fact: FactSummary = {
      ...baseFact,
      subject_uid: 'obj-1',
      object_value: 'obj-2',
    };
    render(
      <FactCard fact={fact} objects={baseObjects} lang="kr" onChange={onChange} />,
    );
    expect(screen.getByTestId('fact-object')).toHaveTextContent('운영시간');
  });

  it('passes through literal object_value untouched ("3.0%", dates, etc.)', () => {
    const onChange = vi.fn();
    const fact: FactSummary = { ...baseFact, object_value: '3.0%' };
    render(
      <FactCard fact={fact} objects={baseObjects} lang="kr" onChange={onChange} />,
    );
    expect(screen.getByTestId('fact-object')).toHaveTextContent('3.0%');
  });

  it('shows "(미해석)" marker when subject_uid is obj-N but not in objects', () => {
    const onChange = vi.fn();
    const fact: FactSummary = { ...baseFact, subject_uid: 'obj-99' };
    render(
      <FactCard fact={fact} objects={baseObjects} lang="kr" onChange={onChange} />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('obj-99');
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(미해석)');
  });

  it('shows "(unresolved)" marker on EN mode for missing refs', () => {
    const onChange = vi.fn();
    const fact: FactSummary = { ...baseFact, subject_uid: 'obj-99' };
    render(
      <FactCard fact={fact} objects={baseObjects} lang="en" onChange={onChange} />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(unresolved)');
  });

  it('regression: works without objects prop (highlighted_text fact)', () => {
    const onChange = vi.fn();
    // A highlighted_text capture's structure stage may produce a fact
    // whose subject_uid is still obj-N. Without the objects prop the
    // card must not crash — it falls back to the "(미해석)" marker,
    // which is honest about the unresolved state.
    render(
      <FactCard fact={baseFact} lang="kr" onChange={onChange} />,
    );
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('obj-1');
    expect(screen.getByTestId('fact-subject')).toHaveTextContent('(미해석)');
    expect(screen.getByTestId('fact-object')).toHaveTextContent('jobs');
  });
});
