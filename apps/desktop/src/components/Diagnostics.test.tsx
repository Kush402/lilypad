import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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
  api: {
    logFilePath: vi.fn().mockResolvedValue('/Users/x/Library/Logs/Lilypad/lilypad.log'),
    revealLogFile: vi.fn().mockResolvedValue(undefined),
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

/**
 * The log file, from support's point of view.
 *
 * Until 2026-08-24 the desktop wrote no log at all: `env_logger` went to
 * stderr, and a `.app` launched from Finder or the login-item LaunchAgent has
 * no stderr. A customer reporting a bad session left no evidence on their own
 * machine — proven when a "wobbly on cellular" report could be traced through
 * the backend's log and stopped dead at the Mac's half.
 *
 * A log nobody can find is worth very little more, so the path has to reach
 * the one artefact support actually asks for: the copyable report.
 */
describe('Diagnostics — the log file', () => {
  const state = {
    device_id: 'desktop-abc',
    backend_base_url: 'http://localhost:8080',
    session: 'idle',
    current_room_id: null,
    pending_request: null,
    plugin_health: {},
    connection_path: null,
    presence: { state: 'online' } as const,
  } satisfies AppStateDto;

  it('names the log path in the report support is asked to paste', () => {
    expect(
      diagnosticsReport(state, '0.1.7', '/Users/x/Library/Logs/Lilypad/lilypad.log'),
    ).toContain('log: /Users/x/Library/Logs/Lilypad/lilypad.log');
  });

  // Says so rather than omitting the line. An absent `log:` row is
  // indistinguishable from an old build, and the whole point is telling
  // support which of those they are looking at.
  it('says the log is not being written rather than staying silent', () => {
    expect(diagnosticsReport(state, '0.1.7', null)).toContain('log: not being written');
  });

  it('shows the path on screen, with a way to reach it', async () => {
    vi.mocked(useAppState).mockReturnValue(state);
    render(<Diagnostics />);
    // `findByTestId` waits for the ELEMENT, and the element is there from the
    // first paint carrying its placeholder — so it resolves immediately and
    // the assertion runs before the path has been fetched. Waiting on the
    // CONTENT is the difference between a test that passes alone and one that
    // also passes under load, which is when it ran a race and lost.
    await waitFor(() =>
      expect(screen.getByTestId('log-path')).toHaveTextContent(
        '/Users/x/Library/Logs/Lilypad/lilypad.log',
      ),
    );
    expect(screen.getByTestId('reveal-log')).toBeEnabled();
  });
});
