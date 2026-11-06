/**
 * flow.ts — the discharge envelope q(e), sampled per *emission time* e (the
 * moment a parcel left the lip), so a surge enters at the brink and visibly
 * travels down the fall. q = intro · slow noise · (1 + surge).
 *
 * Surges are a seeded schedule evaluated analytically in sim time (not an
 * anime timeline): the fall reads q at many past emission times every frame,
 * and an analytic schedule needs no history buffer, pauses with the sim clock
 * and makes `stepTo` deterministic for free.
 */
import { createRng, valueNoise1 } from '../tree/rng';
import {
  FLOW_NOISE,
  INTRO,
  INTRO_Q,
  SEED,
  SUB,
  SURGE_AMP,
  SURGE_FIRST,
  SURGE_GAP,
  TONGUE_E,
} from './config';

export interface Flow {
  /** Discharge (≈1 at rest) for water emitted at sim time e. */
  q(e: number): number;
  /** The coherent first slug, a few seconds in (0 outside it), added to intensity. */
  tongue(e: number): number;
  /** Add a surge starting now (dev / events). */
  surgeNow(ts: number, amp: number): void;
  /** Steady flow (reduced-motion still): no intro, no surges. */
  steady: boolean;
  /** Back to the seeded schedule from t = 0 (dev stepTo). */
  reset(): void;
}

const inOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;
const outSine = (t: number): number => Math.sin((t * Math.PI) / 2);
const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export function createFlow(): Flow {
  let rng = createRng(SEED ^ SUB.surge);
  // Each surge: start, amp, rise, hold, fall (s). Grows lazily; never per frame in practice.
  const start: number[] = [];
  const amp: number[] = [];
  const rise: number[] = [];
  const hold: number[] = [];
  const fall: number[] = [];
  let next = rng.float(SURGE_FIRST[0], SURGE_FIRST[1]);
  let lo = 0;
  const push = (t0: number, a: number, manual = false): void => {
    let k = start.length;
    while (k > 0 && start[k - 1] > t0) k--;
    start.splice(k, 0, t0);
    amp.splice(k, 0, a);
    // Manual surges use fixed timings, so they never shift the seeded schedule.
    rise.splice(k, 0, manual ? 1.3 : rng.float(1.0, 1.6));
    hold.splice(k, 0, manual ? 0.9 : rng.float(0.6, 1.2));
    fall.splice(k, 0, manual ? 3.2 : rng.float(2.5, 4));
  };
  const ensure = (e: number): void => {
    while (next < e + 10) {
      push(next, rng.float(SURGE_AMP[0], SURGE_AMP[1]));
      next += rng.float(SURGE_GAP[0], SURGE_GAP[1]);
    }
  };
  const surgeAt = (e: number): number => {
    ensure(e);
    // Drop events that ended long ago (e only moves forward, minus ≤ 2 s of fall time).
    while (lo < start.length && start[lo] + rise[lo] + hold[lo] + fall[lo] < e - 4) lo++;
    let s = 0;
    for (let k = lo; k < start.length; k++) {
      const t = e - start[k];
      if (t < 0) break;
      const r = rise[k];
      const hd = hold[k];
      const f = fall[k];
      if (t < r) s += amp[k] * inOutSine(t / r);
      else if (t < r + hd) s += amp[k];
      else if (t < r + hd + f) s += amp[k] * (1 - outSine((t - r - hd) / f));
    }
    return s;
  };

  const flow: Flow = {
    steady: false,
    q(e) {
      if (flow.steady) return 1;
      if (e < 0) return 0;
      const intro = INTRO_Q + (1 - INTRO_Q) * smoothstep(INTRO[0], INTRO[1], e);
      return (
        intro *
        (1 + FLOW_NOISE * valueNoise1(e / 9, SEED ^ SUB.flow)) *
        (1 + surgeAt(e))
      );
    },
    tongue(e) {
      if (flow.steady) return 0;
      const t = (e - TONGUE_E) / 0.11;
      return t > 4 || t < -4 ? 0 : 0.6 * Math.exp(-t * t);
    },
    surgeNow(ts, a) {
      push(ts, a, true);
    },
    reset() {
      rng = createRng(SEED ^ SUB.surge);
      start.length = 0;
      amp.length = 0;
      rise.length = 0;
      hold.length = 0;
      fall.length = 0;
      next = rng.float(SURGE_FIRST[0], SURGE_FIRST[1]);
      lo = 0;
    },
  };
  return flow;
}
