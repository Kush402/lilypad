import { z } from 'zod';

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

/** Terminal outcome of a whole run. */
export const RunOutcomeSchema = z.enum(['completed', 'stopped', 'denied', 'failed']);
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;

// ── phone → desktop ────────────────────────────────────────────────────────

const agentCommand = WithTs.extend({
  kind: z.literal('agent_command'),
  runId: RunId,
  /** The natural-language task. */
  text: z.string().min(1).max(MAX_COMMAND_LEN),
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
});

const agentRunEnd = WithTs.extend({
  kind: z.literal('agent_run_end'),
  runId: RunId,
  outcome: RunOutcomeSchema,
});

// ── unions ───────────────────────────────────────────────────────────────────

/** Messages the phone sends to the desktop agent. */
export const AgentInboundSchema = z.discriminatedUnion('kind', [
  agentCommand,
  agentStop,
  agentDecision,
]);
export type AgentInbound = z.infer<typeof AgentInboundSchema>;

/** Messages the desktop agent sends to the phone. */
export const AgentOutboundSchema = z.discriminatedUnion('kind', [agentStep, agentRunEnd]);
export type AgentOutbound = z.infer<typeof AgentOutboundSchema>;

/** Every agent message, either direction — for a single DataChannel demux. */
export const AgentMessageSchema = z.discriminatedUnion('kind', [
  agentCommand,
  agentStop,
  agentDecision,
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
