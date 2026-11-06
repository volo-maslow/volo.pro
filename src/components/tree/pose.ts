/**
 * pose.ts — per-joint damped oscillators (semi-implicit Euler) and the forward
 * pose solve that turns joint angles into anchor frames (ax, ay, ac, as) in
 * viewport CSS px. Anchors 0..J-1 are joints, J..J+C-1 are foliage clusters.
 * Everything is preallocated; step() allocates nothing.
 */
import type { Skeleton } from './skeleton';
import type { DotField } from './rasterize';
import type { TouchDrive } from './touch';
import {
  CLUSTER_DEG,
  FLUTTER_DEG,
  GUST_DEG,
  RUSTLE_GAIN,
  TOUCH_CLUSTER_DEG,
  TOUCH_CLUSTER_TGT_MAX,
  TOUCH_DEG,
  TOUCH_TGT_MAX,
  TURB_AMP,
  WIND_DIR,
} from './config';

const DEG = Math.PI / 180;
const UP = -Math.PI / 2;
const THETA_MAX = 3 * GUST_DEG;

export interface Pose {
  nJ: number;
  nC: number;
  ang: Float64Array;
  ox: Float64Array;
  oy: Float64Array;
  c: Float64Array;
  s: Float64Array;
  theta: Float64Array; // deg
  vel: Float64Array; // deg/ms
  wJ: Float32Array; // envelope seen by each joint this frame
  cTheta: Float64Array;
  cVel: Float64Array;
  ax: Float64Array;
  ay: Float64Array;
  ac: Float64Array;
  as: Float64Array;
  tipRestX: Float64Array;
  tipRestY: Float64Array;
  tipLastX: Float64Array;
  tipLastY: Float64Array;
  tipCurX: Float64Array;
  tipCurY: Float64Array;
  /** True when the anchors hold the exact rest pose (dots draw from rest cells). */
  atRest: boolean;
  /** Max |velocity| over joints and clusters after the last step (deg/ms). */
  maxVel: number;
}

export interface TipMetrics {
  /** Max endpoint movement since the last drawn frame (px). */
  moved: number;
  /** Max endpoint distance from rest (px). */
  fromRest: number;
  /** Signed tip deflection with the largest magnitude (deg). */
  deflDeg: number;
}

export function createPose(sk: Skeleton): Pose {
  const nA = sk.nJ + sk.nC;
  const nT = sk.tips.length;
  return {
    nJ: sk.nJ,
    nC: sk.nC,
    ang: new Float64Array(sk.nJ),
    ox: new Float64Array(sk.nJ),
    oy: new Float64Array(sk.nJ),
    c: new Float64Array(sk.nJ),
    s: new Float64Array(sk.nJ),
    theta: new Float64Array(sk.nJ),
    vel: new Float64Array(sk.nJ),
    wJ: new Float32Array(sk.nJ),
    cTheta: new Float64Array(sk.nC),
    cVel: new Float64Array(sk.nC),
    ax: new Float64Array(nA),
    ay: new Float64Array(nA),
    ac: new Float64Array(nA),
    as: new Float64Array(nA),
    tipRestX: new Float64Array(nT),
    tipRestY: new Float64Array(nT),
    tipLastX: new Float64Array(nT),
    tipLastY: new Float64Array(nT),
    tipCurX: new Float64Array(nT),
    tipCurY: new Float64Array(nT),
    atRest: false,
    maxVel: 0,
  };
}

export function resetDynamics(pose: Pose): void {
  pose.theta.fill(0);
  pose.vel.fill(0);
  pose.cTheta.fill(0);
  pose.cVel.fill(0);
  pose.wJ.fill(0);
  pose.maxVel = 0;
}

/** Writes joint i's frame from its world angle and its parent's end point. */
function placeJoint(
  sk: Skeleton,
  pose: Pose,
  j: number,
  ang: number,
  rootX: number,
  rootY: number,
  H: number,
): void {
  const p = sk.parent[j];
  let ox = rootX;
  let oy = rootY;
  if (p >= 0) {
    const l = sk.len[p] * H;
    ox = pose.ox[p] + l * pose.c[p];
    oy = pose.oy[p] + l * pose.s[p];
  }
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  pose.ang[j] = ang;
  pose.ox[j] = ox;
  pose.oy[j] = oy;
  pose.c[j] = c;
  pose.s[j] = s;
  pose.ax[j] = ox;
  pose.ay[j] = oy;
  pose.ac[j] = c;
  pose.as[j] = s;
}

