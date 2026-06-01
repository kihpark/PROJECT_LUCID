'use client';

import { ActionButton } from './ActionButton';

export type Lang = 'kr' | 'en';

interface Props {
  value: Lang;
  onChange: (next: Lang) => void;
}

export function LangToggle({ value, onChange }: Props) {
  return (
    <div
      role="group"
      aria-label="Display language"
      className="inline-flex items-center gap-1 rounded-md border border-border-subtle p-1"
    >
      <ActionButton
        variant="ghost"
        active={value === 'kr'}
        onClick={() => onChange('kr')}
        aria-pressed={value === 'kr'}
      >
        KR
      </ActionButton>
      <ActionButton
        variant="ghost"
        active={value === 'en'}
        onClick={() => onChange('en')}
        aria-pressed={value === 'en'}
      >
        EN
      </ActionButton>
    </div>
  );
}
