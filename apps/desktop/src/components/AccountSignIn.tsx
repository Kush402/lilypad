import { useCallback, useEffect, useState } from 'react';
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
 * **Signing in here does not link this computer, and the copy says so.** That
 * is the product rule ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)):
 * an account never discovers devices — a phone approving this machine's
 * enrollment code is what makes it yours. The backend enforces it rather than
 * trusting this screen: `/devices/enroll` refuses `kind: "desktop"` outright.
 * So the two panels are deliberately separate and deliberately in this order —
 * "who you are", then "which computer is yours".
 */

type Mode = 'signin' | 'signup' | 'reset';

export function AccountSignIn() {
  const [account, setAccount] = useState<AccountStateDto | null>(null);
  const [mode, setMode] = useState<Mode>('signin');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .getAccountState()
      .then(setAccount)
      .catch(() => {
        /* not running inside Tauri */
      });
  }, []);

  const run = useCallback(async (action: () => Promise<AccountStateDto | void>) => {
    setBusy(true);
    setError('');
    try {
      const next = await action();
      if (next) setAccount(next);
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

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
        {/* The one thing a user is most likely to assume and be wrong about. */}
        <p className="muted">
          Being signed in here does not put this computer on your account — that is the next step,
          and it takes your phone.
        </p>
        <div className="row">
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.accountSignOut();
                setAccount({ signedIn: false, email: null, userId: null });
              })
            }
          >
            Sign out
          </button>
        </div>
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
        {mode !== 'reset' ? (
          <button className="btn btn--small" onClick={() => switchTo('reset')}>
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
