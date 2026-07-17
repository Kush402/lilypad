/**
 * Pure viewport math for pinch-zoom + pan of the remote-screen view.
 *
 * A Mac desktop rendered into a phone-sized view makes every click target a
 * fraction of a fingertip — the standard remote-desktop answer (RDP, Jump,
 * Screens) is a zoomable viewport: pinch to magnify, two-finger drag to pan
 * while zoomed, and taps map through the transform. This module owns the
 * transform state so it stays unit-testable without React Native.
 *
 * Coordinate model: the viewport maps untransformed view space to screen
 * space as `screen = point * scale + (tx, ty)`, i.e. scale about the view's
 * TOP-LEFT then translate. React Native transforms scale about the view's
 * CENTER, so `toRNTransform` converts (see its comment).
 */

export interface Viewport {
  scale: number;
  tx: number;
  ty: number;
}

export interface Size {
  w: number;
  h: number;
}

export const VIEWPORT_MIN_SCALE = 1;
export const VIEWPORT_MAX_SCALE = 6;

/** Scales this close to 1 are treated as "not zoomed" — two-finger drags
 * scroll the remote content instead of panning the viewport. */
export const VIEWPORT_ZOOMED_EPSILON = 0.02;

export const IDENTITY_VIEWPORT: Viewport = { scale: 1, tx: 0, ty: 0 };

export function isZoomed(vp: Viewport): boolean {
  return vp.scale > VIEWPORT_MIN_SCALE + VIEWPORT_ZOOMED_EPSILON;
}

/**
 * Keep the scaled content covering the view: pan offsets are clamped so no
 * edge of the (container-sized, scaled) content pulls inside the container.
 * At scale 1 this forces tx = ty = 0.
 */
export function clampViewport(vp: Viewport, container: Size): Viewport {
  const scale = Math.min(VIEWPORT_MAX_SCALE, Math.max(VIEWPORT_MIN_SCALE, vp.scale));
  const minTx = container.w * (1 - scale);
  const minTy = container.h * (1 - scale);
  return {
    scale,
    tx: Math.min(0, Math.max(minTx, vp.tx)),
    ty: Math.min(0, Math.max(minTy, vp.ty)),
  };
}

/**
 * Multiply the scale by `ratio`, keeping the content point under the screen
 * point `focal` stationary — the pinch midpoint stays pinned under the
 * fingers, which is what makes pinch-zoom feel anchored rather than sliding.
 */
export function zoomAt(
  vp: Viewport,
  focal: { x: number; y: number },
  ratio: number,
  container: Size,
): Viewport {
  const nextScale = Math.min(
    VIEWPORT_MAX_SCALE,
    Math.max(VIEWPORT_MIN_SCALE, vp.scale * ratio),
  );
  // Content point currently under the focal screen point…
  const cx = (focal.x - vp.tx) / vp.scale;
  const cy = (focal.y - vp.ty) / vp.scale;
  // …must still be under it after rescaling.
  return clampViewport(
    { scale: nextScale, tx: focal.x - cx * nextScale, ty: focal.y - cy * nextScale },
    container,
  );
}

/** Translate the viewport by a screen-space delta (two-finger pan). */
export function panBy(vp: Viewport, dx: number, dy: number, container: Size): Viewport {
  return clampViewport({ scale: vp.scale, tx: vp.tx + dx, ty: vp.ty + dy }, container);
}

/**
 * Convert to React Native's transform array. RN scales about the view
 * CENTER `c`, so a center-scale-then-translate by `T` maps `p` to
 * `(p - c)·s + c + T`; matching our top-left model `p·s + t` requires
 * `T = t + c·(s - 1)`.
 */
export function toRNTransform(
  vp: Viewport,
  container: Size,
): [{ translateX: number }, { translateY: number }, { scale: number }] {
  return [
    { translateX: vp.tx + (container.w / 2) * (vp.scale - 1) },
    { translateY: vp.ty + (container.h / 2) * (vp.scale - 1) },
    { scale: vp.scale },
  ];
}
