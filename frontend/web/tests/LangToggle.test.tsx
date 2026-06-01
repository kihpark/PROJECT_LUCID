import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { LangToggle } from '@/components/LangToggle';

describe('LangToggle', () => {
  it('flips between KR and EN', () => {
    const onChange = vi.fn();
    render(<LangToggle value="kr" onChange={onChange} />);
    expect(screen.getByText('KR')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByText('EN'));
    expect(onChange).toHaveBeenCalledWith('en');
  });
});
