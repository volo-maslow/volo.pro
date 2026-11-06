/**
 * mist.ts — spray mist on a coarse grid (2·S desktop, 3·S mobile), carried by
 * an analytic air field: a breeze toward +x (away from the content), the
 * waterfall wind (downdraft in the core, outflow along the pool surface,
 * rising air beside it), slow curl-noise swirls and pointer pushes.
 * Semi-Lagrangian advection, a light blur, exponential decay (τ 2.6 s).
 * Its contribution to V is capped below L3: mist is only ever a haze of L1/L2.
 */
import type { Layout } from './layout';
import type { SceneGrid } from './grid';
import type { AirSampler } from './particles';
import { valueNoise2 } from '../tree/rng';
import { AIR, MIST, SEED, SUB } from './config';

export interface Mist extends AirSampler {
  enabled: boolean;
  wind: number;
  step(h: number, ts: number, qImp: number, q: number): void;
  contribute(g: SceneGrid): void;
  push(x: number, y: number, vx: number, vy: number, radius: number): void;
  /** Mass-weighted centroid (viewport px) and total, for the dev hook. */
  centroid(): { x: number; y: number; m: number };
  clear(): void;
  fill(level: number): void;
}

const S_CURL = SEED ^ SUB.curl;

export function createMist(l: Layout, g: SceneGrid, fallWBot: number): Mist {
  const { Hs, Hf, ppm, S } = l;
  const P = MIST.pitch[l.variant] * S;
  // Region relative to (x_f, y_s), px.
  const xiR = l.xi - l.xf;
  let rx0 = xiR - 0.45 * Hs;
  const rx1 = xiR + 0.55 * Hs;
  const ry0 = -0.55 * Hf - 0.1 * Hs;
  const ry1 = 0.08 * Hs;
  if (Number.isFinite(l.rockMinX)) rx0 = Math.max(rx0, l.rockMinX - l.xf);
  const gl = -g.ic * S;
  rx0 = Math.max(rx0, gl);
  const mc = Math.max(2, Math.ceil((rx1 - rx0) / P) + 1);
  const mr = Math.max(2, Math.ceil((ry1 - ry0) / P) + 1);
  const n = mc * mr;
  let m = new Float32Array(n);
  let m2 = new Float32Array(n);
  const pu = new Float32Array(n);
  const pv = new Float32Array(n);
  const us = new Float32Array(n); // static waterfall wind (px/s)
  const vs = new Float32Array(n);
  const psi = new Float32Array(n);
  const srcI = new Float32Array(n); // impact source weight
  const srcS = new Float32Array(n); // side source weight
  const half = fallWBot / 2;
  for (let r = 0; r < mr; r++)
    for (let c = 0; c < mc; c++) {
      const k = r * mc + c;
      const x = rx0 + c * P;
      const y = ry0 + r * P;
      const dx = x - xiR;
      const ax = Math.abs(dx);
      const above = Math.max(0, -y);
      const out =
        AIR.out * Math.sign(dx) * Math.exp(-ax / (0.18 * Hs)) * Math.exp(-above / (0.06 * Hs));
      let w = -AIR.rise * (1 - Math.exp(-ax / (0.08 * Hs)));
      if (ax < half && y < 0) w += AIR.down;
      // Below the surface there is no air: damp everything.
      const sub = y > 0 ? Math.exp(-y / (0.02 * Hs)) : 1;
      us[k] = out * ppm * sub;
      vs[k] = w * ppm * sub;
      const ex = dx / Math.max(P, 0.6 * fallWBot + 0.02 * Hs);
      const ey = (y + 1.5 * P) / (1.5 * P);
      if (ex * ex + ey * ey < 1) srcI[k] = 1 - (ex * ex + ey * ey);
      // Lower quarter of the fall edges.
      const yf = (y + Hf) / Hf;
      if (yf > 0.72 && yf < 1 && Math.abs(ax - half) < P * 1.5) srcS[k] = 1;
    }
  const curlScale = 1 / (0.15 * Hs);
  const iP = 1 / P;

  const mist: Mist = {
    enabled: true,
    wind: 0,
    ax: 0,
    ay: 0,
    airAt(x, y) {
      // Analytic air at a viewport point: breeze + static field (nearest node).
      const c = Math.round((x - g.gx0 - g.ic * S - rx0) * iP);
      const r = Math.round((y - g.gy0 - g.js * S - ry0) * iP);
      let ax = (AIR.breeze + AIR.gust * mist.wind) * ppm;
      let ay = 0;
      if (c >= 0 && r >= 0 && c < mc && r < mr) {
        const k = r * mc + c;
        ax += us[k] + pu[k];
        ay += vs[k] + pv[k];
      }
      mist.ax = ax;
      mist.ay = ay;
    },
    deposit(x, y, amt) {
      const c = Math.round((x - g.gx0 - g.ic * S - rx0) * iP);
      const r = Math.round((y - g.gy0 - g.js * S - ry0) * iP);
      if (c >= 0 && r >= 0 && c < mc && r < mr) m[r * mc + c] += amt;
    },
    step(h, ts, qImp, q) {
      if (!mist.enabled) return;
      const breeze = (AIR.breeze + AIR.gust * mist.wind) * ppm;
      const curlAmp = AIR.curl * ppm;
      const tx = ts * 0.14;
      const ty = ts * 0.2;
      for (let k = 0; k < n; k++) {
        const c = k % mc;
        const r = (k - c) / mc;
        psi[k] = valueNoise2((rx0 + c * P) * curlScale + tx, (ry0 + r * P) * curlScale - ty, S_CURL);
      }
      const decay = Math.exp(-h / MIST.tau);
      const pdecay = Math.exp(-h / 0.5);
      const qi = Math.pow(Math.max(0, qImp), 1.3) * MIST.src * h * (l.quiet ? 0.7 : 1);
      const qs = Math.max(0, q) * MIST.side * h;
      const hP = h * iP;
      const cScale = (curlAmp / (2 * P)) * (0.15 * Hs);
      for (let r = 0; r < mr; r++) {
        for (let c = 0; c < mc; c++) {
          const k = r * mc + c;
          const cl = c > 0 ? k - 1 : k;
          const cr = c < mc - 1 ? k + 1 : k;
          const cu = r > 0 ? k - mc : k;
          const cd = r < mr - 1 ? k + mc : k;
          // Curl of ψ: u = ∂ψ/∂y, v = −∂ψ/∂x (normalised to the noise scale).
          const cu1 = (psi[cd] - psi[cu]) * cScale;
          const cv1 = -(psi[cr] - psi[cl]) * cScale;
          const u = breeze + us[k] + pu[k] + cu1;
          const v = vs[k] + pv[k] + cv1;
          let sx = c - u * hP;
          let sy = r - v * hP;
          sx = sx < 0 ? 0 : sx > mc - 1.001 ? mc - 1.001 : sx;
          sy = sy < 0 ? 0 : sy > mr - 1.001 ? mr - 1.001 : sy;
          const x0 = sx | 0;
          const y0 = sy | 0;
          const fx = sx - x0;
          const fy = sy - y0;
          const o = y0 * mc + x0;
          const a = m[o] + (m[o + 1] - m[o]) * fx;
          const b = m[o + mc] + (m[o + mc + 1] - m[o + mc]) * fx;
          let val = a + (b - a) * fy;
          val += MIST.blur * (m[cl] + m[cr] + m[cu] + m[cd] - 4 * m[k]);
          val = val * decay + qi * srcI[k] + qs * srcS[k];
          m2[k] = val < 0 ? 0 : val > 1.5 ? 1.5 : val;
          pu[k] *= pdecay;
          pv[k] *= pdecay;
        }
      }
      const tmp = m;
      m = m2;
      m2 = tmp;
    },
    contribute(gr) {
      const { V, cols, S: s, vi0, vi1, vj0, vj1 } = gr;
      const i0 = Math.max(vi0, Math.ceil(rx0 / s) + gr.ic);
      const i1 = Math.min(vi1 - 1, Math.floor((rx0 + (mc - 1) * P) / s) + gr.ic);
      const j0 = Math.max(vj0, Math.ceil(ry0 / s) + gr.js);
      const j1 = Math.min(vj1 - 1, Math.floor((ry0 + (mr - 1) * P) / s) + gr.js);
      const gain = MIST.gain;
      for (let j = j0; j <= j1; j++) {
        const sy = ((j - gr.js) * s - ry0) * iP;
        const y0 = sy | 0;
        const fy = sy - y0;
        const y1 = y0 < mr - 1 ? y0 + 1 : y0;
        const row = j * cols;
        for (let i = i0; i <= i1; i++) {
          const sx = ((i - gr.ic) * s - rx0) * iP;
          const x0 = sx | 0;
          const fx = sx - x0;
          const x1 = x0 < mc - 1 ? x0 + 1 : x0;
          const a = m[y0 * mc + x0] + (m[y0 * mc + x1] - m[y0 * mc + x0]) * fx;
          const b = m[y1 * mc + x0] + (m[y1 * mc + x1] - m[y1 * mc + x0]) * fx;
          const v = (a + (b - a) * fy) * gain;
          if (v > 0.004) V[row + i] += v > 0.45 ? 0.45 : v;
        }
      }
    },
    push(x, y, vx, vy, radius) {
      const cx = (x - g.gx0 - g.ic * S - rx0) * iP;
      const cy = (y - g.gy0 - g.js * S - ry0) * iP;
      const rc = radius * iP;
      const cap = 1.2 * ppm;
      for (let r = Math.max(0, Math.floor(cy - rc)); r <= Math.min(mr - 1, Math.ceil(cy + rc)); r++)
        for (let c = Math.max(0, Math.floor(cx - rc)); c <= Math.min(mc - 1, Math.ceil(cx + rc)); c++) {
          const dx = c - cx;
          const dy = r - cy;
          const d2 = (dx * dx + dy * dy) / (rc * rc * 0.5);
          if (d2 > 2) continue;
          const gs = Math.exp(-d2);
          const k = r * mc + c;
          let u = pu[k] + 0.6 * vx * gs;
          let v = pv[k] + 0.6 * vy * gs;
          const sp = Math.sqrt(u * u + v * v);
          if (sp > cap) {
            u *= cap / sp;
            v *= cap / sp;
          }
          pu[k] = u;
          pv[k] = v;
        }
    },
    centroid() {
      let sx = 0;
      let sy = 0;
      let sm = 0;
      for (let k = 0; k < n; k++) {
        const c = k % mc;
        const r = (k - c) / mc;
        sx += m[k] * c;
        sy += m[k] * r;
        sm += m[k];
      }
      if (sm <= 0) return { x: 0, y: 0, m: 0 };
      return {
        x: g.gx0 + g.ic * S + rx0 + (sx / sm) * P,
        y: g.gy0 + g.js * S + ry0 + (sy / sm) * P,
        m: sm,
      };
    },
    clear() {
      m.fill(0);
      m2.fill(0);
      pu.fill(0);
      pv.fill(0);
    },
    fill(level) {
      for (let k = 0; k < n; k++) m[k] *= level;
    },
  };
  return mist;
}
