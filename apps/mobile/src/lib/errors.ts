/**
 * A small, closed taxonomy of user-facing failure modes. Before this, raw
 * `Error` objects (bare exceptions, raw HTTP response bodies) reached the UI
 * verbatim — e.g. the bug that motivated this audit, an expired-QR
 * redemption surfacing as `'Network request timed out'`. Every failure path
 * in the app (pairing redeem, signaling, the peer connection) now classifies
 * into one of these codes instead. See `docs/audit/m3/mobile-ux.md`
 * Finding 2.
 */
export type AppErrorCode =
  | 'qr_invalid'
  | 'token_expired'
  | 'network_unreachable'
  | 'request_timeout'
  | 'rate_limited'
  | 'server_error'
  | 'signaling_lost'
  | 'signaling_timeout'
  | 'lan_pin_misapplied'
  | 'lan_pinning_unavailable'
  | 'session_gone'
  | 'peer_denied'
  | 'ice_failed'
  // M5.4 no-QR reconnect (`POST /connect/request`) failures:
  | 'not_trusted'
  | 'trust_revoked'
  | 'desktop_offline'
  | 'desktop_not_on_account'
  | 'different_account'
  | 'unknown';

export interface AppError {
  code: AppErrorCode;
  message: string;
  retryable: boolean;
}

const COPY: Record<AppErrorCode, string> = {
  qr_invalid: 'That QR code is not a Lilypad pairing code.',
  token_expired: 'This QR code has expired. Ask for a new one on the laptop and scan again.',
  network_unreachable: "Couldn't reach the laptop. Check your Wi-Fi or cellular connection.",
  request_timeout: 'That took too long. Check your connection and try again.',
  rate_limited: 'Too many attempts just now. Wait a minute, then try again.',
  server_error: 'The pairing server had a problem. Try again in a moment.',
  // Reached on exactly one path, and it is the one where the session is over:
  // `onError(signaling_lost)` is immediately followed by `onState('ended')`
  // and `close()`. An earlier draft said "Reconnecting…" here, which would
  // have been a sentence the app was not going to honour. When signaling
  // drops while media is still flowing, nothing is shown at all — the badge
  // reads "Reconnecting…" and the retry happens quietly.
  signaling_lost: 'Lost the connection to the laptop. Connect again when you’re ready.',
  // The spinner that used to be forever. A socket that neither opens nor
  // fails is indistinguishable, from the screen, from one that is simply
  // slow — so it said "Connecting…" and never stopped. Anything true is
  // better than that, and "try again" is genuinely the right move: the
  // v0.1.21 cause was per-attempt, and a fresh ring re-runs the LAN probe.
  signaling_timeout: 'Couldn’t reach the laptop in time. Check that it’s awake, then try again.',
  // Ours, not theirs — this one is a bug in this app, and it is deliberately
  // NOT dressed up as a network problem. Telling someone to check their Wi-Fi
  // about a mismatched certificate pin sends them to fix something that is
  // already fine.
  lan_pin_misapplied:
    'Lilypad hit an internal connection error. Try again, or scan the laptop’s QR code.',
  // A pin was required and this build cannot enforce it. Falling through to an
  // unpinned socket would quietly drop the control — refuse instead.
  lan_pinning_unavailable:
    'Lilypad can’t verify this laptop’s identity on this build. Update the app, or scan the laptop’s QR code.',
  session_gone: 'That session ended. Connect again when you’re ready.',
  peer_denied: 'The laptop denied this request. Approve it there, then try again.',
  ice_failed: 'Could not reach the laptop. Check that both devices are online, then try again.',
  not_trusted: 'This phone isn’t paired with that laptop yet. Scan its code once to pair.',
  trust_revoked: 'That pairing was ended on the laptop. Scan its code to pair again.',
  desktop_offline: 'The laptop is offline. Make sure Lilypad is running on it.',
  // Distinct from `desktop_offline`, which is what this used to be reported as
  // — and from `not_trusted`, which is what it used to be reported as before
  // that. Signing out of a Mac now releases it from the account (ADR-0015), so
  // a laptop that is switched on, online, and still paired can nonetheless
  // refuse to be rung; removing it from "Your devices" does the same. "It's
  // offline" sends its owner to check a power cable; "scan its code again"
  // sends them to a pairing screen that refuses a computer no account owns.
  // Neither names the one thing that fixes it, and it is not guessable.
  //
  // Named for the FACT, not for either cause, because the backend cannot tell
  // them apart and both have the same remedy.
  desktop_not_on_account:
    'That laptop is not on your Lilypad account right now. Sign in to Lilypad on it to bring it back. Your pairing is still there.',
  // A pair joins two devices on ONE account (ADR-0015). Reachable by scanning a
  // colleague's Mac, and the remedy is not guessable from a 403.
  different_account:
    'That computer is on a different Lilypad account. Sign in to the same account on both, then pair again.',
  unknown: 'Something went wrong. Try again in a moment.',
};

