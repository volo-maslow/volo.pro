/**
 * lake.ts — the plunge pool. A height field h on the lattice obeys the wave
 * equation with per-row anisotropy (perspective: rings are flat ellipses far
 * away and rounder near the viewer) at a fixed 30 Hz. Ring speed is LAKE.speed,
 * 0.8 m/s, the speed of λ ≈ 40 cm gravity waves (≈ 82 px/s sim, ≈ 49 px/s on
 * screen at 1440 × 900; see the note in config.ts).
 * Sponges absorb at the left, right and bottom; the far shore reflects weakly;
 * boulders are walls, so rings diffract around them.
 *
 * Foam is a second field advected by the outflow current; it piles up in
 * front of boulders. Shading turns slope, foam, a calm dash texture, gust
 * ruffles and rock / water reflections (broken up by the ripples) into V.
 */
import type { Layout } from './layout';
import type { SceneGrid } from './grid';
import type { Terrain } from './terrain';
import type { WaterSink } from './particles';
import { OCC_RECESS, OCC_ROCK } from './terrain';
import { hash01, valueNoise2 } from '../tree/rng';
import { AIR, FOAM, LAKE, SEED, SUB, TIME_SCALE } from './config';

export interface Lake extends WaterSink {
  j0: number;
  h: Float32Array;
  foam: Float32Array;
  wind: number;
  step(dt: number, ts: number, qImp: number, stepIdx: number): void;
  shade(g: SceneGrid, ts: number): void;
  /** Seiche impulse (scroll slosh): h += amp·cos(π·colFrac). */
  slosh(amp: number): void;
  clear(): void;
  scale(f: number): void;
}

const S_DASH = SEED ^ SUB.dash;
const S_FOAM = SEED ^ SUB.foam;

