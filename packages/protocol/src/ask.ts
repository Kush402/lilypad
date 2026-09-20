import { z } from 'zod';

/**
 * The hosted System One route — Ask running on Lilypad's own account
 * ([ADR-0020](../../../docs/adr/0020-lilypad-runs-computer-use-on-its-own-account.md)).
 *
 * Two ways of running Ask share one loop and differ only in who pays and
 * where the request goes:
 *
 *   - **your own key**: the Mac holds a TypeSafe key and posts straight to
 *     TypeSafe. Nothing here is involved, and no subscription is needed.
 *   - **Lilypad**: the Mac holds no key at all and posts *this* shape to the
 *     control plane on its device token. The backend checks entitlement,
 *     counts the task, and forwards to TypeSafe on Lilypad's credential —
 *     which never leaves the server.
 *
 * So this schema exists to make the second path a wire contract rather than
 * an opaque tunnel. A pass-through that accepted any JSON would mean the
 * backend could not state a size bound, could not refuse a payload category
 * ADR-0020 says never travels, and could not be reviewed against the privacy
 * page. Every field below is one the desktop already builds for the direct
 * path, so the two requests are the same request with a different envelope.
 *
 * What is deliberately absent: anything that could carry a screenshot, a
 * field's contents, or a credential. `state` and `questions` are strings the
 * desktop composed from control roles and labels, and the schema's own limits
 * are what stop an image arriving base64-encoded in one of them.
 */

/** Longest single string anywhere in a request. A control label, a question's
 *  instructions, one history line — all well under this; a data URL is not. */
const MAX_TEXT = 1_000;
/** Most questions one step may ask. The desktop asks at most one `done`, one
 *  `step`, one per candidate control (8), plus text/key/direction/app. */
export const ASK_MAX_QUESTIONS = 24;
/** Most options one `choice` question may offer. */
export const ASK_MAX_CRITERIA = 64;
/** Most keys the state may describe, and most lines in a list-valued one. */
const MAX_STATE_KEYS = 16;
const MAX_STATE_LINES = 64;

/**
 * Bytes of JSON the hosted route will accept in one step, and accept back
 * from TypeSafe.
 *
 * Fastify's default body limit is 1 MiB, which is three orders of magnitude
 * more than a step needs and exactly the room a screenshot would want. The
 * schema above bounds each field; this bounds the whole, so a request with
 * thousands of legal little strings is refused before it is parsed.
 */
export const ASK_MAX_REQUEST_BYTES = 128 * 1024;
export const ASK_MAX_REPLY_BYTES = 128 * 1024;

/** One question, in the two shapes the System One API documents and the two
 *  the desktop actually builds. */
export const AskQuestionSchema = z.discriminatedUnion('type', [
  z
    .object({
      /** A yes/no question. The answer is a probability. */
      type: z.literal('noul'),
      instructions: z.string().min(1).max(MAX_TEXT),
    })
    .strict(),
  z
    .object({
      /** Pick one of `criteria`. The answer names the option and its odds. */
      type: z.literal('choice'),
      instructions: z.string().min(1).max(MAX_TEXT),
      /** Option id → what it means, or null when the id speaks for itself (an
       *  application name). */
      criteria: z
        .record(z.string().min(1).max(128), z.string().max(MAX_TEXT).nullable())
        .refine((c) => Object.keys(c).length <= ASK_MAX_CRITERIA, {
          message: `at most ${ASK_MAX_CRITERIA} criteria`,
        }),
    })
    .strict(),
]);
export type AskQuestion = z.infer<typeof AskQuestionSchema>;

/**
 * Desktop → backend, one step of one task.
 *
 * `taskId` is what makes the daily allowance count tasks rather than steps
 * (ADR-0020): every step of one run carries the same id, and the backend
 * spends one of the day's tasks on the first step it sees for that id. It is
 * opaque to the backend and is never joined to anything but a counter.
 */
