import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type AccountStateDto } from '../lib/tauri';

/**
 * Who is signed in on this Mac
 * ([ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
 *
 * Until this existed the desktop had no account identity at all, and could not
 * get one: [ADR-0008](../../../../docs/adr/0008-desktop-enrollment-via-phone.md)
 * gives it no OAuth client, and magic link needs a mail sender production does
 * not have. Email + password needs neither, which is the whole reason ADR-0012
 * added it.
 *
 * **Signing in here is what puts this computer on the account**
 * ([ADR-0015](../../../../docs/adr/0015-ownership-follows-sign-in.md)), and the
 * copy says so. The panel below it reports the result rather than asking for a
 * second ceremony.
 *
 * This block used to say the opposite, and correctly: under ADR-0010 a Mac was
 * adopted only by a phone approving its enrollment code, so the screen had to
 * warn that signing in changed nothing. What survives from that rule, and what
 * the copy must still not overclaim, is that ownership is not REACH — a phone
 * sees this screen only through a pairing, which is step 3.
 */

type Mode = 'signin' | 'signup' | 'reset';

export interface AccountSignInProps {
  /** Told whenever the signed-in state changes, so the dashboard can order the
   * steps that follow this one. */
  onChange?: (account: AccountStateDto) => void;
  /**
   * Which form to open on. Defaults to `signin`, which is right on the
   * dashboard — a returning user.
   *
   * The first-run wizard passes `signup`, because there the default was
   * actively wrong: a brand-new customer's first act was typing credentials
   * they did not have yet into a Sign in form and being rejected. Observed in
   * production on 2026-08-21 — `login_failed … password_no_account` at
   * 20:54:41, forty-six seconds before the signup that should have been first.
   * Both buttons stay on screen either way, so neither audience is trapped.
   */
  initialMode?: Mode;
}

