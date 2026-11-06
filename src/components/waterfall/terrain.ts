/**
 * terrain.ts — the seeded rock scene on the lattice, generated once per raster
 * key (Hs, Hf, S, variant, rock clip column). The cliff frames the fall
 * rather than filling the lane: a low left buttress, a taller right mass that
 * carries the stream in from the upper right, a brink lip and a recess behind
 * the sheet, with sky left above and to the right. Pieces are corner-rounded
 * polygons with midpoint-displaced edges, read as an engraving: crisp
 * silhouettes (edge cells always lit), seams between pieces, chiselled facets
 * hatched along their planes, a few cracks, a light from the upper left, and
 * wet, dark rock (denser, larger dots) beside and behind the fall, in the
 * splash zone and at the waterline.
 *
 * Also defines the pool: which cells are water, where boulders stand in it
 * (wave walls + foam collars) and how the lake fades out to the left.
 * Everything is a pure function of (seed, cell, Hs, Hf, S, variant, clip).
 */
import type { Layout } from './layout';
import type { SceneGrid } from './grid';
import { createRng, hash01, valueNoise1, type Rng } from '../tree/rng';
import { LAKE_FADE, ROCK_DOT_BUDGET, SEED, SPREAD, SUB } from './config';

export const OCC_NONE = 0;
export const OCC_ROCK = 1;
export const OCC_RECESS = 2;
export const ROCK_LEVELS = 5;
export const RL_LIGHT = 0;
export const RL_BASE = 1;
export const RL_DARK = 2;
export const RL_WET = 3;
export const RL_RECESS = 4;

export interface Boulder {
  x: number; // px relative to (x_f, y_s)
  y: number;
  r: number;
}

export interface Terrain {
  /** Lit rock cells by level (cell indices), and their total. */
  byLevel: Uint32Array[];
  levelN: Int32Array;
  rockN: number;
  /** All lit rock cells (for mask-change tracking). */
  rockCells: Uint32Array;
  /** 0 none, 1 rock (solid, lit or not), 2 recess. */
  occ: Uint8Array;
  /** 1 where the cell is pool water. */
  lake: Uint8Array;
  /** Wave walls (boulders under the surface, rock feet). */
  wall: Uint8Array;
  /** Foam collar cells (water next to a wall). */
  collar: Uint8Array;
  /** Per column: lake fade-in from the left, [0, 1]. */
  lakeFade: Float32Array;
  /** First lake row per column (far shoreline). */
  shoreRow: Int16Array;
  /** Approach channel cells (stream surface above the brink): band coordinate s along the channel, -1 outside. */
  chanS: Float32Array;
  boulders: Boulder[];
  hash: string;
}

type Pt = [number, number, number]; // x, y (Hs units), edge displacement amp (× base)

/** Midpoint displacement along each edge; vertices also get seeded jitter. */
function roughen(poly: Pt[], rng: Rng, amp: number, jitter: number): number[] {
  const out: number[] = [];
  const n = poly.length;
  const pts = poly.map(([x, y, a]) => [
    x + (a > 0 ? rng.float(-jitter, jitter) : 0),
    y + (a > 0 ? rng.float(-jitter, jitter) : 0),
    a,
  ]);
  const sub = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    a: number,
    depth: number,
  ): void => {
    if (depth === 0 || a <= 0) {
      out.push(x1, y1);
      return;
    }
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const off = rng.float(-a, a);
    const mx = (x0 + x1) / 2 + (-dy / len) * off;
    const my = (y0 + y1) / 2 + (dx / len) * off;
    sub(x0, y0, mx, my, a / 2, depth - 1);
    sub(mx, my, x1, y1, a / 2, depth - 1);
  };
  for (let k = 0; k < n; k++) {
    const p = pts[k];
    const q = pts[(k + 1) % n];
    if (k === 0) out.push(p[0], p[1]);
    sub(p[0], p[1], q[0], q[1], amp * p[2], 4);
  }
  out.length -= 2; // the last point repeats the first
  return out;
}

function inPoly(poly: number[], x: number, y: number): boolean {
  let inside = false;
  const n = poly.length;
  for (let a = 0, b = n - 2; a < n; b = a, a += 2) {
    const xa = poly[a];
    const ya = poly[a + 1];
    const xb = poly[b];
    const yb = poly[b + 1];
    if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa)
      inside = !inside;
  }
  return inside;
}

