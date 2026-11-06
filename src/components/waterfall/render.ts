/**
 * render.ts — Canvas 2D for both layers, geometry in viewport CSS px via
 * setTransform. The rock canvas is drawn once per build / mask / ink change;
 * the water canvas quantises V each frame with a time-stable per-cell dither
 * (moving density crosses thresholds in a scattered but steady order: motion
 * without sparkle), then draws one path of arcs per draw code, lightest first.
 * Droplets and the pointer collar are free dots in a second, batched pass.
 */
import type { Rect } from './layout';
import type { SceneGrid } from './grid';
import type { Terrain } from './terrain';
import type { Particles } from './particles';
import type { Touch } from './touch';
import { MASK_HARD_CODE, MASK_SOFT_CODE, WATER_CODES } from './grid';
import { hash01 } from '../tree/rng';
import {
  DITHER,
  LEVEL_A,
  LEVEL_R,
  LEVEL_T,
  MASK_SOFT,
  ROCK_A,
  ROCK_R,
  SEED,
  SUB,
} from './config';

const TAU = Math.PI * 2;
const FREE_R = [0.17, 0.22, 0.27] as const;
const ROCK_ORDER = [4, 0, 1, 3, 2] as const;

export interface Renderer {
  setRect(r: Rect, dpr: number): void;
  /** Rock ink and water ink (r,g,b) and the variant's alpha multiplier. */
  setInk(ink: string, waterInk: string, alphaMul: number): void;
  setGrid(g: SceneGrid): void;
  drawRocks(t: Terrain, g: SceneGrid): void;
  drawWater(g: SceneGrid, p: Particles | null, touch: Touch | null, dtSim: number): void;
  clear(): void;
  backingPx(): number;
  latticeDots: number;
  freeDots: number;
  /** Fade toward the viewport's right edge (px): the scene sits in the lane, not off it. */
  edgeFade: number;
}

