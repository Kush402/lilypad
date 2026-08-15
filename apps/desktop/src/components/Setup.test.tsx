import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Setup } from './Setup';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(),
}));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: vi.fn(),
}));
// The linking panel has its own suite (AccountPanel.test.tsx); stubbing it here
// keeps these tests about the wizard's own ordering and its final claim.
vi.mock('./AccountPanel', () => ({
  AccountPanel: () => <div data-testid="account-panel" />,
}));

function status(overrides: Partial<{ screen_capture: boolean; accessibility: boolean }> = {}) {
  return { screen_capture: false, accessibility: false, ...overrides };
}

/** Grant both permissions, which is what unlocks steps 2 and 3. */
function grantAll(handler: ((event: { payload: unknown }) => void) | undefined) {
  handler?.({ payload: status({ screen_capture: true, accessibility: true }) });
}

/** `noUncheckedIndexedAccess` makes `arr[n]` possibly-`undefined`; every call
 * site below already knows the element exists (asserted by the surrounding
 * `getAllByText` succeeding at all), so this documents that invariant once
 * instead of a non-null assertion at every call site. */
function nth(elements: HTMLElement[], index: number): HTMLElement {
  const el = elements[index];
  if (!el) throw new Error(`expected an element at index ${index}`);
  return el;
}

