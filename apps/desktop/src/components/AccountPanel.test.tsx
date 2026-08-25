import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AccountPanel } from './AccountPanel';
import { api, type LinkStateDto } from '../lib/tauri';

vi.mock('../lib/tauri', () => ({
  api: { getLinkState: vi.fn(), startEnrollment: vi.fn() },
}));

// jsdom has no canvas; the QR library only needs to resolve to something the
// <img> can carry. What the panel encodes is asserted from the call argument.
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,stub') },
}));

const QRCode = (await import('qrcode')).default;

const linkState = (over: Partial<LinkStateDto> = {}): LinkStateDto => ({
  state: 'unlinked',
  user_id: null,
  device_id: null,
  detail: null,
  ...over,
});

/** The repo's components are driven with plain DOM clicks (see
 * `Control.test.tsx`); `act` flushes the async state updates that follow. */
async function clickLink(): Promise<void> {
  const button = await screen.findByRole('button', { name: 'Add this computer from my phone' });
  await act(async () => {
    button.click();
  });
}

beforeEach(() => {
  vi.mocked(api.getLinkState).mockResolvedValue(linkState());
  vi.mocked(api.startEnrollment).mockResolvedValue({
    code: 'a'.repeat(24),
    expiresInSeconds: 120,
    apiBaseUrl: 'https://lilypad.takedia.com',
    deviceName: 'macos desktop',
    platform: 'macos',
  });
  vi.mocked(QRCode.toDataURL).mockClear();
});

describe('AccountPanel — what it is willing to claim', () => {
  // The product rule (ADR-0010): an account never discovers devices. A
  // computer nobody has linked must say so, not imply availability.
  it('says NOT ON YOUR ACCOUNT, and offers the recovery QR, when no account owns this computer', async () => {
    render(<AccountPanel />);

    expect(await screen.findByTestId('link-state-unlinked')).toHaveTextContent(
      'Not on your account',
    );
    expect(
      screen.getByRole('button', { name: 'Add this computer from my phone' }),
    ).toBeInTheDocument();
  });

  it('says LINKED once an account owns it, and stops offering to link', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(
      linkState({ state: 'linked', user_id: 'u-1', device_id: 'd-1' }),
    );

    render(<AccountPanel />);

    expect(await screen.findByTestId('link-state-linked')).toHaveTextContent('On your account');
    expect(
      screen.queryByRole('button', { name: 'Add this computer from my phone' }),
    ).not.toBeInTheDocument();
  });

  // The distinction that keeps the panel honest in both directions: an
  // unreachable backend is not evidence that this computer is unlinked, and
  // saying so would send a linked user to redo a ceremony they finished.
  it('says UNKNOWN, not "not linked", when the backend cannot be reached', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(
      linkState({ state: 'unknown', detail: 'connection refused' }),
    );

    render(<AccountPanel />);

    expect(await screen.findByTestId('link-state-unknown')).toHaveTextContent(/unknown/i);
    expect(screen.queryByTestId('link-state-unlinked')).not.toBeInTheDocument();
  });

  /** Two ways to be off an account, and they need different things done. A
   * computer that was REMOVED is restored by adding it back; one that was
   * never added has a sign-in that did not finish. The word is "removed"
   * rather than "revoked" because that is the word the phone's own button
   * uses, and one product should not have two names for one act. */
  it('explains a removed computer as removed rather than as never added', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(linkState({ state: 'revoked' }));

    render(<AccountPanel />);

    const line = await screen.findByTestId('link-state-unlinked');
    expect(line).toHaveTextContent(/removed from the account/i);
    expect(line).not.toHaveTextContent(/signing in should have/i);
  });

  // A machine that cannot hold a key cannot join an account at all, so offering the
  // button would be offering something guaranteed to fail.
  it('offers no linking at all when this computer has no durable identity', async () => {
    vi.mocked(api.getLinkState).mockResolvedValue(linkState({ state: 'no_identity' }));

    render(<AccountPanel />);

    expect(await screen.findByTestId('link-state-no-identity')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Add this computer from my phone' }),
    ).not.toBeInTheDocument();
  });

  // ...but it must not be a dead end. This is what a login keychain that is
  // locked, or an access prompt dismissed by accident, looks like — and that
  // prompt returns on every update while the app is ad-hoc signed. The Rust
  // side no longer remembers the failure, so a second attempt can succeed;
  // this is what asks for one.
  it('offers a retry, and clears once the keychain works', async () => {
    vi.mocked(api.getLinkState)
      .mockResolvedValueOnce(linkState({ state: 'no_identity' }))
      .mockResolvedValue(linkState({ state: 'unlinked' }));

    render(<AccountPanel />);
    const retry = await screen.findByTestId('retry-identity');

    await act(async () => {
      retry.click();
    });

    expect(await screen.findByTestId('link-state-unlinked')).toBeInTheDocument();
    expect(screen.queryByTestId('link-state-no-identity')).not.toBeInTheDocument();
  });
});

describe('AccountPanel — the enrollment code', () => {
  it('encodes exactly the payload the phone validates', async () => {
    render(<AccountPanel />);
    await clickLink();

    await waitFor(() => expect(QRCode.toDataURL).toHaveBeenCalled());
    const [encodedArg] = vi.mocked(QRCode.toDataURL).mock.calls[0] ?? [];
    const encoded: unknown = JSON.parse(encodedArg as string);
    // Mirrors `DesktopEnrollmentQrSchema` — a drifting shape here is a QR the
    // phone rejects, which is exactly the failure this asserts against.
    expect(encoded).toEqual({
      v: 1,
      kind: 'desktop-enrollment',
      code: 'a'.repeat(24),
      apiBaseUrl: 'https://lilypad.takedia.com',
      deviceName: 'macos desktop',
      platform: 'macos',
    });
  });

  it('shows the code and its countdown', async () => {
    render(<AccountPanel />);
    await clickLink();

    expect(await screen.findByAltText('Add this computer to your account')).toBeInTheDocument();
    expect(screen.getByText(/Expires in 120s/)).toBeInTheDocument();
  });

  // Approval happens on the phone, so the desktop learns about it by asking
  // again — and must then stop showing a code that no longer means anything.
  it('drops the code once a phone has approved', async () => {
    render(<AccountPanel />);
    await clickLink();
    expect(await screen.findByAltText('Add this computer to your account')).toBeInTheDocument();

    vi.mocked(api.getLinkState).mockResolvedValue(
      linkState({ state: 'linked', user_id: 'u-1', device_id: 'd-1' }),
    );

    await waitFor(
      () =>
        expect(screen.queryByAltText('Add this computer to your account')).not.toBeInTheDocument(),
      { timeout: 5_000 },
    );
    expect(screen.getByTestId('link-state-linked')).toBeInTheDocument();
  });

  it('surfaces a mint failure instead of showing a QR that means nothing', async () => {
    vi.mocked(api.startEnrollment).mockRejectedValue(new Error('backend returned HTTP 500'));

    render(<AccountPanel />);
    await clickLink();

    expect(await screen.findByText(/HTTP 500/)).toBeInTheDocument();
    expect(screen.queryByAltText('Add this computer to your account')).not.toBeInTheDocument();
  });
});
