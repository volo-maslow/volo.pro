/**
 * rasterize.ts — turns the rest skeleton into a dot field on a grid anchored to
 * the tree root (cell (col,row) rests at root + (col*S, row*S)). The raster is
 * translation-independent; the hash is FNV-1a over integer cells, so it is
 * identical across browsers and viewport offsets. Also owns the content-safe mask.
 */
import type { Skeleton } from './skeleton';
import type { BBox, Layout } from './layout';
import { createPose, solveRest } from './pose';
import { hash01, valueNoise2 } from './rng';
import { DOT_BUDGET, MASK_FEATHER, MASK_INFLATE } from './config';

/** Mask codes: 0 = full, 1 = soft (MASK_SOFT), 2 = hard (not drawn). */
export const MASK_FULL = 0;
export const MASK_SOFT_CODE = 1;
export const MASK_HARD_CODE = 2;
/** Draw code = bucket * 2 + (soft ? 1 : 0). */
export const DRAW_CODES = 8;

export interface DotField {
  n: number;
  S: number;
  anchor: Uint16Array;
  lx: Float32Array;
  ly: Float32Array;
  r: Float32Array;
  bucket: Uint8Array;
  mask: Uint8Array;
  flutterAmp: Float32Array;
  fPhase: Float32Array;
  hidden: Uint8Array;
  /** Rest position relative to the root (CSS px). */
  restX: Float32Array;
  restY: Float32Array;
  col: Int16Array;
  row: Int16Array;
  byDraw: Uint32Array[];
  driftCandidates: Uint32Array;
  restBBox: BBox;
}

export interface AvoidRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** MASK_SOFT_CODE or MASK_HARD_CODE. */
  level: number;
}

const OFF = 32768;
const cellKey = (col: number, row: number): number =>
  (col + OFF) * 65536 + (row + OFF);

interface Cell {
  col: number;
  row: number;
  anchor: number;
  bucket: number;
  r: number;
  foliage: boolean;
  dist: number;
}

