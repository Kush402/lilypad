import React, { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { DeviceSession } from '@lilypad/protocol';
import {
  signInWithGoogle,
  signInWithApple,
  signInWithPassword,
  signUpWithPassword,
  requestMagicLink,
  verifyMagicLink,
  requestPasswordReset,
  confirmPasswordReset,
  SignInError,
} from '../lib/signIn';
import { DeviceTakenError, resetDeviceIdentity } from '../lib/auth';
import { isGoogleConfigured } from '../config/oauth';
import { defaultApiBaseUrl } from '../config/backend';
import { theme, radius } from '../theme';

/**
 * Sign in, then enroll this phone ([ADR-0001](../../../../docs/adr/0001-account-authentication.md),
 * [ADR-0012](../../../../docs/adr/0012-password-authentication.md)).
 *
 * This is now the app's FIRST screen, not a detour reachable from the scanner,
 * so it has to work with nothing already set up: no paired laptop, no scanned
 * code, no backend address in hand. `apiBaseUrl` therefore defaults to the
 * shipped one (`config/backend.ts`) and is only passed explicitly when the user
 * arrived from a QR that named a different server.
 *
 * Providers are only offered when they can actually work: Google's button is
 * hidden unless a web client id is compiled in, and Apple's only appears on
 * iOS. Offering a button that fails after the user taps it is worse than not
 * offering it, because the failure looks like the product is broken rather than
 * unconfigured. Email + password is offered unconditionally — it is the one
 * method that depends on neither a provider nor a delivered email, which is
 * exactly why ADR-0012 added it.
 *
 * Apple is listed first on iOS. That is App Store policy, not taste — Sign in
 * with Apple must be offered at least as prominently as any other third-party
 * option.
 *
 * **Signing in never reveals a computer**
 * ([ADR-0010](../../../../docs/adr/0010-explicit-device-linking.md)). This
 * screen's copy has to carry that, because a promise made here that the rest of
 * the product deliberately does not keep is worse than no copy at all.
 */

export interface SignInScreenProps {
  /** Defaults to the shipped backend. Passed explicitly only when a scanned QR
   * named a different one — self-hosting keeps working that way. */
  apiBaseUrl?: string;
  onSignedIn: (session: DeviceSession) => void;
}

/** Just the host, which is the part a person can judge. A full URL invites
 * skimming past everything after the scheme. */
function hostOf(url: string): string {
  const match = /^[a-z]+:\/\/([^/?#]+)/i.exec(url);
  return match?.[1] ?? url;
}

type Busy = 'google' | 'apple' | 'password' | 'email' | null;
/** Which of the email-based flows the form is currently showing. */
type Mode = 'signin' | 'signup' | 'reset' | 'magic-link';

export function SignInScreen({ apiBaseUrl, onSignedIn }: SignInScreenProps): React.JSX.Element {
  const baseUrl = apiBaseUrl ?? defaultApiBaseUrl();
  const [mode, setMode] = useState<Mode>('signin');
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  /**
   * True once the backend has refused this phone's key because it names a
   * device on somebody else's account. A dead end without a way out: the key
   * lives in the Keychain, which survives deleting the app, so no amount of
   * retrying, reinstalling, or trying a different account will ever get past
   * it. The one remedy is a new identity, and it is offered here rather than
   * applied automatically because it abandons the device row on the old
   * account.
   */
  const [deviceTaken, setDeviceTaken] = useState(false);
  /** The attempt that failed, so "start over" can finish what the user asked
   * for instead of returning them to a form they already filled in. */
  const lastAttempt = useRef<{ which: Busy; action: () => Promise<DeviceSession> } | null>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /** True once a code has been mailed, for whichever of the two flows asked. */
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState('');

  const run = useCallback(
    async (which: Busy, action: () => Promise<DeviceSession>) => {
      setBusy(which);
      setError(null);
      setDeviceTaken(false);
      lastAttempt.current = { which, action };
      try {
        onSignedIn(await action());
      } catch (err) {
        // A cancelled sign-in is a choice, not a failure — showing an error for
        // it makes the app feel broken when nothing went wrong.
        if (err instanceof SignInError && err.code === 'cancelled') return;
        if (err instanceof DeviceTakenError) setDeviceTaken(true);
        setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      } finally {
        setBusy(null);
      }
    },
    [onSignedIn],
  );

  /** The escape from `deviceTaken`. Confirmed first, and in the user's terms:
   * what they gain, what they lose, and what is left behind on the old
   * account. */
  const startOver = useCallback(() => {
    Alert.alert(
      'Set this phone up as new?',
      'This phone joins the account you are signing in to, as a new device. ' +
        'It stays listed on the other account until you remove it there, and any ' +
        'laptops paired on this phone will need to be scanned again.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Set up as new',
          style: 'destructive',
          onPress: () => {
            void (async () => {
              const again = lastAttempt.current;
              await resetDeviceIdentity();
              setDeviceTaken(false);
              setError(null);
              if (again) await run(again.which, again.action);
            })();
          },
        },
      ],
    );
  }, [run]);

  /** Both "email me a code" flows: same shape, same deliberate silence about
   * whether the address exists. */
  const sendCode = useCallback(async (send: () => Promise<void>) => {
    setBusy('email');
    setError(null);
    try {
      await send();
      // Deliberately unconditional: the backend answers identically whether
      // or not the address has an account, and the UI must not leak more.
      setCodeSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send an email.');
    } finally {
      setBusy(null);
    }
  }, []);

  /** Leaving a flow must not carry its half-finished state into the next one. */
  const switchTo = useCallback((next: Mode) => {
    setMode(next);
    setError(null);
    setCodeSent(false);
    setCode('');
    setPassword('');
  }, []);

  const disabled = busy !== null;
  const emailReady = email.trim().length > 0;
  const passwordReady = password.length > 0;

  return (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={styles.container}
      keyboardShouldPersistTaps="handled"
      testID="sign-in-screen"
    >
      <Text style={styles.title}>
        {mode === 'signup' ? 'Create your Lilypad account' : 'Sign in to Lilypad'}
      </Text>
      <Text style={styles.subtitle}>
        Signing in tells us who you are. You add each computer separately, by scanning the code it
        shows.
      </Text>

      {/* Which server this is about to create an account on.
       *
       * Shown only when it is NOT Lilypad's own, because the address comes
       * from a scanned QR whenever this screen is pushed by the scanner —
       * and a code can name any host at all. Someone whose password is about
       * to be typed into `not-lilypad.example` should be told so before they
       * type it, not after. Silent when it is the normal case, so the warning
       * keeps its meaning. */}
      {baseUrl !== defaultApiBaseUrl() && (
        <Text testID="foreign-backend-notice" style={styles.foreignBackend}>
          This is a different Lilypad server: {hostOf(baseUrl)}. An account here is separate from
          any other, and this phone can be signed in to one server at a time.
        </Text>
      )}

      {Platform.OS === 'ios' && (
        <Pressable
          accessibilityRole="button"
          testID="sign-in-apple"
          disabled={disabled}
          style={[styles.button, styles.apple, disabled && styles.faded]}
          onPress={() => void run('apple', () => signInWithApple(baseUrl))}
        >
          {busy === 'apple' ? (
            <ActivityIndicator color="#000" />
          ) : (
            <Text style={styles.appleText}>Continue with Apple</Text>
          )}
        </Pressable>
      )}

      {isGoogleConfigured() && (
        <Pressable
          accessibilityRole="button"
          testID="sign-in-google"
          disabled={disabled}
          style={[styles.button, styles.google, disabled && styles.faded]}
          onPress={() => void run('google', () => signInWithGoogle(baseUrl))}
        >
          {busy === 'google' ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.googleText}>Continue with Google</Text>
          )}
        </Pressable>
      )}

      <Text style={styles.divider}>or use your email</Text>

      {mode === 'signup' && (
        <>
          <TextInput
            testID="sign-up-name"
            style={styles.input}
            accessibilityLabel="Your name"
            placeholder="Your name"
            placeholderTextColor={theme.muted}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            value={name}
            onChangeText={setName}
            editable={!disabled}
          />
          <EmailField value={email} onChange={setEmail} editable={!disabled} />
          <PasswordField
            testID="sign-up-password"
            placeholder="Password (at least 12 characters)"
            autoComplete="new-password"
            textContentType="newPassword"
            value={password}
            onChange={setPassword}
            editable={!disabled}
          />
          <Text style={styles.hint}>
            At least 12 characters. Length is the only rule — a phrase you can remember beats a
            short password with symbols in it.
          </Text>
          <Primary
            testID="sign-up-submit"
            label="Create account"
            busy={busy === 'password'}
            disabled={disabled || name.trim().length === 0 || !emailReady || password.length < 12}
            onPress={() =>
              void run('password', () =>
                signUpWithPassword(baseUrl, { name, email: email.trim(), password }),
              )
            }
          />
          <Link
            testID="go-sign-in"
            label="Already have an account? Sign in"
            onPress={() => switchTo('signin')}
          />
        </>
      )}

      {mode === 'signin' && (
        <>
          <EmailField value={email} onChange={setEmail} editable={!disabled} />
          <PasswordField
            testID="sign-in-password"
            placeholder="Password"
            autoComplete="current-password"
            textContentType="password"
            value={password}
            onChange={setPassword}
            editable={!disabled}
          />
          <Primary
            testID="sign-in-password-submit"
            label="Sign in"
            busy={busy === 'password'}
            disabled={disabled || !emailReady || !passwordReady}
            onPress={() =>
              void run('password', () =>
                signInWithPassword(baseUrl, { email: email.trim(), password }),
              )
            }
          />
          <Link testID="go-sign-up" label="Create an account" onPress={() => switchTo('signup')} />
          <Link testID="go-reset" label="Forgot your password?" onPress={() => switchTo('reset')} />
          <Link
            testID="go-magic-link"
            label="Email me a sign-in link instead"
            onPress={() => switchTo('magic-link')}
          />
        </>
      )}

      {mode === 'magic-link' && !codeSent && (
        <>
          <EmailField value={email} onChange={setEmail} editable={!disabled} />
          <Primary
            testID="sign-in-email-submit"
            label="Email me a sign-in link"
            busy={busy === 'email'}
            disabled={disabled || !emailReady}
            onPress={() => void sendCode(() => requestMagicLink(baseUrl, email.trim()))}
          />
          <Link
            testID="go-sign-in"
            label="Use a password instead"
            onPress={() => switchTo('signin')}
          />
        </>
      )}

      {mode === 'magic-link' && codeSent && (
        <>
          <Text style={styles.sent}>
            If that address has an account, a sign-in link is on its way. Paste the code from the
            email below.
          </Text>
          <CodeField value={code} onChange={setCode} editable={!disabled} />
          <Primary
            testID="sign-in-token-submit"
            label="Sign in"
            busy={busy === 'email'}
            disabled={disabled || code.trim().length === 0}
            onPress={() => void run('email', () => verifyMagicLink(baseUrl, code.trim()))}
          />
        </>
      )}

      {mode === 'reset' && !codeSent && (
        <>
          <Text style={styles.sent}>
            We’ll email you a code. Entering it lets you set a new password.
          </Text>
          <EmailField value={email} onChange={setEmail} editable={!disabled} />
          <Primary
            testID="reset-request-submit"
            label="Email me a reset code"
            busy={busy === 'email'}
            disabled={disabled || !emailReady}
            onPress={() => void sendCode(() => requestPasswordReset(baseUrl, email.trim()))}
          />
          <Link testID="go-sign-in" label="Back to sign in" onPress={() => switchTo('signin')} />
        </>
      )}

      {mode === 'reset' && codeSent && (
        <>
          <Text style={styles.sent}>
            If that address has an account, a reset code is on its way. Paste it below with your new
            password.
          </Text>
          <CodeField value={code} onChange={setCode} editable={!disabled} />
          <PasswordField
            testID="reset-password"
            placeholder="New password (at least 12 characters)"
            autoComplete="new-password"
            textContentType="newPassword"
            value={password}
            onChange={setPassword}
            editable={!disabled}
          />
          <Primary
            testID="reset-confirm-submit"
            label="Set new password and sign in"
            busy={busy === 'password'}
            disabled={disabled || code.trim().length === 0 || password.length < 12}
            onPress={() =>
              void run('password', () => confirmPasswordReset(baseUrl, code.trim(), password))
            }
          />
        </>
      )}

      {error !== null && (
        <Text testID="sign-in-error" style={styles.error}>
          {error}
        </Text>
      )}

      {deviceTaken && (
        <Pressable
          testID="start-over-as-new-device"
          style={styles.startOver}
          disabled={disabled}
          onPress={startOver}
        >
          <Text style={styles.link}>Set this phone up as new</Text>
        </Pressable>
      )}
    </ScrollView>
  );
}

