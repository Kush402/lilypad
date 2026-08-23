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
  | 'session_gone'
  | 'peer_denied'
  | 'ice_failed'
  // M5.4 no-QR reconnect (`POST /connect/request`) failures:
  | 'not_trusted'
  | 'trust_revoked'
  | 'desktop_offline'
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
  signaling_lost: 'Lost the connection to the laptop.',
  session_gone: 'That session ended. Reconnecting to the laptop…',
  peer_denied: 'The laptop denied this request.',
  ice_failed: 'Could not establish a connection to the laptop.',
  not_trusted: "This laptop hasn't trusted this phone yet. Scan its QR code once to pair.",
  trust_revoked: 'This pairing was revoked on the laptop. Scan its QR code to pair again.',
  desktop_offline: 'The laptop is offline. Make sure Lilypad is running on it.',
  unknown: 'Something went wrong.',
};

const RETRYABLE: Record<AppErrorCode, boolean> = {
  qr_invalid: false,
  token_expired: false,
  network_unreachable: true,
  request_timeout: true,
  rate_limited: true,
  server_error: true,
  signaling_lost: true,
  session_gone: true,
  peer_denied: false,
  ice_failed: true,
  not_trusted: false,
  trust_revoked: false,
  desktop_offline: true,
  unknown: true,
};

export function appError(code: AppErrorCode, message?: string): AppError {
  return { code, message: message ?? COPY[code], retryable: RETRYABLE[code] };
}

/** Thrown by `redeemToken` so callers can branch UI on `.code`/`.retryable`
 * instead of pattern-matching a message string. */
export class RedeemError extends Error implements AppError {
  readonly code: AppErrorCode;
  readonly retryable: boolean;

  constructor(err: AppError) {
    super(err.message);
    this.name = 'RedeemError';
    this.code = err.code;
    this.retryable = err.retryable;
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
  void body;
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
  return appError('unknown', message);
}

/** Classify a fetch that never got an HTTP response at all — a network
 * failure or our own client-side timeout abort. */
export function classifyFetchError(timedOut: boolean): AppError {
  return timedOut ? appError('request_timeout') : appError('network_unreachable');
}

/** Normalize anything caught into an `AppError` for display, preserving a
 * `RedeemError`'s real classification instead of flattening it to 'unknown'. */
export function toAppError(err: unknown): AppError {
  if (err instanceof RedeemError)
    return { code: err.code, message: err.message, retryable: err.retryable };
  if (err instanceof Error) return appError('unknown', err.message);
  return appError('unknown', String(err));
}
