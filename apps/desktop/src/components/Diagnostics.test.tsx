import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Diagnostics, diagnosticsReport } from './Diagnostics';
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

/**
 * The window exists so a person can hand their state to someone who can read
 * it. Retyping `desktop-b31d4eed-…` over the phone is not that.
 *
 * `pnpm support <email>` answers the server's half — account, devices, pairs,
 * audit. This is the half only the customer's machine knows: which build, which
 * permissions, whether a phone can reach it at all, and how the last session's
 * media travelled.
 */
describe('the report a customer can send', () => {
  const state = {
    device_id: 'desktop-b31d4eed-d318-4e37-ba08-9a1f76349290',
    backend_base_url: 'https://api.takedia.com',
    session: 'idle',
    current_room_id: null,
    pending_request: null,
    plugin_health: { ScreenCapture: 'ok', Accessibility: 'degraded: not granted' },
    connection_path: 'relay',
    presence: { state: 'refused' },
  } satisfies AppStateDto;

  it('carries every fact a support conversation opens with', () => {
    const report = diagnosticsReport(state, '0.1.4');
    expect(report).toContain('version: 0.1.4');
    expect(report).toContain('desktop-b31d4eed-d318-4e37-ba08-9a1f76349290');
    expect(report).toContain('https://api.takedia.com');
    // In words, not `refused` — the reader may be the customer.
    expect(report).toMatch(/unlinked, revoked, or has no key/);
    expect(report).toMatch(/TURN/);
    expect(report).toContain('Screen Recording: ok');
    expect(report).toContain('Accessibility: degraded: not granted');
  });

  it('says so when nothing has been reported, rather than leaving a blank', () => {
    const report = diagnosticsReport(
      { ...state, plugin_health: {}, connection_path: null },
      '0.1.4',
    );
    expect(report).toContain('(none reported)');
    expect(report).toContain('last connection: none yet');
  });

  it('shows whether a phone can reach this Mac, which nothing used to', () => {
    vi.mocked(useAppState).mockReturnValue({ ...state, presence: { state: 'online' } });
    render(<Diagnostics />);
    expect(screen.getByTestId('presence-state')).toHaveTextContent(/a phone can ring this Mac/i);
  });
});