// ── field primitives ────────────────────────────────────────────────────────
// Local, not a shared component library: they exist so this one screen's four
// flows cannot drift in their keyboard, autofill, and capitalisation settings —
// the details that make a sign-in form feel broken when they are wrong.

function EmailField({
  value,
  onChange,
  editable,
}: {
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
}): React.JSX.Element {
  return (
    <TextInput
      testID="sign-in-email"
      style={styles.input}
      // The placeholder is the only thing naming these fields, and a
      // placeholder is gone the moment there is a value — so VoiceOver reads
      // out what you typed with no idea what it was for.
      accessibilityLabel="Email address"
      placeholder="you@example.com"
      placeholderTextColor={theme.muted}
      autoCapitalize="none"
      autoCorrect={false}
      autoComplete="email"
      keyboardType="email-address"
      textContentType="emailAddress"
      value={value}
      onChangeText={onChange}
      editable={editable}
    />
  );
}

/**
 * A password field you can actually read.
 *
 * The reveal is not a nicety. A masked field on both ends means the password
 * you SET and the password you later type are never both visible to you, so if
 * the two differ — a typo, or platform AutoFill substituting a saved or
 * generated credential — the only symptom is a sign-in that fails on the other
 * device with nothing anywhere to say why.
 */
function PasswordField({
  testID,
  placeholder,
  autoComplete,
  textContentType,
  value,
  onChange,
  editable,
}: {
  testID: string;
  placeholder: string;
  autoComplete: 'new-password' | 'current-password';
  textContentType: 'newPassword' | 'password';
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
}): React.JSX.Element {
  const [reveal, setReveal] = useState(false);
  return (
    <View style={styles.fieldRow}>
      <TextInput
        testID={testID}
        style={[styles.input, styles.fieldRowInput]}
        accessibilityLabel={placeholder}
        placeholder={placeholder}
        placeholderTextColor={theme.muted}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry={!reveal}
        // Both are needed: iOS uses `textContentType` for the Passwords keychain
        // suggestion, Android uses `autoComplete`. Setting one leaves the other
        // platform without autofill, which is where password UX actually fails.
        autoComplete={autoComplete}
        textContentType={textContentType}
        value={value}
        onChangeText={onChange}
        editable={editable}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={reveal ? 'Hide password' : 'Show password'}
        accessibilityState={{ selected: reveal }}
        testID={`${testID}-reveal`}
        style={styles.reveal}
        onPress={() => setReveal((v) => !v)}
      >
        <Text style={styles.revealText}>{reveal ? 'Hide' : 'Show'}</Text>
      </Pressable>
    </View>
  );
}

