import { z } from 'zod';

/** Increment when older peers cannot disclose or enforce the same authority. */
export const ASK_PROTOCOL_VERSION = 2 as const;

/**
 * AI-agent protocol — carried over the SAME WebRTC DataChannel as input
 * (`input.ts`), but as its own message kinds. The agent runs on the desktop;
 * the phone dispatches a command, watches a step feed, and answers holds.
 *
 * Design rules (see docs/m5.3-ai-executor-plan.md):
 *   • phone → desktop: `agent_command`, `agent_stop`, `agent_decision`
 *   • desktop → phone: `agent_step`, `agent_run_end`
 *   • every message is timestamped (`ts`, ms since epoch on the sender), same
 *     convention as input events
 *   • all free-text fields are bounded — this is the only validation boundary
 *     an over-the-wire agent payload passes before either side acts on it,
 *     mirroring `input.ts`'s `MAX_TEXT_INPUT_LEN` reasoning
 */

/** A natural-language task fits comfortably; bounded against pathological
 * payloads, same spirit as `input.ts`'s text caps. */
const MAX_COMMAND_LEN = 4 * 1024;
/** A human-readable one-line step summary for the phone feed. */
const MAX_SUMMARY_LEN = 512;
/** A run/step identifier minted by the sender (uuid-ish); never trusted for
 * anything but correlation, so a generous opaque-string cap is enough. */
const MAX_ID_LEN = 128;
/** The exact script source travels to the phone so the approval card can show
 * what will actually run. Generous for a real model-written script, bounded so
 * one frame cannot be unbounded. */
const MAX_SCRIPT_LEN = 8 * 1024;
/** One filesystem path on an approval card. */
const MAX_PATH_LEN = 1024;
/** How many extra writable paths one approval may disclose. */
const MAX_WRITABLE_PATHS = 32;

const WithTs = z.object({
  ts: z.number().int().nonnegative(),
});

const RunId = z.string().min(1).max(MAX_ID_LEN);
const StepId = z.string().min(1).max(MAX_ID_LEN);

/** Which executor tier produced/backs a step. Ordered cheap → expensive:
 * `skill` (deterministic OS command) · `sandbox` (model-generated code run
 * under Seatbelt) · `ax` (accessibility-tree action) · `vision` (pixel
 * fallback). */
export const AgentTierSchema = z.enum(['skill', 'sandbox', 'ax', 'vision']);
export type AgentTier = z.infer<typeof AgentTierSchema>;

/**
 * Security classification of a proposed action — the deterministic gate's
 * verdict (see `security.rs`). The phone renders it; it does NOT decide policy
 * (the desktop does), it only reflects it.
 */
export const ToolClassSchema = z.enum(['safe', 'sensitive', 'consequential', 'forbidden']);
export type ToolClass = z.infer<typeof ToolClassSchema>;

/** What a step is. */
export const StepKindSchema = z.enum(['thinking', 'action', 'result', 'error']);
export type StepKind = z.infer<typeof StepKindSchema>;

/** Lifecycle of a step as the phone should render it. `held` means the desktop
 * is blocked awaiting an `agent_decision`. */
export const StepStateSchema = z.enum(['proposed', 'held', 'running', 'done', 'denied', 'failed']);
export type StepState = z.infer<typeof StepStateSchema>;

/** Terminal outcome of a whole run.
 *
 * `needs_input` is distinct from `failed`: nothing went wrong, the assistant
 * asked a question or needs something it cannot get on its own. Collapsing it
 * into `completed` is what let a refusal render as success (L-235). */
export const RunOutcomeSchema = z.enum(['completed', 'stopped', 'denied', 'failed', 'needs_input']);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

// ── phone → desktop ────────────────────────────────────────────────────────

const agentCommand = WithTs.extend({
  kind: z.literal('agent_command'),
  runId: RunId,
  /** The natural-language task. */
  text: z.string().min(1).max(MAX_COMMAND_LEN),
  protocolVersion: z.literal(ASK_PROTOCOL_VERSION).optional(),
});

const agentHello = WithTs.extend({ kind: z.literal('agent_hello'), runId: RunId });
const agentReady = WithTs.extend({
  kind: z.literal('agent_ready'),
  runId: RunId,
  protocolVersion: z.literal(ASK_PROTOCOL_VERSION),
});

const agentStop = WithTs.extend({
  kind: z.literal('agent_stop'),
  runId: RunId,
});

