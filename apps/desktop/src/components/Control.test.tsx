import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
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
    connection_path: null,
    presence: { state: 'online' } as const,
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

  /**
   * The sentence, not just the chips.
   *
   * It read "wants to view and control this Mac" for every request regardless
   * of `requested_scopes`, with the truth relegated to two chips underneath. On
   * the one screen where a person grants a stranger's phone access to their
   * computer, the sentence they read described a grant that had not been asked
   * for.
   */
  it.each([
    [['view'], /wants to view this Mac’s screen/, /view and control/],
    [['view', 'control'], /wants to view and control this Mac/, /screen/],
    [['control'], /wants to control this Mac/, /view and control/],
    // An unrecognised scope must not be silently dropped from the sentence, so
    // it falls back to the vaguer one rather than under-describing the ask.
    [['view', 'clipboard'], /wants to connect to this Mac/, /view and control/],
    [[], /wants to connect to this Mac/, /view and control/],
  ] as const)('describes %j as itself', (scopes, expected, notExpected) => {
    vi.mocked(useAppState).mockReturnValue(
      dto({
        session: 'awaiting_approval',
        pending_request: {
          device_name: 'Ben’s iPhone',
          requested_scopes: [...scopes],
          requested_at: Date.now(),
        },
      }),
    );
    render(<Control />);
    const prompt = screen.getByText(/wants to/).textContent ?? '';
    expect(prompt).toMatch(expected);
    expect(prompt).not.toMatch(notExpected);
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

  /**
   * Every mutation refreshes on its own, so the timer exists only for changes
   * made elsewhere — a phone pairing over the signaling hub, or unpairing
   * itself. Both matter only once somebody looks at this window, and a tray
   * app is in the background most of the time. Production on 2026-08-21 shows
   * the old unconditional timer polling `/devices/pairs` straight through two
   * live sessions: 20:57:42, 20:57:57, 20:58:12, 20:58:27, 20:58:42, …
   */
  describe('when nobody is looking at the trusted-devices list', () => {
    let visibility: DocumentVisibilityState = 'visible';
    // Restored individually rather than with `restoreAllMocks`, which would
    // also strip the `api` implementations this file's module mock sets once.
    let visibilitySpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      visibility = 'visible';
      visibilitySpy = vi
        .spyOn(document, 'visibilityState', 'get')
        .mockImplementation(() => visibility);
      vi.mocked(useAppState).mockReturnValue(dto({ session: 'idle' }));
    });

    afterEach(() => {
      vi.useRealTimers();
      visibilitySpy.mockRestore();
    });

    const setVisibility = async (next: DocumentVisibilityState) => {
      visibility = next;
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
      });
    };

    const elapse = async (ms: number) => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    it('stops polling while the dashboard is hidden', async () => {
      render(<Control />);
      await elapse(0);

      await setVisibility('hidden');
      const atHide = vi.mocked(api.listTrustedDevices).mock.calls.length;
      await elapse(60_000);

      expect(vi.mocked(api.listTrustedDevices).mock.calls.length).toBe(atHide);
    });

    it('refreshes the moment it is looked at again, rather than up to 15s later', async () => {
      render(<Control />);
      await elapse(0);
      await setVisibility('hidden');
      await elapse(30_000);
      const atHide = vi.mocked(api.listTrustedDevices).mock.calls.length;

      await setVisibility('visible');

      expect(vi.mocked(api.listTrustedDevices).mock.calls.length).toBeGreaterThan(atHide);
    });

    it('keeps polling while it is on screen', async () => {
      render(<Control />);
      await elapse(0);
      const start = vi.mocked(api.listTrustedDevices).mock.calls.length;

      await elapse(45_000);

      expect(vi.mocked(api.listTrustedDevices).mock.calls.length).toBeGreaterThan(start);
    });
  });

  /**
   * Under the account -> devices model, `GET /devices/pairs` answers 404 to a
   * computer on no account. `list_trusted_devices` turns any non-2xx into an
   * Err, which the dashboard rendered as "is the backend running?" - false,
   * and alarming, on a machine whose only problem is that nobody linked it.
   */
  describe('trusted devices on a computer that is not on an account', () => {
    beforeEach(() => {
      vi.mocked(useAppState).mockReturnValue(dto({ session: 'idle' }));
      vi.mocked(api.getLinkState).mockResolvedValue({ state: 'unlinked' } as never);
    });

    afterEach(() => {
      vi.mocked(api.getLinkState).mockResolvedValue({ state: 'linked' } as never);
    });

    it('says so, instead of blaming the backend', async () => {
      render(<Control />);

      expect(await screen.findByTestId('trusted-devices-unlinked')).toBeInTheDocument();
      expect(screen.queryByText(/is the backend running/)).toBeNull();
    });

    it('does not ask for a list it is not entitled to', async () => {
      render(<Control />);
      await screen.findByTestId('trusted-devices-unlinked');

      expect(api.listTrustedDevices).not.toHaveBeenCalled();
    });
  });
});