function CodeField({
  value,
  onChange,
  editable,
}: {
  value: string;
  onChange: (v: string) => void;
  editable: boolean;
}): React.JSX.Element {
  return (
    <TextInput
      testID="sign-in-token"
      style={styles.input}
      accessibilityLabel="Code from the email"
      placeholder="Code from the email"
      placeholderTextColor={theme.muted}
      autoCapitalize="none"
      autoCorrect={false}
      value={value}
      onChangeText={onChange}
      editable={editable}
    />
  );
}

function Primary({
  testID,
  label,
  busy,
  disabled,
  onPress,
}: {
  testID: string;
  label: string;
  busy: boolean;
  disabled: boolean;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable
      accessibilityRole="button"
      testID={testID}
      disabled={disabled}
      style={[styles.button, styles.email, disabled && styles.faded]}
      onPress={onPress}
    >
      {busy ? (
        <ActivityIndicator color={theme.onAccent} />
      ) : (
        <Text style={styles.emailText}>{label}</Text>
      )}
    </Pressable>
  );
}

function Link({
  testID,
  label,
  onPress,
}: {
  testID: string;
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable accessibilityRole="button" testID={testID} onPress={onPress} style={styles.linkHit}>
      <Text style={styles.link}>{label}</Text>
    </Pressable>
  );
}

