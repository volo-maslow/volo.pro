/**
 * fall.ts — the falling sheet as K emission-time strands, plus the approach
 * channel above the brink and the impact zone (boil, resurgence, splash skirt).
 *
 * A strand is not a particle chain: at lattice row y the visible water left
 * the lip at e = ts − τ(y). Every texture term (bundled ropes, ribs, comet
 * slugs, fragments, lateral wander, flow surges) is a function of e, so
 * features travel down at the ballistic speed v(y) and stretch by v/v₀ on
 * the way, which is what a real nappe does. Each strand splats into V at the
 * two nearest columns (linear weights), so motion stays sub-cell smooth while
 * every cell still draws at most one dot.
 *
 * Pointer play writes per-strand "parcel memory": a ring over emission time.
 * A parcel that met the cursor carries an offset, a lateral velocity and a
 * kept mass fraction downstream, so a held finger parts the fall and the
 * disturbance washes out within one fall time once it leaves.
 */
import type { Layout } from './layout';
import type { SceneGrid } from './grid';
import type { Terrain } from './terrain';
import type { Flow } from './flow';
import { hash01, valueNoise1, valueNoise2 } from '../tree/rng';
import {
  AERATION,
  BREAK,
  FALL_GAIN,
  G_MS,
  RHO_EXP,
  RIBS_HZ,
  RING,
  SEED,
  SLOT_HZ,
  SLUG_PERIOD,
  SLUG_RISE,
  SLUG_TAIL,
  SPREAD,
  PTR,
  STRANDS_PER_COL,
  SUB,
  SWAY_HZ,
  U0_MS,
  V0Y_MS,
  VIEW_THROW,
} from './config';

const TAU = Math.PI * 2;
const RMASK = RING - 1;
const smoothstep = (a: number, b: number, x: number): number => {
  const t = x <= a ? 0 : x >= b ? 1 : (x - a) / (b - a);
  return t * t * (3 - 2 * t);
};

const S_BUNDLE = SEED ^ SUB.bundle;
const S_FINE = SEED ^ SUB.bundleFine;
const S_FRAG = SEED ^ SUB.frag;
const S_LAT = SEED ^ SUB.lat;
const S_SLUG = SEED ^ SUB.slug;
const S_BOIL = SEED ^ SUB.boil;
const S_GAP = SEED ^ SUB.frag ^ 0x6a9;

export interface Fall {
  K: number;
  /** Grid rows of the fall: (jTop … jBot], jBot = js. */
  jTop: number;
  jBot: number;
  /** Per grid row (index j): fall time, speed (px/s), breakup, y below lip. */
  tau: Float32Array;
  vel: Float32Array;
  beta: Float32Array;
  yRel: Float32Array;
  /** Fall time to the pool surface (s). */
  tauF: number;
  /** Speed at impact (px/s, sim). */
  vImp: number;
  /** Sheet width at the bottom (px). */
  wBot: number;
  rim: Uint8Array;
  /** Parcel memory (K × RING): contact y below lip (−1 none), τ at contact, offset, vx, keep, wrap length. */
  hitY: Float32Array;
  tauH: Float32Array;
  xoff: Float32Array;
  hvx: Float32Array;
  keep: Float32Array;
  wrap: Float32Array;
  lastHitTs: number;
  /** Output of evalStrand. */
  ox: number;
  oI: number;
  /** Wind strength used for sway this frame. */
  wind: number;
  evalStrand(k: number, j: number, ts: number, qe: number, tg: number): void;
  splat(g: SceneGrid, ts: number): void;
  approach(g: SceneGrid, ts: number): void;
  impact(g: SceneGrid, ts: number, qImp: number): void;
  /** Clear ring slots for parcels emitted in (ePrev, ts]. */
  advance(ts: number): void;
  /** Mark parcels of strand k emitted in (e0, e1] as having met the cursor. */
  markHit(
    k: number,
    e0: number,
    e1: number,
    yHit: number,
    xoff: number,
    vx: number,
    keep: number,
    wrap: number,
    ts: number,
  ): void;
  /** Long-exposure average for the reduced-motion still. */
  resetMemory(): void;
}

