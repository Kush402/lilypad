import { computeContentRect, toContentNorm, TouchInterpreter, type TouchIntent } from './touch';

describe('computeContentRect', () => {
  it('is full-bleed when aspect ratios match', () => {
    expect(computeContentRect({ x: 1600, y: 1000 }, { x: 1600, y: 1000 })).toEqual({
      x: 0,
      y: 0,
      w: 1600,
      h: 1000,
    });
  });

  it('letterboxes (pillarboxes) a 16:9 video inside a tall portrait container', () => {
    // Portrait phone 400x800, source 1600x900 (16:9). Fit by width → 400x225,
    // centered vertically.
    const r = computeContentRect({ x: 400, y: 800 }, { x: 1600, y: 900 });
    expect(r.w).toBeCloseTo(400);
    expect(r.h).toBeCloseTo(225);
    expect(r.x).toBeCloseTo(0);
    expect(r.y).toBeCloseTo((800 - 225) / 2);
  });

  it('pillarboxes a tall source inside a wide container', () => {
    const r = computeContentRect({ x: 1000, y: 500 }, { x: 500, y: 500 });
    expect(r.h).toBeCloseTo(500);
    expect(r.w).toBeCloseTo(500);
    expect(r.x).toBeCloseTo(250);
    expect(r.y).toBeCloseTo(0);
  });

  it('degrades to an empty-ish rect for zero-size inputs instead of NaN', () => {
    const r = computeContentRect({ x: 0, y: 0 }, { x: 100, y: 100 });
    expect(Number.isNaN(r.w)).toBe(false);
    expect(r.w).toBe(0);
  });
});

describe('toContentNorm', () => {
  const rect = { x: 0, y: 287.5, w: 400, h: 225 }; // the pillarbox from above

  it('maps a point inside the content rect to 0..1', () => {
    expect(toContentNorm({ x: 200, y: 287.5 + 112.5 }, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('drops a point in the top letterbox bar (returns null)', () => {
    expect(toContentNorm({ x: 200, y: 10 }, rect)).toBeNull();
  });

  it('drops a point in the bottom letterbox bar', () => {
    expect(toContentNorm({ x: 200, y: 790 }, rect)).toBeNull();
  });
});

// A container that matches the source, so mapping is identity (0..1 == px/size)
// — keeps the gesture tests about gesture logic, not letterbox arithmetic.
const TEST_TUNING = {
  settleMs: 70,
  radiusPx: 6,
  longPressMs: 500,
  pinchClassifyPx: 12,
  twoFingerMovePx: 8,
  doubleTapMs: 300,
  doubleTapRadiusPx: 30,
  twoFingerTapMs: 250,
  twoFingerDoubleTapMs: 400,
};

function identityInterp() {
  const interp = new TouchInterpreter(TEST_TUNING);
  interp.setGeometry({ x: 100, y: 100 }, { x: 100, y: 100 });
  return interp;
}

const P = (x: number, y: number) => ({ x, y });

describe('TouchInterpreter — tap → click', () => {
  it('emits a single left click on a tap that lifts within the radius', () => {
    const i = identityInterp();
    expect(i.begin([P(50, 50)], 0)).toEqual([]);
    // lift the only finger
    const out = i.end([], 50);
    expect(out).toEqual([{ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 }]);
  });

  it('drops a tap that lands in a letterbox bar', () => {
    const i = new TouchInterpreter();
    i.setGeometry({ x: 400, y: 800 }, { x: 1600, y: 900 }); // pillarboxed
    i.begin([P(200, 10)], 0); // top bar
    expect(i.end([], 30)).toEqual([]);
  });

  it('does not emit a pointer_down at first contact (precision: waits for release)', () => {
    const i = identityInterp();
    // A press that stays still and then lifts is a click, never a bare down.
    expect(i.begin([P(30, 30)], 0)).toEqual([]);
    const out = i.end([], 40);
    expect(out.every((o) => o.kind !== 'pointer_down')).toBe(true);
  });
});

describe('TouchInterpreter — drag', () => {
  it('commits a drag (down at anchor, then move) once movement passes the radius after the settle window', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    // within settle window: anchor follows, no output
    expect(i.move([P(51, 51)], 30)).toEqual([]);
    // after settle window, beyond radius → drag
    const out = i.move([P(70, 50)], 100);
    expect(out[0]).toEqual({ kind: 'pointer_down', x: 0.51, y: 0.51 });
    expect(out[1]).toEqual({ kind: 'pointer_move', x: 0.7, y: 0.5 });
  });

  it('emits pointer_up on release after a drag', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    i.move([P(80, 50)], 100);
    const out = i.end([], 150);
    expect(out).toEqual([{ kind: 'pointer_up', x: expect.any(Number), y: expect.any(Number) }]);
  });

  it('a release after a drag is NOT a click', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    i.move([P(80, 50)], 100);
    const out = i.end([], 150);
    expect(out.every((o) => o.kind !== 'click')).toBe(true);
  });
});

describe('TouchInterpreter — long-press right-click', () => {
  it('emits a right-click once the finger is held still past the long-press deadline', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    expect(i.nextDeadline()).toBe(500);
    // Not yet.
    expect(i.deadline(499)).toEqual([]);
    const out = i.deadline(500);
    expect(out).toEqual([{ kind: 'click', x: 0.5, y: 0.5, button: 'right', count: 1 }]);
  });

  it('does not also emit a left click when the finger lifts after a right-click fired', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    i.deadline(500); // right-click
    expect(i.end([], 600)).toEqual([]);
  });

  it('a drag cancels the pending long-press (no right-click)', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    i.move([P(90, 50)], 100); // drag commit clears the deadline
    expect(i.nextDeadline()).toBeNull();
    expect(i.deadline(500)).toEqual([]);
  });
});

