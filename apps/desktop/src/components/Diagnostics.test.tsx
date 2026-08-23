import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Diagnostics } from './Diagnostics';
import { useAppState } from '../lib/useAppState';
import type { AppStateDto } from '../lib/tauri';

vi.mock('../lib/useAppState', () => ({
  useAppState: vi.fn(),
}));

// Diagnostics now embeds the "Software update" panel, which reads the current
// version and can trigger a check — stub the updater seam so these tests stay
// focused on the health list (the updater flow is covered in
// SoftwareUpdate.test.tsx).
vi.mock('../lib/tauri', () => ({
  updater: {
    currentVersion: vi.fn().mockResolvedValue('0.1.0'),
    check: vi.fn().mockResolvedValue(null),
    relaunch: vi.fn(),
  },
}));

describe('Diagnostics', () => {
  it('renders health entries with consumer-facing labels and the device id', () => {
    vi.mocked(useAppState).mockReturnValue({
      device_id: 'desktop-abc',
      backend_base_url: 'http://localhost:8080',
      session: 'idle',
      current_room_id: null,
      pending_request: null,
      plugin_health: { ScreenCapture: 'ok', Accessibility: 'degraded: not granted' },
      connection_path: null,
      presence: { state: 'online' } as const,
    } satisfies AppStateDto);

    render(<Diagnostics />);

    expect(screen.getByText('Screen Recording')).toBeInTheDocument();
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
    expect(screen.getByText('degraded: not granted')).toBeInTheDocument();
    expect(screen.getByText(/desktop-abc/)).toBeInTheDocument();
  });

  it.each([
    ['lan', /local network/i],
    ['direct', /over the internet/i],
    ['relay', /TURN/i],
  ] as const)('names the %s path in words', (path, expected) => {
    // The whole reason this exists: a connectivity test has to be able to say
    // which transport a session actually used, and every other signal — the
    // status indicator, the candidate logs — looks the same for all three.
    vi.mocked(useAppState).mockReturnValue({
      device_id: 'desktop-abc',
      backend_base_url: 'http://localhost:8080',
      session: 'active',
      current_room_id: 'room-1',
      pending_request: null,
      plugin_health: {},
      connection_path: path,
      presence: { state: 'online' } as const,
    } satisfies AppStateDto);

    render(<Diagnostics />);
    expect(screen.getByTestId('connection-path')).toHaveTextContent(expected);
  });

  it('says no session has connected rather than implying one has', () => {
    vi.mocked(useAppState).mockReturnValue({
      device_id: 'desktop-abc',
      backend_base_url: 'http://localhost:8080',
      session: 'idle',
      current_room_id: null,
      pending_request: null,
      plugin_health: {},
      connection_path: null,
      presence: { state: 'online' } as const,
    } satisfies AppStateDto);

    render(<Diagnostics />);
    expect(screen.getByTestId('connection-path')).toHaveTextContent(/no session/i);
  });

  it('renders nothing crash-worthy before state has loaded', () => {
    vi.mocked(useAppState).mockReturnValue(null);
    expect(() => render(<Diagnostics />)).not.toThrow();
  });
});
