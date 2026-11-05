/**
 * touch.ts — "Brush & Twang": the desktop cursor brushing the crown. Pointer
 * samples become a smoothed velocity (handler side, O(1)); once per frame the
 * swept cursor segment pushes nearby joints across their swing tangent, the
 * push carries toward the trunk, and fast-attack / fast-release envelopes turn
 * it into per-joint (P) and per-cluster (CP) drives that pose.step() adds to
 * the wind targets. Letting go drops the push within ~90 ms, so the existing
 * underdamped springs ring ("twang"). Also owns the local rustle (rJ), the
 * shake streak and the one-roll-per-swipe leaf shed decision.
 *
 * Timebase: every time here is on the performance.now() clock (event
 * timeStamp); the runtime's timer time never enters this module.
 * All buffers are allocated in createTouch(); feed()/update() allocate nothing.
 */
import type { Skeleton } from './skeleton';
import type { Pose } from './pose';
import type { Rng } from './rng';
import {
  RUSTLE_ATTACK,
  RUSTLE_EPS,
  RUSTLE_TAU,
  RUSTLE_V0,
  RUSTLE_V1,
  SHAKE_V,
  SHAKE_WINDOW,
  TOUCH_ATTACK,
  TOUCH_CLUSTER_REACH,
  TOUCH_EPS,
  TOUCH_FRESH,
  TOUCH_PROP,
  TOUCH_RELEASE,
  TOUCH_RELEASE_HOLD,
  TOUCH_R_FRAC,
  TOUCH_R_MAX,
  TOUCH_R_MIN,
  TOUCH_SHED_CLUSTERS,
  TOUCH_SHED_MAX,
  TOUCH_SHED_P,
  TOUCH_SHED_RESET_V,
  TOUCH_SHED_STREAK_BONUS,
  TOUCH_SHED_TRAVEL,
  TOUCH_SHED_V,
  TOUCH_STALE,
  TOUCH_TELEPORT,
  TOUCH_V_CAP,
  TOUCH_V_DECAY,
  TOUCH_V_KNEE,
  TOUCH_V_MIN,
  TOUCH_V_REF,
} from './config';

/** What pose.step() reads: joint push (screen sense), cluster spin, rustle. */
export interface TouchDrive {
  P: Float32Array;
  CP: Float32Array;
  rJ: Float32Array;
}