describe('TouchInterpreter — two-finger scroll', () => {
  it('emits scroll deltas from the two-finger centroid movement', () => {
    const i = identityInterp();
    i.begin([P(40, 40)], 0);
    // second finger arrives via move
    const enter = i.move([P(40, 40), P(60, 60)], 20); // centroid (50,50), baseline
    expect(enter).toEqual([]); // no delta yet
    // Centroid travels 10px (> twoFingerMovePx) with stable finger distance →
    // classifies as a scroll; the classification tick itself emits nothing.
    expect(i.move([P(40, 50), P(60, 70)], 40)).toEqual([]); // centroid (50,60)
    const out = i.move([P(40, 60), P(60, 80)], 60); // centroid (50,70) → dy +10
    expect(out).toHaveLength(1);
    const scroll = out[0] as Extract<TouchIntent, { kind: 'scroll' }>;
    expect(scroll.kind).toBe('scroll');
    expect(scroll.dy).toBeCloseTo(10);
    expect(scroll.dx).toBeCloseTo(0);
  });

  it('releases a held drag button before scrolling if a second finger joins mid-drag', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    i.move([P(85, 50)], 100); // drag → button down
    const out = i.move([P(85, 50), P(30, 30)], 120); // second finger → scroll
    expect(out[0]?.kind).toBe('pointer_up');
  });

  it('does not resume a single-finger drag after one of two fingers lifts', () => {
    const i = identityInterp();
    i.begin([P(40, 40)], 0);
    i.move([P(40, 40), P(60, 60)], 20); // scroll
    i.end([P(40, 40)], 40); // one finger lifted, one remains
    // A move with the remaining finger must not produce pointer events.
    expect(i.move([P(45, 45)], 60)).toEqual([]);
  });
});

describe('TouchInterpreter — cancel', () => {
  it('releases a mid-drag button so nothing stays stuck down', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    i.move([P(85, 50)], 100);
    expect(i.cancel()[0]?.kind).toBe('pointer_up');
  });

  it('is a no-op when nothing is pressed', () => {
    const i = identityInterp();
    expect(i.cancel()).toEqual([]);
  });
});

describe('TouchInterpreter — double-tap → double-click', () => {
  it('escalates a rapid second tap at the same spot to count 2', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    const first = i.end([], 40);
    expect(first).toEqual([{ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 }]);
    i.begin([P(52, 51)], 150);
    const second = i.end([], 190);
    expect(second).toEqual([
      { kind: 'click', x: expect.any(Number), y: expect.any(Number), button: 'left', count: 2 },
    ]);
  });

  it('caps escalation at triple-click', () => {
    const i = identityInterp();
    for (const [t0, t1] of [
      [0, 40],
      [150, 190],
      [300, 340],
      [450, 490],
    ] as const) {
      i.begin([P(50, 50)], t0);
      const out = i.end([], t1);
      const click = out[0] as Extract<TouchIntent, { kind: 'click' }>;
      expect(click.count).toBeLessThanOrEqual(3);
    }
  });

  it('a slow second tap stays a single click', () => {
    const i = identityInterp();
    i.begin([P(50, 50)], 0);
    i.end([], 40);
    i.begin([P(50, 50)], 1000);
    const out = i.end([], 1040);
    expect((out[0] as Extract<TouchIntent, { kind: 'click' }>).count).toBe(1);
  });

  it('a distant second tap stays a single click', () => {
    const i = identityInterp();
    i.begin([P(20, 20)], 0);
    i.end([], 40);
    i.begin([P(80, 80)], 150);
    const out = i.end([], 190);
    expect((out[0] as Extract<TouchIntent, { kind: 'click' }>).count).toBe(1);
  });
});