function bbox(poly: number[]): [number, number, number, number] {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < poly.length; k += 2) {
    x0 = Math.min(x0, poly[k]);
    x1 = Math.max(x1, poly[k]);
    y0 = Math.min(y0, poly[k + 1]);
    y1 = Math.max(y1, poly[k + 1]);
  }
  return [x0, y0, x1, y1];
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** One pass of Chaikin corner cutting: rounds corners, keeps edge amplitudes. */
function chaikin(poly: Pt[]): Pt[] {
  const out: Pt[] = [];
  const n = poly.length;
  for (let k = 0; k < n; k++) {
    const p = poly[k];
    const q = poly[(k + 1) % n];
    out.push(
      [0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1], p[2]],
      [0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1], q[2]],
    );
  }
  return out;
}

/**
 * Approach channel (Hs units): the stream's centreline from the brink up and
 * to the right, where it disappears behind the right mass, and its half width
 * (wide where it pours over the brink, narrow in the distance).
 */
export function channelLine(h: number): { pts: number[]; w0: number; w1: number } {
  const yL = -h;
  return {
    pts: [0, yL, 0.035, yL - 0.022, 0.08, yL - 0.058, 0.13, yL - 0.098, 0.17, yL - 0.122],
    w0: 0.048,
    w1: 0.014,
  };
}

/** s ∈ [0, 1] along the channel (0 at the brink) if (X, Y) is on it, else −1. */
function channelS(ch: { pts: number[]; w0: number; w1: number }, X: number, Y: number): number {
  const p = ch.pts;
  let total = 0;
  for (let k = 2; k < p.length; k += 2) total += Math.hypot(p[k] - p[k - 2], p[k + 1] - p[k - 1]);
  let best = Infinity;
  let bestS = 0;
  let run = 0;
  for (let k = 2; k < p.length; k += 2) {
    const ax = p[k - 2];
    const ay = p[k - 1];
    const dx = p[k] - ax;
    const dy = p[k + 1] - ay;
    const L = Math.hypot(dx, dy);
    const u = Math.min(1, Math.max(0, ((X - ax) * dx + (Y - ay) * dy) / (L * L)));
    const d = Math.hypot(X - ax - u * dx, Y - ay - u * dy);
    if (d < best) {
      best = d;
      bestS = (run + u * L) / total;
    }
    run += L;
  }
  // The brink end is cut flat at the lip row: nothing below it.
  if (Y > p[1] + 1e-6) return -1;
  const w = ch.w0 + (ch.w1 - ch.w0) * Math.pow(bestS, 0.8);
  return best <= w ? bestS : -1;
}