export function createFall(
  l: Layout,
  g: SceneGrid,
  t: Terrain,
  flow: Flow,
): Fall {
  const { S, Hf, W0, ppm, Hs } = l;
  const { rows, js, cols } = g;
  const gpx = G_MS * ppm;
  const v0y = V0Y_MS * ppm;
  const u0 = U0_MS * ppm;
  const v0 = Math.sqrt(u0 * u0 + v0y * v0y);
  const K = Math.max(8, Math.round((2 * W0) / S));

  const tau = new Float32Array(rows);
  const vel = new Float32Array(rows);
  const rho = new Float32Array(rows);
  const beta = new Float32Array(rows);
  const yRel = new Float32Array(rows);
  const yFrac = new Float32Array(rows);
  const bowX = new Float32Array(rows);
  const wf = new Float32Array(rows);
  const alat = new Float32Array(rows);
  const swayA = new Float32Array(rows);
  const swayB = new Float32Array(rows);
  const swayPh = new Float32Array(rows);
  const gapT = new Float32Array(rows);
  const lipB = new Float32Array(rows);
  let jTop = rows;
  for (let j = 0; j < rows; j++) {
    const y = (j - js) * S + Hf;
    yRel[j] = y;
    if (y <= 0) continue;
    if (j < jTop) jTop = j;
    const tt = (-v0y + Math.sqrt(v0y * v0y + 2 * gpx * y)) / gpx;
    const vy = v0y + gpx * tt;
    const v = Math.sqrt(u0 * u0 + vy * vy);
    const yf = y / Hf;
    tau[j] = tt;
    vel[j] = v;
    rho[j] = Math.pow(v0 / v, RHO_EXP);
    beta[j] = smoothstep(BREAK[0], BREAK[1], yf);
    yFrac[j] = yf;
    bowX[j] = -VIEW_THROW * u0 * tt;
    // Pour-over: the sheet bulges over the brink, contracts just below it,
    // then spreads as it falls.
    const con = yf < 0.14 ? 0.1 * Math.sin((Math.PI * yf) / 0.14) : 0;
    wf[j] = 1 + SPREAD * Math.pow(yf, 1.3) - con + (y < 2.5 * S ? 0.04 : 0);
    // Lateral wander grows with √(fall distance): the edges fray.
    alat[j] = W0 * (0.012 + 0.11 * Math.sqrt(yf) + 0.05 * beta[j]);
    // Strand gaps open as the water falls (threshold on a [0, 1] noise).
    gapT[j] = 0.04 + 0.3 * Math.pow(yf, 0.9);
    // The brink: a bright curved band one or two rows thick.
    lipB[j] = y < 1.5 * S ? 1.7 : y < 3 * S ? 1.3 : 1;
    swayA[j] = 0.01 * Hf * Math.pow(yf, 1.5);
    swayB[j] = 0.025 * Hf * yf * yf;
    swayPh[j] = 1.3 * yf;
  }
  const jBot = js;
  const tauF = tau[js];
  const vImp = vel[js];
  const wBot = W0 * wf[js];

  // Strands: centre-heavy irregular weights, 10% skew to the right half, rims.
  const u = new Float32Array(K);
  const w = new Float32Array(K);
  const bOff = new Float32Array(K);
  const rimMul = new Float32Array(K);
  const rim = new Uint8Array(K);
  for (let k = 0; k < K; k++) {
    const uk = (k + 0.5) / K;
    u[k] = uk;
    const c = Math.abs(2 * uk - 1);
    w[k] =
      (1 - Math.pow(c, 2.2)) *
      (1 + 0.25 * valueNoise1(k * 0.37, SEED ^ SUB.weight)) *
      (uk > 0.5 ? 1.1 : 1);
    const isRim = k < 2 || k >= K - 2;
    rim[k] = isRim ? 1 : 0;
    rimMul[k] = isRim ? 1.25 : 1;
    bOff[k] = (hash01(k, 7, SEED ^ SUB.bundle) - 0.5) * 0.16 + (isRim ? 0.15 : 0);
  }

  const Rclose = Math.min(PTR.rMax, Math.max(PTR.rMin, PTR.rFrac * Hs));
  const closeLen = PTR.close * Rclose;
  const n = K * RING;
  const hitY = new Float32Array(n).fill(-1);
  const tauH = new Float32Array(n);
  const xoffA = new Float32Array(n);
  const hvx = new Float32Array(n);
  const keepA = new Float32Array(n).fill(1);
  const wrapA = new Float32Array(n).fill(1);

  // Approach channel cells, distance from the brink in px.
  let chN = 0;
  for (let c = 0; c < g.n; c++) if (t.chanS[c] >= 0) chN++;
  const chIdx = new Uint32Array(chN);
  const chS = new Float32Array(chN);
  chN = 0;
  for (let c = 0; c < g.n; c++)
    if (t.chanS[c] >= 0) {
      chIdx[chN] = c;
      chS[chN++] = t.chanS[c];
    }
  const chanLen = 0.12 * Hs;
  const vApp = 0.6 * ppm;

  // Impact zone: boil ellipse cells with static falloff; skirt columns.
  const xiRel = l.xi - l.xf;
  const rxB = 0.6 * wBot + 0.03 * Hs;
  const cyB = -0.012 * Hs;
  const ryUp = 0.035 * Hs;
  const ryDn = 0.02 * Hs;
  const boilIdx: number[] = [];
  const boilF: number[] = [];
  const resIdx: number[] = [];
  const resF: number[] = [];
  const xr = xiRel - 0.08 * Hs;
  const yr = 0.022 * Hs;
  const rxR = 0.06 * Hs;
  const ryR = 0.014 * Hs;
  for (let j = 0; j < rows; j++)
    for (let i = 0; i < cols; i++) {
      const x = (i - g.ic) * S;
      const y = (j - js) * S;
      const ex = (x - xiRel) / rxB;
      const ey = (y - cyB) / (y < cyB ? ryUp : ryDn);
      const d2 = ex * ex + ey * ey;
      if (d2 < 1) {
        const f = 1 - d2;
        boilIdx.push(j * cols + i);
        boilF.push(Math.pow(f, 1.3));
      }
      const rx2 = (x - xr) / rxR;
      const ry2 = (y - yr) / ryR;
      const r2 = rx2 * rx2 + ry2 * ry2;
      if (r2 < 1 && j >= js) {
        resIdx.push(j * cols + i);
        resF.push((1 - r2) * (1 - r2));
      }
    }
  // Mist halo: a faint haze ~1.8 W0 wide rising off the plunge.
  const haloIdx: number[] = [];
  const haloF: number[] = [];
  const hRx = 0.9 * W0 + 0.5 * wBot;
  const hRy = 0.13 * Hs;
  const hCy = -0.05 * Hs;
  for (let j = 0; j < js; j++)
    for (let i = 0; i < cols; i++) {
      const ex = ((i - g.ic) * S - xiRel) / hRx;
      const ey = ((j - js) * S - hCy) / hRy;
      const d2 = ex * ex + ey * ey;
      if (d2 < 1) {
        haloIdx.push(j * cols + i);
        haloF.push((1 - d2) * (1 - d2));
      }
    }
  const haloI = Uint32Array.from(haloIdx);
  const haloW = Float32Array.from(haloF);
  const boilI = Uint32Array.from(boilIdx);
  const boilW = Float32Array.from(boilF);
  const resI = Uint32Array.from(resIdx);
  const resW = Float32Array.from(resF);
  const skI0 = Math.floor((xiRel - rxB * 1.05) / S) + g.ic;
  const skI1 = Math.ceil((xiRel + rxB * 1.05) / S) + g.ic;
  const skH = 0.06 * Hs;

  let ePrev = -1;

  const fall: Fall = {
    K,
    jTop,
    jBot,
    tau,
    vel,
    beta,
    yRel,
    tauF,
    vImp,
    wBot,
    rim,
    hitY,
    tauH,
    xoff: xoffA,
    hvx,
    keep: keepA,
    wrap: wrapA,
    lastHitTs: -1e9,
    ox: 0,
    oI: 0,
    wind: 0,

    evalStrand(k, j, ts, qe, tg) {
      const e = ts - tau[j];
      const yf = yFrac[j];
      const b = smoothstep(BREAK[0], BREAK[1], yf + bOff[k] - 0.08 * (qe - 1));
      const nb =
        valueNoise2(k * 0.35, e * 1.7, S_BUNDLE) * 0.6 +
        valueNoise2(k * 0.9, e * 5.3, S_FINE) * 0.4;
      const th = 0.12 + 0.36 * b;
      const ropes = smoothstep(th - 0.1, th + 0.1, nb);
      const ribs = 1 + 0.08 * (1 - b) * Math.sin(TAU * RIBS_HZ * e + k * 0.4);
      let frag = 1;
      if (b > 0.7) {
        const on = valueNoise2(k * 1.7, e * 9, S_FRAG) > 0.3 ? 1 : 0;
        frag = 1 + (on - 1) * ((b - 0.7) / 0.3);
      }
      // Comet slugs: counter-based events in emission time, head leads.
      let slug = 0;
      const sj = Math.floor(e / SLUG_PERIOD);
      for (let q = sj - 1; q <= sj; q++) {
        const ej = q * SLUG_PERIOD + hash01(q, k, S_SLUG);
        const dt = e - ej;
        if (dt < 0) continue;
        const a = 0.5 + 0.5 * hash01(k, q, S_SLUG);
        slug += a * (dt < SLUG_RISE ? dt / SLUG_RISE : Math.exp(-(dt - SLUG_RISE) / SLUG_TAIL));
      }
      // Strands, not a block: neighbouring strands share a gate (ropes two or
      // three strands wide) and the gaps between them widen with the drop.
      // Rims open earlier, so the edges fray into fingers.
      const gt = gapT[j] + (rim[k] ? 0.12 : 0);
      const gv = valueNoise2(k * 0.42, e * 1.9 + k * 0.17, S_GAP);
      const gate = smoothstep(gt - 0.07, gt + 0.07, gv);
      fall.oI =
        (qe *
          w[k] *
          (rho[j] + AERATION * b) *
          (0.62 * ribs + 0.38) *
          (0.72 + 0.56 * nb * (0.5 + 0.5 * b)) *
          (1 + b * (ropes - 1)) *
          frag *
          (1 + 0.45 * slug) +
          tg * w[k] * (1 - 0.5 * b)) *
        rimMul[k] *
        lipB[j] *
        (0.08 + 0.92 * gate) *
        FALL_GAIN;
      const wq = Math.pow(qe + 0.4 * tg, 0.4) * W0 * wf[j];
      fall.ox =
        l.xf +
        bowX[j] +
        swayA[j] * Math.sin(TAU * SWAY_HZ * ts + swayPh[j]) +
        swayB[j] * fall.wind +
        (u[k] - 0.5) * wq +
        alat[j] * valueNoise1(e * 1.6 + k * 0.21, S_LAT) +
        // Rims wander on their own, so the edges fray instead of ruling a line.
        (rim[k] ? 1.3 * alat[j] * valueNoise1(e * 2.3 + k * 1.7, S_LAT ^ 0x51) : 0);
    },

    splat(gr, ts) {
      const V = gr.V;
      const gx0 = gr.gx0;
      const j0 = Math.max(jTop, gr.vj0);
      const j1 = Math.min(jBot, gr.vj1 - 1);
      const deflOn = ts - fall.lastHitTs < tauF + 0.1;
      const half = 1 / STRANDS_PER_COL;
      const streak = gr.streak;
      for (let j = j0; j <= j1; j++) {
        const e = ts - tau[j];
        if (e < 0) continue;
        const stk = yFrac[j] > 0.42 ? 1 : 0;
        const qe = flow.q(e);
        const tg = flow.tongue(e);
        if (qe + tg < 1e-3) continue;
        const row = j * cols;
        const y = yRel[j];
        const sf = e * SLOT_HZ;
        const s0 = Math.floor(sf);
        const fr = sf - s0;
        const i0 = s0 & RMASK;
        const i1 = (s0 + 1) & RMASK;
        for (let k = 0; k < K; k++) {
          fall.evalStrand(k, j, ts, qe, tg);
          let x = fall.ox;
          let I = fall.oI;
          if (deflOn) {
            let dx = 0;
            let kp = 0;
            const base = k * RING;
            for (let side = 0; side < 2; side++) {
              const s = base + (side === 0 ? i0 : i1);
              const wgt = side === 0 ? 1 - fr : fr;
              const hy = hitY[s];
              if (hy >= 0 && y > hy) {
                const dy = y - hy;
                const wr = wrapA[s];
                // Wrap around the disc, then the shadow refills within ~1.5 radii:
                // the parted ropes spread back sideways and re-converge, and the
                // sideways kick dies with them (no endless keyhole to the pool).
                const heal = smoothstep(wr, wr + closeLen, dy);
                dx +=
                  wgt *
                  (xoffA[s] * smoothstep(0, wr, dy) + hvx[s] * Math.min(tau[j] - tauH[s], 0.12)) *
                  (1 - heal);
                kp += wgt * (keepA[s] + (1 - keepA[s]) * heal);
              } else kp += wgt;
            }
            x += dx;
            I *= kp;
          }
          if (I <= 0.002) continue;
          const col = (x - gx0) / S;
          const c0 = Math.floor(col);
          if (c0 < 0 || c0 >= cols - 1) continue;
          const f = col - c0;
          V[row + c0] += I * (1 - f) * half;
          V[row + c0 + 1] += I * f * half;
          if (stk) {
            streak[row + c0] = 1;
            streak[row + c0 + 1] = 1;
          }
        }
      }
    },

    approach(gr, ts) {
      const V = gr.V;
      const q = flow.q(ts) + flow.tongue(ts);
      if (q <= 0.01) return;
      const qa = Math.min(1.3, q);
      for (let m = 0; m < chN; m++) {
        const c = chIdx[m];
        const s = chS[m];
        // Drawdown: the last few cells speed up and thin toward the brink.
        const d = s * chanLen;
        const acc = d < 3 * S ? 1 + (3 * S - d) / (2 * S) : 1;
        const ph = (d * acc) / S + (ts * vApp) / S;
        const row = Math.floor(c / cols);
        const glint = 0.15 * valueNoise2(ph * 0.6, row * 0.8, S_BOIL);
        const edge = s > 0.85 ? (1 - s) / 0.15 : 1;
        V[c] += qa * (0.55 + glint) * (0.55 + 0.45 * edge);
      }
    },

    impact(gr, ts, qImp) {
      if (qImp <= 0.01) return;
      const V = gr.V;
      const qi = Math.pow(qImp, 1.3);
      const tsc = ts * 3;
      for (let m = 0; m < boilI.length; m++) {
        const c = boilI[m];
        const i = c % cols;
        const j = (c - i) / cols;
        // Broken white water, not a block: noise patches that boil upward.
        const nz = valueNoise2(i * 0.4, j * 0.4 - tsc, S_BOIL);
        V[c] += qi * Math.max(0, 1.7 * nz - 0.45) * boilW[m];
      }
      const tsh = ts * 1.2;
      for (let m = 0; m < haloI.length; m++) {
        const c = haloI[m];
        const i = c % cols;
        const j = (c - i) / cols;
        V[c] += qi * 0.2 * haloW[m] * (0.4 + 0.6 * valueNoise2(i * 0.3, j * 0.3 + tsh, S_BOIL ^ 0x3));
      }
      const pulse = 0.4 * (0.75 + 0.25 * valueNoise1(ts * 0.7, S_BOIL));
      for (let m = 0; m < resI.length; m++) {
        const c = resI[m];
        const i = c % cols;
        const j = (c - i) / cols;
        V[c] +=
          qi * pulse * (0.6 + 0.6 * valueNoise2(i * 0.5 + ts * 0.4, j * 0.6, S_BOIL)) * resW[m];
      }
      // Splash skirt: a ragged curtain on both flanks of the plunge.
      const ts4 = ts * 4;
      for (let i = Math.max(skI0, gr.vi0); i <= Math.min(skI1, gr.vi1 - 1); i++) {
        const x = (i - g.ic) * S - xiRel;
        const ax = Math.abs(x) / rxB;
        if (ax > 1.05) continue;
        const flank = smoothstep(0.15, 0.55, ax) * (1 - smoothstep(0.8, 1.05, ax));
        const hcol =
          skH * qImp * flank * (0.35 + 0.65 * valueNoise2(i * 0.7, ts4, S_BOIL));
        if (hcol < S * 0.5) continue;
        const rowsUp = Math.floor(hcol / S);
        for (let r = 1; r <= rowsUp; r++) {
          const j = js - r;
          if (j < 0) break;
          V[j * cols + i] += 0.55 * (1 - (r * S) / hcol) * qi;
        }
      }
    },

    advance(ts) {
      if (ePrev < 0) ePrev = ts - 1 / SLOT_HZ;
      const a = Math.floor(ePrev * SLOT_HZ) + 1;
      const b = Math.floor(ts * SLOT_HZ);
      if (b >= a) {
        const m = Math.min(b - a + 1, RING);
        for (let s = 0; s < m; s++) {
          const idx = (a + s) & RMASK;
          for (let k = 0; k < K; k++) {
            const o = k * RING + idx;
            hitY[o] = -1;
            keepA[o] = 1;
          }
        }
      }
      ePrev = ts;
    },

    markHit(k, e0, e1, yHit, xo, vx, kp, wr, ts) {
      let a = Math.floor(e0 * SLOT_HZ) + 1;
      const b = Math.floor(e1 * SLOT_HZ);
      if (b < a) a = b;
      for (let s = Math.max(a, b - 4); s <= b; s++) {
        if (s < 0) continue;
        const o = k * RING + (s & RMASK);
        hitY[o] = yHit;
        tauH[o] = fall.tau[Math.min(jBot, Math.max(jTop, Math.round((yHit - Hf) / S) + js))];
        xoffA[o] = xo;
        hvx[o] = vx;
        keepA[o] = kp;
        wrapA[o] = wr;
      }
      fall.lastHitTs = ts;
    },

    resetMemory() {
      hitY.fill(-1);
      keepA.fill(1);
      fall.lastHitTs = -1e9;
      ePrev = -1;
    },
  };
  return fall;
}
