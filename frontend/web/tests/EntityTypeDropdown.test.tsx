/**
 * REQ-012-v1 — EntityTypeDropdown unit tests.
 *
 * PO 의뢰서 verbatim:
 *   - 10종 드롭다운 + 변경 즉시 그래프 반영 + AI confidence 낮으면 확인 필요.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EntityTypeDropdown } from '@/components/EntityTypeDropdown';
import * as api from '@/lib/api';

describe('EntityTypeDropdown', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all 10 entity_type options (PO closed set)', () => {
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="organization"
      />,
    );
    const select = screen.getByTestId('entity-type-select') as HTMLSelectElement;
    // 10 options + 1 placeholder.
    expect(select.options.length).toBe(11);
    const values = Array.from(select.options).map((o) => o.value);
    for (const t of [
      'person', 'organization', 'group', 'knowledge', 'resource',
      'task', 'concept', 'event', 'metric', 'location',
    ]) {
      expect(values).toContain(t);
    }
  });

  it('shows AI low-confidence banner when confidence < 0.55', () => {
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="concept"
        confidence={0.3}
      />,
    );
    const banner = screen.getByTestId('entity-type-low-confidence');
    expect(banner.textContent).toMatch(/확인 필요/);
    expect(banner.textContent).toMatch(/30%/);
  });

  it('hides low-confidence banner when confidence >= 0.55', () => {
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="concept"
        confidence={0.8}
      />,
    );
    expect(screen.queryByTestId('entity-type-low-confidence')).toBeNull();
    expect(screen.getByTestId('entity-type-confidence').textContent).toMatch(/80%/);
  });

  it('calls changeEntityType then onChanged on submit', async () => {
    const spy = vi.spyOn(api, 'changeEntityType').mockResolvedValue({
      entity_uid: 'ent-1',
      primary_label: '광주',
      previous_entity_type: 'organization',
      entity_type: 'location',
      relabel_history_size: 1,
      updated_at: '2026-07-01T00:00:00Z',
    });
    const onChanged = vi.fn();
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="organization"
        onChanged={onChanged}
      />,
    );
    const select = screen.getByTestId('entity-type-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'location' } });
    const button = screen.getByTestId('entity-type-save') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(spy).toHaveBeenCalledWith('space-1', 'ent-1', 'location');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('entity-type-saved')).toBeTruthy();
  });

  it('disables save when selected matches current', () => {
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="location"
      />,
    );
    const button = screen.getByTestId('entity-type-save') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  // ★ REQ-012 UI 완성도 fix (PO 2026-07-01) — 세 가지 시각/텍스트 회귀 잠금.
  it('label reads "타입 변경" (was "종류 변경") — PO copy correction', () => {
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="organization"
      />,
    );
    const form = screen.getByTestId('entity-type-dropdown');
    expect(form.textContent).toMatch(/타입 변경/);
    expect(form.textContent).not.toMatch(/종류 변경/);
  });

  it('select uses dark palette (dark theme regression lock)', () => {
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="organization"
      />,
    );
    const select = screen.getByTestId('entity-type-select') as HTMLSelectElement;
    // ★ background/color 은 verbatim 다크 hex — 흰 배경 회귀 방지.
    expect(select.style.background).toBe('rgb(11, 17, 20)'); // #0b1114
    expect(select.style.colorScheme).toBe('dark');
    // ★ option 도 다크 명시 (native <option> 브라우저 기본은 시스템 색).
    const options = Array.from(select.options);
    for (const opt of options) {
      expect(opt.style.background).toBe('rgb(11, 17, 20)');
    }
  });
});
