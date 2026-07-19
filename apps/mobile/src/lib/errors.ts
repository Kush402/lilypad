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
  | 'server_error'
  | 'signaling_lost'
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
  server_error: 'The pairing server had a problem. Try again in a moment.',
  signaling_lost: 'Lost the connection to the laptop.',
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
  server_error: true,
  signaling_lost: true,
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

/** Classify an HTTP error response from `/pairing/redeem`. */
export function classifyHttpStatus(status: number, body: string): AppError {
  if (status === 410) return appError('token_expired');
  if (status >= 500) return appError('server_error');
  return appError('unknown', `HTTP ${status}${body ? `: ${body}` : ''}`);
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
