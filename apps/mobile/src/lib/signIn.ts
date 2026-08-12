import { Platform } from 'react-native';
import { GoogleSignin } from '@react-native-google-signin/google-signin';
import appleAuth from '@invertase/react-native-apple-authentication';
import type { AuthSession, DeviceSession, OAuthProviderName } from '@lilypad/protocol';
import { GOOGLE_WEB_CLIENT_ID, GOOGLE_IOS_CLIENT_ID, isGoogleConfigured } from '../config/oauth';
import { enrollDevice } from './auth';

/**
 * Sign-in: prove who the human is, then bind this phone to them.
 *
 * The shape follows [ADR-0001](../../../../docs/adr/0001-account-authentication.md)
 * and [ADR-0002](../../../../docs/adr/0002-device-identity.md):
 *
 * 1. The platform SDK performs the interactive sign-in and returns an **ID
 *    token**. Lilypad never sees a provider password and never performs an
 *    authorization-code exchange — the backend verifies the token the SDK
 *    produced.
 * 2. That token is exchanged at `/auth/oauth` for a short-lived ACCOUNT session.
 * 3. The account session is spent immediately on `/devices/enroll`, which binds
 *    this phone's Ed25519 key to the account and returns a DEVICE token.
 *
 * **The account session is then discarded, and nothing bearer-shaped is ever
 * written to storage.** Once enrolled, the phone re-authenticates by signing a
 * challenge with its key, so persisting the account refresh token would leave a
 * copyable credential lying around for a job the key already does.
 *
 * The cost is that a failure between steps 2 and 3 means signing in again. That
 * is one tap, and it is the correct trade against storing a long-lived token.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export class SignInError extends Error {
  constructor(
    readonly code: 'cancelled' | 'not_configured' | 'unavailable' | 'rejected' | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'SignInError';
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return { status: res.status, text: await res.text() };
  } catch {
    throw new SignInError('network', 'Could not reach Lilypad. Check your connection.');
  } finally {
    clearTimeout(timer);
  }
}

/** Exchange a provider ID token for an account session. */
async function exchangeIdToken(
  apiBaseUrl: string,
  provider: OAuthProviderName,
  idToken: string,
): Promise<AuthSession> {
  const { status, text } = await postJson(`${apiBaseUrl.replace(/\/$/, '')}/auth/oauth`, {
    provider,
    idToken,
  });
  if (status === 200) return JSON.parse(text) as AuthSession;
  if (status === 503) {
    throw new SignInError(
      'not_configured',
      `${provider === 'apple' ? 'Apple' : 'Google'} sign-in is not available right now.`,
    );
  }
  if (status === 403) {
    // email_required / email_unverified — actionable by the user, and neither
    // answer reveals whether an account exists.
    const reason = text.includes('email_unverified')
      ? 'Your account with this provider has an unverified email address.'
      : 'That sign-in did not share an email address, which Lilypad needs to create an account.';
    throw new SignInError('rejected', reason);
  }
  throw new SignInError('rejected', 'That sign-in could not be completed.');
}

/** Configure the Google SDK. Idempotent; safe to call before every attempt. */
function configureGoogle(): void {
  GoogleSignin.configure({
    // The ID token's `aud` becomes this on BOTH platforms, which is why the
    // backend's GOOGLE_CLIENT_IDS must contain the WEB client id.
    webClientId: GOOGLE_WEB_CLIENT_ID,
    ...(Platform.OS === 'ios' && GOOGLE_IOS_CLIENT_ID ? { iosClientId: GOOGLE_IOS_CLIENT_ID } : {}),
    offlineAccess: false,
  });
}

/** Sign in with Google and enroll this phone. */
export async function signInWithGoogle(apiBaseUrl: string): Promise<DeviceSession> {
  if (!isGoogleConfigured()) {
    throw new SignInError('not_configured', 'Google sign-in is not set up in this build.');
  }
  configureGoogle();
  let idToken: string | null = null;
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    const result = await GoogleSignin.signIn();
    idToken = result.type === 'success' ? result.data.idToken : null;
    if (result.type === 'cancelled') throw new SignInError('cancelled', 'Sign-in cancelled.');
  } catch (err) {
    if (err instanceof SignInError) throw err;
    throw new SignInError('unavailable', 'Google sign-in is unavailable on this device.');
  }
  if (!idToken) {
    // Almost always a misconfigured webClientId: without it Android returns a
    // successful sign-in carrying no ID token at all, which would otherwise
    // surface as a confusing generic failure.
    throw new SignInError(
      'not_configured',
      'Google did not return an identity token — check the web client id.',
    );
  }
  return completeSignIn(apiBaseUrl, await exchangeIdToken(apiBaseUrl, 'google', idToken));
}

/** Sign in with Apple and enroll this phone. */
export async function signInWithApple(apiBaseUrl: string): Promise<DeviceSession> {
  if (!appleAuth.isSupported) {
    throw new SignInError('unavailable', 'Sign in with Apple needs iOS 13 or later.');
  }
  let identityToken: string | null = null;
  try {
    const response = await appleAuth.performRequest({
      requestedOperation: appleAuth.Operation.LOGIN,
      // Apple only returns the email on the FIRST authorization, so it must be
      // requested here even though later sign-ins will not include it. The
      // backend resolves returning users by `sub`, not by email, for exactly
      // that reason.
      requestedScopes: [appleAuth.Scope.EMAIL, appleAuth.Scope.FULL_NAME],
    });
    identityToken = response.identityToken;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === appleAuth.Error.CANCELED) {
      throw new SignInError('cancelled', 'Sign-in cancelled.');
    }
    throw new SignInError('unavailable', 'Sign in with Apple could not be completed.');
  }
  if (!identityToken) {
    throw new SignInError('rejected', 'Apple did not return an identity token.');
  }
  return completeSignIn(apiBaseUrl, await exchangeIdToken(apiBaseUrl, 'apple', identityToken));
}

/** Ask for a magic link. Always resolves — the backend answers identically
 * whether or not the address has an account, and the UI must not leak more than
 * the backend does. */
export async function requestMagicLink(apiBaseUrl: string, email: string): Promise<void> {
  const { status } = await postJson(`${apiBaseUrl.replace(/\/$/, '')}/auth/magic-link/request`, {
    email,
  });
  if (status === 503) {
    throw new SignInError('not_configured', 'Email sign-in is not available on this server.');
  }
  if (status !== 202) throw new SignInError('rejected', 'That address could not be used.');
}

/** Redeem a magic-link token and enroll this phone. */
export async function verifyMagicLink(apiBaseUrl: string, token: string): Promise<DeviceSession> {
  const { status, text } = await postJson(
    `${apiBaseUrl.replace(/\/$/, '')}/auth/magic-link/verify`,
    { token },
  );
  if (status !== 200) {
    throw new SignInError('rejected', 'That link has expired or was already used.');
  }
  return completeSignIn(apiBaseUrl, JSON.parse(text) as AuthSession);
}

/**
 * Spend an account session on enrollment, then let it go.
 *
 * Exported so the magic-link and OAuth paths share one definition of "signed
 * in" — which, for this app, means "this phone is enrolled", not "a token is
 * stored somewhere".
 */
export async function completeSignIn(
  apiBaseUrl: string,
  session: AuthSession,
): Promise<DeviceSession> {
  return enrollDevice(apiBaseUrl, session.accessToken);
}