function rasterizeAt(
  sk: Skeleton,
  H: number,
  S: number,
  seed: number,
): DotField {
  const rest = createPose(sk);
  solveRest(sk, rest, 0, 0, H);
  const cells: Cell[] = [];
  const occ = new Map<number, number>();

  // ── Wood: distance to each joint segment, nearest owner wins ──────────────
  for (let j = 0; j < sk.nJ; j++) {
    const L = sk.len[j] * H;
    const half = Math.max(sk.thick[j] * H, 0.95 * S) / 2;
    const x0 = rest.ox[j];
    const y0 = rest.oy[j];
    const dx = rest.c[j];
    const dy = rest.s[j];
    const x1 = x0 + dx * L;
    const y1 = y0 + dy * L;
    const c0 = Math.floor((Math.min(x0, x1) - half) / S);
    const c1 = Math.ceil((Math.max(x0, x1) + half) / S);
    const r0 = Math.floor((Math.min(y0, y1) - half) / S);
    const r1 = Math.ceil((Math.max(y0, y1) + half) / S);
    for (let col = c0; col <= c1; col++) {
      for (let row = r0; row <= r1; row++) {
        const px = col * S - x0;
        const py = row * S - y0;
        const t = (px * dx + py * dy) / L;
        const tc = t < 0 ? 0 : t > 1 ? 1 : t;
        const d = Math.hypot(px - dx * tc * L, py - dy * tc * L);
        if (d >= half) continue;
        // Seam rule: overhang before the segment start belongs to the parent.
        const owner = t < 0 && sk.parent[j] >= 0 ? sk.parent[j] : j;
        const key = cellKey(col, row);
        const idx = occ.get(key);
        if (idx === undefined) {
          occ.set(key, cells.length);
          cells.push({
            col,
            row,
            anchor: owner,
            bucket: 0,
            r: 0,
            foliage: false,
            dist: d,
          });
        } else {
          const e = cells[idx];
          if (
            d < e.dist - 1e-9 ||
            (Math.abs(d - e.dist) <= 1e-9 &&
              sk.order[owner] > sk.order[e.anchor])
          ) {
            e.anchor = owner;
            e.dist = d;
          }
        }
      }
    }
  }
  for (const c of cells) {
    const trunk = sk.order[c.anchor] === 0;
    c.bucket = trunk ? 0 : 1;
    c.r = (trunk ? 0.34 : 0.31) * S;
  }

  // ── Foliage: noisy discs per cluster, integer-cell hashes only ────────────
  const J = sk.nJ;
  for (let k = 0; k < sk.nC; k++) {
    const cx = rest.ax[J + k];
    const cy = rest.ay[J + k];
    const R = sk.cR[k] * H;
    const Rmax = R * 1.25;
    const c0 = Math.floor((cx - Rmax) / S);
    const c1 = Math.ceil((cx + Rmax) / S);
    const r0 = Math.floor((cy - Rmax) / S);
    const r1 = Math.ceil((cy + Rmax) / S);
    for (let col = c0; col <= c1; col++) {
      for (let row = r0; row <= r1; row++) {
        const key = cellKey(col, row);
        if (occ.has(key)) continue; // wood (or an earlier cluster) wins
        const px = col * S - cx;
        const py = row * S - cy;
        const d = Math.hypot(px, py);
        if (d > Rmax) continue;
        const ang = Math.atan2(py, px);
        const angular =
          valueNoise2(
            Math.cos(ang) * 1.6 + k * 7.31,
            Math.sin(ang) * 1.6,
            seed ^ 0x2c1b,
          ) *
            2 -
          1;
        const Reff = R * (1 + 0.25 * angular);
        if (d >= Reff) continue;
        const u = d / Reff;
        const clumpN =
          valueNoise2(col * 0.21, row * 0.21, seed ^ 0x51ed) * 0.65 +
          valueNoise2(col * 0.47, row * 0.47, seed ^ 0x7a3) * 0.35;
        const clump = 0.45 + 0.7 * clumpN;
        if (hash01(col, row, seed) >= 0.82 * Math.sqrt(1 - u * u) * clump)
          continue;
        const light = hash01(col, row, seed ^ 0x1234) >= 0.7;
        const small = hash01(col, row, seed ^ 0x4321) < 0.2;
        occ.set(key, cells.length);
        cells.push({
          col,
          row,
          anchor: J + k,
          bucket: light ? 3 : 2,
          r: (small ? 0.22 : 0.3) * S,
          foliage: true,
          dist: d,
        });
      }
    }
  }

  // ── Pack into typed arrays ────────────────────────────────────────────────
  const n = cells.length;
  const f: DotField = {
    n,
    S,
    anchor: new Uint16Array(n),
    lx: new Float32Array(n),
    ly: new Float32Array(n),
    r: new Float32Array(n),
    bucket: new Uint8Array(n),
    mask: new Uint8Array(n),
    flutterAmp: new Float32Array(n),
    fPhase: new Float32Array(n),
    hidden: new Uint8Array(n),
    restX: new Float32Array(n),
    restY: new Float32Array(n),
    col: new Int16Array(n),
    row: new Int16Array(n),
    byDraw: [],
    driftCandidates: new Uint32Array(0),
    restBBox: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let fMinX = Infinity;
  let fMaxX = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = cells[i];
    const x = c.col * S;
    const y = c.row * S;
    const a = c.anchor;
    const ddx = x - rest.ax[a];
    const ddy = y - rest.ay[a];
    f.anchor[i] = a;
    f.lx[i] = rest.ac[a] * ddx + rest.as[a] * ddy;
    f.ly[i] = -rest.as[a] * ddx + rest.ac[a] * ddy;
    f.r[i] = c.r;
    f.bucket[i] = c.bucket;
    f.restX[i] = x;
    f.restY[i] = y;
    f.col[i] = c.col;
    f.row[i] = c.row;
    if (c.foliage && hash01(c.col, c.row, seed ^ 0x6f1) < 0.06) {
      f.flutterAmp[i] = 0.6 + 0.8 * hash01(c.col, c.row, seed ^ 0x6f2);
      f.fPhase[i] = Math.PI * 2 * hash01(c.col, c.row, seed ^ 0x6f3);
    }
    minX = Math.min(minX, x - c.r);
    maxX = Math.max(maxX, x + c.r);
    minY = Math.min(minY, y - c.r);
    maxY = Math.max(maxY, y + c.r);
    if (c.foliage) {
      fMinX = Math.min(fMinX, x);
      fMaxX = Math.max(fMaxX, x);
    }
  }
  f.restBBox = { minX, minY, maxX, maxY };
  // Leeward (wind blows +x) outer 25% of the canopy.
  const leeward = fMaxX - 0.25 * (fMaxX - fMinX);
  const drift: number[] = [];
  for (let i = 0; i < n; i++)
    if (cells[i].foliage && f.restX[i] >= leeward) drift.push(i);
  f.driftCandidates = Uint32Array.from(drift);
  rebuildDraw(f);
  return f;
}

