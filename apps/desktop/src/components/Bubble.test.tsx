import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Bubble } from './Bubble';
import { useAppState } from '../lib/useAppState';
import { api, updater } from '../lib/tauri';
import { WebviewWindow } from '@tauri-apps/api/webviewWindow';

vi.mock('../lib/useAppState', () => ({
  useAppState: vi.fn(),
}));

vi.mock('../lib/tauri', () => ({
  api: {
    createPairing: vi.fn().mockResolvedValue(undefined),
    showQrWindow: vi.fn().mockResolvedValue(undefined),
    showControl: vi.fn().mockResolvedValue(undefined),
  },
  updater: {
    currentVersion: vi.fn().mockResolvedValue('0.1.31'),
    check: vi.fn().mockResolvedValue(null),
    relaunch: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@tauri-apps/api/webviewWindow', () => ({
  WebviewWindow: {
    getByLabel: vi.fn(),
  },
}));

function mockState(session: string) {
  vi.mocked(useAppState).mockReturnValue({
    device_id: 'd1',
    backend_base_url: 'http://x',
    session: session as never,
    current_room_id: null,
    pending_request: null,
    plugin_health: {},
    connection_path: null,
    presence: { state: 'online' } as const,
    shared_display: null,
  });
}

describe('Bubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * Regression: an idle click used to open the pairing QR directly, making a
   * QR code the app's front door — shown before any account existed and before
   * the user had seen a screen explaining what Lilypad is. The dashboard is
   * the front door; it carries its own "Pair a new device" button, so pairing
   * is one click further away and one click after the two things that give it
   * meaning (who you are, and which computer is yours).
   */
  it('idle: click opens the DASHBOARD, not the pairing QR', async () => {
    mockState('idle');
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(api.showControl).toHaveBeenCalledTimes(1));
    expect(api.showQrWindow).not.toHaveBeenCalled();
    // The bubble still mints no pairing itself — that caused a double pairing
    // per click (see commit 9490187). The QR overlay's mount effect remains
    // the single `createPairing` caller.
    expect(api.createPairing).not.toHaveBeenCalled();
    expect(WebviewWindow.getByLabel).not.toHaveBeenCalled();
  });

  it('pairing: click reopens the qr-overlay window instead of starting a new pairing', async () => {
    mockState('pairing');
    const win = {
      show: vi.fn().mockResolvedValue(undefined),
      setFocus: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(win as never);
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(WebviewWindow.getByLabel).toHaveBeenCalledWith('qr-overlay'));
    expect(win.show).toHaveBeenCalled();
    expect(win.setFocus).toHaveBeenCalled();
    expect(api.createPairing).not.toHaveBeenCalled();
  });

  // This is the regression test for the "stop-ship" bug in
  // docs/audit/m3/desktop-ux.md Finding 3: clicking the bubble during an
  // ACTIVE session must never call createPairing() again (which would
  // silently disconnect the live session by overwriting AppState.control_tx).
  //
  // Uses `api.showControl()` (create-if-absent, else focus) rather than the
  // old `focusWindow('control')`, which only focused an ALREADY-OPEN window —
  // a trusted phone's silent auto-reconnect never creates it, so that path
  // left the dashboard completely unreachable.
  it('active: click opens/focuses the control window via showControl and NEVER calls createPairing again', async () => {
    mockState('active');
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(api.showControl).toHaveBeenCalledTimes(1));
    expect(api.createPairing).not.toHaveBeenCalled();
  });

  it('awaiting_approval: click opens/focuses the control window via showControl, not a new pairing', async () => {
    mockState('awaiting_approval');
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(api.showControl).toHaveBeenCalledTimes(1));
    expect(api.createPairing).not.toHaveBeenCalled();
  });

  it('connecting: click opens/focuses the control window via showControl, not a new pairing', async () => {
    mockState('connecting');
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(api.showControl).toHaveBeenCalledTimes(1));
    expect(api.createPairing).not.toHaveBeenCalled();
  });

  /**
   * These three used to require the OPPOSITE, and the suite was what kept the
   * mistake alive.
   *
   * They asserted the active label says "disconnect" and the idle label says
   * "pairing QR" — written when an idle click really did open the QR. That
   * changed (see the first test in this file: the dashboard, not the pairing
   * QR), the labels were never revisited, and these tests then guarded the
   * stale copy against being corrected.
   *
   * The label is the `title` tooltip AND the accessible name, so both audiences
   * were told the wrong thing — and the active one promised a DESTRUCTIVE
   * action that the click does not perform. That is the worse half: a
   * screen-reader user was told this button ends the session, when it opens the
   * window where Disconnect lives.
   *
   * What is still worth pinning is what these were reaching for: the label is
   * specific to the state, not one static sentence for all five.
   */
  it('shows a status-appropriate tooltip so the click target is discoverable', () => {
    mockState('active');
    render(<Bubble />);
    expect(screen.getByRole('button')).toHaveAttribute(
      'title',
      expect.stringContaining('connected'),
    );
  });

  // Color-only status encoding fails WCAG 1.4.1 and specifically misleads
  // assistive-tech users when the announced label is static and wrong for
  // the current state. See docs/audit/m3/desktop-ux.md Finding 14.
  it('describes an active session without promising a disconnect the click does not do', () => {
    mockState('active');
    render(<Bubble />);
    const button = screen.getByRole('button');
    expect(button).toHaveAccessibleName(expect.stringContaining('phone is connected'));
    // The click calls `showControl`. Saying "click to disconnect" would be the
    // app describing a destructive act it is not about to perform.
    expect(button).not.toHaveAccessibleName(expect.stringContaining('disconnect'));
  });

  it('gives idle its own label, and does not promise a QR the click no longer shows', () => {
    mockState('idle');
    render(<Bubble />);
    const button = screen.getByRole('button');
    expect(button).toHaveAccessibleName(expect.stringContaining('dashboard'));
    expect(button).not.toHaveAccessibleName(expect.stringContaining('pairing QR'));
  });

  it('asks about updates at launch, from the one window that exists then', async () => {
    // The dashboard's banner was the app's only automatic check, and the
    // dashboard is not open at launch — so a Mac whose owner never opened it
    // never checked. Measured: 0.1.30 for 28 hours after 0.1.31 published.
    mockState('idle');
    render(<Bubble />);
    await waitFor(() => expect(vi.mocked(updater.check)).toHaveBeenCalled());
    // Nothing available: the bubble stays exactly as it was.
    expect(screen.queryByTestId('bubble-update')).toBeNull();
  });

  it('shows a waiting update on the bubble, and names it', async () => {
    vi.mocked(updater.check).mockResolvedValueOnce({
      version: '0.1.31',
      body: null,
    } as never);
    mockState('idle');
    render(<Bubble />);
    expect(await screen.findByTestId('bubble-update')).toBeTruthy();
    expect(screen.getByRole('button')).toHaveAccessibleName(expect.stringContaining('0.1.31'));
  });

  it('gives every state a label of its own', () => {
    const seen = new Set<string>();
    for (const state of ['idle', 'pairing', 'awaiting_approval', 'connecting', 'active'] as const) {
      mockState(state);
      const { unmount } = render(<Bubble />);
      const name = screen.getByRole('button').getAttribute('aria-label') ?? '';
      expect(name).not.toBe('');
      seen.add(name);
      unmount();
    }
    expect(seen.size).toBe(5);
  });
});
