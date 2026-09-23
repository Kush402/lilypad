import { ASK_MAX_REPLY_BYTES, type AskSystemOneRequest } from '@lilypad/protocol';
import { config } from '../config.js';

/**
 * Forwarding one Ask step to TypeSafe on Lilypad's own credential
 * (ADR-0020).
 *
 * Plain `fetch` against one endpoint, as `resendMailer.ts` does and for the
 * same reason: this is a POST with three fields and a bearer, and an SDK to
 * save twenty lines is an SDK to patch forever.
 *
 * ### What this file is careful about
 *
 * It is the one place in Lilypad where a person's screen reading and
 * Lilypad's own billable credential are in the same function, so three rules
 * are load-bearing rather than tidy:
 *
 *  1. **The key is read here and referenced nowhere else.** It is never put
 *     on a reply, an error, a log line, or a metric label.
 *  2. **The request body is never logged, stored, or attached to an error.**
 *     Not at debug level, not on failure, not in a sampled trace. What the
 *     operator gets is a status, a duration and a reason — enough to run the
 *     service, and nothing a subpoena could turn into a screen recording.
 *  3. **The response is bounded before it is parsed.** An upstream that
 *     answers with a gigabyte must cost this process one buffer, not its
 *     heap.
 */

/** Bounded across response headers and the entire body, so a stalled stream
 *  cannot hold a device's step open. One step measured ~250 ms live; ten
 *  seconds is a failure, not slowness. */
const REQUEST_TIMEOUT_MS = 10_000;

/** The System One endpoint. One path, not a base a caller can steer. */
const PATH = '/v1/systemone';

export type AskUpstreamResult =
  | { ok: true; model: string; answers: Record<string, unknown> }
  | { ok: false; reason: 'unconfigured' }
  | { ok: false; reason: 'upstream'; status: number | null; detail: string };

/** Whether this deployment can serve hosted Ask at all. */
export function hostedAskConfigured(): boolean {
  return (config.env.TYPESAFE_SERVICE_API_KEY ?? '').trim().length > 0;
}

/**
 * One step, forwarded and answered.
 *
 * Never throws: every failure is a named reason, because the route above maps
 * reasons to sentences a person can act on and an exception would collapse
 * them all into "something went wrong".
 */
export async function askSystemOne(
  request: AskSystemOneRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<AskUpstreamResult> {
  const apiKey = (config.env.TYPESAFE_SERVICE_API_KEY ?? '').trim();
  if (apiKey.length === 0) return { ok: false, reason: 'unconfigured' };

  // Exactly the three fields TypeSafe is asked about, rebuilt rather than
  // forwarded wholesale. `taskId` is Lilypad's own accounting and has no
  // business at the upstream; spreading the validated object would have sent
  // it, and would send any field a future schema adds without anyone deciding
  // to.
  const body = JSON.stringify({
    model: request.model,
    state: request.state,
    questions: request.questions,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await fetchImpl(`${config.env.TYPESAFE_BASE_URL.replace(/\/+$/, '')}${PATH}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
        body,
        signal: controller.signal,
        // A redirect is a request to send the bearer somewhere else. Refuse it
        // rather than follow it — the desktop's own client takes the same line
        // (`agent/llm/http.rs`, L-275).
        redirect: 'manual',
      });
    } catch (err) {
      // The error type is the transport's, never a returned body. Keep the
      // timer's own reason distinct from an ordinary connection failure.
      return {
        ok: false,
        reason: 'upstream',
        status: null,
        detail: controller.signal.aborted
          ? 'timeout'
          : err instanceof Error
            ? err.name
            : 'transport',
      };
    }

    if (res.status >= 300 && res.status < 400) {
      return { ok: false, reason: 'upstream', status: res.status, detail: 'redirect refused' };
    }

    let raw: string | null;
    try {
      raw = await readBounded(res);
    } catch {
      // A failed stream can reject after headers arrived. Neither that
      // rejection nor an abort may escape as a route-level 500.
      return {
        ok: false,
        reason: 'upstream',
        status: res.status,
        detail: controller.signal.aborted ? 'timeout' : 'reply unreadable',
      };
    }
    if (raw === null) {
      return { ok: false, reason: 'upstream', status: res.status, detail: 'reply too large' };
    }
    if (!res.ok) {
      // TypeSafe's own error text is deliberately dropped. It is written for
      // whoever holds the account — which is Lilypad, not the caller — and it
      // is exactly the sort of string that quotes back what was sent.
      return { ok: false, reason: 'upstream', status: res.status, detail: 'refused' };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ok: false, reason: 'upstream', status: res.status, detail: 'malformed reply' };
    }
    const reply = parsed as { model?: unknown; answers?: unknown };
    if (typeof reply.model !== 'string' || !isPlainObject(reply.answers)) {
      return {
        ok: false,
        reason: 'upstream',
        status: res.status,
        detail: 'unexpected reply shape',
      };
    }
    return { ok: true, model: reply.model, answers: reply.answers };
  } finally {
    clearTimeout(timer);
  }
}

/** The body, or null if it exceeds what a step's answers can plausibly be.
 *  Streamed so an oversized reply is abandoned rather than buffered whole. */
async function readBounded(res: Response): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return await res.text();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      size += value.byteLength;
      if (size > ASK_MAX_REPLY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
