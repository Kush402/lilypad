import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AccountSignIn } from './AccountSignIn';
import { api } from '../lib/tauri';
import { listen } from '@tauri-apps/api/event';

vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

vi.mock('../lib/tauri', () => ({
  api: {
    getAccountState: vi.fn(),
    accountSignUp: vi.fn(),
    accountSignIn: vi.fn(),
    accountEmailAvailable: vi.fn(),
    accountRequestPasswordReset: vi.fn(),
    accountConfirmPasswordReset: vi.fn(),
    accountSignOut: vi.fn(),
    accountDelete: vi.fn(),
    showSetup: vi.fn(),
  },
}));

const SIGNED_OUT = { signedIn: false, email: null, userId: null };
const SIGNED_IN = { signedIn: true, email: 'ada@example.com', userId: 'user-1' };

function type(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

describe('AccountSignIn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_OUT);
    vi.mocked(api.accountEmailAvailable).mockResolvedValue(true);
    vi.mocked(listen).mockResolvedValue(vi.fn() as never);
  });

  it('signs in with email and password', async () => {
    vi.mocked(api.accountSignIn).mockResolvedValue(SIGNED_IN);
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');

    type('account-email', ' Ada@Example.com ');
    type('account-password', 'correct horse battery staple');
    fireEvent.click(screen.getByTestId('account-sign-in-submit'));

    await waitFor(() =>
      expect(api.accountSignIn).toHaveBeenCalledWith(
        'Ada@Example.com',
        'correct horse battery staple',
      ),
    );
    expect(await screen.findByTestId('account-signed-in')).toHaveTextContent('ada@example.com');
  });

  it('creates an account with a name', async () => {
    vi.mocked(api.accountSignUp).mockResolvedValue(SIGNED_IN);
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');

    fireEvent.click(screen.getByText('Create an account'));
    type('account-name', 'Ada Lovelace');
    type('account-email', 'ada@example.com');
    type('account-password', 'correct horse battery staple');
    fireEvent.click(screen.getByTestId('account-sign-up-submit'));

    await waitFor(() =>
      expect(api.accountSignUp).toHaveBeenCalledWith(
        'Ada Lovelace',
        'ada@example.com',
        'correct horse battery staple',
      ),
    );
  });

  /** The policy is a length and nothing else (ADR-0012), and the form must not
   * let the user discover it by submitting. */
  it('will not submit a signup password under 12 characters', async () => {
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');
    fireEvent.click(screen.getByText('Create an account'));

    type('account-name', 'Ada');
    type('account-email', 'ada@example.com');
    type('account-password', 'short');

    expect(screen.getByTestId('account-sign-up-submit')).toBeDisabled();
  });

  it('sends a reset code, then spends it on a new password', async () => {
    vi.mocked(api.accountRequestPasswordReset).mockResolvedValue(undefined);
    vi.mocked(api.accountConfirmPasswordReset).mockResolvedValue(SIGNED_IN);
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');

    fireEvent.click(screen.getByText('Forgot password'));
    type('account-email', 'ada@example.com');
    fireEvent.click(screen.getByTestId('account-reset-request'));

    const code = await screen.findByTestId('account-reset-code');
    fireEvent.change(code, { target: { value: 'reset-code' } });
    type('account-password', 'a whole new passphrase');
    fireEvent.click(screen.getByTestId('account-reset-confirm'));

    await waitFor(() =>
      expect(api.accountConfirmPasswordReset).toHaveBeenCalledWith(
        'ada@example.com',
        'reset-code',
        'a whole new passphrase',
      ),
    );
  });

  /**
   * Reproduces the support case this control exists for: an account was created
   * on the desktop, and sign-in on the phone failed with `invalid_credentials`
   * every time. The two passwords were never both visible to the person typing
   * them, so nothing on either device could show that they differed.
   */
  it('can reveal the password that is about to be submitted', async () => {
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');

    const field = screen.getByTestId('account-password');
    type('account-password', 'correct horse battery staple');
    expect(field).toHaveAttribute('type', 'password');

    fireEvent.click(screen.getByTestId('account-password-reveal'));

    expect(field).toHaveAttribute('type', 'text');
    expect(field).toHaveValue('correct horse battery staple');
  });

  it('surfaces a rejected credential instead of failing silently', async () => {
    vi.mocked(api.accountSignIn).mockRejectedValue(
      'That email and password do not match an account. Check the password, or create an account.',
    );
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');

    type('account-email', 'ada@example.com');
    type('account-password', 'wrong');
    fireEvent.click(screen.getByTestId('account-sign-in-submit'));

    expect(await screen.findByTestId('account-error')).toHaveTextContent(/do not match/i);
  });

  /**
   * The line this panel exists to draw, and it moved on 2026-08-25.
   *
   * It used to be "signing in does NOT put this computer on your account",
   * which was the truth under ADR-0010 and stopped being one under
   * [ADR-0015](../../../docs/adr/0015-ownership-follows-sign-in.md). The line
   * that still has to be drawn is the next one along: on the account is not the
   * same as reachable. Someone who reads "on your account" as "my phone can see
   * it now" stops at step 2 and finds nothing on their phone.
   *
   * The retired sentence is asserted absent, not merely replaced: it is now
   * false, and a screen carrying both would contradict itself.
   */
  /**
   * This card knows there is a signed-in session. It does NOT know that the
   * enrollment behind that sign-in succeeded — a Mac already owned by another
   * account, or offline at the wrong moment, is signed in and unenrolled — and
   * it used to assert otherwise one line above `AccountPanel`, which asks the
   * backend and answers the same question for real.
   */
  it('claims only what it knows: who is signed in, not what the backend did with it', async () => {
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
    render(<AccountSignIn />);
    const panel = await screen.findByTestId('account-signed-in');
    expect(panel).toHaveTextContent('ada@example.com');
    expect(panel).not.toHaveTextContent(/this computer is on your account/i);
    expect(panel).not.toHaveTextContent(/does not put this computer on your account/i);
  });

  /**
   * A render loop, caught as a number rather than as a hang.
   *
   * `onChange` used to be a dependency of the effect that reads the account, so
   * a parent passing an inline arrow — the obvious way to write it, and what
   * `Setup` was changed to do on 2026-08-25 — re-ran that effect on every
   * render: read → `onChange` → parent state → render → new arrow → read.
   *
   * It never threw. It starved the macrotask queue, so every `waitFor` in the
   * file timed out at once and the suite simply stopped producing output. This
   * counts instead: a fresh `onChange` on every render must not buy a second
   * read.
   */
  it('does not re-read the account when the caller passes a new onChange', async () => {
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);

    const { rerender } = render(<AccountSignIn onChange={() => {}} />);
    await screen.findByTestId('account-signed-in');

    for (let i = 0; i < 5; i += 1) {
      // A different function identity each time, exactly as an inline arrow in
      // a re-rendering parent produces.
      rerender(<AccountSignIn onChange={() => {}} />);
    }
    await screen.findByTestId('account-signed-in');

    expect(api.getAccountState).toHaveBeenCalledTimes(1);
  });

  /**
   * This suite used to assert the opposite, under the name "signs out without
   * revoking anything", and it was right about the code and wrong about the
   * product. Sign-out deleted the saved email address and nothing else: the
   * device key kept authenticating, the presence seat stayed occupied, every
   * paired phone could still ring this Mac, and a session already running kept
   * streaming the screen of the person who had just pressed the button.
   *
   * ADR-0015 makes signing in what puts a Mac on an account, so signing out is
   * what takes it off. What is pinned here is that the button now costs a
   * confirmation, and that the confirmation says the two things a customer
   * cannot infer: what stops working, and that signing back in restores it.
   */
  describe('signing out', () => {
    beforeEach(() => {
      vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
      vi.mocked(api.accountSignOut).mockResolvedValue(undefined);
    });

    it('is not one click away — it ends sessions and releases this Mac', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');

      fireEvent.click(screen.getByTestId('account-sign-out'));

      expect(api.accountSignOut).not.toHaveBeenCalled();
      expect(screen.getByTestId('account-sign-out-confirm')).toBeInTheDocument();
    });

    it('says what stops working, and that signing back in restores it', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByTestId('account-sign-out'));

      const confirm = screen.getByTestId('account-sign-out-confirm');
      expect(confirm).toHaveTextContent(/leaves your account/i);
      expect(confirm).toHaveTextContent(/paired phones stop being able to connect/i);
      expect(confirm).toHaveTextContent(/a session running right now ends/i);
      // The half that keeps this a reversible act rather than a scary one.
      expect(confirm).toHaveTextContent(/signing back in here restores everything/i);
      expect(confirm).toHaveTextContent(/not need to scan a QR again/i);
    });

    it('signs out on the second click, and returns to the signed-out screen', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByTestId('account-sign-out'));
      fireEvent.click(screen.getByTestId('account-sign-out-confirm-button'));

      await waitFor(() => expect(api.accountSignOut).toHaveBeenCalled());
      expect(await screen.findByTestId('account-sign-in')).toBeInTheDocument();
    });

    it('cancelling leaves the account alone', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByTestId('account-sign-out'));
      fireEvent.click(screen.getByTestId('account-sign-out-cancel'));

      expect(api.accountSignOut).not.toHaveBeenCalled();
      expect(screen.queryByTestId('account-sign-out-confirm')).toBeNull();
      expect(screen.getByTestId('account-signed-in')).toBeInTheDocument();
    });

    /**
     * A sign-out that could not reach the backend has NOT released this Mac,
     * and the Rust side refuses to clear the local session in that case for
     * exactly that reason. The screen must agree: staying signed in is the
     * honest outcome, and the error is what says why.
     */
    it('stays signed in, and says why, when the release fails', async () => {
      vi.mocked(api.accountSignOut).mockRejectedValue(
        new Error('Couldn’t reach Lilypad. Check your internet connection and try again.'),
      );
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByTestId('account-sign-out'));
      fireEvent.click(screen.getByTestId('account-sign-out-confirm-button'));

      await screen.findByText(/Couldn’t reach Lilypad/);
      expect(screen.getByTestId('account-signed-in')).toBeInTheDocument();
      expect(screen.queryByTestId('account-sign-in')).toBeNull();
    });
  });

  describe('deleting the account', () => {
    /**
     * The only irreversible action in the product. What is tested is the ways
     * it could fire when nobody meant it to: on one click, on an empty form,
     * or with the confirmation quietly filled in by the app instead of by the
     * person.
     */
    beforeEach(() => {
      vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
    });

    it('is not one click away', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');

      // The button that starts the flow exists; the button that DOES it does
      // not, until asked for.
      expect(screen.queryByTestId('account-delete')).toBeNull();
      expect(screen.queryByTestId('delete-confirm')).toBeNull();
    });

    it('says what will happen before asking for anything', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByText('Delete account'));

      expect(await screen.findByTestId('account-delete')).toHaveTextContent(/cannot be undone/i);
    });

    it('will not submit until both the address and the password are typed', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByText('Delete account'));
      await screen.findByTestId('account-delete');

      expect(screen.getByTestId('delete-confirm')).toBeDisabled();
      type('delete-confirm-email', 'ada@example.com');
      expect(screen.getByTestId('delete-confirm')).toBeDisabled();
      type('delete-password', 'correct horse battery staple');
      expect(screen.getByTestId('delete-confirm')).toBeEnabled();
    });

    it('sends the address the USER typed, not the one it already knows', async () => {
      // If this screen filled the confirmation in from the stored account, the
      // server's check would pass without a human ever confirming anything —
      // which is the only thing that check is for.
      vi.mocked(api.accountDelete).mockResolvedValue(undefined);
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByText('Delete account'));
      await screen.findByTestId('account-delete');

      type('delete-confirm-email', ' ada@example.com ');
      type('delete-password', 'correct horse battery staple');
      fireEvent.click(screen.getByTestId('delete-confirm'));

      await waitFor(() =>
        expect(api.accountDelete).toHaveBeenCalledWith(
          'ada@example.com',
          'correct horse battery staple',
        ),
      );
    });

    it('returns to the signed-out screen once the account is gone', async () => {
      vi.mocked(api.accountDelete).mockResolvedValue(undefined);
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByText('Delete account'));
      await screen.findByTestId('account-delete');

      type('delete-confirm-email', 'ada@example.com');
      type('delete-password', 'correct horse battery staple');
      fireEvent.click(screen.getByTestId('delete-confirm'));

      expect(await screen.findByTestId('account-sign-in')).toBeInTheDocument();
    });

    it('keeps the user signed in, and says why, when the server refuses', async () => {
      // A wrong password must leave everything exactly as it was — including
      // the form, so the user can simply fix the typo.
      vi.mocked(api.accountDelete).mockRejectedValue(
        new Error('That password does not match this account.'),
      );
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByText('Delete account'));
      await screen.findByTestId('account-delete');

      type('delete-confirm-email', 'ada@example.com');
      type('delete-password', 'wrong');
      fireEvent.click(screen.getByTestId('delete-confirm'));

      expect(await screen.findByText(/does not match this account/i)).toBeInTheDocument();
      expect(screen.getByTestId('account-signed-in')).toBeInTheDocument();
      expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();
    });

    it('cancelling forgets what was typed', async () => {
      render(<AccountSignIn />);
      await screen.findByTestId('account-signed-in');
      fireEvent.click(screen.getByText('Delete account'));
      await screen.findByTestId('account-delete');

      type('delete-confirm-email', 'ada@example.com');
      type('delete-password', 'correct horse battery staple');
      fireEvent.click(screen.getByTestId('delete-cancel'));

      expect(screen.queryByTestId('account-delete')).toBeNull();
      fireEvent.click(screen.getByText('Delete account'));
      expect(await screen.findByTestId('delete-confirm-email')).toHaveValue('');
      expect(screen.getByTestId('delete-password')).toHaveValue('');
      expect(api.accountDelete).not.toHaveBeenCalled();
    });
  });

  /**
   * A brand-new customer's first act should not be a rejection.
   *
   * Production, 2026-08-21: `login_failed … reason=password_no_account` at
   * 20:54:41 on a first run, forty-six seconds before the signup that should
   * have come first. The wizard opened on Sign in, so the customer typed
   * credentials that could not exist yet.
   */
  describe('which form it opens on', () => {
    it('opens on Sign in by default — the dashboard is for people who have an account', async () => {
      render(<AccountSignIn />);
      expect(await screen.findByTestId('account-sign-in-submit')).toBeInTheDocument();
      expect(screen.queryByTestId('account-sign-up-submit')).toBeNull();
    });

    it('opens on Create account when asked, for the first-run wizard', async () => {
      render(<AccountSignIn initialMode="signup" />);
      expect(await screen.findByTestId('account-sign-up-submit')).toBeInTheDocument();
      expect(screen.queryByTestId('account-sign-in-submit')).toBeNull();
    });

    it('still offers the other door, so neither audience is trapped', async () => {
      render(<AccountSignIn initialMode="signup" />);
      await screen.findByTestId('account-sign-up-submit');
      fireEvent.click(screen.getByText('Sign in instead'));
      expect(await screen.findByTestId('account-sign-in-submit')).toBeInTheDocument();
    });
  });
});

