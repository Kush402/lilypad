import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Control } from './Control';
import { useAppState } from '../lib/useAppState';
import { api } from '../lib/tauri';
import type { AppStateDto } from '../lib/tauri';

vi.mock('../lib/useAppState', () => ({
  useAppState: vi.fn(),
}));

vi.mock('../lib/tauri', () => ({
  api: {
    approve: vi.fn(),
    deny: vi.fn(),
    disconnect: vi.fn(),
    panic: vi.fn(),
    // Trusted devices dashboard (M5.4)
    listTrustedDevices: vi.fn().mockResolvedValue([]),
    setPairAutoApprove: vi.fn(),
    revokePair: vi.fn(),
    getLoginItemEnabled: vi.fn().mockResolvedValue(true),
    setLoginItemEnabled: vi.fn(),
  },
}));

function dto(overrides: Partial<AppStateDto> = {}): AppStateDto {
  return {
    device_id: 'd1',
    backend_base_url: 'http://x',
    session: 'idle',
    current_room_id: null,
    pending_request: null,
    plugin_health: { ScreenCapture: 'ok', Accessibility: 'ok', Encoder: 'not yet tested this run' },
    ...overrides,
  };
}

describe('Control', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the requesting device name and requested scopes instead of fixed prose', () => {
    vi.mocked(useAppState).mockReturnValue(
      dto({
        session: 'awaiting_approval',
        pending_request: {
          device_name: "Kush's iPhone",
          requested_scopes: ['view', 'control'],
          requested_at: Date.now(),
        },
      }),
    );
    render(<Control />);

    expect(screen.getByText("Kush's iPhone")).toBeInTheDocument();
    expect(screen.getByText('View')).toBeInTheDocument();
    expect(screen.getByText('Control')).toBeInTheDocument();
  });

  it('falls back to "An unknown device" when device_name is null', () => {
    vi.mocked(useAppState).mockReturnValue(
      dto({
        session: 'awaiting_approval',
        pending_request: { device_name: null, requested_scopes: ['view'], requested_at: Date.now() },
      }),
    );
    render(<Control />);

    expect(screen.getByText('An unknown device')).toBeInTheDocument();
    expect(screen.getByText('View')).toBeInTheDocument();
    expect(screen.queryByText('Control')).not.toBeInTheDocument();
  });

  it('does not render the approve/deny section outside awaiting_approval', () => {
    vi.mocked(useAppState).mockReturnValue(dto({ session: 'idle' }));
    render(<Control />);

    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Deny')).not.toBeInTheDocument();
  });

  it('does not render a "Plugin health" debug dump anymore — moved to Diagnostics', () => {
    vi.mocked(useAppState).mockReturnValue(dto({ session: 'active' }));
    render(<Control />);

    expect(screen.queryByText(/plugin health/i)).not.toBeInTheDocument();
    expect(screen.queryByText('ScreenCapture')).not.toBeInTheDocument();
  });

  it('active session shows Disconnect and Panic', () => {
    vi.mocked(useAppState).mockReturnValue(dto({ session: 'active' }));
    render(<Control />);

    screen.getByText('Disconnect').click();
    screen.getByText('⛔ Panic').click();
    expect(api.disconnect).toHaveBeenCalled();
    expect(api.panic).toHaveBeenCalled();
  });

  it('approve/deny call the respective commands', () => {
    vi.mocked(useAppState).mockReturnValue(
      dto({
        session: 'awaiting_approval',
        pending_request: { device_name: 'Phone', requested_scopes: ['view'], requested_at: Date.now() },
      }),
    );
    render(<Control />);

    screen.getByText('Approve').click();
    expect(api.approve).toHaveBeenCalled();
    screen.getByText('Deny').click();
    expect(api.deny).toHaveBeenCalled();
  });
});
