/**
 * OAuth client identifiers.
 *
 * **These are not secrets.** OAuth client IDs are public by design — they ship
 * inside every app binary and are visible in any network trace. What stops
 * someone using ours is the backend's audience check
 * (`apps/backend/src/auth/providers.ts`), which rejects a token whose `aud` is
 * not one of ours, plus Apple's and Google's own binding of a client to a
 * registered bundle id and signing certificate. So they live in source rather
 * than in a build-time secret, and are checked in deliberately.
 *
 * Every value here must also appear in the backend's `GOOGLE_CLIENT_IDS` /
 * `APPLE_CLIENT_IDS` if it can end up as a token's `aud`, or sign-in fails with
 * `invalid_token`. See `docs/oauth-setup.md`.
 */

/**
 * Google's **Web** client id.
 *
 * This is the one that matters most and the one that is easiest to get wrong.
 * `@react-native-google-signin/google-signin` mints the ID token with `aud` set
 * to `webClientId` on BOTH platforms when it is supplied — and on Android it is
 * required in order to get an ID token at all. So this, not the iOS client id,
 * is normally what the backend must accept.
 */
export const GOOGLE_WEB_CLIENT_ID = '';

/**
 * Google's **iOS** client id. Required by the iOS SDK to start the flow at all,
 * even though the resulting token's audience is the web client above.
 */
export const GOOGLE_IOS_CLIENT_ID = '';

/** True when Google sign-in can actually be attempted. The UI hides the button
 * rather than offering one that fails after the user taps it. */
export function isGoogleConfigured(): boolean {
  return GOOGLE_WEB_CLIENT_ID.length > 0;
}

/**
 * Apple needs no client id here.
 *
 * Native Sign in with Apple mints an identity token whose `aud` is the app's
 * **bundle id** (`com.takedia.lilypad`), which the OS supplies — there is
 * nothing for the app to configure. The backend must list that bundle id in
 * `APPLE_CLIENT_IDS`. A Services ID is only needed for web or desktop
 * browser-based sign-in, neither of which the phone performs.
 */
export const APPLE_BUNDLE_ID = 'com.takedia.lilypad';