describe('TouchInterpreter — pinch zoom', () => {
  it('classifies a distance change as a pinch and emits ratio increments', () => {
    const i = identityInterp();
    i.begin([P(40, 50), P(60, 50)], 0); // distance 20
    // Distance grows to 40 (> pinchClassifyPx change) → pinch; classify tick
    // emits nothing.
    expect(i.move([P(30, 50), P(70, 50)], 20)).toEqual([]);
    const out = i.move([P(20, 50), P(80, 50)], 40); // distance 60
    expect(out).toHaveLength(1);
    const pinch = out[0] as Extract<TouchIntent, { kind: 'pinch' }>;
    expect(pinch.kind).toBe('pinch');
    // True ratio is 60/40 = 1.5, clamped to the per-event ceiling (1.33) —
    // a single-event jump that large is touch noise, not fingers.
    expect(pinch.ratio).toBeCloseTo(1.33);
    expect(pinch.cx).toBeCloseTo(50);
    expect(pinch.cy).toBeCloseTo(50);
  });

  it('two-finger drag still SCROLLS while zoomed (zoom lock off)', () => {
    const i = identityInterp();
    i.setViewport({ scale: 2, tx: -50, ty: -50 });
    i.begin([P(40, 40), P(60, 60)], 0); // centroid (50,50)
    expect(i.move([P(40, 50), P(60, 70)], 20)).toEqual([]); // classify → scroll
    const out = i.move([P(40, 60), P(60, 80)], 40);
    expect(out[0]?.kind).toBe('scroll');
  });

  it('zoom lock: one finger pans the viewport, nothing goes to the remote', () => {
    const i = identityInterp();
    i.setZoomLock(true);
    expect(i.begin([P(50, 50)], 0)).toEqual([]);
    expect(i.move([P(60, 45)], 20)).toEqual([{ kind: 'pan', dx: 10, dy: -5 }]);
    expect(i.move([P(65, 45)], 40)).toEqual([{ kind: 'pan', dx: 5, dy: 0 }]);
    // Lifting emits no click.
    expect(i.end([], 60)).toEqual([]);
  });

  it('zoom lock: two-finger drag pans instead of scrolling', () => {
    const i = identityInterp();
    i.setZoomLock(true);
    i.begin([P(40, 40), P(60, 60)], 0);
    expect(i.move([P(40, 50), P(60, 70)], 20)).toEqual([]); // classify → panning
    expect(i.move([P(40, 60), P(60, 80)], 40)).toEqual([{ kind: 'pan', dx: 0, dy: 10 }]);
  });

  it('zoom lock: pinch still zooms', () => {
    const i = identityInterp();
    i.setZoomLock(true);
    i.begin([P(40, 50), P(60, 50)], 0); // distance 20
    expect(i.move([P(30, 50), P(70, 50)], 20)).toEqual([]); // classify → pinch
    const out = i.move([P(20, 50), P(80, 50)], 40);
    expect(out[0]?.kind).toBe('pinch');
  });

  it('a double two-finger tap resets the zoom', () => {
    const i = identityInterp();
    // First two-finger tap: down and all-up quickly.
    i.begin([P(40, 50), P(60, 50)], 0);
    expect(i.end([P(40, 50)], 100)).toEqual([]); // first finger up (tap recorded)
    i.end([], 110);
    // Second two-finger tap inside the double-tap window.
    i.begin([P(40, 50), P(60, 50)], 200);
    expect(i.end([P(40, 50)], 280)).toEqual([{ kind: 'zoom_reset' }]);
  });

  it('maps taps through the zoom viewport', () => {
    const i = identityInterp();
    // 2× zoom anchored so the content's center quadrant fills the view:
    // screen point = content point * 2 - 50.
    i.setViewport({ scale: 2, tx: -50, ty: -50 });
    i.begin([P(50, 50)], 0); // content point (50,50) → normalized 0.5
    const out = i.end([], 40);
    expect(out).toEqual([{ kind: 'click', x: 0.5, y: 0.5, button: 'left', count: 1 }]);
  });
});
