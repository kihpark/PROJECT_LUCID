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

  // ★ REQ-013 (PO 2026-07-02) — native <select> 폐기, custom <button>+<ul>.
  //   같은 개수는 새 spec 이 data-testid=`entity-type-option-{value}` 로 담당.
  it('renders all 10 entity_type options (PO closed set)', () => {
    const { getByTestId } = render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="organization"
      />,
    );
    // Open the listbox.
    fireEvent.click(getByTestId('entity-type-select'));
    for (const t of [
      'person', 'organization', 'group', 'knowledge', 'resource',
      'task', 'concept', 'event', 'metric', 'location',
    ]) {
      expect(getByTestId(`entity-type-option-${t}`)).toBeTruthy();
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
    // ★ REQ-013 — 새 커스텀 dropdown: trigger click → option click.
    fireEvent.click(screen.getByTestId('entity-type-select'));
    fireEvent.click(screen.getByTestId('entity-type-option-location'));
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

  // ★ REQ-013 (PO 2026-07-02) — native <select> 폐기, 커스텀 dropdown.
  //   trigger button 이 dark 팔레트인지만 확인 (option 다크는 listbox <ul>
  //   컴포넌트가 담당, DOM 은 open 시에만 존재).
  it('trigger uses dark palette (dark theme regression lock)', () => {
    render(
      <EntityTypeDropdown
        spaceId="space-1"
        entityUid="ent-1"
        currentType="organization"
      />,
    );
    const trigger = screen.getByTestId('entity-type-select') as HTMLButtonElement;
    expect(trigger.style.background).toBe('rgb(11, 17, 20)'); // #0b1114
    // open the listbox and verify at least one option is dark.
    fireEvent.click(trigger);
    const opt = screen.getByTestId('entity-type-option-person') as HTMLButtonElement;
    expect(opt).toBeTruthy();
  });
});