function placeClusters(
  sk: Skeleton,
  pose: Pose,
  H: number,
  useTheta: boolean,
): void {
  const J = sk.nJ;
  for (let k = 0; k < sk.nC; k++) {
    const o = sk.cOwner[k];
    const c = pose.c[o];
    const s = pose.s[o];
    const lx = sk.clx[k] * H;
    const ly = sk.cly[k] * H;
    const a = pose.ang[o] + (useTheta ? pose.cTheta[k] * DEG : 0);
    pose.ax[J + k] = pose.ox[o] + c * lx - s * ly;
    pose.ay[J + k] = pose.oy[o] + s * lx + c * ly;
    pose.ac[J + k] = Math.cos(a);
    pose.as[J + k] = Math.sin(a);
  }
}

/** Exact rest pose; tip rest endpoints and "last drawn" endpoints are reset to it. */
export function solveRest(
  sk: Skeleton,
  pose: Pose,
  rootX: number,
  rootY: number,
  H: number,
): void {
  for (let j = 0; j < sk.nJ; j++) {
    const p = sk.parent[j];
    placeJoint(
      sk,
      pose,
      j,
      (p >= 0 ? pose.ang[p] : UP) + sk.restRel[j],
      rootX,
      rootY,
      H,
    );
  }
  placeClusters(sk, pose, H, false);
  for (let t = 0; t < sk.tips.length; t++) {
    const j = sk.tips[t];
    const l = sk.len[j] * H;
    const x = pose.ox[j] + l * pose.c[j];
    const y = pose.oy[j] + l * pose.s[j];
    pose.tipRestX[t] = x;
    pose.tipRestY[t] = y;
    pose.tipLastX[t] = x;
    pose.tipLastY[t] = y;
    pose.tipCurX[t] = x;
    pose.tipCurY[t] = y;
  }
  pose.atRest = true;
}

/**
 * Advance the oscillators by dtMs and solve the pose.
 * env[level] is the envelope at (t - lagLevel*step); turb[band] is in [-1, 1].
 * `touch` (desktop pointer) adds a push to joint and cluster targets plus a
 * local rustle on flutter; null keeps wind-only frames bit-identical.
 */
export function step(
  sk: Skeleton,
  pose: Pose,
  env: Float32Array,
  turb: Float32Array,
  tMs: number,
  dtMs: number,
  rootX: number,
  rootY: number,
  H: number,
  touch: TouchDrive | null = null,
): void {
  const sub = dtMs > 20 ? 2 : 1;
  const h = dtMs / sub;
  const tSec = tMs / 1000;
  let maxVel = 0;
  const { theta, vel, wJ } = pose;

  for (let j = 0; j < sk.nJ; j++) {
    const w = env[sk.lagLevel[j]] * (1 + TURB_AMP * turb[sk.turbBand[j]]);
    wJ[j] = w;
    let tgt = GUST_DEG * sk.gain[j] * w;
    let fw = w;
    if (touch) {
      const tp = touch.P[j];
      if (tp !== 0) {
        // P is a screen-sense push; theta is multiplied by WIND_DIR when placed.
        const sum = tgt + TOUCH_DEG * sk.tGain[j] * tp * WIND_DIR;
        // Never weakens a wind-only target.
        const lim = Math.max(TOUCH_TGT_MAX, Math.abs(tgt));
        tgt = sum > lim ? lim : sum < -lim ? -lim : sum;
      }
      fw = w + RUSTLE_GAIN * touch.rJ[j];
    }
    const om = sk.omega[j];
    const om2 = om * om;
    const damp = 2 * sk.zeta[j] * om;
    let th = theta[j];
    let v = vel[j];
    for (let i = 0; i < sub; i++) {
      v += (om2 * (tgt - th) - damp * v) * h;
      th += v * h;
    }
    // Zero the outward velocity at the clamp, or it keeps accumulating and the joint sticks at the limit.
    if (th > THETA_MAX) {
      th = THETA_MAX;
      if (v > 0) v = 0;
    } else if (th < -THETA_MAX) {
      th = -THETA_MAX;
      if (v < 0) v = 0;
    }
    theta[j] = th;
    vel[j] = v;
    const av = v < 0 ? -v : v;
    if (av > maxVel) maxVel = av;
    const ff = sk.fFlutter[j];
    const flut =
      ff > 0 ? FLUTTER_DEG * fw * Math.sin(tSec * ff + sk.phaseFlutter[j]) : 0;
    const p = sk.parent[j];
    const ang =
      (p >= 0 ? pose.ang[p] : UP) +
      sk.restRel[j] +
      (th + flut) * DEG * WIND_DIR;
    placeJoint(sk, pose, j, ang, rootX, rootY, H);
  }

  const { cTheta, cVel } = pose;
  for (let k = 0; k < sk.nC; k++) {
    let tgt = CLUSTER_DEG * sk.cGain[k] * sk.cSign[k] * wJ[sk.cOwner[k]];
    if (touch) {
      // placeClusters adds cTheta with no WIND_DIR, so CP is already screen-sense.
      const cp = touch.CP[k];
      if (cp !== 0) {
        const sum = tgt + TOUCH_CLUSTER_DEG * sk.cGain[k] * cp;
        const lim = Math.max(TOUCH_CLUSTER_TGT_MAX, Math.abs(tgt));
        tgt = sum > lim ? lim : sum < -lim ? -lim : sum;
      }
    }
    const om = sk.cOmega[k];
    const om2 = om * om;
    const damp = 2 * sk.cZeta[k] * om;
    let th = cTheta[k];
    let v = cVel[k];
    for (let i = 0; i < sub; i++) {
      v += (om2 * (tgt - th) - damp * v) * h;
      th += v * h;
    }
    cTheta[k] = th;
    cVel[k] = v;
    const av = v < 0 ? -v : v;
    if (av > maxVel) maxVel = av;
  }
  placeClusters(sk, pose, H, true);
  pose.maxVel = maxVel;
  pose.atRest = false;
}