const RETRYABLE: Record<AppErrorCode, boolean> = {
  qr_invalid: false,
  token_expired: false,
  network_unreachable: true,
  request_timeout: true,
  rate_limited: true,
  server_error: true,
  signaling_lost: true,
  signaling_timeout: true,
  // The pin and the URL are recomputed from scratch on the next ring, and the
  // mismatch that produced this one was a per-attempt accident of which target
  // won the probe — so trying again really can land differently.
  lan_pin_misapplied: true,
  // Retrying the same build cannot invent a native pin module.
  lan_pinning_unavailable: false,
  session_gone: true,
  peer_denied: false,
  ice_failed: true,
  not_trusted: false,
  trust_revoked: false,
  desktop_offline: true,
  // Nothing about tapping again changes whether someone signed in on the
  // laptop, and the button that offers it would be the app disagreeing with
  // the sentence directly above it.
  desktop_not_on_account: false,
  // Retrying with the same two devices can only fail the same way.
  different_account: false,
  unknown: true,
};

/**
 * An error whose message was written for a person to read.
 *
 * `toAppError` used to pass EVERY `Error.message` straight to the screen, so a
 * runtime fault rendered itself: "undefined is not an object (evaluating
 * 'this.pc.close')" is a sentence this app was one TypeError away from showing
 * a customer, in the viewer, mid-session. That is precisely the failure this
 * module's own opening comment says it exists to prevent — fixed for HTTP
 * bodies, still live on the catch-all path.
 *
 * The distinction cannot be made from the type alone, because our own curated
 * copy was thrown as a plain `Error` too. So the copy is marked instead: this
 * class and its subclasses are the messages we wrote, and everything else
 * falls back to the catalogue.
 */
export class UserFacingError extends Error {}

export function appError(code: AppErrorCode, message?: string): AppError {
  return { code, message: message ?? COPY[code], retryable: RETRYABLE[code] };
}

/**
 * A thrown error that carries its own classification, so `toAppError` can hand
 * the screen the real code rather than flattening it to `unknown`.
 *
 * Split out of `RedeemError` (which is now one of these) because failures that
 * are nothing to do with redeeming a QR code need the same guarantee: the
 * signaling open-timeout has a specific remedy and a Retry button hangs off
 * `.retryable`, and neither survives being reported as "something went wrong".
 */
export class ClassifiedError extends UserFacingError implements AppError {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(err: AppError) {
    super(err.message);
    this.name = 'ClassifiedError';
    this.code = err.code;
    this.retryable = err.retryable;
  }
}

/** Thrown by `redeemToken` so callers can branch UI on `.code`/`.retryable`
 * instead of pattern-matching a message string. */
export class RedeemError extends ClassifiedError {
  constructor(err: AppError) {
    super(err);
    this.name = 'RedeemError';
  }
}

/**
 * Classify an HTTP error response from `/pairing/redeem`.
 *
 * The last line used to be `appError('unknown', \`HTTP ${status}: ${body}\`)`,
 * which put a status line and a JSON body on the scanner screen. Two of the
 * statuses that fell through to it happen in ordinary use: **429**, because
 * the route is rate-limited and a person who scans twice can reach it, and
 * **404**, which is what a code from another backend or a long-dead session
 * looks like.
 *
 * `body` is no longer interpolated anywhere. It stays a parameter because the
 * caller has it and a future classification may need to read it — but nothing
 * a server sends is copy this app is willing to show.
 */
export function classifyHttpStatus(status: number, body: string): AppError {
  // The one 403 with a remedy of its own. A pair joins two devices on ONE
  // account (ADR-0015), so scanning a colleague's Mac is refused — and the
  // generic `unknown` would say "try again in a moment" about the one failure
  // that trying again cannot fix.
  if (status === 403 && body.includes('different_account')) return appError('different_account');
  // Gone, not expired-and-gone: the same remedy either way, and "ask for a new
  // one on the laptop" is the true instruction for both.
  if (status === 410 || status === 404) return appError('token_expired');
  if (status === 429) return appError('rate_limited');
  if (status >= 500) return appError('server_error');
  return appError('unknown');
}

/**
 * Classify an `error` frame from the signaling hub.
 *
 * `unauthorized_room` is the one that matters, and it is not the security
 * problem its name suggests. It is what a phone gets when it re-registers into
 * a room whose authorization record is gone — the ordinary consequence of the
 * laptop dropping (a lid closing is enough) and the phone reconnecting a couple
 * of minutes later. Observed four times in 48 hours on production with a single
 * user.
 *
 * Passing the hub's own words through put "this device is not authorized to
 * join this room" on screen: alarming, and about the wrong thing. The session
 * is simply over, and the fix is a new one.
 */
export function classifyHubError(code: string, message: string): AppError {
  if (code === 'unauthorized_room') return appError('session_gone');
  // The comment above describes passing the hub's own words through as the
  // bug, and then this line did it for every OTHER code. `message` is a
  // protocol string aimed at a developer; it is kept for the log, not the
  // screen.
  void message;
  return appError('unknown');
}

/** Classify a fetch that never got an HTTP response at all — a network
 * failure or our own client-side timeout abort. */
export function classifyFetchError(timedOut: boolean): AppError {
  return timedOut ? appError('request_timeout') : appError('network_unreachable');
}

/** Normalize anything caught into an `AppError` for display, preserving a
 * `ClassifiedError`'s real classification instead of flattening it to
 * 'unknown'. */
export function toAppError(err: unknown): AppError {
  if (err instanceof ClassifiedError)
    return { code: err.code, message: err.message, retryable: err.retryable };
  // Only text we wrote. A `TypeError` from a null peer connection, or a
  // `String(err)` that renders "[object Object]", is not an explanation — it
  // is the app's insides on a customer's screen.
  if (err instanceof UserFacingError) return appError('unknown', err.message);
  return appError('unknown');
}
