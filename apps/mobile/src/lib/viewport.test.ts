import {
  IDENTITY_VIEWPORT,
  VIEWPORT_MAX_SCALE,
  clampViewport,
  isZoomed,
  panBy,
  toRNTransform,
  zoomAt,
} from './viewport';

const CONTAINER = { w: 400, h: 800 };

describe('clampViewport', () => {
  it('forces identity pan at scale 1', () => {
    expect(clampViewport({ scale: 1, tx: -50, ty: 30 }, CONTAINER)).toEqual(IDENTITY_VIEWPORT);
  });

  it('clamps scale into [1, max]', () => {
    expect(clampViewport({ scale: 0.4, tx: 0, ty: 0 }, CONTAINER).scale).toBe(1);
    expect(clampViewport({ scale: 99, tx: 0, ty: 0 }, CONTAINER).scale).toBe(VIEWPORT_MAX_SCALE);
  });

  it('keeps the scaled content covering the container (no gaps at edges)', () => {
    const vp = clampViewport({ scale: 2, tx: -900, ty: 40 }, CONTAINER);
    // Content is 800x1600; tx may be at most 0 and at least -(800-400) = -400.
    expect(vp.tx).toBe(-400);
    expect(vp.ty).toBe(0);
  });
});

describe('zoomAt', () => {
  it('keeps the focal point stationary while zooming', () => {
    const focal = { x: 100, y: 200 };
    const vp = zoomAt(IDENTITY_VIEWPORT, focal, 2, CONTAINER);
    // Content point under focal before: (100, 200). After: p*2 + t must equal focal.
    expect(100 * vp.scale + vp.tx).toBeCloseTo(focal.x);
    expect(200 * vp.scale + vp.ty).toBeCloseTo(focal.y);
  });

  it('zooming back out to 1 recenters exactly', () => {
    const zoomedIn = zoomAt(IDENTITY_VIEWPORT, { x: 100, y: 200 }, 3, CONTAINER);
    const back = zoomAt(zoomedIn, { x: 200, y: 400 }, 1 / 9, CONTAINER);
    expect(back).toEqual(IDENTITY_VIEWPORT);
  });
});

describe('panBy', () => {
  it('translates and clamps', () => {
    const vp = zoomAt(IDENTITY_VIEWPORT, { x: 200, y: 400 }, 2, CONTAINER);
    const panned = panBy(vp, -10_000, 10_000, CONTAINER);
    expect(panned.tx).toBe(-400); // fully panned right
    expect(panned.ty).toBe(0); // fully panned up
  });
});

describe('isZoomed', () => {
  it('is false at identity and true past the epsilon', () => {
    expect(isZoomed(IDENTITY_VIEWPORT)).toBe(false);
    expect(isZoomed({ scale: 2, tx: 0, ty: 0 })).toBe(true);
  });
});

describe('toRNTransform', () => {
  it('is identity at scale 1', () => {
    expect(toRNTransform(IDENTITY_VIEWPORT, CONTAINER)).toEqual([
      { translateX: 0 },
      { translateY: 0 },
      { scale: 1 },
    ]);
  });

  it('compensates for RN scaling about the center', () => {
    // Top-left model: p·2 + (-400, -800) shows the bottom-right quadrant.
    const [tx, ty, s] = toRNTransform({ scale: 2, tx: -400, ty: -800 }, CONTAINER);
    // T = t + c(s-1) with c = (200, 400).
    expect(tx.translateX).toBe(-400 + 200);
    expect(ty.translateY).toBe(-800 + 400);
    expect(s.scale).toBe(2);
  });
});