/** Fills `out` with tip endpoint motion; current endpoints land in tipCur*. */
export function measureTips(
  sk: Skeleton,
  pose: Pose,
  H: number,
  out: TipMetrics,
): TipMetrics {
  let moved = 0;
  let fromRest = 0;
  let defl = 0;
  for (let t = 0; t < sk.tips.length; t++) {
    const j = sk.tips[t];
    const l = sk.len[j] * H;
    const x = pose.ox[j] + l * pose.c[j];
    const y = pose.oy[j] + l * pose.s[j];
    pose.tipCurX[t] = x;
    pose.tipCurY[t] = y;
    const dm = Math.hypot(x - pose.tipLastX[t], y - pose.tipLastY[t]);
    if (dm > moved) moved = dm;
    const dr = Math.hypot(x - pose.tipRestX[t], y - pose.tipRestY[t]);
    if (dr > fromRest) fromRest = dr;
    const d = (pose.ang[j] - sk.restAng[j]) / DEG;
    if (Math.abs(d) > Math.abs(defl)) defl = d;
  }
  out.moved = moved;
  out.fromRest = fromRest;
  out.deflDeg = defl;
  return out;
}

/** Marks the current tip endpoints as drawn. */
export function commitTips(pose: Pose): void {
  pose.tipLastX.set(pose.tipCurX);
  pose.tipLastY.set(pose.tipCurY);
}

/** Current viewport position of dot i (no flutter). */
export function dotPosition(
  field: DotField,
  pose: Pose,
  rootX: number,
  rootY: number,
  i: number,
  out: { x: number; y: number },
): void {
  if (pose.atRest) {
    out.x = rootX + field.restX[i];
    out.y = rootY + field.restY[i];
    return;
  }
  const a = field.anchor[i];
  const lx = field.lx[i];
  const ly = field.ly[i];
  out.x = pose.ax[a] + pose.ac[a] * lx - pose.as[a] * ly;
  out.y = pose.ay[a] + pose.as[a] * lx + pose.ac[a] * ly;
}

/** Shift the whole pose (and its tip references) by (dx, dy) after a root move. */
export function translatePose(pose: Pose, dx: number, dy: number): void {
  if (dx === 0 && dy === 0) return;
  const shift = (a: Float64Array, d: number): void => {
    for (let i = 0; i < a.length; i++) a[i] += d;
  };
  shift(pose.ox, dx);
  shift(pose.oy, dy);
  shift(pose.ax, dx);
  shift(pose.ay, dy);
  shift(pose.tipRestX, dx);
  shift(pose.tipRestY, dy);
  shift(pose.tipLastX, dx);
  shift(pose.tipLastY, dy);
  shift(pose.tipCurX, dx);
  shift(pose.tipCurY, dy);
}
