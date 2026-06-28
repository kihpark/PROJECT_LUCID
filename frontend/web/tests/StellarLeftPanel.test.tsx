/**
 * fix/stellar-leftpanel-simplify (2026-06-28 PO 명령) — left-panel
 * surface tests.
 *
 * Direct PO command: "좌패널 단순화 부탁". Drastic reading per the
 * dogfood quote "노드 엔티티 별 구분이 제일 먼저 필요해 보임. ...
 * 좌패널 복잡함." → ENTITY (WHO / WHAT / WHERE) 만 남기고 fact_type /
 * as_of / link_status 섹션은 좌패널 UI 에서 제거.
 *
 * These tests pin the simplified surface:
 *   - ENTITY 토글 3개 만 보인다.
 *   - 옛 fact_type / as_of / link_status 컨트롤은 절대 안 보인다.
 *   - 단순화 회귀 가드 (re-introduce 방지).
 *
 * Data-layer 보존 (link_status / fact_type / as_of 필드) 는
 * StellarView.test.tsx 의 CLAIM 토글 / hover card 테스트가 담는다.
 */
import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';

import { StellarLeftPanel, type EntityBucket } from '@/components/StellarLeftPanel';

function harness(initial?: Partial<Record<EntityBucket, boolean>>) {
  const buckets: Record<EntityBucket, boolean> = {
    who: initial?.who ?? true,
    what: initial?.what ?? true,
    where: initial?.where ?? true,
  };
  const onChange = vi.fn();
  const utils = render(
    <StellarLeftPanel
      entityBuckets={buckets}
      onEntityBucketChange={onChange}
    />,
  );
  return { onChange, ...utils };
}

describe('StellarLeftPanel (fix/stellar-leftpanel-simplify)', () => {
  it('renders the left-panel container', () => {
    harness();
    expect(screen.getByTestId('stellar-left-panel')).toBeInTheDocument();
  });

  it('renders exactly the 3 ENTITY toggles (WHO / WHAT / WHERE)', () => {
    harness();
    expect(screen.getByTestId('stellar-filter-entity-who')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-filter-entity-what')).toBeInTheDocument();
    expect(screen.getByTestId('stellar-filter-entity-where')).toBeInTheDocument();
    // No 4th bucket has snuck in.
    const checkboxes = screen
      .getAllByRole('checkbox')
      .filter((el) => (el.getAttribute('data-testid') ?? '').startsWith('stellar-filter-entity-'));
    expect(checkboxes).toHaveLength(3);
  });

  it('★ does NOT render the legacy fact_type section (PO simplify)', () => {
    harness();
    expect(screen.queryByTestId('stellar-filter-fact-type-action')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-filter-fact-type-claim')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-filter-fact-type-measurement')).not.toBeInTheDocument();
  });

  it('★ does NOT render the legacy as_of section (PO simplify)', () => {
    harness();
    expect(screen.queryByTestId('stellar-filter-as-of-from')).not.toBeInTheDocument();
    expect(screen.queryByTestId('stellar-filter-as-of-to')).not.toBeInTheDocument();
  });

  it('★ does NOT render the legacy link_status section (PO simplify)', () => {
    harness();
    expect(screen.queryByTestId('stellar-filter-link-status')).not.toBeInTheDocument();
  });

  it('★ legacy section headers (FACT TYPE / AS_OF / LINK STATUS) absent', () => {
    harness();
    // Coarse text-content guard so a future regression that re-introduces
    // any of the three trips the same assertion regardless of testid form.
    const text = screen.getByTestId('stellar-left-panel').textContent ?? '';
    expect(text).not.toMatch(/FACT TYPE/i);
    expect(text).not.toMatch(/AS_OF/i);
    expect(text).not.toMatch(/LINK STATUS/i);
  });

  it('checkboxes reflect entityBuckets prop (controlled)', () => {
    harness({ who: false, what: true, where: false });
    const who = screen.getByTestId('stellar-filter-entity-who') as HTMLInputElement;
    const what = screen.getByTestId('stellar-filter-entity-what') as HTMLInputElement;
    const where = screen.getByTestId('stellar-filter-entity-where') as HTMLInputElement;
    expect(who.checked).toBe(false);
    expect(what.checked).toBe(true);
    expect(where.checked).toBe(false);
  });

  it('toggling WHO calls onEntityBucketChange("who", next)', () => {
    const { onChange } = harness({ who: true, what: true, where: true });
    const who = screen.getByTestId('stellar-filter-entity-who');
    fireEvent.click(who);
    expect(onChange).toHaveBeenCalledWith('who', false);
  });

  it('toggling WHAT calls onEntityBucketChange("what", next)', () => {
    const { onChange } = harness({ who: false, what: false, where: false });
    const what = screen.getByTestId('stellar-filter-entity-what');
    fireEvent.click(what);
    expect(onChange).toHaveBeenCalledWith('what', true);
  });

  it('toggling WHERE calls onEntityBucketChange("where", next)', () => {
    const { onChange } = harness({ who: true, what: true, where: true });
    const where = screen.getByTestId('stellar-filter-entity-where');
    fireEvent.click(where);
    expect(onChange).toHaveBeenCalledWith('where', false);
  });

  it('ENTITY labels carry the human-readable Korean bucket names', () => {
    harness();
    const panel = screen.getByTestId('stellar-left-panel');
    expect(panel.textContent).toContain('WHO');
    expect(panel.textContent).toContain('사람/조직');
    expect(panel.textContent).toContain('WHAT');
    expect(panel.textContent).toContain('개념/사건');
    expect(panel.textContent).toContain('WHERE');
    expect(panel.textContent).toContain('장소');
  });
});
