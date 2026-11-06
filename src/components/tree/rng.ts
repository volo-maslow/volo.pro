/**
 * rng.ts — seeded randomness and integer-cell noise.
 * createRng wraps anime's createSeededRandom (always 6 decimals; its default of 0
 * decimals would yield integers only). hash01/valueNoise are pure functions of
 * integer cells, so rasterization never depends on draw order.
 */
import { utils } from 'animejs';

export interface Rng {
  /** Uniform in [a, b] (inclusive, 6 decimals). */
  float(a: number, b: number): number;
  /** Integer in [a, b] (inclusive). */
  int(a: number, b: number): number;
  chance(p: number): boolean;
  sign(): 1 | -1;
}

export function createRng(seed: number): Rng {
  const r = utils.createSeededRandom(seed | 0, 0, 1, 6);
  return {
    float: (a, b) => r(a, b, 6),
    int: (a, b) => r(a, b, 0),
    chance: (p) => r(0, 1, 6) < p,
    sign: () => (r(0, 1, 6) < 0.5 ? -1 : 1),
  };
}

/** 32-bit integer hash of an integer cell. */
export function hash32(x: number, y: number, seed: number): number {
  let h =
    (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Hash of an integer cell mapped to [0, 1). */
export function hash01(x: number, y: number, seed: number): number {
  return hash32(x, y, seed) / 4294967296;
}

const smooth = (t: number): number => t * t * (3 - 2 * t);

/** 2D value noise in [0, 1], smoothstep-interpolated lattice hashes. */
export function valueNoise2(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = smooth(x - x0);
  const fy = smooth(y - y0);
  const a = hash01(x0, y0, seed);
  const b = hash01(x0 + 1, y0, seed);
  const c = hash01(x0, y0 + 1, seed);
  const d = hash01(x0 + 1, y0 + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** 1D value noise in [-1, 1], cosine-interpolated. */
export function valueNoise1(x: number, seed: number): number {
  const x0 = Math.floor(x);
  const f = (1 - Math.cos((x - x0) * Math.PI)) * 0.5;
  const a = hash01(x0, 0, seed) * 2 - 1;
  const b = hash01(x0 + 1, 0, seed) * 2 - 1;
  return a + (b - a) * f;
}
