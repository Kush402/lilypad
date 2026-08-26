import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Control } from './Control';
import { api, type LinkStateDto } from '../lib/tauri';

vi.mock('../lib/tauri', () => ({
  api: {
    approve: vi.fn(),
    deny: vi.fn(),
    disconnect: vi.fn(),
    panic: vi.fn(),
    showQrWindow: vi.fn(),
    showSetup: vi.fn(),
    listTrustedDevices: vi.fn().mockResolvedValue([]),
    setPairAutoApprove: vi.fn(),
    revokePair: vi.fn(),
    getLoginItemEnabled: vi.fn().mockResolvedValue(true),
    getBubbleVisible: vi.fn().mockResolvedValue(true),
    setBubbleVisible: vi.fn().mockResolvedValue(undefined),
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
    getAccountState: vi.fn().mockResolvedValue({ signedIn: false, email: null, userId: null }),
    accountEmailAvailable: vi.fn().mockResolvedValue(true),
    getLinkState: vi.fn(),
  },
  updater: { currentVersion: vi.fn().mockResolvedValue('0.1.0'), check: vi.fn() },
}));
vi.mock('../lib/useAppState', () => ({ useAppState: () => ({ session: 'idle' }) }));
vi.mock('./AccountSignIn', () => ({ AccountSignIn: () => <div data-testid="account-sign-in" /> }));
vi.mock('./AccountPanel', () => ({ AccountPanel: () => <div data-testid="account-panel" /> }));

/**
 * Pairing comes after linking, on every surface.
 *
 * Reported from the running app: the pairing QR was reachable from the tray's
 * "Pair a phone…", from this dashboard's "+", and from the setup wizard, on a
 * computer nobody had signed into or linked. That is not a small ordering nit —
 * a pair made in that state belongs to no account. It appears in nobody's "Your
 * devices" and can be revoked from nowhere, which
 * [ADR-0010](../../../docs/adr/0010-explicit-device-linking.md) rejected in so
 * many words, and which `docs/api.md` recorded as ending "when P1 makes
 * enrolment mandatory".
 *
 * The tray applies the identical rule in `TrayHandles::apply`, and
 * `create_pairing` refuses for real — this covers the surface a user actually
 * looks at.
 */
const linkState = (state: LinkStateDto['state']): LinkStateDto => ({
  state,
  user_id: null,
  device_id: null,
  detail: null,
});

describe('the dashboard’s pair button', () => {
  beforeEach(() => vi.clearAllMocks());

  const pairButton = () => screen.getByTestId('pair-new-device');

  it('is disabled while this computer is on no account', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(linkState('unlinked'));
    render(<Control />);

    await waitFor(() => expect(pairButton()).toBeDisabled());
    // Names the step that unlocks it, and that step is signing in — pairing an
    // unowned machine is what `/pairing/create` refuses.
    expect(pairButton()).toHaveAttribute('title', expect.stringMatching(/sign in first/i));
  });

  it('is disabled after ownership is revoked', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(linkState('revoked'));
    render(<Control />);
    await waitFor(() => expect(pairButton()).toBeDisabled());
  });

  it('is enabled once linked', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(linkState('linked'));
    render(<Control />);
    await waitFor(() => expect(pairButton()).toBeEnabled());
  });

  /**
   * `unknown` means the backend could not be ASKED, not that this machine is
   * unowned — the distinction `LinkStateDto` exists to carry. Disabling on it
   * would tell a linked user their computer is on no account because their
   * wifi blipped; `create_pairing` re-checks for real on click, so the cost of
   * being wrong in this direction is an honest error instead of a false claim.
   */
  it('stays enabled when the backend cannot be asked', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(linkState('unknown'));
    render(<Control />);
    await waitFor(() => expect(pairButton()).toBeEnabled());
  });
});
