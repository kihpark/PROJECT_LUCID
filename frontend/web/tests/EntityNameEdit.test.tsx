/**
 * REQ-012-v2 — EntityNameEdit unit tests.
 *
 * PO 의뢰서 verbatim (image #145 dogfood):
 *   "한 총리 라고 되어 있는데, 사용자가 한성숙 으로 바꾸고 싶다면?"
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { EntityNameEdit } from '@/components/EntityNameEdit';
import * as api from '@/lib/api';

describe('EntityNameEdit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the input with the current name', () => {
    render(
      <EntityNameEdit
        spaceId="space-1"
        entityUid="ent-1"
        currentName="한 총리"
      />,
    );
    const input = screen.getByTestId('entity-name-input') as HTMLInputElement;
    expect(input.value).toBe('한 총리');
  });

  it('disables save button when input equals current name', () => {
    render(
      <EntityNameEdit
        spaceId="space-1"
        entityUid="ent-1"
        currentName="한 총리"
      />,
    );
    const button = screen.getByTestId('entity-name-save') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('calls updateEntityName + onChanged on submit', async () => {
    const spy = vi.spyOn(api, 'updateEntityName').mockResolvedValue({
      entity_uid: 'ent-1',
      primary_label: '한성숙',
      previous_name: '한 총리',
      aliases: ['한 총리'],
      relabel_history_size: 1,
      updated_at: '2026-07-01T00:00:00Z',
    });
    const onChanged = vi.fn();
    render(
      <EntityNameEdit
        spaceId="space-1"
        entityUid="ent-1"
        currentName="한 총리"
        onChanged={onChanged}
      />,
    );
    const input = screen.getByTestId('entity-name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '한성숙' } });
    const button = screen.getByTestId('entity-name-save') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(spy).toHaveBeenCalledWith('space-1', 'ent-1', '한성숙', {
      previousName: '한 총리',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('entity-name-saved')).toBeTruthy();
  });

  it('surfaces server error on failure', async () => {
    vi.spyOn(api, 'updateEntityName').mockRejectedValue(new Error('500 boom'));
    render(
      <EntityNameEdit
        spaceId="space-1"
        entityUid="ent-1"
        currentName="한 총리"
      />,
    );
    const input = screen.getByTestId('entity-name-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '한성숙' } });
    const button = screen.getByTestId('entity-name-save') as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByTestId('entity-name-error').textContent).toMatch(/500 boom/);
  });
});
