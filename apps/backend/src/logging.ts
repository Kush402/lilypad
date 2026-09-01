import { randomBytes, createHash } from 'node:crypto';
import { createLogger } from '@lilypad/shared';

/**
 * One structured logger per subsystem (no println debugging). Each carries its
 * own `name` so logs are filterable: `{name: "signaling", ...}`.
 */
export const log = {
  server: createLogger('server'),
  signaling: createLogger('signaling'),
  session: createLogger('session'),
  turn: createLogger('turn'),
  security: createLogger('security'),
  pairing: createLogger('pairing'),
  audit: createLogger('audit'),
};

/**
 * Build a privacy-safe correlator bound to one salt: `sha256(salt + value)`,
 * truncated to 12 hex chars. Separated from `hashForLog` below purely so
 * tests can construct two independent hashers and prove their outputs
 * actually differ — the exported, production-facing `hashForLog` is a single
 * process-wide instance, and a test running inside that one process has no
 * other way to observe "a different salt produces a different hash."
 * Production code should always go through `hashForLog`, never this.
 */
export function createLogHasher(salt: string): (value: string) => string {
  return (value: string) =>
    createHash('sha256').update(salt).update(value).digest('hex').slice(0, 12);
}

/**
 * Per-process random salt, generated once at boot and never persisted or
 * logged itself. Reused for every `hashForLog` call for the life of this
 * process, so repeated events sharing a raw value (the same abusive IP
 * hammering the rate limiter, the same address requesting several magic
 * links) still visibly correlate with each other in one deploy's logs — but
 * a fresh salt every restart means that correlation never survives one.
 */
const LOG_SALT = randomBytes(16).toString('hex');

/**
 * Privacy-safe stand-in for a raw identifier (IP address, email address, …)
 * that must never appear in plaintext in an OPERATIONAL log line.
 *
 * The privacy policy promises security-log data (the `audit_logs` table,
 * `services/auditLog.ts`) is deleted after 2 days — and that table's IP
 * storage is disclosed and genuinely retention-bounded, so it is fine as-is.
 * pino's stdout is a different animal: Docker rotates container logs by
 * SIZE, not age, so a busy deployment's log files can silently hold weeks or
 * months of history. Writing a raw IP or email into a `log.*.warn`/`.info`
 * call therefore lets that value quietly outlive the 2-day promise, even
 * though nothing about it is the audited security log the promise names.
 *
 * `hashForLog` keeps the operational value of the field (an operator can
 * still tell "these five warnings are the same caller" apart from "five
 * different callers") while making the log line itself useless as a stable
 * identifier: the salt is random, in-memory only, and regenerated on every
 * restart, so the hash cannot be reversed and cannot be correlated with the
 * same raw value's hash from a different process run.
 */
export const hashForLog: (value: string) => string = createLogHasher(LOG_SALT);
