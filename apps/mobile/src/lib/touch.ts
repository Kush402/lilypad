import { TOUCH_SETTLE_MS, TOUCH_SETTLE_RADIUS_PX, LONG_PRESS_MS } from '@lilypad/protocol';
import { IDENTITY_VIEWPORT, type Viewport } from './viewport';

/**
 * Pure, dependency-free touch interpretation for the viewer. It owns every
 * "what does this gesture mean" decision so the decision logic is unit-testable
 * without React Native, a device, or a gesture library — `ViewerScreen` is a
 * thin wiring layer that feeds it raw container-space touches and turns the
 * emitted intents into `InputSender` calls.
 *
 * It implements four Phase-5 input findings from `docs/audit/m3/input-touch.md`:
 *
 *  • Finding 1 — coordinates are mapped onto the *letterboxed* video content
 *    rect (`objectFit: 'contain'`), not the raw view. Touches in the black
 *    bars are dropped, not mapped to phantom clicks on the Mac.
 *  • Finding 7 — a short settle window re-anchors the touch point during
 *    initial finger jitter, and a press only commits as a click on release
 *    (at the stable anchor) or as a drag once real movement crosses a
 *    threshold — never at the jittery first-contact pixel.
 *  • Finding 5 — a sustained still press becomes a right-click (context menu).
 *  • Finding 6 — a two-finger gesture is a scroll (centroid deltas), mutually
 *    exclusive with the single-finger cursor drag.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** A touch position in container (view) points. */
export interface TouchSample {
  x: number;
  y: number;
}

export type PointerButton = 'left' | 'right';

/** High-level gesture outcomes. Coordinates on pointer/click intents are
 * already normalized 0..1 within the video content rect; scroll `x`/`y` are
 * the normalized centroid, `dx`/`dy` are pixel deltas.
 *
 * `pinch`/`pan`/`zoom_reset` are VIEW-LOCAL: they steer the phone-side zoom
 * viewport (see `viewport.ts`) and are never sent to the desktop. Their
 * coordinates/deltas are raw screen points, since that's the space the
 * viewport transform lives in. */