describe('Setup', () => {
  let eventHandler: ((event: { payload: unknown }) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    eventHandler = undefined;
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'unlinked' };
      return undefined;
    });
    vi.mocked(listen).mockImplementation((async (
      _name: string,
      handler: (e: { payload: unknown }) => void,
    ) => {
      eventHandler = handler;
      return vi.fn();
    }) as unknown as typeof listen);
  });

  /**
   * Ordering regression. First run used to be permissions → link → pair, with
   * no mention of an account anywhere and a QR code as its last screen, which
   * taught the wrong model of what Lilypad is. The account comes first now
   * (ADR-0012) — not because anything below needs it, but because it is step 1
   * of the product.
   */
  it('puts the account step before the permissions step', async () => {
    render(<Setup />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_permission_status'));

    // `AccountSignIn` renders its own h2, so filter to the numbered steps.
    const steps = screen
      .getAllByRole('heading', { level: 2 })
      .map((h) => h.textContent ?? '')
      .filter((text) => /^\d+ · /.test(text));
    expect(steps[0]).toBe('1 · Your account');
    expect(steps[1]).toBe('2 · Permissions');
  });

  it('fetches initial status and shows both permission rows', async () => {
    render(<Setup />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_permission_status'));
    expect(screen.getByText('Screen Recording')).toBeInTheDocument();
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
  });

  it('Grant calls the prompting request_permission command', async () => {
    render(<Setup />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_permission_status'));
    vi.mocked(invoke).mockResolvedValueOnce(true);

    fireEvent.click(nth(screen.getAllByText('Grant'), 0));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('request_permission', { kind: 'screen_capture' }),
    );
  });

  it('Open Settings deep-links via open_permission_settings', async () => {
    render(<Setup />);
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('get_permission_status'));

    fireEvent.click(nth(screen.getAllByText('Open Settings'), 0));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_permission_settings', { kind: 'screen_capture' }),
    );
  });

  it('updates status when a lilypad://permission event fires, without a poll timer', async () => {
    render(<Setup />);
    await waitFor(() =>
      expect(listen).toHaveBeenCalledWith('lilypad://permission', expect.any(Function)),
    );

    eventHandler?.({ payload: status({ screen_capture: true }) });

    await waitFor(() => expect(screen.getAllByText('Granted')).toHaveLength(1));
  });

  it('shows a Done button once both permissions are granted, which closes the window', async () => {
    const closeMock = vi.fn().mockResolvedValue(undefined);
    vi.mocked(getCurrentWindow).mockReturnValue({ close: closeMock } as never);

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    grantAll(eventHandler);

    fireEvent.click(await screen.findByText('Done'));
    expect(closeMock).toHaveBeenCalled();
  });

  // ── First run as a whole (P1) ───────────────────────────────────────────
  // Offering to put a computer on an account, or to pair a phone with it,
  // before it can capture or type is a step out of order — neither would work.
  it('withholds linking and pairing until the permissions are granted', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    expect(screen.queryByTestId('account-panel')).not.toBeInTheDocument();
    expect(screen.queryByText('Show pairing code')).not.toBeInTheDocument();

    grantAll(eventHandler);

    expect(await screen.findByTestId('account-panel')).toBeInTheDocument();
    expect(screen.getByText('Show pairing code')).toBeInTheDocument();
  });

  /**
   * The defect this whole change exists for. The wizard used to finish with
   * "All set — you can start pairing now" as soon as the two permissions were
   * granted, which is the one thing P1's definition of done forbids: the
   * desktop announcing it is ready before a phone has approved it. Permissions
   * say what the machine can do, never whose it is.
   */
  it('does not claim the computer is on an account when it is not', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    const done = await screen.findByTestId('setup-done-unlinked');
    expect(done).toHaveTextContent(/not on an account yet/i);
    expect(screen.queryByTestId('setup-done-linked')).not.toBeInTheDocument();
  });

  /**
   * Regression: the final card derived "not on an account" from
   * `state !== 'linked'`, which lumps in `unknown` — the state that means the
   * backend could not be asked, not that nobody owns this machine. A linked
   * user whose wifi dropped mid-setup was told their computer was on no
   * account and pointed at step 2 to fix it, i.e. invited to redo a ceremony
   * they had already completed. `LinkStateDto` calls the two out as
   * deliberately different for exactly this reason.
   */
  it('does not claim the computer is unlinked when the backend cannot be asked', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'unknown' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByTestId('setup-done-unknown')).toHaveTextContent(/could not check/i);
    expect(screen.queryByTestId('setup-done-unlinked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('setup-done-linked')).not.toBeInTheDocument();
  });

  it('says the computer belongs to the account once a phone has adopted it', async () => {
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === 'get_permission_status') return status();
      if (cmd === 'get_link_state') return { state: 'linked' };
      return undefined;
    });

    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    expect(await screen.findByTestId('setup-done-linked')).toHaveTextContent(
      /belongs to your account/i,
    );
    expect(screen.queryByTestId('setup-done-unlinked')).not.toBeInTheDocument();
  });

  it('opens the pairing code window from the last step', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());
    grantAll(eventHandler);

    fireEvent.click(await screen.findByText('Show pairing code'));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('show_qr_window'));
  });

  // Regression test for the relaunch heuristic in
  // docs/audit/m3/desktop-ux.md Finding 1: only offer a restart after the
  // user demonstrably opened Settings for a permission AND it still reads
  // ungranted after several consecutive polls — never on a timer alone, and
  // never for a permission nobody tried to grant yet.
  it('offers a restart only after Settings was opened AND 3 consecutive polls still read ungranted', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    // Two stale polls with Settings never opened for accessibility — must not offer a restart.
    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });
    expect(screen.queryByText('Restart Lilypad')).not.toBeInTheDocument();

    // User opens Settings for accessibility.
    fireEvent.click(nth(screen.getAllByText('Open Settings'), 1));
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_permission_settings', { kind: 'accessibility' }),
    );

    // Two more stale polls — not yet at the threshold (3).
    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });
    expect(screen.queryByText('Restart Lilypad')).not.toBeInTheDocument();

    // Third consecutive stale poll after opening Settings — now offer it.
    eventHandler?.({ payload: status() });
    await waitFor(() => expect(screen.getByText('Restart Lilypad')).toBeInTheDocument());
  });

  it('a granted permission resets its stale-poll counter', async () => {
    render(<Setup />);
    await waitFor(() => expect(listen).toHaveBeenCalled());

    fireEvent.click(nth(screen.getAllByText('Open Settings'), 1)); // accessibility
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('open_permission_settings', { kind: 'accessibility' }),
    );

    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });
    // Granted in between — counter resets.
    eventHandler?.({ payload: status({ accessibility: true }) });
    eventHandler?.({ payload: status() });
    eventHandler?.({ payload: status() });

    expect(screen.queryByText('Restart Lilypad')).not.toBeInTheDocument();
  });
});
