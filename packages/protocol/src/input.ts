import { z } from 'zod';

/**
 * Input protocol — carried over the WebRTC DataChannel, phone → desktop.
 *
 * Design rules (see docs/input-protocol.md):
 *   • pointer_move events are COALESCED on the sender (batched, ~120Hz cap)
 *   • pointer down/up, clicks, keys, and shortcuts are sent IMMEDIATELY
 *   • every event is timestamped (`ts`, ms since epoch on the sender)
 *   • coordinates are normalized 0..1 relative to the streamed frame, so they
 *     survive resolution/DPR differences between phone and laptop
 */

const NormCoord = z.number().min(0).max(1);

// Input events travel peer-to-peer over the DataChannel, never through the
// backend — these bounds are the only validation boundary a malformed or
// hostile payload passes through before the desktop acts on it. Mirrors the
// same defense-in-depth pattern already applied to signaling-message string
// fields (`signaling.ts`'s `MAX_SDP_LEN`/`MAX_CANDIDATE_LEN`/etc.). See
// `docs/audit/m3/backend-security.md` Finding 9.
/** A `text_input` event carries one typed increment (a few keystrokes, or an
 * IME/autocomplete commit) — generous relative to that, not a whole-document
 * paste ceiling. */
const MAX_TEXT_INPUT_LEN = 8 * 1024;
/** Matches `signaling.ts`'s `MAX_CLIPBOARD_LEN` (the desktop→phone
 * direction's cap) for the same reasoning: generous for a real clipboard
 * paste, bounded against pathological payloads. */
const MAX_CLIPBOARD_TEXT_LEN = 64 * 1024;

/**
 * Ordering/staleness metadata mixed into every event.
 *
 *  • `ts` — milliseconds since epoch on the sender. For latency measurement,
 *    logging, telemetry ONLY. It is wall-clock and can step backward (NTP
 *    resync, sleep/resume), so it must NOT drive correctness decisions.
 *  • `seq` — a monotonic per-session counter (starts at 1, one `InputSender`
 *    instance per session). This is the ordering/dedup discriminant the
 *    desktop dispatcher uses. Optional on the wire for backward-compatible
 *    decode (a pre-v2 sender omits it, and the desktop falls back to `ts`);
 *    every current sender always stamps it. See
 *    `docs/audit/m3/input-touch.md` Finding 8.
 */
const WithTs = z.object({
  ts: z.number().int().nonnegative(),
  seq: z.number().int().nonnegative().optional(),
});

export const PointerButtonSchema = z.enum(['left', 'right', 'middle']);
export type PointerButton = z.infer<typeof PointerButtonSchema>;

/** Named modifier keys, OS-agnostic (desktop maps cmd/ctrl per platform). */
export const ModifierSchema = z.enum(['ctrl', 'alt', 'shift', 'meta']);
export type Modifier = z.infer<typeof ModifierSchema>;

const pointerMove = WithTs.extend({
  kind: z.literal('pointer_move'),
  x: NormCoord,
  y: NormCoord,
});

const pointerDown = WithTs.extend({
  kind: z.literal('pointer_down'),
  x: NormCoord,
  y: NormCoord,
  button: PointerButtonSchema.default('left'),
  /** Modifiers held during the press — enables Cmd-click, Shift-click, etc.
   * (`docs/audit/m3/input-touch.md` Finding 5). */
  modifiers: z.array(ModifierSchema).default([]),
});

const pointerUp = WithTs.extend({
  kind: z.literal('pointer_up'),
  x: NormCoord,
  y: NormCoord,
  button: PointerButtonSchema.default('left'),
  modifiers: z.array(ModifierSchema).default([]),
});

const click = WithTs.extend({
  kind: z.literal('click'),
  x: NormCoord,
  y: NormCoord,
  button: PointerButtonSchema.default('left'),
  /** 1 = single, 2 = double, 3 = triple. */
  count: z.number().int().min(1).max(3).default(1),
  modifiers: z.array(ModifierSchema).default([]),
});

const scroll = WithTs.extend({
  kind: z.literal('scroll'),
  x: NormCoord,
  y: NormCoord,
  /** Wheel deltas in CSS pixels; positive dy scrolls content down. */
  dx: z.number(),
  dy: z.number(),
});

const keyDown = WithTs.extend({
  kind: z.literal('key_down'),
  /** Physical key per the UI Events `code` set, e.g. "KeyA", "Enter", "Tab". */
  code: z.string().min(1),
  modifiers: z.array(ModifierSchema).default([]),
  repeat: z.boolean().default(false),
});

const keyUp = WithTs.extend({
  kind: z.literal('key_up'),
  code: z.string().min(1),
  modifiers: z.array(ModifierSchema).default([]),
});

const textInput = WithTs.extend({
  kind: z.literal('text_input'),
  /** Committed text (IME/autocorrect friendly), typed as a unit. */
  text: z.string().max(MAX_TEXT_INPUT_LEN),
});

const shortcut = WithTs.extend({
  kind: z.literal('shortcut'),
  /** Semantic dev shortcut from the mobile toolbar. */
  action: z.enum([
    'copy',
    'paste',
    'cut',
    'undo',
    'redo',
    'select_all',
    'save',
    'escape',
    'tab',
    'enter',
    'arrow_up',
    'arrow_down',
    'arrow_left',
    'arrow_right',
  ]),
});

const clipboard = WithTs.extend({
  kind: z.literal('clipboard'),
  /** Set the desktop clipboard to this text (phone → desktop paste bridge). */
  text: z.string().max(MAX_CLIPBOARD_TEXT_LEN),
});

export const InputEventSchema = z.discriminatedUnion('kind', [
  pointerMove,
  pointerDown,
  pointerUp,
  click,
  scroll,
  keyDown,
  keyUp,
  textInput,
  shortcut,
  clipboard,
]);
export type InputEvent = z.infer<typeof InputEventSchema>;

/** DataChannel frames may batch coalesced events; one envelope per send. */
export const InputBatchSchema = z.object({
  kind: z.literal('input_batch'),
  events: z.array(InputEventSchema).min(1),
});
export type InputBatch = z.infer<typeof InputBatchSchema>;

export function encodeInputBatch(events: InputEvent[]): string {
  return JSON.stringify({ kind: 'input_batch', events } satisfies InputBatch);
}
