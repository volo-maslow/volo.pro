/**
 * touch.ts — pointer play. Mouse / pen samples become a smoothed velocity
 * (handler side, O(1), same hygiene as the tree: EMA, staleness decay, fresh
 * restart after a gap, speed cap, teleport guard). Once per frame the cursor
 * acts on whatever it is over:
 *
 *  - the fall: parcels crossing the cursor's contact row are pushed to the
 *    rim of a disc (radius Rp), pick up sideways speed (spread + the hand's
 *    drag) and lose mass to splash droplets. The fall parts around the
 *    "finger", leaves a dry wedge below it, and heals by itself one fall time
 *    after the cursor leaves (the deflected parcels simply fall out);
 *  - the pool: a moving cursor drags a wake; a click drops a pebble;
 *  - the mist: waving pushes it aside.
 *
 * Touch: a tap on the pool drops a pebble, a tap on the fall holds a short
 * obstacle (350 ms) with a splash. Scrolling sloshes the pool. Listeners live
 * in the runtime; nothing here ever calls preventDefault.
 */
import type { Layout } from './layout';
import type { SceneGrid } from './grid';
import type { Fall } from './fall';
import type { Flow } from './flow';
import type { Lake } from './lake';
import type { Mist } from './mist';
import type { Particles } from './particles';
import { fallTime } from './layout';
import { hash01 } from '../tree/rng';
import { K_SLOSH, PTR, SEED, SPAWN, SUB, TIME_SCALE } from './config';

export const REGION_NONE = 0;
export const REGION_FALL = 1;
export const REGION_LAKE = 2;
export const REGION_AIR = 3;

export interface Touch {
  R: number;
  region: number;
  live: boolean;
  collarX: Float32Array;
  collarY: Float32Array;
  collarLv: Uint8Array;
  collarN: number;
  /** Pointer splash droplets spawned (total, for the dev hook). */
  splashes: number;
  feed(x: number, y: number, tMs: number): void;
  lift(): void;
  /** pointerdown: pebble on the pool; a touch on the fall holds an obstacle. */
  down(x: number, y: number, touch: boolean, tMs: number, ts: number): void;
  touchMove(x: number, y: number): void;
  touchEnd(): void;
  /** Obstacle hold for ms at (x, y) (dev poke / tap). */
  hold(x: number, y: number, ms: number, tMs: number): void;
  scroll(scrollY: number, tMs: number): void;
  update(ts: number, tsPrev: number, nowMs: number, stepIdx: number): void;
  /** Per lake step: scroll slosh, delayed jets. */
  fieldStep(ts: number): void;
  pebble(x: number, y: number, ts: number): void;
  reset(): void;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};
const S_COL = SEED ^ SUB.collar;

