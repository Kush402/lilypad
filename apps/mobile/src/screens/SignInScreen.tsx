import React, { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import type { DeviceSession } from '@lilypad/protocol';
import {
  signInWithGoogle,
  signInWithApple,
  requestMagicLink,
  verifyMagicLink,
  SignInError,
} from '../lib/signIn';
import { isGoogleConfigured } from '../config/oauth';

/**
 * Sign in, then enroll this phone ([ADR-0001](../../../../docs/adr/0001-account-authentication.md)).
 *
 * Providers are only offered when they can actually work: Google's button is
 * hidden unless a web client id is compiled in, and Apple's only appears on
 * iOS. Offering a button that fails after the user taps it is worse than not
 * offering it, because the failure looks like the product is broken rather than
 * unconfigured.
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
  apiBaseUrl: string;
  onSignedIn: (session: DeviceSession) => void;
}

type Busy = 'google' | 'apple' | 'email' | null;

export function SignInScreen({ apiBaseUrl, onSignedIn }: SignInScreenProps): React.JSX.Element {
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [linkSent, setLinkSent] = useState(false);
  const [linkToken, setLinkToken] = useState('');

  const run = useCallback(
    async (which: Busy, action: () => Promise<DeviceSession>) => {
      setBusy(which);
      setError(null);
      try {
        onSignedIn(await action());
      } catch (err) {
        // A cancelled sign-in is a choice, not a failure — showing an error for
        // it makes the app feel broken when nothing went wrong.
        if (err instanceof SignInError && err.code === 'cancelled') return;
        setError(err instanceof Error ? err.message : 'Sign-in failed. Please try again.');
      } finally {
        setBusy(null);
      }
    },
    [onSignedIn],
  );

  const sendLink = useCallback(async () => {
    setBusy('email');
    setError(null);
    try {
      await requestMagicLink(apiBaseUrl, email.trim());
      // Deliberately unconditional: the backend answers identically whether or
      // not the address has an account, and the UI must not leak more than it.
      setLinkSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send a sign-in link.');
    } finally {
      setBusy(null);
    }
  }, [apiBaseUrl, email]);

  return (
    <View style={styles.container} testID="sign-in-screen">
      <Text style={styles.title}>Sign in to Lilypad</Text>
      <Text style={styles.subtitle}>
        Signing in tells us who you are. You add each computer separately, by scanning the code it
        shows.
      </Text>

      {Platform.OS === 'ios' && (
        <Pressable
          accessibilityRole="button"
          testID="sign-in-apple"
          disabled={busy !== null}
          style={[styles.button, styles.apple, busy !== null && styles.disabled]}
          onPress={() => void run('apple', () => signInWithApple(apiBaseUrl))}
        >
          {busy === 'apple' ? (
            <ActivityIndicator color="#fff" />
          ) : (
            <Text style={styles.appleText}>Continue with Apple</Text>
          )}
        </Pressable>
      )}

      {isGoogleConfigured() && (
        <Pressable
          accessibilityRole="button"
          testID="sign-in-google"
          disabled={busy !== null}
          style={[styles.button, styles.google, busy !== null && styles.disabled]}
          onPress={() => void run('google', () => signInWithGoogle(apiBaseUrl))}
        >
          {busy === 'google' ? (
            <ActivityIndicator />
          ) : (
            <Text style={styles.googleText}>Continue with Google</Text>
          )}
        </Pressable>
      )}

      <Text style={styles.divider}>or use your email</Text>

      {!linkSent ? (
        <>
          <TextInput
            testID="sign-in-email"
            style={styles.input}
            placeholder="you@example.com"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="email-address"
            textContentType="emailAddress"
            value={email}
            onChangeText={setEmail}
            editable={busy === null}
          />
          <Pressable
            accessibilityRole="button"
            testID="sign-in-email-submit"
            disabled={busy !== null || email.trim().length === 0}
            style={[
              styles.button,
              styles.email,
              (busy !== null || email.trim().length === 0) && styles.disabled,
            ]}
            onPress={() => void sendLink()}
          >
            {busy === 'email' ? <ActivityIndicator /> : <Text>Email me a sign-in link</Text>}
          </Pressable>
        </>
      ) : (
        <>
          <Text style={styles.sent}>
            If that address has an account, a sign-in link is on its way. Paste the code from the
            email below.
          </Text>
          <TextInput
            testID="sign-in-token"
            style={styles.input}
            placeholder="Sign-in code"
            autoCapitalize="none"
            autoCorrect={false}
            value={linkToken}
            onChangeText={setLinkToken}
            editable={busy === null}
          />
          <Pressable
            accessibilityRole="button"
            testID="sign-in-token-submit"
            disabled={busy !== null || linkToken.trim().length === 0}
            style={[
              styles.button,
              styles.email,
              (busy !== null || linkToken.trim().length === 0) && styles.disabled,
            ]}
            onPress={() => void run('email', () => verifyMagicLink(apiBaseUrl, linkToken.trim()))}
          >
            {busy === 'email' ? <ActivityIndicator /> : <Text>Sign in</Text>}
          </Pressable>
        </>
      )}

      {error !== null && (
        <Text testID="sign-in-error" style={styles.error}>
          {error}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', padding: 24, gap: 12 },
  title: { fontSize: 26, fontWeight: '700', textAlign: 'center' },
  subtitle: { fontSize: 15, textAlign: 'center', opacity: 0.7, marginBottom: 12 },
  button: { paddingVertical: 14, borderRadius: 10, alignItems: 'center' },
  apple: { backgroundColor: '#000' },
  appleText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  google: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#ccc' },
  googleText: { fontSize: 16, fontWeight: '600' },
  email: { backgroundColor: '#eee' },
  disabled: { opacity: 0.5 },
  divider: { textAlign: 'center', opacity: 0.5, marginVertical: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 10, padding: 12, fontSize: 16 },
  sent: { fontSize: 14, opacity: 0.8, textAlign: 'center' },
  error: { color: '#b00020', textAlign: 'center', marginTop: 8 },
});
