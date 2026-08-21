import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AccountSignIn } from './AccountSignIn';
import { api } from '../lib/tauri';

vi.mock('../lib/tauri', () => ({
  api: {
    getAccountState: vi.fn(),
    accountSignUp: vi.fn(),
    accountSignIn: vi.fn(),
    accountRequestPasswordReset: vi.fn(),
    accountConfirmPasswordReset: vi.fn(),
    accountSignOut: vi.fn(),
    accountDelete: vi.fn(),
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
      'That email and password do not match an account.',
    );
    render(<AccountSignIn />);
    await screen.findByTestId('account-sign-in');

    type('account-email', 'ada@example.com');
    type('account-password', 'wrong');
    fireEvent.click(screen.getByTestId('account-sign-in-submit'));

    expect(await screen.findByTestId('account-error')).toHaveTextContent(/do not match/i);
  });

  /**
   * The product rule this panel is most likely to be misread as breaking
   * (ADR-0010): an account never discovers devices. Being signed in on this Mac
   * is not the same as this Mac belonging to the account, and the copy has to
   * say so — the backend refuses `kind: "desktop"` at `/devices/enroll`, so a
   * screen that implied otherwise would be promising something impossible.
   */
  it('says signing in does not put this computer on the account', async () => {
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
    render(<AccountSignIn />);
    expect(await screen.findByTestId('account-signed-in')).toHaveTextContent(
      /does not put this computer on your account/i,
    );
  });

  it('signs out without revoking anything', async () => {
    vi.mocked(api.getAccountState).mockResolvedValue(SIGNED_IN);
    vi.mocked(api.accountSignOut).mockResolvedValue(undefined);
    render(<AccountSignIn />);
    await screen.findByTestId('account-signed-in');

    fireEvent.click(screen.getByText('Sign out'));

    await waitFor(() => expect(api.accountSignOut).toHaveBeenCalled());
    expect(await screen.findByTestId('account-sign-in')).toBeInTheDocument();
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
});