/**
 * P3: this screen was on no palette at all — no background colour, so it
 * rendered white while every other screen is dark green, with `#ccc` borders
 * and a Material red error. It is the first thing a new user sees, which made
 * it the most visible incoherence in the product.
 *
 * The two provider buttons keep their vendor colours on purpose. Apple's and
 * Google's sign-in buttons are brand assets with published appearance rules,
 * and a palette is not licence to restyle them; Apple's white style is the one
 * of its permitted styles that stays legible on a dark background.
 */
const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: theme.bg },
  container: { flexGrow: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { color: theme.ink, fontSize: 26, fontWeight: '700', textAlign: 'center' },
  subtitle: { color: theme.muted, fontSize: 15, textAlign: 'center', marginBottom: 12 },
  button: { paddingVertical: 14, borderRadius: radius.sm, alignItems: 'center' },
  apple: { backgroundColor: '#fff' },
  appleText: { color: '#000', fontSize: 16, fontWeight: '600' },
  google: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#dadce0' },
  googleText: { color: '#3c4043', fontSize: 16, fontWeight: '600' },
  email: { backgroundColor: theme.accent },
  emailText: { color: theme.onAccent, fontSize: 16, fontWeight: '700' },
  faded: { opacity: 0.5 },
  divider: { color: theme.muted, textAlign: 'center', marginVertical: 8 },
  input: {
    color: theme.ink,
    backgroundColor: theme.panel,
    borderWidth: 1,
    borderColor: theme.line,
    borderRadius: radius.sm,
    padding: 12,
    fontSize: 16,
  },
  hint: { color: theme.muted, fontSize: 13 },
  fieldRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  fieldRowInput: { flex: 1 },
  // 44pt is Apple's minimum touch target.
  reveal: { minHeight: 44, minWidth: 56, alignItems: 'center', justifyContent: 'center' },
  revealText: { color: theme.accent, fontSize: 15, fontWeight: '600' },
  sent: { color: theme.muted, fontSize: 14, textAlign: 'center' },
  // 44pt is Apple's minimum touch target; a text link that only covers its
  // glyphs is the most commonly missed one.
  linkHit: { minHeight: 44, justifyContent: 'center' },
  link: { color: theme.accent, fontSize: 15, textAlign: 'center' },
  startOver: { marginTop: 12, minHeight: 44, justifyContent: 'center' },
  error: { color: theme.danger, textAlign: 'center', marginTop: 8 },
  foreignBackend: {
    color: theme.danger,
    fontSize: 13,
    textAlign: 'center',
    marginBottom: 12,
    lineHeight: 18,
  },
});
