/**
 * skeleton.ts — seeded tree skeleton in normalized space (height 1, root at the
 * origin, up = -y) plus static per-joint / per-cluster dynamics constants.
 *
 * Two independent seeded streams: rngShape decides topology and geometry, rngDyn
 * decides motion parameters, so tuning motion can never change the shape or hash.
 * Joints are emitted parent-first (parent index < child index), so a single
 * forward pass solves the pose.
 */
import { createRng, type Rng } from './rng';
import {
  F_TRUNK,
  F_TWIG,
  LAG_LEVELS,
  LAG_MAX,
  MAX_ORDER,
  TURB_BANDS,
} from './config';

const DEG = Math.PI / 180;
const UP = -Math.PI / 2;
const SEG = 0.045;
const MIN_LEN = 0.035;
const HARD_JOINT_CAP = 900;

/** Finalized, typed-array skeleton. Lengths/radii are in units of tree height. */
export interface Skeleton {
  nJ: number;
  nC: number;
  parent: Int32Array;
  restRel: Float32Array;
  restAng: Float32Array;
  len: Float32Array;
  thick: Float32Array;
  order: Uint8Array;
  pathDist: Float32Array;
  isTip: Uint8Array;
  tips: Uint32Array;
  chain: Uint16Array;
  /** Joint each chain sprouts from (-1 for the trunk chain or a pruned root). */
  chainRoot: Int32Array;
  // per-joint mechanics
  flex: Float32Array;
  gain: Float32Array;
  tGain: Float32Array; // touch stiffness: sqrt(flex)·chain.gain
  omega: Float32Array; // rad/ms
  zeta: Float32Array;
  lagMs: Float32Array;
  lagLevel: Uint8Array;
  turbBand: Uint8Array;
  phaseFlutter: Float32Array;
  fFlutter: Float32Array; // rad/s, 0 below order 3
  // clusters (foliage anchors), centre in the owner joint's rest frame
  cOwner: Uint16Array;
  clx: Float32Array;
  cly: Float32Array;
  cR: Float32Array;
  cOmega: Float32Array;
  cZeta: Float32Array;
  cGain: Float32Array;
  cSign: Int8Array;
}

interface RawJoint {
  parent: number;
  wa: number; // world rest angle
  len: number;
  thick: number;
  order: number;
  chain: number;
  phaseFlutter: number;
  fFlutter: number;
  tip: boolean;
}

interface RawCluster {
  owner: number;
  cx: number; // world rest centre (normalized)
  cy: number;
  r: number;
  f: number; // Hz
  gain: number;
  sign: 1 | -1;
}

interface RawChain {
  root: number;
  gain: number;
  freq: number;
  lag: number;
}