export function createRenderer(
  rockCanvas: HTMLCanvasElement,
  waterCanvas: HTMLCanvasElement,
  ink0: string,
): Renderer {
  const rc = rockCanvas.getContext('2d');
  const wc = waterCanvas.getContext('2d');
  if (!rc || !wc) throw new Error('Waterfall: 2D canvas context unavailable');
  let rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  let ink = ink0;
  let waterInk = ink0;
  let mul = 1;
  const waterStyles: string[] = [];
  const rockStyles: string[] = [];
  let dither = new Float32Array(0);
  let ditherFor: SceneGrid | null = null;
  // Free-dot batches: 3 levels (L1..L3) × soft, positions packed.
  const FREE_CAP = 2048;
  const fx: Float32Array[] = [];
  const fy: Float32Array[] = [];
  const fn = new Int32Array(6);
  for (let k = 0; k < 6; k++) {
    fx.push(new Float32Array(FREE_CAP));
    fy.push(new Float32Array(FREE_CAP));
  }

  const buildStyles = (): void => {
    for (let c = 0; c < WATER_CODES; c++) {
      const a = LEVEL_A[c >> 1] * mul * (c & 1 ? MASK_SOFT : 1);
      waterStyles[c] = `rgba(${waterInk},${a.toFixed(4)})`;
    }
    for (let c = 0; c < 10; c++) {
      const a = ROCK_A[c >> 1] * mul * (c & 1 ? MASK_SOFT : 1);
      rockStyles[c] = `rgba(${ink},${a.toFixed(4)})`;
    }
  };
  buildStyles();

  const size = (cv: HTMLCanvasElement, ctx: CanvasRenderingContext2D, r: Rect, dpr: number): void => {
    const s = cv.style;
    s.left = `${r.left}px`;
    s.top = `${r.top}px`;
    s.width = `${r.width}px`;
    s.height = `${r.height}px`;
    const bw = Math.max(1, Math.round(r.width * dpr));
    const bh = Math.max(1, Math.round(r.height * dpr));
    if (cv.width !== bw) cv.width = bw;
    if (cv.height !== bh) cv.height = bh;
    ctx.setTransform(dpr, 0, 0, dpr, -r.left * dpr, -r.top * dpr);
  };

  const pushFree = (k: number, x: number, y: number): void => {
    const m = fn[k];
    if (m >= FREE_CAP) return;
    fx[k][m] = x;
    fy[k][m] = y;
    fn[k] = m + 1;
  };

  const ren: Renderer = {
    latticeDots: 0,
    freeDots: 0,
    edgeFade: 120,
    setRect(r, dpr) {
      rect = r;
      size(rockCanvas, rc, r, dpr);
      size(waterCanvas, wc, r, dpr);
    },
    setInk(ink2, water2, alphaMul) {
      ink = ink2;
      waterInk = water2;
      mul = alphaMul;
      buildStyles();
    },
    setGrid(g) {
      if (ditherFor === g) return;
      ditherFor = g;
      dither = new Float32Array(g.n);
      const seed = SEED ^ SUB.dither;
      for (let j = 0; j < g.rows; j++)
        for (let i = 0; i < g.cols; i++)
          dither[j * g.cols + i] = (hash01(i - g.ic, j - g.js, seed) - 0.5) * DITHER;
    },
    drawRocks(t, g) {
      rc.clearRect(rect.left, rect.top, rect.width, rect.height);
      const { mask, cols, S, gx0, gy0, vi0, vi1, vj0, vj1 } = g;
      const fadeN = Math.max(1, Math.round(ren.edgeFade / S));
      const iFade = vi1 - fadeN;
      const fadeSeed = SEED ^ SUB.dither ^ 0xed;
      // Lightest first: recess, light, base, wet, dark.
      for (let soft = 1; soft >= 0; soft--) {
        for (const lv of ROCK_ORDER) {
          const list = t.byLevel[lv];
          if (!list.length) continue;
          const r = ROCK_R[lv] * S;
          rc.fillStyle = rockStyles[lv * 2 + soft];
          rc.beginPath();
          for (let n = 0; n < list.length; n++) {
            const c = list[n];
            const m = mask[c];
            if (m === MASK_HARD_CODE || (m === MASK_SOFT_CODE) !== (soft === 1)) continue;
            const i = c % cols;
            const j = (c - i) / cols;
            if (i < vi0 || i >= vi1 || j < vj0 || j >= vj1) continue;
            // Edge fade by dropping dots (the dot language has no partial dots).
            if (i > iFade && hash01(i - g.ic, j - g.js, fadeSeed) > (vi1 - i) / fadeN) continue;
            const x = gx0 + i * S;
            const y = gy0 + j * S;
            rc.moveTo(x + r, y);
            rc.arc(x, y, r, 0, TAU);
          }
          rc.fill();
        }
      }
    },
    drawWater(g, p, touch, dtSim) {
      wc.clearRect(rect.left, rect.top, rect.width, rect.height);
      const { V, streak, mask, cols, S, gx0, gy0, vi0, vi1, vj0, vj1, lists, counts } = g;
      counts.fill(0);
      const t0 = LEVEL_T[0];
      const t1 = LEVEL_T[1];
      const t2 = LEVEL_T[2];
      const t3 = LEVEL_T[3];
      const pre = t0 - DITHER * 0.5;
      // The scene thins out over the last EDGE_FADE px before the viewport's right edge.
      const fadeN = Math.max(1, Math.round(ren.edgeFade / S));
      const iFade = vi1 - fadeN;
      for (let j = vj0; j < vj1; j++) {
        const row = j * cols;
        for (let i = vi0; i < vi1; i++) {
          const c = row + i;
          const v0 = i > iFade ? V[c] * ((vi1 - i) / fadeN) : V[c];
          if (v0 < pre) continue;
          const m = mask[c];
          if (m === MASK_HARD_CODE) continue;
          const v = v0 + dither[c];
          if (v < t0) continue;
          const lv = v < t1 ? 0 : v < t2 ? 1 : v < t3 ? 2 : 3;
          const code = lv * 2 + (m === MASK_SOFT_CODE ? 1 : 0) + (streak[c] && lv > 0 ? WATER_CODES : 0);
          lists[code][counts[code]++] = c;
        }
      }
      let lat = 0;
      for (let code = 0; code < 2 * WATER_CODES; code++) {
        const nList = counts[code];
        if (nList === 0) continue;
        lat += nList;
        const list = lists[code];
        const base = code % WATER_CODES;
        const r = LEVEL_R[base >> 1] * S;
        wc.fillStyle = waterStyles[base];
        wc.beginPath();
        if (code < WATER_CODES) {
          for (let n = 0; n < nList; n++) {
            const c = list[n];
            const i = c % cols;
            const x = gx0 + i * S;
            const y = gy0 + ((c - i) / cols) * S;
            wc.moveTo(x + r, y);
            wc.arc(x, y, r, 0, TAU);
          }
        } else {
          // Fast water: a short vertical dash on the lattice point, along the velocity.
          const rx = r * 0.8;
          const ry = Math.min(0.45 * S, r * 2);
          for (let n = 0; n < nList; n++) {
            const c = list[n];
            const i = c % cols;
            const x = gx0 + i * S;
            const y = gy0 + ((c - i) / cols) * S;
            wc.moveTo(x + rx, y);
            wc.ellipse(x, y, rx, ry, 0, 0, TAU);
          }
        }
        wc.fill();
      }
      ren.latticeDots = lat;

      // Free dots: droplets (+ a one-level-lower streak dot when fast) and the collar.
      fn.fill(0);
      if (p && p.count > 0) {
        const { x, y, vx, vy, size, alive, cap } = p;
        for (let k = 0; k < cap; k++) {
          if (!alive[k]) continue;
          const ci = Math.round((x[k] - gx0) / S);
          const cj = Math.round((y[k] - gy0) / S);
          let m = 0;
          if (ci >= 0 && cj >= 0 && ci < cols && cj < g.rows) m = mask[cj * cols + ci];
          if (m === MASK_HARD_CODE) continue;
          const soft = m === MASK_SOFT_CODE ? 1 : 0;
          const lv = size[k];
          pushFree(lv * 2 + soft, x[k], y[k]);
          const sx = vx[k] * dtSim;
          const sy = vy[k] * dtSim;
          if (sx * sx + sy * sy > 0.64 * S * S && lv > 0)
            pushFree((lv - 1) * 2 + soft, x[k] - sx * 0.5, y[k] - sy * 0.5);
        }
      }
      if (touch && touch.collarN > 0) {
        for (let k = 0; k < touch.collarN; k++) {
          const ci = Math.round((touch.collarX[k] - gx0) / S);
          const cj = Math.round((touch.collarY[k] - gy0) / S);
          let m = 0;
          if (ci >= 0 && cj >= 0 && ci < cols && cj < g.rows) m = mask[cj * cols + ci];
          if (m === MASK_HARD_CODE) continue;
          pushFree((touch.collarLv[k] - 1) * 2 + (m === MASK_SOFT_CODE ? 1 : 0), touch.collarX[k], touch.collarY[k]);
        }
      }
      let free = 0;
      for (let k = 0; k < 6; k++) {
        const m = fn[k];
        if (m === 0) continue;
        free += m;
        const r = FREE_R[k >> 1] * S;
        wc.fillStyle = waterStyles[k];
        wc.beginPath();
        const xs = fx[k];
        const ys = fy[k];
        for (let q = 0; q < m; q++) {
          wc.moveTo(xs[q] + r, ys[q]);
          wc.arc(xs[q], ys[q], r, 0, TAU);
        }
        wc.fill();
      }
      ren.freeDots = free;
    },
    clear() {
      rc.clearRect(rect.left, rect.top, rect.width, rect.height);
      wc.clearRect(rect.left, rect.top, rect.width, rect.height);
    },
    backingPx: () => rockCanvas.width * rockCanvas.height + waterCanvas.width * waterCanvas.height,
  };
  return ren;
}
