/**
 * layout.ts — viewport → tree placement. H (tree height) and S (dot pitch) form
 * the raster key; rootX/rootY are pure translation, snapped to device pixels, so
 * width and URL-bar changes move the tree without re-rasterizing it.
 */
import {
  BACKING_MAX_PX,
  BREAKPOINT,
  MOTION_MARGIN,
  type Variant,
} from './config';

export interface Layout {
  variant: Variant;
  vw: number;
  vh: number;
  H: number;
  S: number;
  rootX: number;
  rootY: number;
  alphaMul: number;
  dpr: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
const snap = (v: number, dpr: number): number => Math.round(v * dpr) / dpr;

export const variantFor = (vw: number): Variant =>
  vw < BREAKPOINT ? 'mobile' : 'desktop';

export function heightFor(variant: Variant, vh: number): number {
  // Mobile: a tall background tree (~2/3 of the screen) aligned right, behind
  // the content like on desktop.
  return Math.round(
    variant === 'desktop'
      ? clamp(vh * 0.88, 520, 1100)
      : clamp(vh * 0.66, 380, 720),
  );
}

function place(
  variant: Variant,
  vw: number,
  vh: number,
  H: number,
  dpr: number,
): { rootX: number; rootY: number } {
  const desktop = variant === 'desktop';
  return {
    // Desktop 0.76 keeps the crown plus its leeward (+x) motion margin inside the viewport.
    rootX: snap(vw * (desktop ? 0.76 : 0.68), dpr),
    rootY: snap(vh + 0.04 * H, dpr),
  };
}

export function computeLayout(vw: number, vh: number, dpr: number): Layout {
  const variant = variantFor(vw);
  const H = heightFor(variant, vh);
  return {
    variant,
    vw,
    vh,
    H,
    S: variant === 'desktop' ? 6 : 5,
    ...place(variant, vw, vh, H, dpr),
    alphaMul: variant === 'desktop' ? 1 : 0.85,
    dpr,
  };
}

/** New viewport, frozen H/S/raster: only the root translates. */
export function retarget(
  layout: Layout,
  vw: number,
  vh: number,
  dpr: number,
): Layout {
  return {
    ...layout,
    vw,
    vh,
    dpr,
    ...place(layout.variant, vw, vh, layout.H, dpr),
  };
}

/** Rest bbox (root-relative) inflated by the motion margin, clipped to the viewport, integer CSS px. */
export function canvasRect(layout: Layout, bbox: BBox): Rect {
  const m = Math.round(MOTION_MARGIN * layout.H);
  const left = Math.max(0, Math.floor(layout.rootX + bbox.minX - m));
  const top = Math.max(0, Math.floor(layout.rootY + bbox.minY - m));
  const right = Math.min(layout.vw, Math.ceil(layout.rootX + bbox.maxX + m));
  const bottom = Math.min(layout.vh, Math.ceil(layout.rootY + bbox.maxY + m));
  return {
    left,
    top,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
  };
}

/** Device DPR capped at 2 and by the backing-store pixel budget. */
export function effectiveDpr(
  deviceDpr: number,
  cssW: number,
  cssH: number,
): number {
  const area = Math.max(1, cssW * cssH);
  return Math.min(deviceDpr || 1, 2, Math.sqrt(BACKING_MAX_PX / area));
}