interface RawTree {
  joints: RawJoint[];
  clusters: RawCluster[];
  chains: RawChain[];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

function generateRaw(seed: number): RawTree {
  const rs: Rng = createRng(seed);
  const rd: Rng = createRng(seed ^ 0x9e3779b9);
  const joints: RawJoint[] = [];
  const clusters: RawCluster[] = [];
  const chains: RawChain[] = [{ root: -1, gain: 1, freq: 1, lag: 0 }];

  const pushJoint = (
    parent: number,
    wa: number,
    len: number,
    thick: number,
    order: number,
    chain: number,
  ): number => {
    const flutter = order >= 3;
    joints.push({
      parent,
      wa,
      len,
      thick,
      order,
      chain,
      phaseFlutter: rd.float(0, Math.PI * 2),
      fFlutter: flutter ? rd.float(5, 9) : 0,
      tip: false,
    });
    return joints.length - 1;
  };

  const newChain = (root: number, parentChain: number): number => {
    const p = chains[parentChain];
    const own = {
      gain: rd.float(0.7, 1.3),
      freq: rd.float(0.85, 1.2),
      lag: rd.float(-80, 80),
    };
    // The trunk chain is neutral (1, 1, 0); inherit half from real parents only.
    const inherit = parentChain === 0 ? own : p;
    chains.push({
      root,
      gain: inherit.gain * 0.5 + own.gain * 0.5,
      freq: inherit.freq * 0.5 + own.freq * 0.5,
      lag: inherit.lag * 0.5 + own.lag * 0.5,
    });
    return chains.length - 1;
  };

  const grow = (
    parent: number,
    wa: number,
    len: number,
    thick: number,
    order: number,
    parentChain: number,
  ): void => {
    if (joints.length >= HARD_JOINT_CAP) return;
    const chain = newChain(parent, parentChain);
    const n = Math.max(1, Math.ceil(len / SEG));
    const seg = len / n;
    const thickEnd = thick * 0.85;
    let p = parent;
    for (let i = 0; i < n; i++) {
      const a = wa + rs.float(-3, 3) * DEG;
      p = pushJoint(p, a, seg, lerp(thick, thickEnd, i / n), order, chain);
    }
    if (order >= MAX_ORDER || len * 0.8 < MIN_LEN) {
      joints[p].tip = true;
      return;
    }
    spawn(p, wa, len, thickEnd, order + 1, chain);
  };

  const spawn = (
    parent: number,
    wa: number,
    len: number,
    thick: number,
    order: number,
    chain: number,
  ): void => {
    const count = rs.chance(0.3) ? 3 : 2;
    const side = rs.sign();
    const toVertical = (a: number): number => a + 0.25 * (UP - a);
    // leader: small deflection, keeps most of the length
    const leaderA = toVertical(wa + side * rs.float(4, 14) * DEG);
    const others: number[] = [];
    for (let k = 1; k < count; k++) {
      const s = k % 2 === 1 ? -side : side;
      others.push(toVertical(wa + s * rs.float(18, 36) * DEG));
    }
    const otherLens = others.map(() => len * rs.float(0.62, 0.74));
    grow(parent, leaderA, len * 0.8, thick * 0.78, order, chain);
    // Side shoots shorter than the minimum segment are simply not grown.
    for (let k = 0; k < others.length; k++) {
      if (otherLens[k] >= MIN_LEN)
        grow(parent, others[k], otherLens[k], thick * 0.68, order, chain);
    }
  };

  // Trunk: ~8 joints, gentle lean to the left plus a damped random walk.
  const TRUNK_N = 8;
  const TRUNK_LEN = 0.34;
  const lean = rs.float(-6, -2) * DEG;
  let walk = 0;
  let prev = -1;
  const trunk: number[] = [];
  for (let i = 0; i < TRUNK_N; i++) {
    walk = clamp(walk * 0.6 + rs.float(-1.6, 1.6) * DEG, -2.5 * DEG, 2.5 * DEG);
    prev = pushJoint(
      prev,
      UP + lean + walk,
      TRUNK_LEN / TRUNK_N,
      lerp(0.05, 0.032, i / (TRUNK_N - 1)),
      0,
      0,
    );
    trunk.push(prev);
  }
  const top = trunk[TRUNK_N - 1];
  spawn(top, joints[top].wa, 0.25, 0.032, 1, 0);

  // Trunk laterals between 55% and 90% of the trunk height, alternating sides.
  const laterals = rs.int(2, 3);
  let lside = rs.sign();
  for (let i = 0; i < laterals; i++) {
    const frac = lerp(0.55, 0.9, (i + rs.float(0.1, 0.9)) / laterals);
    const tj = trunk[clamp(Math.round(frac * TRUNK_N) - 1, 0, TRUNK_N - 2)];
    const a = UP + lside * rs.float(40, 65) * DEG;
    grow(tj, a, rs.float(0.12, 0.17), joints[tj].thick * 0.6, 1, 0);
    lside = lside === 1 ? -1 : 1;
  }

  // Rest positions (normalized, root at origin) for clusters + normalization.
  const nJ = joints.length;
  const ox = new Float64Array(nJ);
  const oy = new Float64Array(nJ);
  for (let j = 0; j < nJ; j++) {
    const p = joints[j].parent;
    if (p >= 0) {
      ox[j] = ox[p] + joints[p].len * Math.cos(joints[p].wa);
      oy[j] = oy[p] + joints[p].len * Math.sin(joints[p].wa);
    }
  }
  const endX = (j: number): number =>
    ox[j] + joints[j].len * Math.cos(joints[j].wa);
  const endY = (j: number): number =>
    oy[j] + joints[j].len * Math.sin(joints[j].wa);

  const addCluster = (owner: number, r: number): void => {
    clusters.push({
      owner,
      cx: endX(owner) + rs.float(-0.01, 0.01),
      cy: endY(owner) + rs.float(-0.01, 0.01),
      r,
      f: rd.float(2.2, 3.0),
      gain: rd.float(0.6, 1.4),
      sign: rd.chance(0.25) ? -1 : 1,
    });
  };
  for (let j = 0; j < nJ; j++) {
    const o = joints[j].order;
    if (joints[j].tip) {
      const r = clamp(
        lerp(0.085, 0.045, clamp((o - 2) / 4, 0, 1)) * rs.float(0.9, 1.1),
        0.045,
        0.085,
      );
      addCluster(j, r);
    } else if (o >= 4 && rs.chance(0.4)) {
      addCluster(j, rs.float(0.045, 0.06));
    }
  }

  // Normalize so the whole silhouette (canopy included) is exactly 1 tall.
  let minY = 0;
  for (let j = 0; j < nJ; j++) minY = Math.min(minY, endY(j));
  for (const c of clusters) minY = Math.min(minY, c.cy - c.r);
  const k = 1 / -minY;
  for (const jt of joints) {
    jt.len *= k;
    jt.thick *= k;
  }
  for (const c of clusters) {
    c.cx *= k;
    c.cy *= k;
    c.r *= k;
  }
  return { joints, clusters, chains };
}

/** Drop joints above maxOrder; orphaned clusters move to the nearest kept ancestor. */
function pruneRaw(raw: RawTree, maxOrder: number): RawTree {
  const map = new Int32Array(raw.joints.length).fill(-1);
  const joints: RawJoint[] = [];
  raw.joints.forEach((j, i) => {
    if (j.order <= maxOrder) {
      map[i] = joints.length;
      joints.push({ ...j, parent: j.parent >= 0 ? map[j.parent] : -1 });
    }
  });
  const hasChild = new Uint8Array(joints.length);
  for (const j of joints) if (j.parent >= 0) hasChild[j.parent] = 1;
  joints.forEach((j, m) => (j.tip = j.tip || hasChild[m] === 0));
  const clusters = raw.clusters.map((c) => {
    let o = c.owner;
    while (o >= 0 && map[o] < 0) o = raw.joints[o].parent;
    return { ...c, owner: map[o] };
  });
  const chains = raw.chains.map((c) => ({
    ...c,
    root: c.root >= 0 ? map[c.root] : -1,
  }));
  return { joints, clusters, chains };
}

function finalize(raw: RawTree): Skeleton {
  const { joints, clusters, chains } = raw;
  const nJ = joints.length;
  const nC = clusters.length;
  const parent = new Int32Array(nJ);
  const restRel = new Float32Array(nJ);
  const restAng = new Float32Array(nJ);
  const len = new Float32Array(nJ);
  const thick = new Float32Array(nJ);
  const order = new Uint8Array(nJ);
  const pathDist = new Float32Array(nJ);
  const isTip = new Uint8Array(nJ);
  const chain = new Uint16Array(nJ);
  const ox = new Float64Array(nJ);
  const oy = new Float64Array(nJ);
  const ex = new Float64Array(nJ);
  const tipList: number[] = [];

  for (let j = 0; j < nJ; j++) {
    const jt = joints[j];
    const p = jt.parent;
    parent[j] = p;
    restAng[j] = jt.wa;
    restRel[j] = jt.wa - (p >= 0 ? joints[p].wa : UP);
    len[j] = jt.len;
    thick[j] = jt.thick;
    order[j] = jt.order;
    chain[j] = jt.chain;
    if (p >= 0) {
      ox[j] = ox[p] + joints[p].len * Math.cos(joints[p].wa);
      oy[j] = oy[p] + joints[p].len * Math.sin(joints[p].wa);
    }
    ex[j] = ox[j] + jt.len * Math.cos(jt.wa);
    pathDist[j] = (p >= 0 ? pathDist[p] : 0) + jt.len;
    if (jt.tip) {
      isTip[j] = 1;
      tipList.push(j);
    }
  }

  let minX = Infinity;
  let maxX = -Infinity;
  for (let j = 0; j < nJ; j++) {
    minX = Math.min(minX, ex[j]);
    maxX = Math.max(maxX, ex[j]);
  }
  const spanX = Math.max(1e-6, maxX - minX);

  const flex = new Float32Array(nJ);
  const gain = new Float32Array(nJ);
  const tGain = new Float32Array(nJ);
  const omega = new Float32Array(nJ);
  const zeta = new Float32Array(nJ);
  const lagMs = new Float32Array(nJ);
  const lagLevel = new Uint8Array(nJ);
  const turbBand = new Uint8Array(nJ);
  const phaseFlutter = new Float32Array(nJ);
  const fFlutter = new Float32Array(nJ);
  for (let j = 0; j < nJ; j++) {
    const ch = chains[chain[j]];
    const fl = Math.pow(clamp(1 - thick[j] / 0.05, 0.02, 1), 1.6);
    const torque = Math.max(0.35, Math.abs(Math.sin(restAng[j])));
    const normX = (ex[j] - minX) / spanX;
    const f = lerp(F_TRUNK, F_TWIG, Math.sqrt(fl)) * ch.freq;
    flex[j] = fl;
    gain[j] = fl * ch.gain * torque;
    // No torque factor: a hand can push in any direction, unlike the wind.
    tGain[j] = Math.sqrt(fl) * ch.gain;
    omega[j] = (2 * Math.PI * f) / 1000;
    zeta[j] = lerp(0.4, 0.25, fl);
    const lag = clamp(pathDist[j] * 520 + normX * 260 + ch.lag, 0, LAG_MAX);
    lagMs[j] = lag;
    lagLevel[j] = Math.round((lag / LAG_MAX) * (LAG_LEVELS - 1));
    turbBand[j] = Math.min(TURB_BANDS - 1, Math.floor(normX * TURB_BANDS));
    phaseFlutter[j] = joints[j].phaseFlutter;
    fFlutter[j] = joints[j].fFlutter;
  }

  const cOwner = new Uint16Array(nC);
  const clx = new Float32Array(nC);
  const cly = new Float32Array(nC);
  const cR = new Float32Array(nC);
  const cOmega = new Float32Array(nC);
  const cZeta = new Float32Array(nC);
  const cGain = new Float32Array(nC);
  const cSign = new Int8Array(nC);
  for (let k = 0; k < nC; k++) {
    const c = clusters[k];
    const o = c.owner;
    const dx = c.cx - ox[o];
    const dy = c.cy - oy[o];
    const ca = Math.cos(restAng[o]);
    const sa = Math.sin(restAng[o]);
    cOwner[k] = o;
    clx[k] = ca * dx + sa * dy;
    cly[k] = -sa * dx + ca * dy;
    cR[k] = c.r;
    cOmega[k] = (2 * Math.PI * c.f) / 1000;
    cZeta[k] = 0.3;
    cGain[k] = c.gain;
    cSign[k] = c.sign;
  }

  const chainRoot = new Int32Array(chains.length);
  chains.forEach((c, i) => (chainRoot[i] = c.root));

  return {
    nJ,
    nC,
    parent,
    restRel,
    restAng,
    len,
    thick,
    order,
    pathDist,
    isTip,
    tips: Uint32Array.from(tipList),
    chain,
    chainRoot,
    flex,
    gain,
    tGain,
    omega,
    zeta,
    lagMs,
    lagLevel,
    turbBand,
    phaseFlutter,
    fFlutter,
    cOwner,
    clx,
    cly,
    cR,
    cOmega,
    cZeta,
    cGain,
    cSign,
  };
}

const rawCache = new Map<number, RawTree>();

/** Deterministic skeleton for `seed`, optionally pruned to `maxOrder` (mobile). */
export function generateSkeleton(
  seed: number,
  maxOrder: number = MAX_ORDER,
): Skeleton {
  let raw = rawCache.get(seed);
  if (!raw) {
    raw = generateRaw(seed);
    rawCache.set(seed, raw);
  }
  return finalize(maxOrder < MAX_ORDER ? pruneRaw(raw, maxOrder) : raw);
}
