/**
 * still.ts — the reduced-motion frame: a long exposure, the way waterfalls
 * are photographed. The slow fields (mist, foam, ripples) are warmed up for
 * 3 s of steady flow, then the fall is the average of 40 time samples over
 * 1.2 s, so ropes blur into continuous striations along their paths while
 * the bow and the breakup still read. No droplets, no collar, drawn once.
 */
import type { SceneGrid } from './grid';
import type { Fall } from './fall';
import type { Flow } from './flow';
import type { Lake } from './lake';
import type { Mist } from './mist';
import { clearV, swapV } from './grid';
import { FIELD_HZ, TIME_SCALE } from './config';

export interface StillParts {
  g: SceneGrid;
  fall: Fall;
  flow: Flow;
  lake: Lake;
  mist: Mist;
}

const SAMPLES = 40;
/** The first pass only seeds Vprev for the pool's reflection: a rough average is enough. */
const SAMPLES_SEED = 10;
const SPAN = 1.2;
const WARM = 3;

export function composeStill({ g, fall, flow, lake, mist }: StillParts): void {
  const wasSteady = flow.steady;
  flow.steady = true;
  fall.resetMemory();
  lake.clear();
  mist.clear();
  mist.wind = 0;
  lake.wind = 0;
  fall.wind = 0;
  const h = (1 / FIELD_HZ) * TIME_SCALE;
  let ts = 0;
  let step = 0;
  while (ts < WARM) {
    ts += h;
    step++;
    lake.step(h, ts, 1, step);
    mist.step(h, ts, 1, 1);
  }
  lake.scale(0.5);
  // A first pass fills Vprev, so reflections see the averaged fall.
  for (let pass = 0; pass < 2; pass++) {
    swapV(g);
    clearV(g);
    const m = pass === 0 ? SAMPLES_SEED : SAMPLES;
    for (let s = 0; s < m; s++) fall.splat(g, ts + (s / m) * SPAN);
    const inv = 1 / m;
    const { V, cols, vi0, vi1, vj0, vj1 } = g;
    for (let j = vj0; j < vj1; j++)
      for (let i = vi0; i < vi1; i++) V[j * cols + i] *= inv;
    fall.approach(g, ts);
    fall.impact(g, ts, 1);
    lake.shade(g, ts);
    mist.contribute(g);
  }
  flow.steady = wasSteady;
}
