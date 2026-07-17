/**
 * Press-and-hold auto-repeat for toolbar buttons where held-repeat is a
 * meaningful, expected interaction (arrow keys, Tab) — unlike a real
 * physical key, a single `Pressable` tap only ever fires once. Deliberately
 * NOT applied to every toolbar entry: repeated Copy/Paste/Undo/Redo on a
 * long-press would be actively harmful, so callers opt a button in
 * individually. See `docs/audit/m3/input-touch.md` Finding 14.
 */

/** Delay before the first repeat kicks in — long enough that a normal tap
 * (press then immediate release) never triggers a second fire. */
export const PRESS_REPEAT_INITIAL_DELAY_MS = 400;
/** Steady-state repeat rate once held past the initial delay. */
export const PRESS_REPEAT_INTERVAL_MS = 70;

export class PressRepeater {
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly fire: () => void) {}

  /** Call on `onPressIn`. Fires once immediately (the tap itself), then
   * starts repeating after `PRESS_REPEAT_INITIAL_DELAY_MS` if still held. */
  start(): void {
    this.stop();
    this.fire();
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.repeatTimer = setInterval(() => this.fire(), PRESS_REPEAT_INTERVAL_MS);
    }, PRESS_REPEAT_INITIAL_DELAY_MS);
  }

  /** Call on `onPressOut` (and on unmount). Idempotent. */
  stop(): void {
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
    if (this.repeatTimer) {
      clearInterval(this.repeatTimer);
      this.repeatTimer = null;
    }
  }
}