describe('Control — can a phone actually reach this Mac', () => {
  /**
   * The gap this closes, measured rather than imagined: on 2026-08-22 the
   * production Mac's presence register was refused 56 times over six hours
   * while its device row was owned and unrevoked. The phone said "the laptop
   * is offline", the dashboard said "Linked", and neither was the thing the
   * user needed to know.
   */
  it('says nothing while everything is fine', async () => {
    vi.mocked(useAppState).mockReturnValue(dto({ presence: { state: 'online' } }));
    vi.mocked(api.getLinkState).mockResolvedValue({ state: 'linked' } as never);

    render(<Control />);
    // Wait for the link state to resolve before asserting on an absence.
    await screen.findByText('Trusted devices');

    // A badge that is always on screen becomes furniture.
    expect(screen.queryByTestId('reachability')).not.toBeInTheDocument();
  });

  it('says so, and why, when the hub will not seat this Mac', async () => {
    vi.mocked(useAppState).mockReturnValue(dto({ presence: { state: 'refused' } }));
    vi.mocked(api.getLinkState).mockResolvedValue({ state: 'linked' } as never);

    render(<Control />);

    const panel = await screen.findByTestId('reachability');
    expect(panel).toHaveTextContent(/can’t reach this Mac/i);
    // Names the remedy, not the mechanism. "unauthorized_room" helps nobody.
    expect(panel).toHaveTextContent(/link it again/i);
    expect(panel.textContent).not.toMatch(/presence|register|4403|room/i);
  });

  it('distinguishes a network problem from a refusal', async () => {
    vi.mocked(useAppState).mockReturnValue(dto({ presence: { state: 'unreachable' } }));
    vi.mocked(api.getLinkState).mockResolvedValue({ state: 'linked' } as never);

    render(<Control />);

    // Different cause, different fix — and this one clears on its own.
    expect(await screen.findByTestId('reachability')).toHaveTextContent(/internet connection/i);
  });

  it('points at the keychain when there is no identity to present', async () => {
    vi.mocked(useAppState).mockReturnValue(dto({ presence: { state: 'no_identity' } }));
    vi.mocked(api.getLinkState).mockResolvedValue({ state: 'linked' } as never);

    render(<Control />);

    expect(await screen.findByTestId('reachability')).toHaveTextContent(/keychain/i);
  });

  it('stays quiet on an unlinked Mac, which no phone is trying to reach', async () => {
    vi.mocked(useAppState).mockReturnValue(dto({ presence: { state: 'refused' } }));
    vi.mocked(api.getLinkState).mockResolvedValue({ state: 'unlinked' } as never);

    render(<Control />);
    // Wait for the link state to resolve before asserting on an absence.
    await screen.findByText('Trusted devices');

    // `LinkStep` is already asking for the step that matters; a second
    // complaint about a consequence of it is noise.
    expect(screen.queryByTestId('reachability')).not.toBeInTheDocument();
  });
});
