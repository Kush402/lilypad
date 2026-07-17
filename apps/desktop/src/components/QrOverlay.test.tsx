import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QrOverlay } from './QrOverlay';
import { api } from '../lib/tauri';

vi.mock('../lib/tauri', () => ({
  api: {
    createPairing: vi.fn(),
    getState: vi.fn(),
    simulatePairRequest: vi.fn(),
  },
}));

vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,x') },
}));

function payload(roomId = 'room-12345678-abcd') {
  return {
    v: 2,
    token: 'tok',
    roomId,
    apiBaseUrl: 'http://x',
    signalingUrl: 'ws://x',
    expiresInSeconds: 60,
    deviceName: 'macos desktop',
    platform: 'macos',
  };
}

describe('QrOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.createPairing).mockResolvedValue(payload());
  });

  it('generates a code on mount without asking for confirmation', async () => {
    render(<QrOverlay />);
    await waitFor(() => expect(api.createPairing).toHaveBeenCalledTimes(1));
  });

  it('regenerating a code while nothing is pending does not confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    render(<QrOverlay />);
    await waitFor(() => expect(api.createPairing).toHaveBeenCalledTimes(1));

    vi.mocked(api.getState).mockResolvedValue({
      device_id: 'd',
      backend_base_url: 'x',
      session: 'pairing',
      current_room_id: 'r',
      pending_request: null,
      plugin_health: {},
    });

    screen.getByText('New code').click();
    await waitFor(() => expect(api.createPairing).toHaveBeenCalledTimes(2));
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  // Regression test for docs/audit/m3/desktop-ux.md Finding 9: regenerating
  // while an approval is pending or a session is active must not silently
  // tear it down the same way the bubble click used to (Finding 3).
  it('regenerating while awaiting_approval asks for confirmation, and honors "cancel"', async () => {
    render(<QrOverlay />);
    await waitFor(() => expect(api.createPairing).toHaveBeenCalledTimes(1));

    vi.mocked(api.getState).mockResolvedValue({
      device_id: 'd',
      backend_base_url: 'x',
      session: 'awaiting_approval',
      current_room_id: 'r',
      pending_request: null,
      plugin_health: {},
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

    screen.getByText('New code').click();
    await waitFor(() => expect(confirmSpy).toHaveBeenCalled());
    expect(api.createPairing).toHaveBeenCalledTimes(1); // cancelled — no second call
  });

  it('regenerating while active proceeds only after confirming', async () => {
    render(<QrOverlay />);
    await waitFor(() => expect(api.createPairing).toHaveBeenCalledTimes(1));

    vi.mocked(api.getState).mockResolvedValue({
      device_id: 'd',
      backend_base_url: 'x',
      session: 'active',
      current_room_id: 'r',
      pending_request: null,
      plugin_health: {},
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    screen.getByText('New code').click();
    await waitFor(() => expect(api.createPairing).toHaveBeenCalledTimes(2));
  });

  describe('dev-only "Simulate phone scan" button', () => {
    const originalDev = import.meta.env.DEV;

    afterEach(() => {
      import.meta.env.DEV = originalDev;
    });

    it('renders in a dev build', async () => {
      import.meta.env.DEV = true;
      render(<QrOverlay />);
      await waitFor(() => expect(api.createPairing).toHaveBeenCalled());
      expect(screen.getByText('Simulate phone scan')).toBeInTheDocument();
    });

    it('is compiled out of a production build', async () => {
      import.meta.env.DEV = false;
      render(<QrOverlay />);
      await waitFor(() => expect(api.createPairing).toHaveBeenCalled());
      expect(screen.queryByText('Simulate phone scan')).not.toBeInTheDocument();
    });
  });
});
