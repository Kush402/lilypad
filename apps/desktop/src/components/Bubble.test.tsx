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
  });
}

describe('Bubble', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('idle: click opens the QR window (which is the sole pairing creator)', async () => {
    mockState('idle');
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    // The bubble no longer mints a pairing itself — that caused a double
    // pairing per click (see commit 9490187). It opens the overlay, whose
    // mount effect is the single `createPairing` caller.
    await waitFor(() => expect(api.showQrWindow).toHaveBeenCalledTimes(1));
    expect(api.createPairing).not.toHaveBeenCalled();
    expect(WebviewWindow.getByLabel).not.toHaveBeenCalled();
  });

  it('pairing: click reopens the qr-overlay window instead of starting a new pairing', async () => {
    mockState('pairing');
    const win = { show: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined) };
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
  it('active: click reopens the control window and NEVER calls createPairing again', async () => {
    mockState('active');
    const win = { show: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(win as never);
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(WebviewWindow.getByLabel).toHaveBeenCalledWith('control'));
    expect(win.show).toHaveBeenCalled();
    expect(win.setFocus).toHaveBeenCalled();
    expect(api.createPairing).not.toHaveBeenCalled();
  });

  it('awaiting_approval: click reopens the control window, not a new pairing', async () => {
    mockState('awaiting_approval');
    const win = { show: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined) };
    vi.mocked(WebviewWindow.getByLabel).mockResolvedValue(win as never);
    render(<Bubble />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(WebviewWindow.getByLabel).toHaveBeenCalledWith('control'));
    expect(api.createPairing).not.toHaveBeenCalled();
  });

  it('shows a status-appropriate tooltip so the click target is discoverable', () => {
    mockState('active');
    render(<Bubble />);
    expect(screen.getByRole('button')).toHaveAttribute('title', expect.stringContaining('disconnect'));
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
