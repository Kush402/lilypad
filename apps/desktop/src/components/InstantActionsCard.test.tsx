import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { invoke } from '@tauri-apps/api/core';
import { InstantActionsCard } from './InstantActionsCard';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const OFF = {
  hasKey: false,
  source: 'none',
  origin: 'https://api.typesafe.ai',
  problem: null,
  engine: 'model',
};
const ON = { ...OFF, hasKey: true, source: 'settings' };

const mocked = vi.mocked(invoke);

describe('InstantActionsCard', () => {
  beforeEach(() => mocked.mockReset());

  it('says what is sent before a key is added', async () => {
    mocked.mockResolvedValueOnce(OFF);
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-state').textContent).toBe('Off'));
    expect(screen.getByTestId('instant-card').textContent).toMatch(/never a screenshot/);
    expect(screen.getByTestId('instant-card').textContent).toMatch(
      /buttons, links, fields, rows, and menu items/,
    );
    expect(screen.getByTestId('instant-card').textContent).toMatch(/matching installed-app names/);
    expect(screen.queryByTestId('instant-remove')).toBeNull();
  });

  it('checks and saves a key, then shows where commands go', async () => {
    mocked.mockResolvedValueOnce(OFF).mockResolvedValueOnce(ON);
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-state').textContent).toBe('Off'));
    fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: 'ts_key' } });
    fireEvent.click(screen.getByText('Check and save'));
    await waitFor(() => expect(screen.getByTestId('instant-saved')).toBeTruthy());
    expect(mocked).toHaveBeenLastCalledWith('set_instant_key', { apiKey: 'ts_key' });
    expect(screen.getByTestId('instant-state').textContent).toBe('On');
    expect(screen.getByTestId('instant-origin').textContent).toContain('https://api.typesafe.ai');
    expect((screen.getByLabelText('TypeSafe API key') as HTMLInputElement).value).toBe('');
  });

  it('shows why a key was refused, and keeps it off', async () => {
    mocked
      .mockResolvedValueOnce(OFF)
      .mockRejectedValueOnce(
        'TypeSafe did not accept that key. Copy it again from console.typesafe.ai.',
      );
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-state').textContent).toBe('Off'));
    fireEvent.change(screen.getByLabelText('TypeSafe API key'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByText('Check and save'));
    await waitFor(() =>
      expect(screen.getByTestId('instant-error').textContent).toMatch(/did not accept/),
    );
    expect(screen.getByTestId('instant-state').textContent).toBe('Off');
  });

  it('says so when TypeSafe stopped accepting a saved key', async () => {
    mocked.mockResolvedValueOnce({
      ...ON,
      problem:
        'TypeSafe no longer accepts this key, so short commands go to the AI model instead. Check and save a new key, or turn instant actions off.',
    });
    render(<InstantActionsCard />);
    await waitFor(() =>
      expect(screen.getByTestId('instant-state').textContent).toBe('Key refused'),
    );
    expect(screen.getByTestId('instant-problem').textContent).toMatch(/no longer accepts/);
    expect(screen.getByTestId('instant-remove')).toBeTruthy();
  });

  it('chooses who runs a whole task, once a key is saved', async () => {
    mocked
      .mockResolvedValueOnce(ON)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...ON, engine: 'lilypad' });
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-engine')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/TypeSafe runs whole tasks/));
    await waitFor(() =>
      expect(mocked).toHaveBeenCalledWith('set_ask_engine', { engine: 'lilypad' }),
    );
    await waitFor(() =>
      expect((screen.getByLabelText(/TypeSafe runs whole tasks/) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
  });

  it('turns instant actions off', async () => {
    mocked.mockResolvedValueOnce(ON).mockResolvedValueOnce(OFF);
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-state').textContent).toBe('On'));
    fireEvent.click(screen.getByTestId('instant-remove'));
    await waitFor(() => expect(screen.getByTestId('instant-state').textContent).toBe('Off'));
    expect(mocked).toHaveBeenLastCalledWith('forget_instant_key');
  });

  it('an override is named and cannot be removed from here', async () => {
    mocked.mockResolvedValueOnce({ ...ON, source: 'env' });
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-env')).toBeTruthy());
    expect(screen.queryByTestId('instant-remove')).toBeNull();
  });
});
