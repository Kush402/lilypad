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
    } satisfies AppStateDto);

    render(<Diagnostics />);

    expect(screen.getByText('Screen Recording')).toBeInTheDocument();
    expect(screen.getByText('Accessibility')).toBeInTheDocument();
    expect(screen.getByText('degraded: not granted')).toBeInTheDocument();
    expect(screen.getByText(/desktop-abc/)).toBeInTheDocument();
  });

  it('renders nothing crash-worthy before state has loaded', () => {
    vi.mocked(useAppState).mockReturnValue(null);
    expect(() => render(<Diagnostics />)).not.toThrow();
  });
});