/**
 * A recovery path that cannot run is not offered.
 *
 * Production has never had a mail sender, so every press of "Forgot password"
 * ended at `Password reset is not available on this server.` The backend now
 * says so up front (`GET /auth/methods`) and this panel believes it — and
 * un-hides the link the moment a sender exists, with no client release.
 */
describe('AccountSignIn — the reset link', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_OUT);
  });

  it('hides it when the backend cannot send mail', async () => {
    vi.mocked(api.accountEmailAvailable).mockResolvedValue(false);
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');
    await waitFor(() => expect(screen.queryByTestId('account-go-reset')).toBeNull());
    // The way in that never needed mail is untouched.
    expect(screen.getByTestId('account-sign-in')).toBeInTheDocument();
  });

  it('shows it when the backend can', async () => {
    vi.mocked(api.accountEmailAvailable).mockResolvedValue(true);
    render(<AccountSignIn />);
    expect(await screen.findByTestId('account-go-reset')).toBeInTheDocument();
  });

  it('shows it when the question could not be asked at all', async () => {
    // Fails open: an old backend with no such route, or a laptop that is
    // offline, must not lose a recovery path that works.
    vi.mocked(api.accountEmailAvailable).mockRejectedValue(new Error('offline'));
    render(<AccountSignIn />);
    expect(await screen.findByTestId('account-go-reset')).toBeInTheDocument();
  });
});