/** Rasterize at layout.S, stepping the pitch up until the dot budget fits. */
export function rasterize(
  sk: Skeleton,
  layout: Layout,
  seed: number,
): DotField {
  const budget = DOT_BUDGET[layout.variant];
  let S = layout.S;
  let field = rasterizeAt(sk, layout.H, S, seed);
  while (field.n > budget && S < layout.S + 6) {
    S += 1;
    field = rasterizeAt(sk, layout.H, S, seed);
  }
  return field;
}

/** Rebuild per-draw-code index lists from bucket and mask (O(N)). */
export function rebuildDraw(f: DotField): void {
  const counts = new Uint32Array(DRAW_CODES);
  for (let i = 0; i < f.n; i++) {
    const m = f.mask[i];
    if (m === MASK_HARD_CODE) continue;
    counts[f.bucket[i] * 2 + m]++;
  }
  const lists: Uint32Array[] = [];
  for (let c = 0; c < DRAW_CODES; c++) lists.push(new Uint32Array(counts[c]));
  counts.fill(0);
  for (let i = 0; i < f.n; i++) {
    const m = f.mask[i];
    if (m === MASK_HARD_CODE) continue;
    const code = f.bucket[i] * 2 + m;
    lists[code][counts[code]++] = i;
  }
  f.byDraw = lists;
}

/** Quantized content-safe mask from rest positions against avoid rects. Returns true if it changed. */
export function applyMask(
  f: DotField,
  layout: Layout,
  rects: readonly AvoidRect[],
): boolean {
  let changed = false;
  for (let i = 0; i < f.n; i++) {
    const x = layout.rootX + f.restX[i];
    const y = layout.rootY + f.restY[i];
    let level = MASK_FULL;
    for (let k = 0; k < rects.length && level !== MASK_HARD_CODE; k++) {
      const rc = rects[k];
      const l = rc.x - MASK_INFLATE;
      const t = rc.y - MASK_INFLATE;
      const r = rc.x + rc.w + MASK_INFLATE;
      const b = rc.y + rc.h + MASK_INFLATE;
      if (x >= l && x <= r && y >= t && y <= b) {
        level = Math.max(level, rc.level);
      } else if (
        rc.level === MASK_HARD_CODE &&
        x >= l - MASK_FEATHER &&
        x <= r + MASK_FEATHER &&
        y >= t - MASK_FEATHER &&
        y <= b + MASK_FEATHER
      ) {
        level = Math.max(level, MASK_SOFT_CODE);
      }
    }
    if (f.mask[i] !== level) {
      f.mask[i] = level;
      changed = true;
    }
  }
  if (changed) rebuildDraw(f);
  return changed;
}

/** FNV-1a over sorted (col,row,bucket) plus N, S and the variant. */
export function fieldHash(f: DotField, layout: Layout): string {
  const keys = new Float64Array(f.n);
  for (let i = 0; i < f.n; i++)
    keys[i] = cellKey(f.col[i], f.row[i]) * 4 + f.bucket[i];
  keys.sort();
  let h = 0x811c9dc5;
  const mix = (v: number): void => {
    for (let b = 0; b < 4; b++) {
      h ^= (v >>> (b * 8)) & 0xff;
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(f.n);
  mix(f.S);
  mix(layout.variant === 'desktop' ? 1 : 2);
  for (let i = 0; i < f.n; i++) {
    const k = keys[i];
    const bucket = k % 4;
    const cell = (k - bucket) / 4;
    mix(Math.floor(cell / 65536) - OFF);
    mix((cell % 65536) - OFF);
    mix(bucket);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