export function AccountSignIn({ onChange, initialMode = 'signin' }: AccountSignInProps = {}) {
  const [account, setAccount] = useState<AccountStateDto | null>(null);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState('');
  // The delete flow, which only exists once signed in. Kept collapsed by
  // default: an irreversible button that is always on screen is a button that
  // eventually gets pressed by accident.
  const [deleting, setDeleting] = useState(false);
  const [deleteEmail, setDeleteEmail] = useState('');
  const [deletePassword, setDeletePassword] = useState('');

  /**
   * `onChange` through a ref, for the same reason `useLiveResource` reads its
   * fetcher through one: **so a caller's inline closure cannot re-identify
   * anything this component runs effects on.**
   *
   * It used to be a dependency of `apply`, and `apply` a dependency of the
   * mount effect below. A parent that passed `onChange={(n) => {…}}` — the
   * obvious way to write it — handed over a new function every render, so the
   * effect re-ran, re-read the account, called `onChange`, set state in the
   * parent, re-rendered, and handed over another new function. An infinite
   * loop, in a component nobody had touched, caused entirely by how it was
   * called. It presented as a test suite that stopped producing output rather
   * than as an error, and it starved the macrotask queue, so every `waitFor`
   * in the file timed out with nothing to say.
   *
   * Callers should still memoise; this is what makes forgetting survivable.
   */
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const apply = useCallback((next: AccountStateDto) => {
    setAccount(next);
    onChangeRef.current?.(next);
  }, []);

  useEffect(() => {
    api
      .getAccountState()
      .then(apply)
      .catch(() => {
        /* not running inside Tauri */
      });
  }, [apply]);

  /**
   * Whether the backend can send mail. `true` until told otherwise, so the
   * link only disappears on a definite no — see `Account::email_available`,
   * which fails open for the same reason.
   */
  const [emailAvailable, setEmailAvailable] = useState(true);
  useEffect(() => {
    api
      .accountEmailAvailable()
      .then(setEmailAvailable)
      .catch(() => setEmailAvailable(true));
  }, []);

  const run = useCallback(
    async (action: () => Promise<AccountStateDto | void>) => {
      setBusy(true);
      setError('');
      try {
        const next = await action();
        if (next) apply(next);
        return true;
      } catch (err) {
        setError(String(err));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply],
  );

  const switchTo = (next: Mode) => {
    setMode(next);
    setError('');
    setCodeSent(false);
    setCode('');
    setPassword('');
    setReveal(false);
  };

  if (account?.signedIn) {
    return (
      <section className="control__account card" data-testid="account-signed-in">
        <h2 className="section-title">Your account</h2>
        <p className="muted">
          Signed in as <strong>{account.email}</strong>.
        </p>
        {/* Says what signing in DID do, and draws the one line that still
            matters: on the account is not the same as reachable. Someone who
            assumes otherwise stops at step 2 and wonders why their phone shows
            nothing. */}
        <p className="muted">
          This computer is on your account. Pairing a phone is what lets it connect — that is the
          last step.
        </p>
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.accountSignOut();
                apply({ signedIn: false, email: null, userId: null });
              })
            }
          >
            Sign out
          </button>
          {deleting ? null : (
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={() => {
                setDeleting(true);
                setError('');
              }}
            >
              Delete account
            </button>
          )}
        </div>

        {deleting ? (
          <div className="account__delete" data-testid="account-delete">
            {/* Said plainly and in full BEFORE the inputs. Someone who reads
                only the first line should still know what they are agreeing
                to. */}
            <p className="error">
              This permanently deletes your account, every computer and phone on it, and every
              pairing between them. Your Macs stay installed but stop being yours. This cannot be
              undone.
            </p>
            <input
              className="field"
              data-testid="delete-confirm-email"
              type="email"
              aria-label={`Type ${account.email} to confirm`}
              placeholder={`Type ${account.email} to confirm`}
              autoComplete="off"
              value={deleteEmail}
              disabled={busy}
              onChange={(e) => setDeleteEmail(e.target.value)}
            />
            <input
              className="field"
              data-testid="delete-password"
              type="password"
              aria-label="Your password"
              placeholder="Your password"
              autoComplete="current-password"
              value={deletePassword}
              disabled={busy}
              onChange={(e) => setDeletePassword(e.target.value)}
            />
            <div className="row">
              <button
                className="btn btn--danger"
                data-testid="delete-confirm"
                // Both fields, always. The server checks the address itself —
                // this only stops the request being sent half-finished.
                disabled={busy || !deleteEmail.trim() || deletePassword.length === 0}
                onClick={() =>
                  void run(async () => {
                    await api.accountDelete(deleteEmail.trim(), deletePassword);
                    setDeleting(false);
                    setDeleteEmail('');
                    setDeletePassword('');
                    apply({ signedIn: false, email: null, userId: null });
                  })
                }
              >
                {busy ? 'Deleting…' : 'Permanently delete'}
              </button>
              <button
                className="btn"
                data-testid="delete-cancel"
                disabled={busy}
                onClick={() => {
                  setDeleting(false);
                  setDeleteEmail('');
                  setDeletePassword('');
                  setError('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
      </section>
    );
  }

  const emailReady = email.trim().length > 0;

  return (
    <section className="control__account card" data-testid="account-sign-in">
      <h2 className="section-title">
        {mode === 'signup' ? 'Create your account' : 'Sign in to Lilypad'}
      </h2>
      <p className="muted">
        Signing in tells Lilypad who you are. Adding this computer to your account is a separate
        step below, and it takes your phone.
      </p>

      {mode === 'signup' ? (
        <input
          className="field"
          data-testid="account-name"
          aria-label="Your name"
          placeholder="Your name"
          autoComplete="name"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
        />
      ) : null}

      <input
        className="field"
        data-testid="account-email"
        type="email"
        aria-label="Email address"
        placeholder="you@example.com"
        autoComplete="username"
        value={email}
        disabled={busy}
        onChange={(e) => setEmail(e.target.value)}
      />

      {mode === 'reset' && codeSent ? (
        <input
          className="field"
          data-testid="account-reset-code"
          aria-label="Code from the email"
          placeholder="Code from the email"
          value={code}
          disabled={busy}
          onChange={(e) => setCode(e.target.value)}
        />
      ) : null}

      {mode !== 'reset' || codeSent ? (
        <div className="field-row">
          <input
            className="field"
            data-testid="account-password"
            type={reveal ? 'text' : 'password'}
            aria-label={mode === 'signin' ? 'Password' : 'Password, at least 12 characters'}
            placeholder={mode === 'signin' ? 'Password' : 'Password (at least 12 characters)'}
            autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            value={password}
            disabled={busy}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/* A masked field with no reveal means the password you SET and the
              password you later type are never both visible to you — so if the
              two differ (a typo, or macOS AutoFill substituting a generated
              strong password into an `autocomplete="new-password"` field, which
              this is), the only symptom is a sign-in that fails on another
              device with no way to find out why. */}
          <button
            type="button"
            className="btn btn--small"
            data-testid="account-password-reveal"
            aria-pressed={reveal}
            onClick={() => setReveal((v) => !v)}
          >
            {reveal ? 'Hide' : 'Show'}
          </button>
        </div>
      ) : null}

      {mode === 'signup' ? (
        <p className="muted">
          At least 12 characters. Length is the only rule — a phrase you can remember beats a short
          password with symbols in it.
        </p>
      ) : null}

      <div className="row">
        {mode === 'signin' ? (
          <button
            className="btn btn--primary"
            data-testid="account-sign-in-submit"
            disabled={busy || !emailReady || password.length === 0}
            onClick={() => void run(() => api.accountSignIn(email.trim(), password))}
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        ) : null}

        {mode === 'signup' ? (
          <button
            className="btn btn--primary"
            data-testid="account-sign-up-submit"
            disabled={busy || name.trim().length === 0 || !emailReady || password.length < 12}
            onClick={() => void run(() => api.accountSignUp(name.trim(), email.trim(), password))}
          >
            {busy ? 'Creating…' : 'Create account'}
          </button>
        ) : null}

        {mode === 'reset' && !codeSent ? (
          <button
            className="btn btn--primary"
            data-testid="account-reset-request"
            disabled={busy || !emailReady}
            onClick={() =>
              void run(async () => {
                await api.accountRequestPasswordReset(email.trim());
                // Set unconditionally: the backend answers identically whether
                // or not the address has an account, and this must not leak
                // more than the backend does.
                setCodeSent(true);
              })
            }
          >
            {busy ? 'Sending…' : 'Email me a reset code'}
          </button>
        ) : null}

        {mode === 'reset' && codeSent ? (
          <button
            className="btn btn--primary"
            data-testid="account-reset-confirm"
            disabled={busy || code.trim().length === 0 || password.length < 12}
            onClick={() =>
              void run(() => api.accountConfirmPasswordReset(email.trim(), code.trim(), password))
            }
          >
            {busy ? 'Saving…' : 'Set password and sign in'}
          </button>
        ) : null}
      </div>

      <div className="row">
        {mode !== 'signin' ? (
          <button className="btn btn--small" onClick={() => switchTo('signin')}>
            Sign in instead
          </button>
        ) : null}
        {mode !== 'signup' ? (
          <button className="btn btn--small" onClick={() => switchTo('signup')}>
            Create an account
          </button>
        ) : null}
        {/* Reset needs a mail sender. Production has never had one, so this
            button's only possible outcome was "Password reset is not available
            on this server." */}
        {mode !== 'reset' && emailAvailable ? (
          <button
            className="btn btn--small"
            data-testid="account-go-reset"
            onClick={() => switchTo('reset')}
          >
            Forgot password
          </button>
        ) : null}
      </div>

      {error ? (
        <p className="error" data-testid="account-error">
          {error}
        </p>
      ) : null}
    </section>
  );
}