/**
 * Two windows, one account.
 *
 * Reported from a first run on 2026-08-26: the dashboard said "Signed in as
 * kushsharma024@gmail.com" while Settings, open at the same time, still showed
 * the sign-in form. Neither was lying about what it had read — each window is a
 * separate webview, `open_window` HIDES the others rather than closing them, and
 * the account was read once per mount. The window that had been open longest was
 * simply answering a question from before the sign-in.
 *
 * The backend now says so out loud (`commands::announce_account`), and every
 * window re-reads. These are the tests that fail if either half is removed.
 */
describe('AccountSignIn — agreeing with the other windows', () => {
  let accountEvent: ((event: { payload: unknown }) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    accountEvent = undefined;
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_OUT);
    vi.mocked(api.accountEmailAvailable).mockResolvedValue(true);
    vi.mocked(listen).mockImplementation((async (
      name: string,
      handler: (e: { payload: unknown }) => void,
    ) => {
      if (name === 'lilypad://account') accountEvent = handler;
      return vi.fn();
    }) as unknown as typeof listen);
  });

  it('catches up when the sign-in happened in another window', async () => {
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');

    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
    accountEvent?.({ payload: null });

    expect(await screen.findByTestId('account-signed-in')).toHaveTextContent('ada@example.com');
  });

  it('takes the confirmation off screen when the account goes away elsewhere', async () => {
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
    render(<AccountSignIn />);
    fireEvent.click(await screen.findByTestId('account-delete-start'));
    await screen.findByTestId('account-delete');

    // Deleted from the other window. A "Permanently delete" button left on
    // screen now is one that can only answer with a server error.
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_OUT);
    accountEvent?.({ payload: null });

    await screen.findByTestId('account-sign-in');
    expect(screen.queryByTestId('account-delete')).not.toBeInTheDocument();
  });
});

/**
 * The dashboard is a live status window — it is what is open while a phone is
 * connected. Deleting the account is not a thing anyone does from there, and a
 * permanent, irreversible button one row under a running session is a button
 * that eventually gets pressed by accident.
 */
describe('AccountSignIn — the dashboard variant', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
    vi.mocked(api.accountEmailAvailable).mockResolvedValue(true);
    vi.mocked(listen).mockResolvedValue(vi.fn() as never);
  });

  it('offers no way to delete the account, and a door to where you can', async () => {
    render(<AccountSignIn variant="summary" />);
    await screen.findByTestId('account-signed-in');

    expect(screen.queryByTestId('account-delete-start')).not.toBeInTheDocument();
    // Sign-out stays: it is reversible, and it is the thing people look for.
    expect(screen.getByTestId('account-sign-out')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('account-open-settings'));
    expect(api.showSetup).toHaveBeenCalled();
  });

  it('still signs somebody in, because a dashboard nobody can sign in from is a dead end', async () => {
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_OUT);
    render(<AccountSignIn variant="summary" />);

    expect(await screen.findByTestId('account-sign-in')).toBeInTheDocument();
  });
});