export function createLake(l: Layout, g: SceneGrid, t: Terrain, wBot: number): Lake {
  const { S, Hs, ppm } = l;
  const { cols, rows, js, ic } = g;
  let j0 = rows;
  for (let i = 0; i < cols; i++) j0 = Math.min(j0, t.shoreRow[i]);
  const lr = rows - j0; // lake rows
  const n = lr * cols;
  let h = new Float32Array(n);
  let hp = new Float32Array(n);
  let foam = new Float32Array(n);
  let foam2 = new Float32Array(n);
  const live = new Uint8Array(n);
  const wall = new Uint8Array(n);
  const damp = new Float32Array(n);
  const fu = new Float32Array(n); // foam current, cells per sim s
  const fv = new Float32Array(n);
  const foamSrc = new Float32Array(n);
  const cx2 = new Float32Array(lr);
  const cy2 = new Float32Array(lr);
  const rowFrac = new Float32Array(lr);
  const xiRel = l.xi - l.xf;
  const reachRows = Math.ceil((LAKE.reflectReach * Hs) / S);
  const boilRx = 0.6 * wBot + 0.03 * Hs;
  for (let r = 0; r < lr; r++) {
    rowFrac[r] = lr > 1 ? r / (lr - 1) : 0;
    const a = LAKE.aFar + (LAKE.aNear - LAKE.aFar) * rowFrac[r];
    // c per step at 30 Hz in cells; the sim clock is applied in step().
    cx2[r] = 1;
    cy2[r] = a * a;
  }
  for (let r = 0; r < lr; r++)
    for (let i = 0; i < cols; i++) {
      const k = r * cols + i;
      const c = (r + j0) * cols + i;
      live[k] = t.lake[c];
      wall[k] = t.wall[c];
      const de = Math.min(i, cols - 1 - i, lr - 1 - r);
      damp[k] = de < LAKE.sponge ? Math.pow(0.9, LAKE.sponge - de) : 1;
      // Outflow: radial from the impact, biased down-left, fading with distance.
      const x = (i - ic) * S - xiRel;
      const y = (r + j0 - js) * S + 0.04 * Hs;
      const d = Math.sqrt(x * x + y * y) + 1;
      const fall = Math.exp(-d / (FOAM.reach * Hs));
      const sp = FOAM.current * ppm * fall;
      fu[k] = ((x / d) * sp - 0.35 * sp) / S;
      fv[k] = ((y / d) * sp * 0.6 + 0.25 * sp) / S;
      const ex = ((i - ic) * S - xiRel) / boilRx;
      const ey = ((r + j0 - js) * S) / (0.03 * Hs);
      const e2 = ex * ex + ey * ey;
      if (e2 < 1 && live[k]) foamSrc[k] = 1 - e2;
      const exr = ((i - ic) * S - (xiRel - 0.08 * Hs)) / (0.06 * Hs);
      const eyr = ((r + j0 - js) * S - 0.022 * Hs) / (0.016 * Hs);
      const r2 = exr * exr + eyr * eyr;
      if (r2 < 1 && live[k]) foamSrc[k] = Math.max(foamSrc[k], 0.5 * (1 - r2));
    }
  // Zero the current just upstream of walls so foam piles up against boulders.
  for (let r = 0; r < lr; r++)
    for (let i = 1; i < cols - 1; i++) {
      const k = r * cols + i;
      if (!live[k]) continue;
      if ((fu[k] > 0 && wall[k + 1]) || (fu[k] < 0 && wall[k - 1])) fu[k] = 0;
      if (r < lr - 1 && fv[k] > 0 && wall[k + cols]) fv[k] = 0;
    }
  const forceIdx: number[] = [];
  for (let k = 0; k < n; k++) if (foamSrc[k] > 0.3 && live[k]) forceIdx.push(k);
  const force = Uint32Array.from(forceIdx);
  const cWave = LAKE.speed * ppm; // px per sim s

  const at = (x: number, y: number): number => {
    const i = Math.round((x - g.gx0) / S);
    const j = Math.round((y - g.gy0) / S);
    if (i < 0 || i >= cols || j < j0 || j >= rows) return -1;
    return (j - j0) * cols + i;
  };

  const lake: Lake = {
    j0,
    h,
    foam,
    wind: 0,
    isWater(x, y) {
      const k = at(x, y);
      return k >= 0 && live[k] === 1;
    },
    impulse(x, y, amp, sigma) {
      const ci = (x - g.gx0) / S;
      const cj = (y - g.gy0) / S - j0;
      const rad = Math.ceil(sigma * 2.5);
      const i0 = Math.max(0, Math.floor(ci) - rad);
      const i1 = Math.min(cols - 1, Math.ceil(ci) + rad);
      const r0 = Math.max(0, Math.floor(cj) - rad);
      const r1 = Math.min(lr - 1, Math.ceil(cj) + rad);
      const is2 = 1 / (2 * sigma * sigma);
      for (let r = r0; r <= r1; r++)
        for (let i = i0; i <= i1; i++) {
          const k = r * cols + i;
          if (!live[k]) continue;
          const dx = i - ci;
          // Perspective: the footprint is flattened like the rings.
          const dy = (r - cj) / (LAKE.aFar + (LAKE.aNear - LAKE.aFar) * rowFrac[r]);
          h[k] += amp * Math.exp(-(dx * dx + dy * dy * 0.25) * is2);
        }
    },
    step(dt, ts, qImp, stepIdx) {
      // Turbulent forcing at the plunge: a few seeded slugs per step.
      if (qImp > 0.01 && force.length) {
        for (let m = 0; m < 3; m++) {
          const k = force[Math.floor(hash01(stepIdx, m, S_FOAM) * force.length)];
          const i = k % cols;
          const r = (k - i) / cols;
          lake.impulse(
            g.gx0 + i * S,
            g.gy0 + (r + j0) * S,
            LAKE.forcing * qImp * (hash01(stepIdx, m + 7, S_FOAM) - 0.6) * 2,
            1.1,
          );
        }
      }
      const c = (cWave * dt) / S;
      const c2 = c * c;
      const dampStep = Math.pow(LAKE.damp, dt / (TIME_SCALE / 30));
      const refl = LAKE.shoreReflect;
      for (let r = 0; r < lr; r++) {
        const ax = c2 * cx2[r];
        const ay = c2 * cy2[r];
        for (let i = 0; i < cols; i++) {
          const k = r * cols + i;
          if (!live[k]) {
            hp[k] = 0;
            continue;
          }
          const hc = h[k];
          // Walls, rock feet and the grid sides reflect (Neumann); sponges absorb.
          const hl = i > 0 && live[k - 1] ? h[k - 1] : hc;
          const hr = i < cols - 1 && live[k + 1] ? h[k + 1] : hc;
          const hu = r > 0 && live[k - cols] ? h[k - cols] : r > 0 && wall[k - cols] ? hc : hc * refl;
          const hd = r < lr - 1 && live[k + cols] ? h[k + cols] : r < lr - 1 && wall[k + cols] ? hc : 0;
          const nh =
            2 * hc - hp[k] + ax * (hl + hr - 2 * hc) + ay * (hu + hd - 2 * hc);
          hp[k] = nh * dampStep * damp[k];
        }
      }
      const tmp = h;
      h = hp;
      hp = tmp;
      lake.h = h;

      // Foam: semi-Lagrangian advection by the current + breeze, decay, source.
      const decay = Math.exp(-dt / FOAM.tau);
      const breeze = (0.3 * (AIR.breeze + AIR.gust * lake.wind) * ppm) / S;
      const src = Math.max(0, qImp) * dt * 1.6;
      for (let r = 0; r < lr; r++)
        for (let i = 0; i < cols; i++) {
          const k = r * cols + i;
          if (!live[k]) {
            foam2[k] = 0;
            continue;
          }
          let sx = i - (fu[k] + breeze) * dt;
          let sy = r - fv[k] * dt;
          sx = sx < 0 ? 0 : sx > cols - 1.001 ? cols - 1.001 : sx;
          sy = sy < 0 ? 0 : sy > lr - 1.001 ? lr - 1.001 : sy;
          const x0 = sx | 0;
          const y0 = sy | 0;
          const fx = sx - x0;
          const fy = sy - y0;
          const o = y0 * cols + x0;
          const a = foam[o] + (foam[o + 1] - foam[o]) * fx;
          const b = foam[o + cols] + (foam[o + cols + 1] - foam[o + cols]) * fx;
          let f = (a + (b - a) * fy) * decay;
          const fs = foamSrc[k];
          if (fs > 0) {
            // Patchy source: noise in space and time leaves trails, not a disc.
            const nz = valueNoise2(i * 0.45 + ts * 0.9, r * 0.9 - ts * 0.5, S_FOAM);
            f += src * fs * (nz > 0.45 ? (nz - 0.45) * 3.2 : 0);
          }
          foam2[k] = f > 1.2 ? 1.2 : f;
        }
      const tf = foam;
      foam = foam2;
      foam2 = tf;
      lake.foam = foam;
    },
    shade(gr, ts) {
      const { V, Vprev } = gr;
      const occ = t.occ;
      const fade = t.lakeFade;
      const collar = t.collar;
      const jA = Math.max(j0, gr.vj0);
      const jB = Math.min(rows - 1, gr.vj1 - 1);
      const iA = Math.max(1, gr.vi0);
      const iB = Math.min(cols - 2, gr.vi1 - 1);
      const wind = lake.wind;
      const drift = ts * 0.35;
      const cat = (AIR.breeze + AIR.gust * wind) * ppm * 0.6;
      const catOn = wind > 0.05;
      for (let j = jA; j <= jB; j++) {
        const r = j - j0;
        const rf = rowFrac[r];
        const fres = 1 - 0.55 * rf;
        const sxr = 0.3 + (0.12 - 0.3) * rf;
        const refRow = j - js < reachRows ? 2 * js - j - 1 : -1;
        const refAtt = 0.45 * fres * (1 - (j - js) / reachRows);
        const row = j * gr.cols;
        for (let i = iA; i <= iB; i++) {
          const k = r * cols + i;
          if (!live[k]) continue;
          const fa = fade[i];
          if (fa <= 0.01) continue;
          const hh = h[k];
          const sl = (r < lr - 1 && live[k + cols] ? h[k + cols] : hh) - (r > 0 && live[k - cols] ? h[k - cols] : hh);
          const tilt = (live[k + 1] ? h[k + 1] : hh) - (live[k - 1] ? h[k - 1] : hh);
          // Calm water: horizontal dashes, longer toward the viewer, drifting slowly.
          const dn = valueNoise2(i * sxr - drift * sxr + tilt * 1.5, j * 1.0 + sl * 1.2, S_DASH);
          let v = dn > 0.62 && sl > -0.03 ? 0.16 * fres + (dn - 0.62) * 0.4 : 0;
          // Ripples: the crest facing the viewer jumps two levels, the trough
          // behind it clears, so a ring survives the lattice as a thin ellipse.
          if (sl > 0.03) v += 0.3 + 1.6 * sl;
          v += 0.2 * (tilt < 0 ? -tilt : tilt) + 0.85 * foam[k];
          if (collar[(j) * cols + i]) v += 0.22 + 0.6 * Math.min(0.5, Math.abs(hh));
          if (catOn) {
            const cn = valueNoise2(i * 0.5 - (ts * cat) / S, j * 0.8, S_DASH ^ 0x77);
            if (cn > 0.55) v += 0.12 * wind * 2;
          }
          if (refRow >= 0 && ((j - js) & 1) === 0) {
            // Every other row: a broken, flipped image of the fall and cliff.
            // Mirror about the waterline, shifted sideways by the local tilt.
            const si = i + Math.round(3 * tilt);
            if (si >= 0 && si < cols) {
              const src = refRow * cols + si;
              const o = occ[src];
              const rv = Vprev[src] + (o === OCC_ROCK ? 0.35 : o === OCC_RECESS ? 0.2 : 0);
              v += rv * refAtt * 0.7;
            }
          }
          V[row + i] += v * fa;
        }
      }
    },
    slosh(amp) {
      for (let r = 0; r < lr; r++)
        for (let i = 0; i < cols; i++) {
          const k = r * cols + i;
          if (live[k]) h[k] += amp * Math.cos((Math.PI * i) / (cols - 1));
        }
    },
    clear() {
      h.fill(0);
      hp.fill(0);
      foam.fill(0);
      foam2.fill(0);
    },
    scale(f) {
      for (let k = 0; k < n; k++) {
        h[k] *= f;
        hp[k] *= f;
      }
    },
  };
  return lake;
}