const agentDecision = WithTs.extend({
  kind: z.literal('agent_decision'),
  runId: RunId,
  stepId: StepId,
  /** Answer to a `held` (consequential) step. */
  approve: z.boolean(),
});

// ── desktop → phone ──────────────────────────────────────────────────────────

/**
 * What a `held` step is actually asking permission for.
 *
 * The summary alone ("Run shell script") is the same sentence for a script
 * that lists a directory and one that uploads it, so a card built from it is
 * not an informed decision. Everything the desktop is about to *grant* travels
 * with the hold instead: the source, the extra writable paths, the files the
 * script is allowed to read, network access, and for an accessibility press
 * the exact control.
 */
export const AgentApprovalSchema = z.object({
  /** One line naming the effect, e.g. "Run a shell script". */
  purpose: z.string().max(MAX_SUMMARY_LEN),
  /** Present for script steps: exactly what will run. */
  script: z
    .object({
      language: z.string().max(32),
      source: z.string().max(MAX_SCRIPT_LEN),
    })
    .optional(),
  /** Locations the action may write to beyond its own scratch directory. */
  writablePaths: z.array(z.string().max(MAX_PATH_LEN)).max(MAX_WRITABLE_PATHS),
  /**
   * Files and folders the action may read.
   *
   * The sandbox denies the rest of the user's home, so this list is the whole
   * of what a script can see of their files — and reading is disclosure, not a
   * lesser sibling of writing: a sandboxed script's stdout is folded back into
   * the model prompt and sent to the provider. Optional on the wire so a
   * desktop that predates read grants still parses; absent means "not
   * disclosed", which the phone must not render as "reads nothing".
   */
  readablePaths: z.array(z.string().max(MAX_PATH_LEN)).max(MAX_WRITABLE_PATHS).optional(),
  /** Whether outbound network access is granted. */
  network: z.boolean(),
  /** Present for accessibility presses: the control that will be pressed. */
  target: z
    .object({
      role: z.string().max(MAX_PATH_LEN),
      label: z.string().max(MAX_PATH_LEN),
    })
    .optional(),
});
export type AgentApproval = z.infer<typeof AgentApprovalSchema>;

const agentStep = WithTs.extend({
  kind: z.literal('agent_step'),
  runId: RunId,
  stepId: StepId,
  step: StepKindSchema,
  /** Human-readable one-liner for the feed. */
  summary: z.string().max(MAX_SUMMARY_LEN),
  /** Present for `action` steps; omitted for pure `thinking`. */
  tier: AgentTierSchema.optional(),
  /** The gate's classification; present for `action` steps. */
  class: ToolClassSchema.optional(),
  state: StepStateSchema,
  /** Present only on a `held` step: the structured disclosure the approval
   * card renders. Optional so an older desktop still parses. */
  approval: AgentApprovalSchema.optional(),
});

const agentRunEnd = WithTs.extend({
  kind: z.literal('agent_run_end'),
  runId: RunId,
  outcome: RunOutcomeSchema,
});

// ── unions ───────────────────────────────────────────────────────────────────

/** Messages the phone sends to the desktop agent. */
export const AgentInboundSchema = z.discriminatedUnion('kind', [
  agentHello,
  agentCommand,
  agentStop,
  agentDecision,
]);
export type AgentInbound = z.infer<typeof AgentInboundSchema>;

/** Messages the desktop agent sends to the phone. */
export const AgentOutboundSchema = z.discriminatedUnion('kind', [
  agentReady,
  agentStep,
  agentRunEnd,
]);
export type AgentOutbound = z.infer<typeof AgentOutboundSchema>;

/** Every agent message, either direction — for a single DataChannel demux. */
export const AgentMessageSchema = z.discriminatedUnion('kind', [
  agentHello,
  agentCommand,
  agentStop,
  agentDecision,
  agentReady,
  agentStep,
  agentRunEnd,
]);
export type AgentMessage = z.infer<typeof AgentMessageSchema>;

export type AgentCommand = z.infer<typeof agentCommand>;
export type AgentStop = z.infer<typeof agentStop>;
export type AgentDecision = z.infer<typeof agentDecision>;
export type AgentStep = z.infer<typeof agentStep>;
export type AgentRunEnd = z.infer<typeof agentRunEnd>;

export function encodeAgentMessage(msg: AgentMessage): string {
  return JSON.stringify(msg);
}