export type TouchIntent =
  | { kind: 'pointer_down'; x: number; y: number }
  | { kind: 'pointer_move'; x: number; y: number }
  | { kind: 'pointer_up'; x: number; y: number }
  | { kind: 'click'; x: number; y: number; button: PointerButton; count: number }
  | { kind: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { kind: 'pinch'; ratio: number; cx: number; cy: number }
  | { kind: 'pan'; dx: number; dy: number }
  | { kind: 'zoom_reset' };

/**
 * Standard "contain" fit: the largest centered rect with the video's aspect
 * ratio that fits inside the container. When the source size is unknown
 * (before the first `frame-size` signal), callers pass the container size as
 * the video size, yielding a full-bleed rect — i.e. today's pre-fix behavior,
 * the documented graceful fallback.
 */
export function computeContentRect(container: Vec2, video: Vec2): Rect {
  if (container.x <= 0 || container.y <= 0 || video.x <= 0 || video.y <= 0) {
    return { x: 0, y: 0, w: Math.max(0, container.x), h: Math.max(0, container.y) };
  }
  const scale = Math.min(container.x / video.x, container.y / video.y);
  const w = video.x * scale;
  const h = video.y * scale;
  return { x: (container.x - w) / 2, y: (container.y - h) / 2, w, h };
}

/**
 * Map a container-space point onto normalized 0..1 coordinates within the
 * content rect. Returns `null` for points outside the rect (the letterbox
 * bars) so the caller can drop them instead of forwarding a phantom click.
 */
export function toContentNorm(point: TouchSample, rect: Rect): Vec2 | null {
  if (rect.w <= 0 || rect.h <= 0) return null;
  const nx = (point.x - rect.x) / rect.w;
  const ny = (point.y - rect.y) / rect.h;
  if (nx < 0 || nx > 1 || ny < 0 || ny > 1) return null;
  return { x: nx, y: ny };
}

/** Same mapping but clamped into [0,1] rather than dropped — used mid-drag so
 * a finger straying into a letterbox bar pins the cursor to the edge instead
 * of freezing the drag. */
function toContentNormClamped(point: TouchSample, rect: Rect): Vec2 {
  if (rect.w <= 0 || rect.h <= 0) return { x: 0, y: 0 };
  return {
    x: clamp01((point.x - rect.x) / rect.w),
    y: clamp01((point.y - rect.y) / rect.h),
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function dist(a: TouchSample, b: TouchSample): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(touches: TouchSample[]): TouchSample {
  const n = touches.length || 1;
  let sx = 0;
  let sy = 0;
  for (const t of touches) {
    sx += t.x;
    sy += t.y;
  }
  return { x: sx / n, y: sy / n };
}

type Phase =
  | 'idle'
  /** One finger down, not yet a drag/click/right-click. */
  | 'pressing'
  /** One finger, committed to a drag (pointer_down sent). */
  | 'dragging'
  /** One finger panning the viewport (zoom-lock mode only). */
  | 'view_panning'
  /** Two fingers down, not yet classified as pinch vs. scroll/pan. */
  | 'two_finger'
  /** Two fingers, pinch-zooming the viewport. */
  | 'pinching'
  /** Two fingers, panning the zoomed viewport. */
  | 'panning'
  /** Two fingers, scrolling. */
  | 'scrolling'
  /** Gesture resolved (right-click fired, or scroll started then a finger
   * lifted) — swallow the rest until all fingers are up. */
  | 'consumed';

export interface TouchTuning {
  settleMs: number;
  radiusPx: number;
  longPressMs: number;
  /** Inter-finger distance must change by this many px before a two-finger
   * gesture commits to being a pinch. */
  pinchClassifyPx: number;
  /** Two-finger centroid must travel this many px before the gesture commits
   * to being a scroll (1×) or viewport pan (zoomed). */
  twoFingerMovePx: number;
  /** A second tap within this window (and `doubleTapRadiusPx`) of the last
   * click escalates to a double-click (count 2, then 3, capped). */
  doubleTapMs: number;
  doubleTapRadiusPx: number;
  /** Both fingers down-and-up faster than this = a two-finger tap; two such
   * taps back-to-back reset the zoom viewport. */
  twoFingerTapMs: number;
  twoFingerDoubleTapMs: number;
}

export const DEFAULT_TUNING: TouchTuning = {
  settleMs: TOUCH_SETTLE_MS,
  radiusPx: TOUCH_SETTLE_RADIUS_PX,
  longPressMs: LONG_PRESS_MS,
  pinchClassifyPx: 12,
  twoFingerMovePx: 8,
  doubleTapMs: 300,
  doubleTapRadiusPx: 30,
  twoFingerTapMs: 250,
  twoFingerDoubleTapMs: 400,
};

/** Triple-click (select line/paragraph) is the deepest macOS click chord. */
const MAX_CLICK_COUNT = 3;

export class TouchInterpreter {
  private readonly tuning: TouchTuning;
  private rect: Rect = { x: 0, y: 0, w: 1, h: 1 };
  /** Phone-side zoom viewport — the content rect is mapped through it so
   * taps land where the (possibly magnified) pixels actually are. */
  private viewport: Viewport = IDENTITY_VIEWPORT;
  private zoomLock = false;
  /** Last single-finger position while view-panning under the zoom lock. */
  private lastViewPanPoint: TouchSample = { x: 0, y: 0 };

  private phase: Phase = 'idle';
  private startNow = 0;
  /** Re-anchored to the latest position during the settle window, then frozen
   * — the "settled" point a click/drag commits at, not the jittery first pixel. */
  private lastDragPosition = { x: 0, y: 0 };
  private anchor: TouchSample = { x: 0, y: 0 };
  private lastCentroid: TouchSample = { x: 0, y: 0 };
  private longPressDeadline: number | null = null;
  /** Inter-finger distance when the two-finger gesture began / last ticked. */
  private twoFingerStartDist = 0;
  private lastDist = 0;
  private twoFingerStartNow = 0;
  private twoFingerStartCentroid: TouchSample = { x: 0, y: 0 };
  /** Last completed two-finger tap (for the double-tap zoom reset). */
  private lastTwoFingerTapAt: number | null = null;
  /** Last emitted left click (for double/triple-click escalation). */
  private lastClick: { at: number; x: number; y: number; count: number } | null = null;

  constructor(tuning: TouchTuning = DEFAULT_TUNING) {
    this.tuning = tuning;
  }

  /** Recompute the content rect from the current view + source-video sizes.
   * `video` is null until the desktop's first `frame-size` arrives, in which
   * case the mapping is full-bleed (graceful fallback). */
  setGeometry(container: Vec2, video: Vec2 | null): void {
    this.rect = computeContentRect(container, video ?? container);
  }

  /** Update the zoom viewport (owned by the view layer, driven by the
   * pinch/pan/zoom_reset intents this interpreter emits). */
  setViewport(vp: Viewport): void {
    this.viewport = vp;
  }

  /** Zoom-lock mode: every gesture steers the viewport instead of the remote
   * — one finger pans, pinch zooms, nothing is sent to the desktop. The
   * explicit mode (a toggle in the viewer UI) resolves the two-finger
   * ambiguity cleanly: with the lock OFF, two-finger drags always SCROLL the
   * remote (even while zoomed); with it ON, everything pans/zooms the view. */
  setZoomLock(on: boolean): void {
    this.zoomLock = on;
  }

  /** The content rect as it appears on screen: the base contain-fit rect
   * mapped through the zoom viewport. All touch→remote mapping uses this. */
  private effectiveRect(): Rect {
    const { scale, tx, ty } = this.viewport;
    return {
      x: this.rect.x * scale + tx,
      y: this.rect.y * scale + ty,
      w: this.rect.w * scale,
      h: this.rect.h * scale,
    };
  }

  /** Absolute time (ms, same clock as the `now` args) the caller should wake
   * this interpreter via `deadline()`, or null if nothing is pending. Used to
   * fire the long-press right-click without the caller polling. */
  nextDeadline(): number | null {
    return this.longPressDeadline;
  }

  /** A touch went down (or a finger was added). `touches` is every currently
   * active touch in container points. */
  begin(touches: TouchSample[], now: number): TouchIntent[] {
    if (touches.length >= 2) {
      return this.enterTwoFinger(touches, now);
    }
    const p = touches[0];
    if (!p) return [];
    if (this.zoomLock) {
      // Zoom lock: one finger pans the viewport directly, like dragging a
      // photo. No press/click semantics at all.
      this.phase = 'view_panning';
      this.lastViewPanPoint = { x: p.x, y: p.y };
      return [];
    }
    // First finger down: start pressing. No output yet — we don't know if this
    // is a click, a drag, or a right-click, and committing now would fire at
    // the jittery first-contact pixel (Finding 7).
    this.phase = 'pressing';
    this.startNow = now;
    this.anchor = { x: p.x, y: p.y };
    this.longPressDeadline = now + this.tuning.longPressMs;
    return [];
  }

  move(touches: TouchSample[], now: number): TouchIntent[] {
    // A second finger can arrive here (PanResponder reports added touches via
    // move, not a separate callback), so the 1→2 transition lives here too,
    // not only in `begin`.
    if (touches.length >= 2) {
      switch (this.phase) {
        case 'two_finger':
          return this.classifyTwoFinger(touches);
        case 'pinching':
          return this.pinchTo(touches);
        case 'panning':
          return this.panTo(touches);
        case 'scrolling':
          return this.scrollTo(touches);
        default:
          return this.enterTwoFinger(touches, now);
      }
    }
    if (this.phase === 'view_panning') {
      const p = touches[0];
      if (!p) return [];
      const dx = p.x - this.lastViewPanPoint.x;
      const dy = p.y - this.lastViewPanPoint.y;
      this.lastViewPanPoint = { x: p.x, y: p.y };
      if (dx === 0 && dy === 0) return [];
      return [{ kind: 'pan', dx, dy }];
    }
    if (
      this.phase === 'scrolling' ||
      this.phase === 'panning' ||
      this.phase === 'pinching' ||
      this.phase === 'two_finger'
    ) {
      // Dropped back to one finger mid-gesture — stop; don't resume a drag.
      this.phase = 'consumed';
      return [];
    }
    if (this.phase === 'consumed' || this.phase === 'idle') return [];
    const p = touches[0];
    if (!p) return [];

    // Still settling: let the anchor follow the finger so initial jitter (or a
    // fast flick's early travel) doesn't fix a stale press point.
    if (now - this.startNow < this.tuning.settleMs) {
      this.anchor = { x: p.x, y: p.y };
      return [];
    }

    if (this.phase === 'pressing') {
      if (dist(p, this.anchor) > this.tuning.radiusPx) {
        // Real movement past the settle window → it's a drag. Press at the
        // stable anchor, then move to the current point.
        this.phase = 'dragging';
        this.longPressDeadline = null;
        const rect = this.effectiveRect();
        const down = toContentNorm(this.anchor, rect);
        const at = toContentNormClamped(p, rect);
        const out: TouchIntent[] = [];
        if (down) out.push({ kind: 'pointer_down', x: down.x, y: down.y });
        this.lastDragPosition = at;
        out.push({ kind: 'pointer_move', x: at.x, y: at.y });
        return out;
      }
      return [];
    }

    // Dragging.
    const at = toContentNormClamped(p, this.effectiveRect());
    this.lastDragPosition = at;
    return [{ kind: 'pointer_move', x: at.x, y: at.y }];
  }

  end(touches: TouchSample[], now: number): TouchIntent[] {
    // A finger lifted. If others remain, resolve accordingly.
    if (touches.length >= 1) {
      if (this.phase === 'view_panning') {
        // Re-anchor on the surviving finger so the pan doesn't jump.
        const p = touches[0];
        if (p) this.lastViewPanPoint = { x: p.x, y: p.y };
        return [];
      }
      // Dropping from 2→1 (or more) ends a two-finger gesture; don't silently
      // resume a single-finger drag from it — swallow until full release to
      // avoid a surprise cursor jump. An unclassified pair that ends this
      // fast is a two-finger TAP — remember it for the zoom-reset double-tap
      // (resolved in the all-fingers-up branch below via 'consumed').
      if (
        this.phase === 'two_finger' &&
        now - this.twoFingerStartNow < this.tuning.twoFingerTapMs
      ) {
        this.phase = 'consumed';
        return this.registerTwoFingerTap(now);
      }
      if (
        this.phase === 'scrolling' ||
        this.phase === 'panning' ||
        this.phase === 'pinching' ||
        this.phase === 'two_finger'
      ) {
        this.phase = 'consumed';
      }
      return [];
    }

    // Last finger up.
    const out = this.finishSingleFinger(now);
    this.reset();
    return out;
  }

  /** Fire pending time-based transitions (the long-press right-click). Safe to
   * call at any time; only acts once the deadline has actually passed. */
  deadline(now: number): TouchIntent[] {
    if (
      this.phase === 'pressing' &&
      this.longPressDeadline !== null &&
      now >= this.longPressDeadline
    ) {
      this.longPressDeadline = null;
      this.phase = 'consumed';
      const at = toContentNorm(this.anchor, this.effectiveRect());
      if (!at) return [];
      return [{ kind: 'click', x: at.x, y: at.y, button: 'right', count: 1 }];
    }
    return [];
  }

  /** Abandon any in-flight gesture (e.g. control scope lost, screen unmounts).
   * Emits a pointer_up if a drag was mid-flight so the desktop never keeps a
   * button stuck down. */
  cancel(): TouchIntent[] {
    const out: TouchIntent[] = [];
    if (this.phase === 'dragging') {
      const at = this.lastDragPosition;
      out.push({ kind: 'pointer_up', x: at.x, y: at.y });
    }
    this.reset();
    return out;
  }

  private finishSingleFinger(now: number): TouchIntent[] {
    if (this.phase === 'dragging') {
      const at = this.lastDragPosition;
      // Mouse-up carries a position too. Release at the last injected move,
      // not at the gesture origin (which would move/drop the item back).
      return [{ kind: 'pointer_up', x: at.x, y: at.y }];
    }
    if (this.phase === 'pressing') {
      // Lifted within the radius before the long-press fired → a click at the
      // settled anchor. Dropped if the anchor is in a letterbox bar.
      const at = toContentNorm(this.anchor, this.effectiveRect());
      if (!at) return [];
      // Double/triple-tap escalation: macOS opens/selects via the clickState
      // chord (see the desktop's Click injection), so a rapid re-tap near the
      // last click must say "I'm click #2 (#3)" rather than start over.
      let count = 1;
      if (
        this.lastClick &&
        now - this.lastClick.at <= this.tuning.doubleTapMs &&
        dist(this.anchor, { x: this.lastClick.x, y: this.lastClick.y }) <=
          this.tuning.doubleTapRadiusPx
      ) {
        count = Math.min(this.lastClick.count + 1, MAX_CLICK_COUNT);
      }
      this.lastClick = { at: now, x: this.anchor.x, y: this.anchor.y, count };
      return [{ kind: 'click', x: at.x, y: at.y, button: 'left', count }];
    }
    return [];
  }

  private enterTwoFinger(touches: TouchSample[], now: number): TouchIntent[] {
    const out: TouchIntent[] = [];
    // If a drag had already pressed the button, release it before the
    // two-finger gesture so we don't scroll/zoom with a button held.
    if (this.phase === 'dragging') {
      const at = this.lastDragPosition;
      out.push({ kind: 'pointer_up', x: at.x, y: at.y });
    }
    this.phase = 'two_finger';
    this.longPressDeadline = null;
    this.twoFingerStartNow = now;
    this.twoFingerStartDist = this.pairDist(touches);
    this.lastDist = this.twoFingerStartDist;
    this.twoFingerStartCentroid = centroid(touches);
    this.lastCentroid = this.twoFingerStartCentroid;
    return out;
  }

  /** Decide pinch vs. scroll/pan once the fingers commit: a meaningful change
   * in inter-finger DISTANCE is a pinch; meaningful CENTROID travel with a
   * stable distance is a remote scroll — or a viewport pan when the zoom
   * lock is on (the lock owns ALL view manipulation, so scroll stays
   * available while zoomed with the lock off). */
  private classifyTwoFinger(touches: TouchSample[]): TouchIntent[] {
    const d = this.pairDist(touches);
    const c = centroid(touches);
    if (Math.abs(d - this.twoFingerStartDist) > this.tuning.pinchClassifyPx) {
      this.phase = 'pinching';
      this.lastDist = d;
      this.lastCentroid = c;
      return [];
    }
    if (dist(c, this.twoFingerStartCentroid) > this.tuning.twoFingerMovePx) {
      this.phase = this.zoomLock ? 'panning' : 'scrolling';
      this.lastCentroid = c;
      return [];
    }
    return [];
  }

  private pinchTo(touches: TouchSample[]): TouchIntent[] {
    const d = this.pairDist(touches);
    const c = centroid(touches);
    const prev = this.lastDist;
    this.lastDist = d;
    this.lastCentroid = c;
    if (prev <= 0 || d <= 0 || d === prev) return [];
    // Per-event clamp: a finger landing/lifting mid-pinch (or a missed touch
    // sample) can spike the instantaneous distance ratio far beyond anything
    // fingers physically do between two touch events — unclamped, one such
    // spike slams the zoom and reads as the view "breaking".
    const ratio = Math.min(1.33, Math.max(0.75, d / prev));
    return [{ kind: 'pinch', ratio, cx: c.x, cy: c.y }];
  }

  private panTo(touches: TouchSample[]): TouchIntent[] {
    const c = centroid(touches);
    const dx = c.x - this.lastCentroid.x;
    const dy = c.y - this.lastCentroid.y;
    this.lastCentroid = c;
    if (dx === 0 && dy === 0) return [];
    return [{ kind: 'pan', dx, dy }];
  }

  private scrollTo(touches: TouchSample[]): TouchIntent[] {
    if (touches.length < 2) return [];
    const c = centroid(touches);
    const dx = c.x - this.lastCentroid.x;
    const dy = c.y - this.lastCentroid.y;
    this.lastCentroid = c;
    if (dx === 0 && dy === 0) return [];
    const at = toContentNormClamped(c, this.effectiveRect());
    return [{ kind: 'scroll', x: at.x, y: at.y, dx, dy }];
  }

  /** A quick two-finger tap. Two of them back-to-back reset the zoom. */
  private registerTwoFingerTap(now: number): TouchIntent[] {
    if (
      this.lastTwoFingerTapAt !== null &&
      now - this.lastTwoFingerTapAt <= this.tuning.twoFingerDoubleTapMs
    ) {
      this.lastTwoFingerTapAt = null;
      return [{ kind: 'zoom_reset' }];
    }
    this.lastTwoFingerTapAt = now;
    return [];
  }

  private pairDist(touches: TouchSample[]): number {
    const a = touches[0];
    const b = touches[1];
    if (!a || !b) return 0;
    return dist(a, b);
  }

  private reset(): void {
    this.phase = 'idle';
    this.longPressDeadline = null;
  }
}
