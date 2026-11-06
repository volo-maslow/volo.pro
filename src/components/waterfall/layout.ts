/**
 * layout.ts — viewport → scene placement. Hs (scene height), Hf (fall height)
 * and S (dot pitch) are the raster key; x_f / y_s are pure translation,
 * snapped to device pixels, so width and URL-bar changes move the scene
 * without regenerating rocks or resetting the water.
 *
 * The lane formulas mirror the `.page` margin rule (styles/global.css): at
 * ≥ 1024 px the page box (768 px) sits left of a 440 px scene lane, and every
 * rock, and the pool's fade-in, stays at least ROCK_CLEAR px right of the text
 * column.
 */
import {
  ALPHA_MUL,
  BACKING_MAX_PX,
  BREAKPOINT,
  FALL_M,
  G_MS,
  HF_CLAMP,
  HF_FRAC,
  HS_CLAMP,
  HS_FRAC,
  LAKE_VIS,
  LANE_MIN_VW,
  MOBILE_INSET,
  MOBILE_LIP,
  PAGE_BOX,
  PAGE_GUTTER,
  PAGE_LANE,
  ROCK_CLEAR,
  S as PITCH,
  U0_MS,
  V0Y_MS,
  VIEW_THROW,
  W0_FRAC,
  type Variant,
} from './config';

export interface Layout {
  variant: Variant;
  vw: number;
  vh: number;
  quiet: boolean;
  /** True when there is no scene lane (desktop below 1024 px, or mobile). */
  narrow: boolean;
  Hs: number;
  Hf: number;
  S: number;
  /** Lip centre x and pool surface y (grid origin), device-pixel snapped. */
  xf: number;
  ys: number;
  ylip: number;
  W0: number;
  /** Pixels per metre. */
  ppm: number;
  /** Horizontal bow of the fall at impact (px, the fall bows left). */
  throwPx: number;
  /** Impact centre x. */
  xi: number;
  laneLeft: number;
  /** Right edge of the text column, or -Infinity without a lane. */
  contentR: number;
  /** Rocks never start left of this (contentR + ROCK_CLEAR), or -Infinity. */
  rockMinX: number;
  alphaMul: number;
  dpr: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(hi, Math.max(lo, v));
const snap = (v: number, dpr: number): number => Math.round(v * dpr) / dpr;

export const variantFor = (vw: number): Variant =>
  vw < BREAKPOINT ? 'mobile' : 'desktop';

export function heightsFor(
  variant: Variant,
  vh: number,
): { Hs: number; Hf: number } {
  const [hsLo, hsHi] = HS_CLAMP[variant];
  const [hfLo, hfHi] = HF_CLAMP[variant];
  return {
    Hs: Math.round(clamp(vh * HS_FRAC[variant], hsLo, hsHi)),
    Hf: Math.round(clamp(vh * HF_FRAC[variant], hfLo, hfHi)),
  };
}

/** Fall time (s, sim) to drop y px below the lip, for a given ppm. */
export function fallTime(y: number, ppm: number): number {
  const g = G_MS * ppm;
  const v0y = V0Y_MS * ppm;
  return (-v0y + Math.sqrt(v0y * v0y + 2 * g * Math.max(0, y))) / g;
}

interface Placement {
  narrow: boolean;
  xf: number;
  ys: number;
  ylip: number;
  laneLeft: number;
  contentR: number;
  rockMinX: number;
}

function place(
  variant: Variant,
  vw: number,
  vh: number,
  Hf: number,
  dpr: number,
): Placement {
  if (variant === 'mobile') {
    const [f, lo, hi] = MOBILE_INSET;
    const ylip = snap(MOBILE_LIP * vh, dpr);
    return {
      narrow: true,
      xf: snap(vw - clamp(f * vw, lo, hi), dpr),
      ys: ylip + Hf,
      ylip,
      laneLeft: -1,
      contentR: -Infinity,
      rockMinX: -Infinity,
    };
  }
  const ys = snap(vh * (1 - LAKE_VIS), dpr);
  if (vw >= LANE_MIN_VW) {
    const laneLeft = Math.max(0, (vw - PAGE_LANE) / 2) + PAGE_BOX;
    const contentR = laneLeft - PAGE_GUTTER;
    return {
      narrow: false,
      xf: snap(laneLeft + clamp(0.42 * (vw - laneLeft), 170, 330), dpr),
      ys,
      ylip: ys - Hf,
      laneLeft,
      contentR,
      rockMinX: contentR + ROCK_CLEAR,
    };
  }
  return {
    narrow: true,
    xf: snap(vw * 0.8, dpr),
    ys,
    ylip: ys - Hf,
    laneLeft: -1,
    contentR: -Infinity,
    rockMinX: -Infinity,
  };
}

export function computeLayout(
  vw: number,
  vh: number,
  dpr: number,
  quiet: boolean,
): Layout {
  const variant = variantFor(vw);
  const { Hs, Hf } = heightsFor(variant, vh);
  const ppm = Hf / FALL_M;
  const throwPx = VIEW_THROW * U0_MS * ppm * fallTime(Hf, ppm);
  const p = place(variant, vw, vh, Hf, dpr);
  const base = variant === 'desktop' ? ALPHA_MUL.desktop : ALPHA_MUL.mobile;
  return {
    variant,
    vw,
    vh,
    quiet,
    ...p,
    Hs,
    Hf,
    S: PITCH[variant],
    W0: W0_FRAC[variant] * Hs,
    ppm,
    throwPx,
    xi: p.xf - throwPx,
    alphaMul: base * (quiet ? ALPHA_MUL.quiet : 1),
    dpr,
  };
}

/** New viewport, frozen raster (Hs, Hf, S): only the origin translates. */
export function retarget(
  l: Layout,
  vw: number,
  vh: number,
  dpr: number,
): Layout {
  const p = place(l.variant, vw, vh, l.Hf, dpr);
  return { ...l, vw, vh, dpr, ...p, xi: p.xf - l.throwPx };
}

/** Everything the rock raster depends on. A change means rebuild. */
export function rasterKey(l: Layout): string {
  const clip = Number.isFinite(l.rockMinX)
    ? Math.floor((l.rockMinX - l.xf) / l.S)
    : 'none';
  return `${l.variant}|${l.Hs}|${l.Hf}|${l.S}|${clip}`;
}

/**
 * Device DPR capped at 2 and by the backing-store pixel budget. The budget
 * covers both layers (rock + water canvases share one rect and DPR), so the
 * area counts twice.
 */
export function effectiveDpr(
  deviceDpr: number,
  cssW: number,
  cssH: number,
): number {
  const area = Math.max(1, 2 * cssW * cssH);
  return Math.min(deviceDpr || 1, 2, Math.sqrt(BACKING_MAX_PX / area));
}