export interface ShedRequest {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/** Dev override of the shed roll: computed odds, always, or never. */
export type ShedMode = 'auto' | 'always' | 'never';

/**
 * The touch shed budget is per page view, but a Touch is per build(): the
 * runtime owns this object and hands the same one to every createTouch().
 * Times are on the performance.now() clock.
 */
export interface ShedBudget {
  total: number;
  lastT: number;
}

export interface TouchStats {
  live: boolean;
  joints: number;
  rustleMax: number;
  streak: number;
  R: number;
}

export interface Touch extends TouchDrive {
  /** Contact radius (px) for the current tree height. */
  readonly R: number;
  /** Non-zero joint pushes after the last update (no allocation, unlike stats()). */
  readonly joints: number;
  /** From the pointermove handler (timestamps on the performance.now clock). */
  feed(x: number, y: number, tPerf: number): void;
  /** Cursor gone, unusable, or should not push: drop history, keep P/CP/rJ to release. */
  lift(): void;
  speed(): number;
  /** Per frame before step(). Returns `live`. */
  update(
    sk: Skeleton,
    pose: Pose,
    H: number,
    dtMs: number,
    nowPerf: number,
  ): boolean;
  /** Consumed once per frame. Returns the same preallocated object, or null. */
  takeShed(): ShedRequest | null;
  /** The requested leaf really spawned: spend budget and start the spacing. */
  noteShed(nowPerf: number): void;
  reset(): void;
  setShedMode(mode: ShedMode): void;
  /** Dev / diagnostics only (allocates). */
  stats(): TouchStats;
}

/** Touch-only floor between shed leaves (ms), on top of the shared LEAF_MIN_SPACING. */
const SHED_SPACING = 600;
/** Rustle values below this are zeroed (keeps the envelope from creeping forever). */
const RUSTLE_FLOOR = 1e-3;

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;
const smoothstep = (a: number, b: number, v: number): number => {
  const t = clamp((v - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const radiusFor = (H: number): number =>
  clamp(TOUCH_R_FRAC * H, TOUCH_R_MIN, TOUCH_R_MAX);

export function createTouch(
  skel: Skeleton,
  rng: Rng,
  H: number,
  budget: ShedBudget,
): Touch {
  const nJ = skel.nJ;
  const nC = skel.nC;
  const P = new Float32Array(nJ);
  const d0 = new Float32Array(nJ);
  const rJ = new Float32Array(nJ);
  const rT = new Float32Array(nJ);
  const CP = new Float32Array(nC);

  let R = radiusFor(H);
  // Handler side.
  let has = false;
  let px = 0;
  let py = 0;
  let pt = 0;
  let vx = 0;
  let vy = 0;
  // Frame side: the previous frame's cursor (segment start).
  let fHas = false;
  let fx = 0;
  let fy = 0;
  // Shake streak.
  let lastSignX = 0;
  let lastSignY = 0;
  let lastRevT = -Infinity;
  let streak = 0;
  // Shed.
  let travel = 0;
  let peakV = 0;
  let rolled = false;
  let shedMode: ShedMode = 'auto';
  const req: ShedRequest = { x: 0, y: 0, vx: 0, vy: 0 };
  let reqReady = false;
  // Liveness.
  let liveJ = 0;
  let cpLive = false;
  let rustleMax = 0;
  let live = false;
  /** d0/rT hold last frame's contact and must be cleared once drive stops. */
  let targetsDirty = false;

  const reversal = (t: number): void => {
    streak = t - lastRevT <= SHAKE_WINDOW ? streak + 1 : 1;
    lastRevT = t;
  };

  const lift = (): void => {
    has = false;
    fHas = false;
    vx = 0;
    vy = 0;
    travel = 0;
    rolled = false;
    peakV = 0;
  };

  return {
    P,
    CP,
    rJ,
    get R() {
      return R;
    },
    get joints() {
      return liveJ;
    },

    feed(x, y, t) {
      if (!has || t - pt > TOUCH_FRESH) {
        vx = 0;
        vy = 0;
        has = true;
      } else {
        const dt = Math.max(4, t - pt);
        let ix = (x - px) / dt;
        let iy = (y - py) / dt;
        const m = Math.hypot(ix, iy);
        if (m > TOUCH_V_CAP) {
          ix *= TOUCH_V_CAP / m;
          iy *= TOUCH_V_CAP / m;
        }
        vx += (ix - vx) * 0.5;
        vy += (iy - vy) * 0.5;
        // Per-axis reversal between fast moves: a back-and-forth shake.
        if (vx > SHAKE_V || vx < -SHAKE_V) {
          const sg = vx > 0 ? 1 : -1;
          if (lastSignX !== 0 && sg !== lastSignX) reversal(t);
          lastSignX = sg;
        }
        if (vy > SHAKE_V || vy < -SHAKE_V) {
          const sg = vy > 0 ? 1 : -1;
          if (lastSignY !== 0 && sg !== lastSignY) reversal(t);
          lastSignY = sg;
        }
      }
      px = x;
      py = y;
      pt = t;
    },

    lift,

    speed: () => Math.hypot(vx, vy),

    update(sk, pose, H, dt, now) {
      R = radiusFor(H);
      const R2 = R * R;
      // 1. A parked cursor stops pushing within ~100 ms.
      if (has && now - pt > TOUCH_STALE) {
        const k = Math.exp(-dt / TOUCH_V_DECAY);
        vx *= k;
        vy *= k;
      }
      if (now - lastRevT > SHAKE_WINDOW) streak = 0;
      const spd = Math.hypot(vx, vy);
      let kv = has ? smoothstep(TOUCH_V_MIN, TOUCH_V_KNEE, spd) : 0;
      let kr = has ? smoothstep(RUSTLE_V0, RUSTLE_V1, spd) : 0;
      // 2. Swept segment A (last frame) → B (now); a fresh start or teleport gives no drive.
      if (has && (!fHas || Math.hypot(px - fx, py - fy) > TOUCH_TELEPORT * H)) {
        fx = px;
        fy = py;
        fHas = true;
        kv = 0;
        kr = 0;
      }
      if (!has || spd < TOUCH_SHED_RESET_V) {
        travel = 0;
        rolled = false;
        peakV = 0;
      }
      const driving = kv > 0 || kr > 0;
      if (
        !driving &&
        liveJ === 0 &&
        rustleMax < RUSTLE_EPS &&
        !cpLive &&
        !targetsDirty
      ) {
        if (has) {
          fx = px;
          fy = py;
        }
        live = false;
        return false;
      }

      const ax = fx;
      const ay = fy;
      const bx = px;
      const by = py;
      const abx = bx - ax;
      const aby = by - ay;
      const ab = Math.hypot(abx, aby);

      // Did the cursor reach any joint or cluster this frame? Moving through
      // empty canvas margin must not hold the loop awake.
      let contact = false;
      // 3. Joint contact against up to 4 samples along A→B (a flick cannot skip a twig).
      if (driving) {
        const n = clamp(Math.ceil(ab / (0.5 * R)), 1, 4);
        const minX = (ax < bx ? ax : bx) - R;
        const maxX = (ax > bx ? ax : bx) + R;
        const minY = (ay < by ? ay : by) - R;
        const maxY = (ay > by ? ay : by) + R;
        const { ox, oy, c, s } = pose;
        for (let j = 0; j < nJ; j++) {
          const L = sk.len[j] * H;
          const x0 = ox[j];
          const y0 = oy[j];
          const cj = c[j];
          const sj = s[j];
          const x1 = x0 + L * cj;
          const y1 = y0 + L * sj;
          if (
            (x0 < x1 ? x1 : x0) < minX ||
            (x0 < x1 ? x0 : x1) > maxX ||
            (y0 < y1 ? y1 : y0) < minY ||
            (y0 < y1 ? y0 : y1) > maxY
          ) {
            d0[j] = 0;
            rT[j] = 0;
            continue;
          }
          let fmax = 0;
          for (let i = 1; i <= n; i++) {
            const sx = ax + (abx * i) / n;
            const sy = ay + (aby * i) / n;
            const u = clamp(((sx - x0) * cj + (sy - y0) * sj) / L, 0, 1);
            const dx = sx - (x0 + u * L * cj);
            const dy = sy - (y0 + u * L * sj);
            const d2 = dx * dx + dy * dy;
            if (d2 < R2) {
              const q = 1 - d2 / R2;
              if (q * q > fmax) fmax = q * q;
            }
          }
          // Cursor speed along the swing tangent (-s, c): + turns clockwise (y-down).
          if (fmax > 0) contact = true;
          const vt = cj * vy - sj * vx;
          d0[j] = fmax * kv * clamp(vt / TOUCH_V_REF, -1, 1);
          rT[j] = sk.fFlutter[j] > 0 ? fmax * kr : 0;
        }
        // 4. Carry toward the trunk; max, not sum, so it cannot pile up.
        for (let j = nJ - 1; j >= 1; j--) {
          const p = sk.parent[j];
          if (p < 0) continue;
          const cv = TOUCH_PROP * d0[j];
          if ((cv < 0 ? -cv : cv) > (d0[p] < 0 ? -d0[p] : d0[p])) d0[p] = cv;
        }
        targetsDirty = true;
      } else if (targetsDirty) {
        d0.fill(0);
        rT.fill(0);
        targetsDirty = false;
      }

      // 5. Envelopes: fast attack, fast release (push); slower rustle.
      const aA = 1 - Math.exp(-dt / TOUCH_ATTACK);
      // A fast cursor leaves a slower-releasing wake (see TOUCH_RELEASE_HOLD).
      const kR = Math.exp(
        -dt /
          (TOUCH_RELEASE *
            (1 +
              TOUCH_RELEASE_HOLD *
                clamp((spd - TOUCH_V_REF) / TOUCH_V_REF, 0, 2))),
      );
      const aR = 1 - Math.exp(-dt / RUSTLE_ATTACK);
      const kRr = Math.exp(-dt / RUSTLE_TAU);
      let lj = 0;
      let rmax = 0;
      for (let j = 0; j < nJ; j++) {
        const t0 = d0[j];
        const p = P[j];
        let np =
          (t0 < 0 ? -t0 : t0) > (p < 0 ? -p : p) || t0 * p < 0
            ? p + (t0 - p) * aA
            : p * kR;
        if ((np < 0 ? -np : np) < TOUCH_EPS) np = 0;
        else lj++;
        P[j] = np;
        const r = rJ[j];
        const rt = rT[j];
        let nr = rt > r ? r + (rt - r) * aR : r * kRr;
        if (nr < RUSTLE_FLOOR) nr = 0;
        rJ[j] = nr;
        if (nr > rmax) rmax = nr;
      }
      liveJ = lj;
      rustleMax = rmax;

      // 6. Clusters: a rolling spin, the contacted side of the clump is dragged along.
      // Only B is tested: clusters are larger than R, so skipping is not an issue.
      const J = nJ;
      let hitC = 0;
      let cl = false;
      for (let k = 0; k < nC; k++) {
        let cd = 0;
        if (driving) {
          const rk = R + TOUCH_CLUSTER_REACH * sk.cR[k] * H;
          const rx = bx - pose.ax[J + k];
          const ry = by - pose.ay[J + k];
          const d2 = rx * rx + ry * ry;
          if (d2 < rk * rk) {
            contact = true;
            const q = 1 - d2 / (rk * rk);
            const f = q * q;
            const d = Math.sqrt(d2);
            cd =
              f *
              kv *
              clamp(
                (rx * vy - ry * vx) / (Math.max(d, 0.3 * rk) * TOUCH_V_REF),
                -1,
                1,
              );
            if (f > 0.3) hitC++;
          }
        }
        const p = CP[k];
        let np =
          (cd < 0 ? -cd : cd) > (p < 0 ? -p : p) || cd * p < 0
            ? p + (cd - p) * aA
            : p * kR;
        if ((np < 0 ? -np : np) < TOUCH_EPS) np = 0;
        else cl = true;
        CP[k] = np;
      }
      cpLive = cl;

      // 7. Shed: one roll per fast swipe through foliage.
      if (has) {
        if (hitC === 0) {
          travel = 0;
          rolled = false;
          peakV = 0;
        } else if (
          spd >= TOUCH_SHED_V &&
          hitC >= TOUCH_SHED_CLUSTERS &&
          !rolled
        ) {
          travel += ab;
          if (spd > peakV) peakV = spd;
          if (travel >= TOUCH_SHED_TRAVEL) {
            rolled = true;
            const pr =
              TOUCH_SHED_P[0] +
              (TOUCH_SHED_P[1] - TOUCH_SHED_P[0]) *
                clamp((peakV - TOUCH_SHED_V) / 1.6, 0, 1) +
              (streak >= 2 ? TOUCH_SHED_STREAK_BONUS : 0);
            const odds =
              shedMode === 'always'
                ? 1
                : shedMode === 'never'
                  ? 0
                  : Math.min(0.8, pr);
            if (
              budget.total < TOUCH_SHED_MAX &&
              now - budget.lastT >= SHED_SPACING &&
              odds > 0 &&
              rng.chance(odds)
            ) {
              req.x = px;
              req.y = py;
              req.vx = vx;
              req.vy = vy;
              reqReady = true;
            }
          }
        }
        // 8. This frame's B is the next frame's A.
        fx = px;
        fy = py;
      }

      live =
        (has && now - pt < TOUCH_STALE + 50 && kv > 0 && contact) ||
        liveJ > 0 ||
        cpLive ||
        rustleMax >= RUSTLE_EPS;
      return live;
    },

    takeShed() {
      if (!reqReady) return null;
      reqReady = false;
      return req;
    },

    noteShed(now) {
      budget.total++;
      budget.lastT = now;
    },

    reset() {
      lift();
      P.fill(0);
      CP.fill(0);
      rJ.fill(0);
      rT.fill(0);
      d0.fill(0);
      targetsDirty = false;
      liveJ = 0;
      cpLive = false;
      rustleMax = 0;
      live = false;
      reqReady = false;
      streak = 0;
      // shedTotal and lastShedT survive: the cap is per page view.
    },

    setShedMode(mode) {
      shedMode = mode;
    },

    stats: () => ({ live, joints: liveJ, rustleMax, streak, R }),
  };
}
