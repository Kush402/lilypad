import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Control } from './Control';
import { useAppState } from '../lib/useAppState';
import { api } from '../lib/tauri';
import type { AppStateDto, TrustedPairDto } from '../lib/tauri';

vi.mock('../lib/useAppState', () => ({
  useAppState: vi.fn(),
}));

// The account panel talks to its own commands and renders a QR canvas; it has
// dedicated tests in AccountPanel.test.tsx. Stubbing it keeps these tests about
// the dashboard rather than about linking.
vi.mock('./AccountPanel', () => ({
  AccountPanel: () => <section data-testid="account-panel-stub" />,
}));

vi.mock('../lib/tauri', () => ({
  api: {
    approve: vi.fn(),
    deny: vi.fn(),
    disconnect: vi.fn(),
    panic: vi.fn(),
    showQrWindow: vi.fn(),
    // Trusted devices dashboard (M5.4)
    listTrustedDevices: vi.fn().mockResolvedValue([]),
    setPairAutoApprove: vi.fn(),
    revokePair: vi.fn().mockResolvedValue(undefined),
    getLoginItemEnabled: vi.fn().mockResolvedValue(true),
    setLoginItemEnabled: vi.fn(),
    getPermissionStatus: vi.fn().mockResolvedValue({ screen_capture: true, accessibility: true }),
    getAgentConfig: vi.fn().mockResolvedValue({
      providerKind: null,
      model: null,
      baseUrl: null,
      vision: false,
      hasKey: false,
      source: 'none',
    }),
    showSetup: vi.fn(),
    // Account sign-in (ADR-0012) — signed out, which is the state the
    // dashboard's other assertions were all written against.
    getAccountState: vi.fn().mockResolvedValue({ signedIn: false, email: null, userId: null }),
    // Linked, so the dashboard's other assertions run against a computer that
    // can actually pair. `link-ordering.test.tsx` covers the unlinked case.
    getLinkState: vi.fn().mockResolvedValue({ state: 'linked' }),
    accountSignUp: vi.fn(),
    accountSignIn: vi.fn(),
    accountRequestPasswordReset: vi.fn(),
    accountConfirmPasswordReset: vi.fn(),
    accountSignOut: vi.fn(),
  },
  // The launch-time update banner runs a silent check on mount — stub it so
  // Control tests exercise the dashboard, not the updater (covered separately
  // in SoftwareUpdate.test.tsx). `check` resolving null keeps the banner hidden.
  updater: {
    currentVersion: vi.fn().mockResolvedValue('0.1.0'),
    check: vi.fn().mockResolvedValue(null),
    relaunch: vi.fn(),
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
        pending_request: {
          device_name: null,
          requested_scopes: ['view'],
          requested_at: Date.now(),
        },
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

  // Regression test for the "frozen approve card" bug: previously there was
  // no state between awaiting_approval and active, so after clicking Approve
  // the UI kept showing the (now-cleared) approve card with no feedback
  // until (or unless) the connection reached `connected`. `connecting` gives
  // honest in-progress feedback instead.
  it('connecting shows the "Connecting…" card, not the approve card', () => {
    vi.mocked(useAppState).mockReturnValue(dto({ session: 'connecting' }));
    render(<Control />);

    expect(screen.getByText(/Establishing a secure connection/i)).toBeInTheDocument();
    expect(screen.queryByText('Approve')).not.toBeInTheDocument();
    expect(screen.queryByText('Deny')).not.toBeInTheDocument();
  });

  it('connecting still exposes Disconnect and Panic so a stuck connection can be cancelled', () => {
    vi.mocked(useAppState).mockReturnValue(dto({ session: 'connecting' }));
    render(<Control />);

    screen.getByText('Disconnect').click();
    screen.getByText('⛔ Panic').click();
    expect(api.disconnect).toHaveBeenCalled();
    expect(api.panic).toHaveBeenCalled();
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
        pending_request: {
          device_name: 'Phone',
          requested_scopes: ['view'],
          requested_at: Date.now(),
        },
      }),
    );
    render(<Control />);

    screen.getByText('Approve').click();
    expect(api.approve).toHaveBeenCalled();
    screen.getByText('Deny').click();
    expect(api.deny).toHaveBeenCalled();
  });

  // Regression tests for the window.confirm bug: window.confirm returns
  // falsy in Tauri's wry webview, so `if (!window.confirm(...)) return;`
  // always bailed and api.revokePair was NEVER called. The fix replaces it
  // with an inline two-step confirm rendered inside the expanded device row.
  describe('trusted device revoke (inline confirm)', () => {
    function pair(overrides: Partial<TrustedPairDto> = {}): TrustedPairDto {
      return {
        pairId: 'p1',
        mobileFingerprint: 'ab:cd:ef',
        displayName: "Kush's iPhone",
        autoApprove: true,
        revoked: false,
        lastConnectedAt: null,
        createdAt: new Date().toISOString(),
        ...overrides,
      };
    }

    beforeEach(() => {
      vi.mocked(useAppState).mockReturnValue(dto({ session: 'idle' }));
    });

    it('clicking Revoke alone does not call api.revokePair (two-step guard)', async () => {
      vi.mocked(api.listTrustedDevices).mockResolvedValue([pair()]);
      render(<Control />);

      await waitFor(() => expect(screen.getByText("Kush's iPhone")).toBeInTheDocument());
      screen.getByText("Kush's iPhone").click(); // expand the row
      await waitFor(() => expect(screen.getByText('Revoke')).toBeInTheDocument());

      screen.getByText('Revoke').click(); // reveals the inline confirm
      await waitFor(() => expect(screen.getByText('Confirm')).toBeInTheDocument());
      expect(api.revokePair).not.toHaveBeenCalled();
    });

    it('expand -> Revoke -> Confirm calls api.revokePair with the pairId', async () => {
      vi.mocked(api.listTrustedDevices).mockResolvedValue([pair({ pairId: 'p42' })]);
      render(<Control />);

      await waitFor(() => expect(screen.getByText("Kush's iPhone")).toBeInTheDocument());
      screen.getByText("Kush's iPhone").click();
      await waitFor(() => expect(screen.getByText('Revoke')).toBeInTheDocument());

      screen.getByText('Revoke').click();
      await waitFor(() => expect(screen.getByText('Confirm')).toBeInTheDocument());
      screen.getByText('Confirm').click();

      await waitFor(() => expect(api.revokePair).toHaveBeenCalledWith('p42'));
    });

    it('Cancel aborts without calling api.revokePair', async () => {
      vi.mocked(api.listTrustedDevices).mockResolvedValue([pair()]);
      render(<Control />);

      await waitFor(() => expect(screen.getByText("Kush's iPhone")).toBeInTheDocument());
      screen.getByText("Kush's iPhone").click();
      await waitFor(() => expect(screen.getByText('Revoke')).toBeInTheDocument());

      screen.getByText('Revoke').click();
      await waitFor(() => expect(screen.getByText('Cancel')).toBeInTheDocument());
      screen.getByText('Cancel').click();

      await waitFor(() => expect(screen.getByText('Revoke')).toBeInTheDocument());
      expect(api.revokePair).not.toHaveBeenCalled();
    });
  });
});