export function generateTerrain(l: Layout, g: SceneGrid): Terrain {
  const { Hs, S, W0, ppm } = l;
  const { cols, rows, n, ic, js } = g;
  const h = l.Hf / Hs;
  const yL = -h;
  const rng = createRng(SEED ^ SUB.terrain);
  const AMP = 0.012;
  const JIT = 0.01;

  // ── Pieces (front to back; the first piece containing a cell owns it) ─────
  const pieces: number[][] = [];
  const add = (pts: Pt[], amp = AMP, jit = JIT): void => {
    pieces.push(roughen(pts, rng, amp, jit));
  };
  // The cliff frames the fall instead of filling the lane: a low left
  // buttress, a taller right mass that carries the stream in from the upper
  // right, a short brink lip between them and a recess behind the sheet.
  // Clear sky stays above the brink and right of the cliff (the tree had air
  // around its crown). Edges run on diagonals and corners are rounded, so the
  // lattice never shows axis-aligned steps.
  // 1 Brink lip: slopes up into the right mass, lower on the left.
  add(
    chaikin([
      [-0.075, yL + 0.03, 0.5],
      [-0.05, yL + 0.006, 0],
      [0.045, yL - 0.004, 0.3],
      [0.085, yL - 0.03, 0.8],
      [0.1, yL + 0.035, 1],
      [0.05, yL + 0.07, 1],
      [-0.035, yL + 0.075, 1],
    ]),
    AMP * 0.8,
  );
  // Boulders: two at the left foot, two at the right jamb, two in the pool.
  const boulders: Boulder[] = [];
  const boulderDefs: [number, number, number][] = [
    [-0.215, 0.008, 0.03],
    [-0.255, 0.016, 0.02],
    [0.092, 0.016, 0.03],
    [0.14, 0.024, 0.02],
    [-0.15, 0.055, 0.03],
    [0.2, 0.085, 0.026],
  ];
  for (const [bx, by, br] of boulderDefs) {
    const pts: Pt[] = [];
    const m = 9;
    const ph = rng.float(0, Math.PI * 2);
    for (let k = 0; k < m; k++) {
      const a = ph + (k / m) * Math.PI * 2;
      const rr = br * rng.float(0.82, 1.08);
      // Flattened (perspective) and a little squarer on top.
      pts.push([bx + Math.cos(a) * rr * 1.15, by + Math.sin(a) * rr * 0.78, 0.5]);
    }
    add(pts, AMP * 0.5, 0.004);
    boulders.push({ x: bx * Hs, y: by * Hs, r: br * Hs });
  }
  const nFront = pieces.length;
  // Left buttress: its crest falls away from the brink in diagonal runs.
  add(
    chaikin([
      [-0.058, yL + 0.06, 0.6],
      [-0.085, yL + 0.1, 1],
      [-0.13, yL + 0.24 * h, 1],
      [-0.185, yL + 0.38 * h, 1],
      [-0.215, yL + 0.5 * h, 1],
      [-0.25, -0.16 * h, 1],
      [-0.27, 0.026, 0.6],
      [-0.07, 0.024, 1],
      [-0.068, -0.5 * h, 1],
    ]),
  );
  // A lower block stepping out of the buttress toward the shore.
  add(
    chaikin([
      [-0.165, yL + 0.55 * h, 1],
      [-0.12, yL + 0.5 * h, 1],
      [-0.1, -0.12 * h, 1],
      [-0.11, 0.024, 1],
      [-0.2, 0.026, 1],
      [-0.2, -0.2 * h, 1],
    ]),
  );
  // Right mass: crest up from the brink (the stream's far bank), then a
  // diagonal flank down to the pool well before the viewport edge.
  add(
    chaikin([
      [0.05, yL + 0.03, 1],
      [0.09, yL - 0.045, 1],
      [0.13, yL - 0.085, 1],
      [0.18, yL - 0.105, 1],
      [0.225, yL - 0.095, 1],
      [0.245, yL - 0.05, 1],
      [0.235, yL + 0.1 * h, 1],
      [0.25, yL + 0.3 * h, 1],
      [0.255, -0.2 * h, 1],
      [0.27, 0.026, 0.5],
      [0.07, 0.022, 1],
      [0.075, -0.3 * h, 1],
      [0.062, -0.7 * h, 1],
    ]),
    AMP * 1.2,
  );
  // A lower shelf stepping down to the right: the cliff ends well inside the lane.
  add(
    chaikin([
      [0.24, yL + 0.36 * h, 1],
      [0.285, yL + 0.42 * h, 1],
      [0.31, yL + 0.6 * h, 1],
      [0.335, -0.06 * h, 1],
      [0.35, 0.026, 0.6],
      [0.25, 0.026, 1],
    ]),
  );
  // Near bank of the stream above the brink, behind the channel.
  add(
    chaikin([
      [-0.05, yL + 0.004, 0.4],
      [0.02, yL - 0.03, 1],
      [0.08, yL - 0.072, 1],
      [0.14, yL - 0.11, 1],
      [0.15, yL - 0.095, 1],
      [0.08, yL - 0.045, 1],
      [0.02, yL - 0.01, 1],
    ]),
    AMP * 0.7,
  );
  const nPieces = pieces.length;
  const alcove = roughen(
    [
      [-0.06, yL + 0.07, 1],
      [0.06, yL + 0.07, 1],
      [0.072, 0.02, 1],
      [-0.07, 0.022, 1],
    ],
    rng,
    AMP * 0.6,
    0.004,
  );
  const chan = channelLine(h);
  const boxes = pieces.map(bbox);
  const chanBox = [-0.06, -h - 0.14, 0.19, -h + 0.001];
  const alcoveBox = bbox(alcove);

  // ── Coverage ──────────────────────────────────────────────────────────────
  const piece = new Uint8Array(n); // 0 none, k+1 piece
  const occ = new Uint8Array(n);
  const chanS = new Float32Array(n).fill(-1);
  const clipI = Number.isFinite(l.rockMinX)
    ? Math.ceil((l.rockMinX - l.xf) / S) + ic
    : -1;
  for (let j = 0; j < rows; j++) {
    const Y = ((j - js) * S) / Hs;
    for (let i = 0; i < cols; i++) {
      const X = ((i - ic) * S) / Hs;
      const c = j * cols + i;
      if (
        X >= chanBox[0] &&
        X <= chanBox[2] &&
        Y >= chanBox[1] &&
        Y <= chanBox[3]
      ) {
        // s ∈ [0, 1]: 0 at the brink, 1 at the far end of the channel.
        const cs = channelS(chan, X, Y);
        if (cs >= 0) {
          chanS[c] = cs;
          continue;
        }
      }
      if (i < clipI) continue;
      for (let k = 0; k < nPieces; k++) {
        const b = boxes[k];
        if (X < b[0] || X > b[2] || Y < b[1] || Y > b[3]) continue;
        if (inPoly(pieces[k], X, Y)) {
          piece[c] = k + 1;
          break;
        }
      }
      if (piece[c]) occ[c] = OCC_ROCK;
      else if (
        X >= alcoveBox[0] &&
        X <= alcoveBox[2] &&
        Y >= alcoveBox[1] &&
        Y <= alcoveBox[3] &&
        inPoly(alcove, X, Y)
      )
        occ[c] = OCC_RECESS;
    }
  }

  // Seams: a 1-cell gap where two pieces meet (right/down neighbour differs).
  const seam = new Uint8Array(n);
  for (let j = 0; j < rows - 1; j++)
    for (let i = 0; i < cols - 1; i++) {
      const c = j * cols + i;
      const p = piece[c];
      if (!p) continue;
      const pr = piece[c + 1];
      const pd = piece[c + cols];
      if ((pr && pr !== p) || (pd && pd !== p)) seam[c] = 1;
    }

  // ── Edge distance (two-pass chamfer, cells) ───────────────────────────────
  const BIG = 1e4;
  const d = new Float32Array(n);
  for (let c = 0; c < n; c++) d[c] = piece[c] && !seam[c] ? BIG : 0;
  const D1 = 1;
  const D2 = 1.414;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      if (!d[c]) continue;
      let v = d[c];
      if (i > 0) v = Math.min(v, d[c - 1] + D1);
      else v = Math.min(v, 1);
      if (j > 0) {
        v = Math.min(v, d[c - cols] + D1);
        if (i > 0) v = Math.min(v, d[c - cols - 1] + D2);
        if (i < cols - 1) v = Math.min(v, d[c - cols + 1] + D2);
      } else v = Math.min(v, 1);
      d[c] = v;
    }
  for (let j = rows - 1; j >= 0; j--)
    for (let i = cols - 1; i >= 0; i--) {
      const c = j * cols + i;
      if (!d[c]) continue;
      let v = d[c];
      if (i < cols - 1) v = Math.min(v, d[c + 1] + D1);
      else v = Math.min(v, 1);
      if (j < rows - 1) {
        v = Math.min(v, d[c + cols] + D1);
        if (i < cols - 1) v = Math.min(v, d[c + cols + 1] + D2);
        if (i > 0) v = Math.min(v, d[c + cols - 1] + D2);
      } else v = Math.min(v, 1);
      d[c] = v;
    }

  // ── Light: normal from a 5×5 box blur of occupancy ────────────────────────
  const solid = new Float32Array(n);
  for (let c = 0; c < n; c++) solid[c] = piece[c] && !seam[c] ? 1 : 0;
  const tmp = new Float32Array(n);
  const blur = new Float32Array(n);
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        const ii = Math.min(cols - 1, Math.max(0, i + k));
        s += solid[j * cols + ii];
      }
      tmp[j * cols + i] = s / 5;
    }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      let s = 0;
      for (let k = -2; k <= 2; k++) {
        const jj = Math.min(rows - 1, Math.max(0, j + k));
        s += tmp[jj * cols + i];
      }
      blur[j * cols + i] = s / 5;
    }
  const LX = -0.6;
  const LY = -0.8;
  const light = new Float32Array(n);
  for (let j = 1; j < rows - 1; j++)
    for (let i = 1; i < cols - 1; i++) {
      const c = j * cols + i;
      if (!solid[c]) continue;
      const gx = blur[c + 1] - blur[c - 1];
      const gy = blur[c + cols] - blur[c - cols];
      const m = Math.sqrt(gx * gx + gy * gy);
      if (m < 0.05) continue;
      // Outward normal is −∇occupancy; weight by how sharp the edge is.
      light[c] = ((-gx * LX - gy * LY) / m) * Math.min(1, m * 2.2);
    }

  // ── Cracks: seeded walks from top edges downward ──────────────────────────
  const crack = new Uint8Array(n);
  const crackRng = createRng(SEED ^ SUB.crack);
  const tops: number[] = [];
  for (let j = 1; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      if (solid[c] && !solid[c - cols] && piece[c] > nFront) tops.push(c);
    }
  const nCracks = tops.length ? crackRng.int(4, 7) : 0;
  for (let k = 0; k < nCracks; k++) {
    const start = tops[crackRng.int(0, tops.length - 1)];
    let x = start % cols;
    let y = Math.floor(start / cols) + 1;
    let ang = Math.PI / 2 + crackRng.float(-0.3, 0.3);
    const len = crackRng.int(6, 30);
    for (let s = 0; s < len; s++) {
      const ci = Math.round(x);
      const cj = Math.round(y);
      if (ci < 1 || ci >= cols - 1 || cj < 1 || cj >= rows - 1) break;
      const c = cj * cols + ci;
      if (!solid[c]) break;
      crack[c] = 1;
      ang += crackRng.float(-0.44, 0.44);
      ang = Math.min(Math.PI * 0.8, Math.max(Math.PI * 0.2, ang));
      x += Math.cos(ang);
      y += Math.sin(ang);
    }
  }

  // ── Wet mask and recess footprint ─────────────────────────────────────────
  const wet = new Uint8Array(n);
  const under = new Uint8Array(n); // behind the mean sheet
  const g0 = 9.81 * ppm;
  const v0y = 0.3 * ppm;
  const u0 = 1.2 * ppm;
  const rxI = 0.22 * Hs;
  const ryI = 0.12 * Hs;
  for (let j = 0; j < rows; j++) {
    const y = (j - js) * S; // px rel. y_s
    const yf = y + l.Hf; // px below the lip
    let xc = 0;
    let half = -1;
    if (yf > 0 && y < 0) {
      const tau = (-v0y + Math.sqrt(v0y * v0y + 2 * g0 * yf)) / g0;
      xc = -0.35 * u0 * tau;
      half = 0.5 * W0 * (1 + SPREAD * Math.pow(yf / l.Hf, 1.3));
    }
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      if (!occ[c]) continue;
      const x = (i - ic) * S;
      if (half > 0) {
        const ax = Math.abs(x - xc);
        if (ax < half + 0.25 * W0) wet[c] = 1;
        if (ax < half - S) under[c] = 1;
      }
      const ex = (x - (l.xi - l.xf)) / rxI;
      const ey = y / ryI;
      if (y <= 0 && ex * ex + ey * ey < 1) wet[c] = 1;
      if (j >= js - 2 && j <= js + 4) wet[c] = 1;
    }
  }
  // The lip top: the two rows of the ledge under and beside the brink.
  for (let j = 0; j < rows; j++) {
    const y = (j - js) * S + l.Hf;
    if (y < 0 || y > 2 * S) continue;
    for (let i = 0; i < cols; i++) {
      const x = (i - ic) * S;
      if (Math.abs(x) < 0.09 * Hs && piece[j * cols + i] === 1)
        wet[j * cols + i] = 1;
    }
  }

  // ── Fill + level, under the dot budget ────────────────────────────────────
  // Chiselled facets: a Worley partition (~0.07 Hs cells), each facet with its
  // own seeded normal, lit from the upper left. Tone sets density through a
  // 4×4 ordered dither, so a facet reads as one flat halftone plane and the
  // planes together read as broken rock. Silhouettes are always lit, seams
  // and cracks stay open, and the rock beside and behind the fall is wet and
  // dark so the white water reads against it.
  const level = new Uint8Array(n).fill(255);
  const budget = ROCK_DOT_BUDGET[l.variant];
  const fillSeed = SEED ^ SUB.fill;
  const darkNb = (c: number): boolean =>
    seam[c - 1] === 1 ||
    seam[c + 1] === 1 ||
    seam[c - cols] === 1 ||
    seam[c + cols] === 1 ||
    crack[c - 1] === 1 ||
    crack[c + 1] === 1 ||
    crack[c - cols] === 1 ||
    crack[c + cols] === 1;
  const F = 0.07 * Hs;
  const facet = new Float32Array(n);
  const hatch = new Float32Array(n); // hatch-line normal angle per facet
  for (let c = 0; c < n; c++) {
    if (!solid[c]) continue;
    const i = c % cols;
    const j = (c - i) / cols;
    const x = (i - ic) * S;
    const y = (j - js) * S;
    const gx = Math.floor(x / F);
    const gy = Math.floor(y / (0.8 * F));
    let best = Infinity;
    let bx = 0;
    let by = 0;
    for (let a = -1; a <= 1; a++)
      for (let bq = -1; bq <= 1; bq++) {
        const cx = (gx + a + 0.15 + 0.7 * hash01(gx + a, gy + bq, fillSeed)) * F;
        const cy = (gy + bq + 0.15 + 0.7 * hash01(gy + bq, gx + a, fillSeed ^ 0x3d)) * 0.8 * F;
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if (d2 < best) {
          best = d2;
          bx = gx + a;
          by = gy + bq;
        }
      }
    const ang = hash01(bx, by, SEED ^ SUB.bed) * Math.PI * 2;
    const tilt = 0.35 + 0.65 * hash01(by, bx, SEED ^ SUB.bed);
    facet[c] = (Math.cos(ang) * LX + Math.sin(ang) * LY) * tilt;
    // Engraver's hatching follows the plane: diagonal strokes 25–60° either way
    // (never level, which reads as text, nor upright, which reads as water).
    const hs = hash01(bx + 17, by - 5, SEED ^ SUB.crack);
    const la = (25 + 35 * ((hs * 2) % 1)) * (hs < 0.5 ? 1 : -1) * (Math.PI / 180);
    hatch[c] = la + Math.PI / 2;
  }
  const xL = -0.5 * W0; // fall edges at the lip (px rel. x_f)
  const xR = 0.5 * W0;
  let lower = 0;
  let count = 0;
  for (let pass = 0; pass < 12; pass++) {
    count = 0;
    level.fill(255);
    for (let j = 1; j < rows - 1; j++) {
      for (let i = 1; i < cols - 1; i++) {
        const c = j * cols + i;
        const o = occ[c];
        if (!o) continue;
        const u = hash01(i - ic, j - js, fillSeed);
        if (o === OCC_RECESS) {
          const yb = (j - js) * S; // undercut: bottom 0.12 Hf of the alcove is darker
          const p = (yb > -0.12 * l.Hf ? 0.3 : 0.2) - lower;
          if (u < p) level[c] = RL_RECESS;
          continue;
        }
        if (seam[c] || crack[c]) continue;
        const x = (i - ic) * S;
        const y = (j - js) * S;
        const dc = d[c];
        const L = light[c];
        const wetC = wet[c] === 1;
        // Tone: 0 lit … 1 dark.
        let tone = 0.5 - 0.5 * (0.7 * facet[c] + 0.55 * L);
        // Form shadow: faces right of the fall turn away from the upper-left light.
        tone += 0.28 * Math.min(1, Math.max(-0.6, (x - 0.06 * Hs) / (0.22 * Hs)));
        // Jambs: the rock flanking the fall is in its own shadow.
        const jamb = Math.min(Math.abs(x - xL), Math.abs(x - xR));
        if (y > -l.Hf && jamb < 0.07 * Hs) tone += 0.25 * (1 - jamb / (0.07 * Hs));
        // Under the brink lip.
        if (y > -l.Hf + 0.06 * Hs && y < -l.Hf + 0.11 * Hs) tone += 0.15;
        if (darkNb(c)) tone += 0.3;
        tone = Math.min(1, Math.max(0, tone));
        const edge = dc <= 1.5;
        if (!edge) {
          let p = 0.04 + 0.78 * Math.pow(tone, 1.4);
          if (wetC) p += 0.18;
          if (dc <= 2.6) p += 0.2;
          p -= lower;
          // Hatch lines every 3 cells; darker planes draw thicker lines.
          const a = hatch[c];
          const hv = (x * Math.cos(a) + y * Math.sin(a)) / (3 * S);
          const th = hv - Math.floor(hv);
          if (th + 0.1 * (u - 0.5) >= p) continue;
        }
        let lv = RL_BASE;
        if (under[c]) lv = RL_RECESS;
        else if (wetC) lv = RL_WET;
        else if (tone < 0.3 || (edge && L > 0.25)) lv = RL_LIGHT;
        else if (tone > 0.6) lv = RL_DARK;
        level[c] = lv;
        count++;
      }
    }
    if (count <= budget) break;
    lower += 0.04;
  }
  // No lone lit dots: a light cell needs two lit neighbours (of 8).
  for (let j = 1; j < rows - 1; j++)
    for (let i = 1; i < cols - 1; i++) {
      const c = j * cols + i;
      if (level[c] !== RL_LIGHT || d[c] <= 1.5) continue;
      let nb = 0;
      for (let b = -1; b <= 1; b++)
        for (let a = -1; a <= 1; a++)
          if ((a || b) && level[c + b * cols + a] !== 255) nb++;
      if (nb < 2) {
        level[c] = 255;
        count--;
      }
    }

  // ── Lake: far shoreline, fade, walls, collars ─────────────────────────────
  const lake = new Uint8Array(n);
  const wall = new Uint8Array(n);
  const collar = new Uint8Array(n);
  const shoreRow = new Int16Array(cols);
  const lakeFade = new Float32Array(cols);
  const fadeLen = LAKE_FADE * Hs;
  // With a scene lane the pool starts at the same clear line as the rocks, so
  // the water never runs in behind the text column; it fades in from there.
  const fade0 = Math.max(0, clipI) * S;
  for (let i = 0; i < cols; i++) {
    // An irregular far shore: long swells plus short bites, never a ruled line.
    shoreRow[i] =
      js +
      Math.round(
        valueNoise1((i - ic) * 0.06, SEED ^ SUB.shore) * 1.6 +
          valueNoise1((i - ic) * 0.23, SEED ^ SUB.shore ^ 0x9) * 0.8,
      );
    lakeFade[i] = smoothstep(fade0, fade0 + fadeLen, i * S);
  }
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const c = j * cols + i;
      if (j < shoreRow[i]) continue;
      if (occ[c] === OCC_ROCK) {
        wall[c] = 1;
        continue;
      }
      lake[c] = 1;
    }
  for (const b of boulders) {
    // The submerged lower half is a wall for the waves.
    const bi = b.x / S + ic;
    const bj = b.y / S + js;
    const rx = (b.r * 1.15) / S;
    const ry = (b.r * 0.6) / S;
    for (let j = Math.floor(bj); j <= Math.ceil(bj + ry); j++)
      for (let i = Math.floor(bi - rx); i <= Math.ceil(bi + rx); i++) {
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        const ex = (i - bi) / rx;
        const ey = (j - bj) / ry;
        if (ex * ex + ey * ey <= 1) {
          wall[j * cols + i] = 1;
          lake[j * cols + i] = 0;
        }
      }
  }
  for (let j = 1; j < rows - 1; j++)
    for (let i = 1; i < cols - 1; i++) {
      const c = j * cols + i;
      if (!lake[c]) continue;
      if (wall[c - 1] || wall[c + 1] || wall[c + cols] || wall[c - cols])
        collar[c] = 1;
    }

  // ── Lists + hash ──────────────────────────────────────────────────────────
  const levelN = new Int32Array(5);
  for (let c = 0; c < n; c++) if (level[c] !== 255) levelN[level[c]]++;
  const byLevel: Uint32Array[] = [];
  for (let k = 0; k < 5; k++) byLevel.push(new Uint32Array(levelN[k]));
  const fillN = new Int32Array(5);
  const rockCells = new Uint32Array(count + levelN[RL_RECESS]);
  let rc = 0;
  let hsh = 0x811c9dc5;
  const mix = (v: number): void => {
    for (let b = 0; b < 4; b++) {
      hsh ^= (v >>> (b * 8)) & 0xff;
      hsh = Math.imul(hsh, 0x01000193);
    }
  };
  let total = 0;
  for (let c = 0; c < n; c++) if (level[c] !== 255) total++;
  mix(total);
  mix(S);
  mix(l.variant === 'desktop' ? 1 : 2);
  for (let c = 0; c < n; c++) {
    const lv = level[c];
    if (lv === 255) continue;
    byLevel[lv][fillN[lv]++] = c;
    if (rc < rockCells.length) rockCells[rc++] = c;
    mix((c % cols) - ic);
    mix(Math.floor(c / cols) - js);
    mix(lv);
  }
  return {
    byLevel,
    levelN,
    rockN: total,
    rockCells: rockCells.subarray(0, rc),
    occ,
    lake,
    wall,
    collar,
    lakeFade,
    shoreRow,
    chanS,
    boulders,
    hash: (hsh >>> 0).toString(16).padStart(8, '0'),
  };
}
