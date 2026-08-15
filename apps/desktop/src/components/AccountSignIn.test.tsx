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
});
