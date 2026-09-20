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
  hostedAvailable: false,
  hostedOrigin: null,
};
const ON = { ...OFF, hasKey: true, source: 'settings' };
/** A Mac signed in to an account, so Lilypad's own way of running is
 *  reachable. Whether it is PAID for is the backend's answer, not this
 *  flag's. */
const HOSTED = { ...OFF, hostedAvailable: true, hostedOrigin: 'https://api.lilypad.example' };

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

  it('runs whole tasks on your own key, once one is saved', async () => {
    mocked
      .mockResolvedValueOnce(ON)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...ON, engine: 'typesafe' });
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-engine-typesafe')).toBeTruthy());
    fireEvent.click(screen.getByLabelText(/Your own TypeSafe key runs whole tasks/));
    await waitFor(() =>
      expect(mocked).toHaveBeenCalledWith('set_ask_engine', { engine: 'typesafe' }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText(/Your own TypeSafe key runs whole tasks/) as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
  });

  it('offers Lilypad’s own account with no key at all, labelled Pro', async () => {
    // ADR-0020: the hosted way needs no TypeSafe key on this Mac. Hiding it
    // behind the key field is what the first draft did, and it made the one
    // option a subscriber is meant to use invisible to them.
    mocked
      .mockResolvedValueOnce(HOSTED)
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ ...HOSTED, engine: 'lilypad' });
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-engine-lilypad')).toBeTruthy());
    expect(screen.getByTestId('instant-state').textContent).toBe('Off');
    const label = screen.getByTestId('instant-engine-lilypad').textContent ?? '';
    expect(label).toMatch(/Pro/);
    expect(label).toMatch(/no key needed/i);
    expect(label).toMatch(/25 tasks a day/);
    // The destination named is Lilypad's server, because that is what
    // receives the reading — saying TypeSafe here would be untrue.
    expect(label).toContain('https://api.lilypad.example');
    expect(label).not.toMatch(/straight to TypeSafe/);

    fireEvent.click(screen.getByLabelText(/Lilypad runs whole tasks/));
    await waitFor(() =>
      expect(mocked).toHaveBeenCalledWith('set_ask_engine', { engine: 'lilypad' }),
    );
  });

  it('does not offer what this Mac cannot reach', async () => {
    // No false claim that a route exists: a build with no control plane
    // wired shows no Lilypad option at all, rather than one that fails.
    mocked.mockResolvedValueOnce(OFF);
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-engine')).toBeTruthy());
    expect(screen.queryByTestId('instant-engine-lilypad')).toBeNull();
  });

  it('keeps your own key working with no subscription', async () => {
    // BYOK is every tier's, and nothing on this card may suggest otherwise.
    mocked.mockResolvedValueOnce(ON);
    render(<InstantActionsCard />);
    await waitFor(() => expect(screen.getByTestId('instant-engine-typesafe')).toBeTruthy());
    const byok = screen.getByTestId('instant-engine-typesafe').textContent ?? '';
    expect(byok).not.toMatch(/Pro/);
    expect(byok).toMatch(/straight to TypeSafe/);
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
