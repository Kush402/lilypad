import {
  encodeInputBatch,
  POINTER_COALESCE_MS,
  type InputEvent,
  type Modifier,
  type PointerButton,
} from '@lilypad/protocol';

type ShortcutAction = Extract<InputEvent, { kind: 'shortcut' }>['action'];

/**
 * Maximum DataChannel backlog before input backpressure kicks in. Disposable
 * move/scroll batches are dropped above this point; critical input stays
 * queued until the reliable channel drains.
 */
export const MAX_BUFFERED_AMOUNT_BYTES = 64 * 1024;

export type InputSenderFn = (data: string) => void;
export type DataChannelBackpressureRef = { bufferedAmount?: number | null };

/**
 * Buffers input events and sends them over the DataChannel(s). Pointer moves
 * and scroll deltas are coalesced (batched, ~120Hz cap) and routed onto the
 * unreliable move channel (loss-tolerant — the next update always supersedes
 * a dropped one); everything else flushes immediately onto the critical
 * (ordered + reliable) channel, per the input-protocol spec. Coordinates are
 * normalized 0..1 by the caller.
 *
 * The two kinds are queued and flushed independently (never combined into
 * one wire frame) so each can go out on its own channel — see
 * `docs/audit/m3/input-touch.md` Finding 2.
 */
export class InputSender {
  private criticalQueue: InputEvent[] = [];
  private moveQueue: InputEvent[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  /** The unreliable move channel's send callback, wired in once that
   * DataChannel opens (`ViewerConnection`). `null` until then, or forever if
   * the peer never negotiated it — falls back to the critical channel, so
   * pointer moves/scroll still work, just without the loss tolerance. */
  private moveSend: InputSenderFn | null = null;
  /** References used for DataChannel backpressure checks. */
  private moveChannelRef: DataChannelBackpressureRef | null = null;
  private criticalChannelRef: DataChannelBackpressureRef | null = null;
  /** Monotonic per-session ordering counter. The desktop dispatcher orders
   * and dedups on this, NOT on `ts` — `ts` (wall clock) can step backward
   * mid-session and permanently wedge the input stream. One `InputSender`
   * lives per session, so this resets naturally on reconnect. See
   * `docs/audit/m3/input-touch.md` Finding 8. */
  private seq = 0;

  constructor(private readonly sendCritical: InputSenderFn) {}

  /** Wire (or clear, on close) the unreliable move channel's send callback. */
  setMoveChannel(
    send: InputSenderFn | null,
    channelRef: DataChannelBackpressureRef | null = null,
  ): void {
    this.moveSend = send;
    this.moveChannelRef = channelRef;
  }

  setCriticalChannelRef(ref: DataChannelBackpressureRef | null): void {
    this.criticalChannelRef = ref;
  }

  private isBackedUp(ref: DataChannelBackpressureRef | null): boolean {
    const bufferedAmount = ref?.bufferedAmount;
    return typeof bufferedAmount === 'number' && bufferedAmount > MAX_BUFFERED_AMOUNT_BYTES;
  }

  private stamp(): { ts: number; seq: number } {
    this.seq += 1;
    return { ts: Date.now(), seq: this.seq };
  }

  private enqueue(ev: InputEvent, immediate: boolean, disposable: boolean): void {
    if (disposable) {
      this.moveQueue.push(ev);
    } else {
      this.criticalQueue.push(ev);
    }
    if (immediate) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), POINTER_COALESCE_MS);
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.moveQueue.length > 0) {
      const batch = encodeInputBatch(this.moveQueue);
      if (this.moveSend) {
        if (!this.isBackedUp(this.moveChannelRef)) {
          this.moveSend(batch);
        }
        this.moveQueue = [];
      } else {
        if (!this.isBackedUp(this.criticalChannelRef)) {
          this.sendCritical(batch);
        }
        this.moveQueue = [];
      }
    }
    if (this.criticalQueue.length > 0) {
      if (this.isBackedUp(this.criticalChannelRef)) {
        return;
      }
      this.sendCritical(encodeInputBatch(this.criticalQueue));
      this.criticalQueue = [];
    }
  }

  pointerMove(x: number, y: number): void {
    this.enqueue({ kind: 'pointer_move', x, y, ...this.stamp() }, false, true);
  }
  pointerDown(
    x: number,
    y: number,
    button: PointerButton = 'left',
    modifiers: Modifier[] = [],
  ): void {
    this.enqueue({ kind: 'pointer_down', x, y, button, modifiers, ...this.stamp() }, true, false);
  }
  pointerUp(
    x: number,
    y: number,
    button: PointerButton = 'left',
    modifiers: Modifier[] = [],
  ): void {
    this.enqueue({ kind: 'pointer_up', x, y, button, modifiers, ...this.stamp() }, true, false);
  }
  click(
    x: number,
    y: number,
    button: PointerButton = 'left',
    count = 1,
    modifiers: Modifier[] = [],
  ): void {
    this.enqueue({ kind: 'click', x, y, button, count, modifiers, ...this.stamp() }, true, false);
  }
  /** Coalesced like `pointerMove` (docs/audit/m3/input-touch.md Finding 11)
   * — a fast two-finger scroll fires roughly once per touch-move frame, and
   * flushing every delta immediately would defeat the disposable channel's
   * point (each new delta already supersedes the last one visually). */
  scroll(x: number, y: number, dx: number, dy: number): void {
    this.enqueue({ kind: 'scroll', x, y, dx, dy, ...this.stamp() }, false, true);
  }
  keyDown(code: string, modifiers: Modifier[] = []): void {
    this.enqueue(
      { kind: 'key_down', code, modifiers, repeat: false, ...this.stamp() },
      true,
      false,
    );
  }
  keyUp(code: string, modifiers: Modifier[] = []): void {
    this.enqueue({ kind: 'key_up', code, modifiers, ...this.stamp() }, true, false);
  }
  text(text: string): void {
    this.enqueue({ kind: 'text_input', text, ...this.stamp() }, true, false);
  }
  shortcut(action: ShortcutAction): void {
    this.enqueue({ kind: 'shortcut', action, ...this.stamp() }, true, false);
  }
}
