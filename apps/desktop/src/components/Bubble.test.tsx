import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Bubble } from './Bubble';
import { useAppState } from '../lib/useAppState';
import { api } from '../lib/tauri';
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

  it('shows a status-appropriate tooltip so the click target is discoverable', () => {
    mockState('active');
    render(<Bubble />);
    expect(screen.getByRole('button')).toHaveAttribute(
      'title',
      expect.stringContaining('disconnect'),
    );
  });

  // Color-only status encoding fails WCAG 1.4.1 and specifically misleads
  // assistive-tech users when the announced label is static and wrong for
  // the current state. See docs/audit/m3/desktop-ux.md Finding 14.
  it('gives an active session an accessible label that says "disconnect", not the generic idle "pair a phone" text', () => {
    mockState('active');
    render(<Bubble />);
    const button = screen.getByRole('button');
    expect(button).toHaveAccessibleName(expect.stringContaining('disconnect'));
    expect(button).not.toHaveAccessibleName(expect.stringContaining('pairing QR'));
  });

  it('gives idle a distinct accessible label describing the pair action', () => {
    mockState('idle');
    render(<Bubble />);
    expect(screen.getByRole('button')).toHaveAccessibleName(expect.stringContaining('pairing QR'));
  });
});
