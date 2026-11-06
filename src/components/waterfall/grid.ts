/**
 * grid.ts — the scene lattice. Cell (i, j) rests at (gx0 + i·S, gy0 + j·S);
 * the lattice is anchored so that (x_f, y_s) is a lattice point. Extents are
 * fixed in Hs units around that anchor, so a viewport change only moves gx0 /
 * gy0 and the visible window; every simulation buffer keeps its meaning.
 *
 * Owns the water value grid V (+ previous frame for reflections), the content
 * mask (rasterised from avoid rects, O(cells covered)) and the per-draw-code
 * index lists the renderer fills each frame.
 */
import type { Layout } from './layout';
import {
  GRID_BOTTOM,
  GRID_LEFT,
  GRID_RIGHT,
  GRID_TOP_PAD,
  MASK_FEATHER,
  MASK_INFLATE,
} from './config';

export const MASK_FULL = 0;
export const MASK_SOFT_CODE = 1;
export const MASK_HARD_CODE = 2;
/** Water draw code = (level − 1) · 2 + soft. */
export const WATER_CODES = 8;

export interface AvoidRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** MASK_SOFT_CODE or MASK_HARD_CODE. */
  level: number;
}

export interface SceneGrid {
  S: number;
  cols: number;
  rows: number;
  n: number;
  /** Lattice column of x_f and row of y_s. */
  ic: number;
  js: number;
  gx0: number;
  gy0: number;
  /** Visible window [vi0, vi1) × [vj0, vj1). */
  vi0: number;
  vi1: number;
  vj0: number;
  vj1: number;
  V: Float32Array;
  Vprev: Float32Array;
  /** 1 where the falling sheet is fast enough to draw as a vertical streak (this frame). */
  streak: Uint8Array;
  mask: Uint8Array;
  prevMask: Uint8Array;
  /** Per water draw code: cell indices this frame. */
  lists: Uint32Array[];
  counts: Int32Array;
}

export function createGrid(l: Layout): SceneGrid {
  const S = l.S;
  const left = Math.ceil((GRID_LEFT[l.variant] * l.Hs) / S);
  const right = Math.ceil((GRID_RIGHT * l.Hs) / S);
  const top = Math.ceil((l.Hf + GRID_TOP_PAD * l.Hs) / S);
  const bottom = Math.ceil((GRID_BOTTOM * l.Hs) / S) + 2;
  const cols = left + right + 1;
  const rows = top + bottom + 1;
  const n = cols * rows;
  const lists: Uint32Array[] = [];
  // Round dots, then the same codes drawn as vertical streaks.
  for (let c = 0; c < 2 * WATER_CODES; c++) lists.push(new Uint32Array(n));
  const g: SceneGrid = {
    S,
    cols,
    rows,
    n,
    ic: left,
    js: top,
    gx0: 0,
    gy0: 0,
    vi0: 0,
    vi1: 0,
    vj0: 0,
    vj1: 0,
    V: new Float32Array(n),
    Vprev: new Float32Array(n),
    streak: new Uint8Array(n),
    mask: new Uint8Array(n),
    prevMask: new Uint8Array(n),
    lists,
    counts: new Int32Array(2 * WATER_CODES),
  };
  setOrigin(g, l);
  return g;
}

/** Re-anchor to the layout's (x_f, y_s) and clip the visible window to the viewport. */
export function setOrigin(g: SceneGrid, l: Layout): void {
  const S = g.S;
  g.gx0 = l.xf - g.ic * S;
  g.gy0 = l.ys - g.js * S;
  g.vi0 = Math.max(0, Math.ceil((-S - g.gx0) / S));
  g.vi1 = Math.min(g.cols, Math.floor((l.vw + S - g.gx0) / S) + 1);
  g.vj0 = Math.max(0, Math.ceil((-S - g.gy0) / S));
  g.vj1 = Math.min(g.rows, Math.floor((l.vh + S - g.gy0) / S) + 1);
}

export function swapV(g: SceneGrid): void {
  const t = g.V;
  g.V = g.Vprev;
  g.Vprev = t;
}

/** Clear V over the visible window only. */
export function clearV(g: SceneGrid): void {
  const { V, streak, cols, vi0, vi1, vj0, vj1 } = g;
  for (let j = vj0; j < vj1; j++) {
    V.fill(0, j * cols + vi0, j * cols + vi1);
    streak.fill(0, j * cols + vi0, j * cols + vi1);
  }
}

/**
 * Rasterise avoid rects into the mask: inflated rect → its level, a feather
 * band around hard rects → soft. `base` is the floor level everywhere (soft
 * on mobile / narrow layouts). Returns true when any cell in `watch` (rock
 * cell indices) changed level, so the static rock canvas needs a redraw.
 */
export function applyMask(
  g: SceneGrid,
  rects: readonly AvoidRect[],
  base: number,
  watch: Uint32Array,
  watchN: number,
): boolean {
  const { mask, prevMask, cols, rows, S, gx0, gy0 } = g;
  prevMask.set(mask);
  mask.fill(base);
  const cellRange = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    level: number,
  ): void => {
    const i0 = Math.max(0, Math.ceil((x0 - gx0) / S));
    const i1 = Math.min(cols - 1, Math.floor((x1 - gx0) / S));
    const j0 = Math.max(0, Math.ceil((y0 - gy0) / S));
    const j1 = Math.min(rows - 1, Math.floor((y1 - gy0) / S));
    for (let j = j0; j <= j1; j++) {
      const o = j * cols;
      for (let i = i0; i <= i1; i++)
        if (mask[o + i] < level) mask[o + i] = level;
    }
  };
  for (let k = 0; k < rects.length; k++) {
    const r = rects[k];
    const x0 = r.x - MASK_INFLATE;
    const y0 = r.y - MASK_INFLATE;
    const x1 = r.x + r.w + MASK_INFLATE;
    const y1 = r.y + r.h + MASK_INFLATE;
    if (r.level === MASK_HARD_CODE)
      cellRange(
        x0 - MASK_FEATHER,
        y0 - MASK_FEATHER,
        x1 + MASK_FEATHER,
        y1 + MASK_FEATHER,
        MASK_SOFT_CODE,
      );
    cellRange(x0, y0, x1, y1, r.level);
  }
  for (let k = 0; k < watchN; k++) {
    const i = watch[k];
    if (mask[i] !== prevMask[i]) return true;
  }
  return false;
}
