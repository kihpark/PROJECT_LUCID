'use client';

import type { ButtonHTMLAttributes } from 'react';

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  active?: boolean;
}

const baseStyles =
  'inline-flex items-center justify-center rounded-md px-3 py-1.5 ' +
  'text-sm font-medium transition-colors focus:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent-cool ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const variantStyles: Record<NonNullable<Props['variant']>, string> = {
  primary:
    'bg-accent-cool text-bg-base hover:bg-accent-cool/90',
  secondary:
    'bg-bg-card border border-border-subtle text-text-primary hover:bg-bg-card-hover',
  danger:
    'bg-bg-card border border-accent-error/40 text-accent-error hover:bg-accent-error/10',
  ghost:
    'text-text-secondary hover:text-text-primary hover:bg-bg-card-hover',
};

const activeRing = 'ring-2 ring-accent-cool ring-offset-2 ring-offset-bg-base';

export function ActionButton({
  variant = 'secondary',
  active = false,
  className = '',
  ...props
}: Props) {
  const classes = [
    baseStyles,
    variantStyles[variant],
    active ? activeRing : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <button {...props} className={classes} />;
}