export const AskSystemOneRequestSchema = z
  .object({
    /** Opaque per-run id, stable across the run's steps. */
    taskId: z.string().min(8).max(64),
    /** The pinned System One model. Echoed by the reply; the Mac refuses an
     *  answer from a different one, because thresholds are per version. */
    model: z.string().min(1).max(64),
    /** What the model is told about the screen: the command, the app in front,
     *  what has focus, what is selected, the control roles and labels, and
     *  Lilypad's own one-line summaries of the steps so far. Strings only. */
    state: z
      .record(
        z.string().min(1).max(64),
        z.union([z.string().max(MAX_TEXT), z.array(z.string().max(MAX_TEXT)).max(MAX_STATE_LINES)]),
      )
      .refine((s) => Object.keys(s).length <= MAX_STATE_KEYS, {
        message: `at most ${MAX_STATE_KEYS} state keys`,
      }),
    questions: z
      .record(z.string().min(1).max(64), AskQuestionSchema)
      .refine((q) => Object.keys(q).length >= 1 && Object.keys(q).length <= ASK_MAX_QUESTIONS, {
        message: `between 1 and ${ASK_MAX_QUESTIONS} questions`,
      }),
  })
  // STRICT, not stripping. zod's default would quietly drop an unknown field
  // and hand the handler a clean object — so a desktop that started sending
  // `screenshot` would be accepted by a server that believed it carried no
  // pixels, and nothing would say otherwise. A field nobody designed is a
  // field nobody disclosed on the privacy page; refuse it and find out.
  .strict();
export type AskSystemOneRequest = z.infer<typeof AskSystemOneRequestSchema>;

/**
 * Backend → desktop.
 *
 * `answers` is passed through exactly as TypeSafe returned it, because the
 * calibrated numbers in it are the whole product of the call and the Mac
 * already parses them tolerantly for the direct path. `allowance` is the only
 * thing the control plane adds, and it is the counter it just spent — so a
 * Mac can say "3 of today's 25" without a second round trip.
 */
export const AskAllowanceSchema = z.object({
  /** Tasks spent today, including this one. */
  used: z.number().int().min(0),
  /** Tasks allowed per UTC day. */
  limit: z.number().int().min(0),
  /** When the count returns to zero — the next UTC midnight, ISO-8601. */
  resetsAt: z.string().datetime({ offset: true }),
});
export type AskAllowance = z.infer<typeof AskAllowanceSchema>;

export const AskSystemOneReplySchema = z.object({
  model: z.string().min(1).max(64),
  answers: z.record(z.string(), z.unknown()),
  allowance: AskAllowanceSchema,
});
export type AskSystemOneReply = z.infer<typeof AskSystemOneReplySchema>;

/**
 * Backend → desktop, before the hosted choice can be selected.
 *
 * Configuration and entitlement are deliberately separate facts. A paying
 * account on a deployment whose service credential is missing must not be
 * told to buy Pro again, and an unconfigured deployment must not query (or
 * accidentally disclose) the account's billing state just to explain its own
 * outage.
 */
export const HostedAskAccessSchema = z.enum(['entitled', 'not_entitled', 'no_such_account']);
export type HostedAskAccess = z.infer<typeof HostedAskAccessSchema>;

export const HostedAskStatusSchema = z.discriminatedUnion('configured', [
  z.object({ configured: z.literal(false) }).strict(),
  z
    .object({
      configured: z.literal(true),
      access: HostedAskAccessSchema,
    })
    .strict(),
]);
export type HostedAskStatus = z.infer<typeof HostedAskStatusSchema>;

/**
 * Why a hosted step was refused, as the Mac reads it.
 *
 * Named rather than inferred from the status, for the same reason
 * `AgentReadiness` is: the sentence a person should see differs per reason,
 * and "402" does not say whether to subscribe, wait until tomorrow, or add a
 * key of their own.
 */
export const AskRefusalSchema = z.enum([
  /** No subscription. Pro or Team only. */
  'not_entitled',
  /** Today's 25 tasks are spent. */
  'daily_limit',
  /** One task asked for more steps than any task needs. */
  'task_step_limit',
  /** This deployment has no System One credential configured. */
  'unconfigured',
  /** TypeSafe refused or did not answer in time. */
  'upstream',
]);
export type AskRefusal = z.infer<typeof AskRefusalSchema>;