export function createTouch(
  l: Layout,
  g: SceneGrid,
  fall: Fall,
  flow: Flow,
  lake: Lake,
  mist: Mist,
  parts: Particles,
): Touch {
  const R = Math.min(PTR.rMax, Math.max(PTR.rMin, PTR.rFrac * l.Hs));
  const ppm = l.ppm;
  const vCapSim = 1.5 * ppm;
  const K = fall.K;
  const collarX = new Float32Array(PTR.collar);
  const collarY = new Float32Array(PTR.collar);
  const collarLv = new Uint8Array(PTR.collar);
  const quietMul = l.quiet ? 0.5 : 1;

  // Pointer state (performance clock, ms).
  let has = false;
  let px = 0;
  let py = 0;
  let lastFeed = -1e9;
  let vx = 0; // px/ms, smoothed
  let vy = 0;
  let fx = 0; // position at the previous frame
  let fy = 0;
  let fHas = false;
  let lastUpdate = -1;
  // Obstacle (touch tap / dev poke).
  let obX = 0;
  let obY = 0;
  let obUntil = -1;
  // Scroll.
  let sLast = 0;
  let sT = -1;
  let sv = 0;
  let svStep = 0;
  // Effects.
  let tokens = 0;
  let flux = 0;
  let lastPebble = -1e9;
  let jetTs = -1;
  let jetX = 0;
  let jetY = 0;
  let spawnK = 0;

  const rnd = (stepIdx: number): number => hash01(stepIdx, spawnK++, S_COL);

  const t: Touch = {
    R,
    region: REGION_NONE,
    live: false,
    collarX,
    collarY,
    collarLv,
    collarN: 0,
    splashes: 0,
    feed(x, y, tMs) {
      const dt = tMs - lastFeed;
      if (!has || dt > PTR.fresh) {
        vx = 0;
        vy = 0;
        fHas = false;
      } else if (dt > 0) {
        let ix = (x - px) / dt;
        let iy = (y - py) / dt;
        const sp = Math.sqrt(ix * ix + iy * iy);
        if (sp > PTR.vCap) {
          ix *= PTR.vCap / sp;
          iy *= PTR.vCap / sp;
        }
        const a = 1 - Math.exp(-dt / PTR.ema);
        vx += (ix - vx) * a;
        vy += (iy - vy) * a;
      }
      has = true;
      px = x;
      py = y;
      lastFeed = tMs;
    },
    lift() {
      has = false;
      fHas = false;
      vx = 0;
      vy = 0;
    },
    down(x, y, touch, tMs, ts) {
      if (lake.isWater(x, y)) {
        if (tMs - lastPebble < PTR.pebbleGap) return;
        lastPebble = tMs;
        t.pebble(x, y, ts);
        return;
      }
      if (touch && y > l.ylip && y < l.ys) t.hold(x, y, PTR.tapMs, tMs);
    },
    touchMove(x, y) {
      if (obUntil > 0) {
        obX = x;
        obY = y;
      }
    },
    touchEnd() {
      // The obstacle runs out on its own (eased), so a lifted finger still splashes once.
    },
    hold(x, y, ms, tMs) {
      obX = x;
      obY = y;
      obUntil = tMs + ms;
    },
    scroll(scrollY, tMs) {
      if (sT < 0) {
        sT = tMs;
        sLast = scrollY;
        return;
      }
      const dt = Math.max(1, tMs - sT);
      const iv = (scrollY - sLast) / dt;
      const a = 1 - Math.exp(-dt / 80);
      sv += (iv - sv) * a;
      sLast = scrollY;
      sT = tMs;
    },
    pebble(x, y, ts) {
      lake.impulse(x, y, -PTR.pebble, 1.3);
      const n = 6 + Math.floor(hash01(Math.floor(ts * 1000), 1, S_COL) * 5);
      for (let k = 0; k < n; k++) {
        const side = k % 2 === 0 ? -1 : 1;
        const ang = ((45 + 25 * hash01(k, Math.floor(ts * 1000), S_COL)) * Math.PI) / 180;
        const sp = (0.5 + 0.4 * hash01(Math.floor(ts * 1000), k + 9, S_COL)) * ppm;
        parts.spawn(x + side * 2, y - 2, side * Math.cos(ang) * sp, -Math.sin(ang) * sp, k % 3 === 0 ? 2 : 1);
      }
      jetTs = ts + 0.09 * TIME_SCALE;
      jetX = x;
      jetY = y;
    },
    fieldStep(ts) {
      // Scroll slosh: the change in smoothed scroll speed drives a seiche.
      const dv = sv - svStep;
      svStep = sv;
      if (Math.abs(dv) > 1e-3) {
        const amp = Math.max(-0.6, Math.min(0.6, K_SLOSH * dv));
        lake.slosh(amp);
      }
      if (jetTs > 0 && ts >= jetTs) {
        jetTs = -1;
        parts.spawn(jetX, jetY - 3, 0, -(1.0 + 0.2 * hash01(1, 2, S_COL)) * ppm, 2);
      }
    },
    update(ts, tsPrev, nowMs, stepIdx) {
      const dtw = lastUpdate < 0 ? 16.7 : Math.min(34, nowMs - lastUpdate);
      lastUpdate = nowMs;
      const dts = Math.max(0, ts - tsPrev);
      spawnK = 0;
      // Smoothed scroll decays when no scroll events arrive.
      if (nowMs - sT > 60) sv *= Math.exp(-dtw / 80);
      if (has && nowMs - lastFeed > PTR.stale) {
        const k = Math.exp(-dtw / PTR.decay);
        vx *= k;
        vy *= k;
      }
      tokens = Math.min(20, tokens + SPAWN.pointerMax * quietMul * dts);
      flux *= Math.exp(-dtw / 120);

      // Contact: cursor, or a held obstacle (tap / poke) easing out at the end.
      let cx = px;
      let cy = py;
      let Rc = R;
      let active = has;
      if (obUntil > nowMs) {
        cx = obX;
        cy = obY;
        Rc = R * 1.2 * smoothstep(0, 150, obUntil - nowMs);
        active = Rc > 2;
      } else if (obUntil > 0) obUntil = -1;
      t.region = REGION_NONE;
      t.live = false;
      t.collarN = 0;
      if (!active) {
        fHas = false;
        return;
      }
      const segX = fHas ? cx - fx : 0;
      const segY = fHas ? cy - fy : 0;
      const segL = Math.sqrt(segX * segX + segY * segY);
      const teleport = segL > PTR.teleport * l.Hs;
      const sx0 = fHas && !teleport ? fx : cx;
      const sy0 = fHas && !teleport ? fy : cy;
      fx = cx;
      fy = cy;
      fHas = true;
      if (teleport) return;
      const spd = Math.sqrt(vx * vx + vy * vy); // px/ms
      // Pointer velocity in sim px/s, clamped.
      const pvx = (vx * 1000) / TIME_SCALE;
      const pvy = (vy * 1000) / TIME_SCALE;
      const pvxC = Math.max(-vCapSim, Math.min(vCapSim, pvx));

      // ── Region ──────────────────────────────────────────────────────────
      if (cy > l.ylip - Rc && cy < l.ys - 0.3 * Rc) {
        const j = Math.round((cy - g.gy0) / g.S);
        if (j >= fall.jTop && j <= fall.jBot) {
          const e = ts - fall.tau[j];
          const qe = flow.q(e);
          const tg = flow.tongue(e);
          fall.evalStrand(0, j, ts, qe, tg);
          const left = fall.ox;
          fall.evalStrand(K - 1, j, ts, qe, tg);
          const right = fall.ox;
          if (qe + tg > 0.05 && cx > left - Rc && cx < right + Rc) t.region = REGION_FALL;
        }
      }
      if (t.region === REGION_NONE && lake.isWater(cx, cy)) t.region = REGION_LAKE;
      if (t.region === REGION_NONE && cy < l.ys && cy > l.ylip - 0.1 * l.Hs) t.region = REGION_AIR;

      // Waving through spray: the mist parts behind the hand.
      if (spd > 0.05 && cy < l.ys + 0.04 * l.Hs) {
        mist.push(cx, cy, pvx, pvy, 1.6 * Rc);
      }

      if (t.region === REGION_LAKE) {
        t.live = spd > 0.05;
        if (spd > 0.05) {
          const amp = -PTR.wake * smoothstep(0.05, 0.8, spd);
          const stepPx = 0.8 * g.S;
          const steps = Math.max(1, Math.ceil(segL / stepPx));
          for (let s = 1; s <= steps; s++) {
            const u = s / steps;
            lake.impulse(sx0 + (cx - sx0) * u, sy0 + (cy - sy0) * u, amp / Math.sqrt(steps), 1.2);
          }
        }
        return;
      }
      if (t.region !== REGION_FALL) return;
      t.live = true;

      // ── Fall: parcels meet the finger ─────────────────────────────────────
      const jp = Math.round((cy - g.gy0) / g.S);
      const ep = ts - fall.tau[jp];
      const qe = flow.q(ep);
      const tg = flow.tongue(ep);
      const vLoc = fall.vel[jp];
      let hits = 0;
      for (let k = 0; k < K; k++) {
        fall.evalStrand(k, jp, ts, qe, tg);
        const xk = fall.ox;
        const I = fall.oI;
        const dx = xk - cx;
        const o = dx / Rc;
        const ao = Math.abs(o);
        if (ao >= 1.15) continue;
        const side = o > 0 ? 1 : o < 0 ? -1 : k % 2 === 0 ? -1 : 1;
        const cap = Math.sqrt(Math.max(0, 1 - Math.min(1, ao) * Math.min(1, ao)));
        const yc = cy - Rc * cap * 0.95;
        const yHit = Math.max(0, yc - l.ylip);
        const tc = fallTime(yHit, ppm);
        const xo = side * Math.max(0, 1.02 * Rc - Math.abs(dx));
        const hvx =
          side * 0.1 * vLoc * Math.pow(Math.max(0, 1 - ao), 0.7) + 0.45 * pvxC;
        const keep = PTR.keepMin + (1 - PTR.keepMin) * Math.pow(Math.min(1, ao), 1.5);
        const wrap = Math.max(0.35 * Rc, Rc * cap);
        fall.markHit(k, tsPrev - tc, ts - tc, yHit, xo, hvx, keep, wrap, ts);
        flux += (1 - keep + 0.15) * Math.min(1, I) * 0.35;
        hits++;
        // Splash: mass the finger takes from the strand leaves as droplets.
        if (tokens >= 1 && rnd(stepIdx) < (0.15 + 0.9 * (1 - keep)) * quietMul) {
          const a = ((200 + 140 * rnd(stepIdx)) * Math.PI) / 180;
          const sx = cx + Math.cos(a) * Rc;
          const sy = cy + Math.sin(a) * Rc;
          const sp = 0.3 + 0.7 * rnd(stepIdx);
          const dvx = side * sp * 0.3 * vLoc + 0.3 * pvxC;
          const dvy = -(0.15 + 0.3 * rnd(stepIdx)) * vLoc;
          if (parts.spawn(sx, sy, dvx, dvy, sp > 0.75 ? 0 : sp > 0.45 ? 1 : 2)) {
            tokens -= 1;
            t.splashes++;
          }
        }
      }
      // A fast swipe throws a burst of drops along the swept segment.
      if (spd > 1 && hits > 0) {
        const nb = Math.round(Math.max(2, Math.min(14, spd * 12)) * quietMul);
        for (let b = 0; b < nb && tokens >= 1; b++) {
          const u = rnd(stepIdx);
          const bx = sx0 + (cx - sx0) * u;
          const by = sy0 + (cy - sy0) * u;
          const sp = 0.4 + 0.6 * rnd(stepIdx);
          if (
            parts.spawn(
              bx,
              by,
              pvxC * 0.6 * sp + (rnd(stepIdx) - 0.5) * 0.2 * vLoc,
              -(0.1 + 0.25 * rnd(stepIdx)) * vLoc,
              sp > 0.8 ? 0 : 1,
            )
          ) {
            tokens -= 1;
            t.splashes++;
          }
        }
      }
      // Sparse droplets rain through the shadow under the finger.
      if (hits > 0 && tokens >= 1 && rnd(stepIdx) < 0.5 * quietMul) {
        if (
          parts.spawn(
            cx + (rnd(stepIdx) - 0.5) * 1.3 * Rc,
            cy + Rc * (0.7 + 0.4 * rnd(stepIdx)),
            (rnd(stepIdx) - 0.5) * 0.08 * vLoc,
            (0.25 + 0.2 * rnd(stepIdx)) * vLoc,
            rnd(stepIdx) < 0.5 ? 1 : 2,
          )
        )
          tokens -= 1;
      }
      // Splash crown, ∝ intercepted flux: water piles up on the finger and
      // bursts outward, densest where the sheet is deflected (the two
      // shoulders), thinner over the crown, ragged rather than a ring.
      const nC = Math.min(PTR.collar, Math.round(flux * 4));
      for (let c = 0; c < nC; c++) {
        const u = rnd(stepIdx);
        const sh = c % 5 < 3; // 3 in 5 on the shoulders
        const sideC = c % 2 === 0 ? -1 : 1;
        const deg = sh ? 270 + sideC * (45 + 40 * u) : 270 + (u - 0.5) * 80;
        const a = (deg * Math.PI) / 180;
        const rr = Rc + (sh ? 0.2 + 1.4 * rnd(stepIdx) : 0.1 + 0.7 * rnd(stepIdx)) * g.S;
        collarX[c] = cx + Math.cos(a) * rr + (rnd(stepIdx) - 0.5) * 0.5 * g.S;
        collarY[c] = cy + Math.sin(a) * rr + (rnd(stepIdx) - 0.5) * 0.5 * g.S;
        collarLv[c] = sh ? (rnd(stepIdx) < 0.6 ? 3 : 2) : rnd(stepIdx) < 0.5 ? 2 : 1;
      }
      t.collarN = nC;
    },
    reset() {
      t.lift();
      obUntil = -1;
      flux = 0;
      t.collarN = 0;
      t.region = REGION_NONE;
      t.live = false;
      sv = 0;
      svStep = 0;
      sT = -1;
    },
  };
  return t;
}
