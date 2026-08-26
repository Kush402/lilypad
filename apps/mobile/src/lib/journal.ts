import { APP_VERSION } from '../config/version';

/**
 * What this phone saw during a session, so a bad one can be explained
 * afterwards instead of described from memory.
 *
 * The Mac got a log file on 2026-08-24 (`~/Library/Logs/Lilypad`) and it
 * immediately paid for itself. The phone had nothing: its quality HUD shows
 * round-trip time, bitrate and frame rate live, and then the numbers are gone.
 * So when a customer says a cellular session was "wobbly", the backend can
 * show that a phone stopped heart-beating and the Mac can show its own side,
 * and the half that was actually on the moving network is unrecoverable.
 *
 * Deliberately small: an in-memory ring, no file, no dependency, no upload.
 * A session is minutes long and this is read by pressing a button while it is
 * still on screen, so durability across launches buys nothing and a log file
 * on a phone is something a person cannot get at anyway.
 *
 * **Nothing identifying goes in here.** No device names, no email, no room or
 * session ids, no SDP, no candidate addresses — an IP address in a support
 * paste is somebody's home. What it holds is state transitions, error CODES,
 * and numbers. That rule is enforced by a test, not by remembering.
 */

/** Kept short enough to paste into a message and long enough to cover a
 * session's worth of 2s quality samples plus every transition around them. */
const MAX_ENTRIES = 240;

interface Entry {
  /** Milliseconds since the journal started, not a wall clock: relative time
   * is what makes a sequence readable, and an absolute one adds nothing. */
  atMs: number;
  event: string;
  detail?: string;
}

let entries: Entry[] = [];
let startedAt = Date.now();

/**
 * Record one thing that happened.
 *
 * `detail` is for values that belong in a diagnostic and never on screen —
 * the raw text of a failed SDP apply, "gave up after 4 reconnect attempts".
 * Those used to be rendered to the customer verbatim; this is where they go
 * instead.
 */
export function record(event: string, detail?: string): void {
  entries.push({ atMs: Date.now() - startedAt, event, ...(detail ? { detail } : {}) });
  // Drop from the front rather than refusing to record: the end of a session
  // is the part being diagnosed.
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

/** Last state recorded, so a transition is logged once rather than once per
 * code path that reaches it. */
let lastState: string | null = null;

/**
 * Record a state transition, ignoring a repeat of the state we are already in.
 *
 * `connected` is reached from five different places in `webrtc.ts` — the
 * initial negotiation, an ICE recovery, a renegotiation, a signaling
 * reconnect. Logging each one produces a column of identical lines and buries
 * the transitions that explain the session, which is the same reason quality
 * is sampled on change rather than on every poll.
 *
 * A genuine return to a state still records, because the state changed away
 * and back — which is exactly the shape of a wobbly connection.
 */
export function recordState(state: string): void {
  if (state === lastState) return;
  lastState = state;
  record(state);
}

/** Begin a fresh session's journal. */
export function startSession(): void {
  entries = [];
  startedAt = Date.now();
  lastState = null;
  record('session started', `app ${APP_VERSION}`);
}

/** For tests, and for a screen that wants to show a count. */
export function entryCount(): number {
  return entries.length;
}

/**
 * The journal as text a person can paste into a message.
 *
 * Seconds with one decimal, because the interesting gaps in a wobbly session
 * are whole seconds apart and millisecond precision would only make it wider.
 */
export function journalText(): string {
  if (entries.length === 0) return 'Lilypad session log\n(nothing recorded yet)';
  const lines = entries.map((e) => {
    const t = (e.atMs / 1000).toFixed(1).padStart(6, ' ');
    return `${t}s  ${e.event}${e.detail ? `: ${e.detail}` : ''}`;
  });
  return [`Lilypad session log · app ${APP_VERSION}`, ...lines].join('\n');
}
