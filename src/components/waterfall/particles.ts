/**
 * particles.ts — free droplets (off-lattice dots, like the tree's detached
 * leaves): breakup drops shed by the ropes, impact spray, pointer splashes and
 * pebble crowns. Structure-of-arrays pool with a free stack, fixed 60 Hz step,
 * quadratic drag toward the local air velocity, and three ways to end: into
 * the pool (a small ring), onto rock (a rare tiny bounce), or as mist.
 *
 * Spawn randomness is keyed by (step index, counter), so a replay from the
 * same step sequence spawns the same droplets.
 */
import type { Layout } from './layout';
import type { SceneGrid } from './grid';
import type { Terrain } from './terrain';
import { OCC_ROCK } from './terrain';
import { hash01 } from '../tree/rng';
import { DRAG, G_MS, SEED, SUB } from './config';

export interface AirSampler {
  /** Air velocity (px/s sim) at (x, y) → writes ax, ay. */
  airAt(x: number, y: number): void;
  ax: number;
  ay: number;
  deposit(x: number, y: number, amt: number): void;
}

export interface WaterSink {
  /** Gaussian height impulse at viewport (x, y). */
  impulse(x: number, y: number, amp: number, sigmaCells: number): void;
  isWater(x: number, y: number): boolean;
}

export interface Particles {
  cap: number;
  limit: number;
  x: Float32Array;
  y: Float32Array;
  vx: Float32Array;
  vy: Float32Array;
  age: Float32Array;
  size: Uint8Array;
  alive: Uint8Array;
  count: number;
  spawn(x: number, y: number, vx: number, vy: number, size: number): boolean;
  step(h: number, air: AirSampler, lake: WaterSink, stepIdx: number): void;
  clear(): void;
}

const S_SPAWN = SEED ^ SUB.spawn;

export function createParticles(
  cap: number,
  l: Layout,
  g: SceneGrid,
  t: Terrain,
): Particles {
  const x = new Float32Array(cap);
  const y = new Float32Array(cap);
  const vx = new Float32Array(cap);
  const vy = new Float32Array(cap);
  const age = new Float32Array(cap);
  const size = new Uint8Array(cap);
  const alive = new Uint8Array(cap);
  const free = new Int32Array(cap);
  let freeN = 0;
  for (let i = cap - 1; i >= 0; i--) free[freeN++] = i;
  const gpx = G_MS * l.ppm;
  const vImpRef = Math.sqrt(2 * gpx * l.Hf);

  const p: Particles = {
    cap,
    limit: cap,
    x,
    y,
    vx,
    vy,
    age,
    size,
    alive,
    count: 0,
    spawn(px, py, pvx, pvy, sz) {
      if (freeN === 0 || p.count >= p.limit) return false;
      const i = free[--freeN];
      x[i] = px;
      y[i] = py;
      vx[i] = pvx;
      vy[i] = pvy;
      age[i] = 0;
      size[i] = sz;
      alive[i] = 1;
      p.count++;
      return true;
    },
    step(h, air, lake, stepIdx) {
      if (p.count === 0) return;
      const { S, cols, rows, gx0, gy0 } = g;
      const occ = t.occ;
      const kd = DRAG;
      const left = gx0 + g.vi0 * S - S;
      const right = gx0 + g.vi1 * S + S;
      const top = gy0 + g.vj0 * S - 4 * S;
      const bottom = gy0 + g.vj1 * S + S;
      for (let i = 0; i < cap; i++) {
        if (!alive[i]) continue;
        air.airAt(x[i], y[i]);
        // Fine drops (size 0) follow the air closely: much larger drag.
        const k = size[i] === 0 ? kd * 3 : kd;
        vx[i] += k * (air.ax - vx[i]) * h;
        vy[i] += (gpx + k * (air.ay - vy[i])) * h;
        x[i] += vx[i] * h;
        y[i] += vy[i] * h;
        age[i] += h;
        let kill = false;
        if (x[i] < left || x[i] > right || y[i] > bottom || y[i] < top || age[i] > 4) {
          kill = true;
        } else if (vy[i] > 0 && lake.isWater(x[i], y[i])) {
          lake.impulse(x[i], y[i], -(0.12 + 0.1 * size[i]) * Math.min(1.5, vy[i] / vImpRef) * 2, 0.9);
          kill = true;
        } else {
          const ci = Math.round((x[i] - gx0) / S);
          const cj = Math.round((y[i] - gy0) / S);
          if (ci >= 0 && cj >= 0 && ci < cols && cj < rows && occ[cj * cols + ci] === OCC_ROCK && age[i] > 0.05) {
            if (size[i] === 2 && hash01(stepIdx, i, S_SPAWN) < 0.2) {
              // A tiny bounce off the rock.
              vx[i] *= -0.3;
              vy[i] *= -0.3;
              size[i] = 0;
              x[i] += vx[i] * h * 2;
              y[i] -= S;
            } else kill = true;
          } else if (size[i] === 0 && age[i] > 0.4) {
            air.deposit(x[i], y[i], 0.02);
            kill = true;
          }
        }
        if (kill) {
          alive[i] = 0;
          free[freeN++] = i;
          p.count--;
        }
      }
    },
    clear() {
      alive.fill(0);
      freeN = 0;
      for (let i = cap - 1; i >= 0; i--) free[freeN++] = i;
      p.count = 0;
    },
  };
  return p;
}
