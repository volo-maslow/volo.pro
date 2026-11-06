/**
 * leaves.ts — a few leeward foliage dots detach during strong gusts and drift
 * away on an anime.js tween; a fast cursor flick through foliage (touch.ts)
 * can also shake one loose. Fixed pool of 4 particles shared by both, with a
 * shared spawn spacing; a detached dot is never restored (reappearing reads as
 * a glitch) and a session caps gust and touch detachments separately.
 */
import { animate, utils, type JSAnimation } from 'animejs';
import type { Rng } from './rng';
import type { DotField } from './rasterize';
import type { Rect } from './layout';
import { MASK_HARD_CODE, MASK_SOFT_CODE } from './rasterize';
import {
  ALPHA,
  LEAF_MIN_SPACING,
  LEAF_THROW_MS,
  LEAF_TREMBLE_MS,
  LEAF_TREMBLE_PX,
  MASK_SOFT,
  LEAF_SPAWN_STRENGTH,
  MAX_DETACHED,
  MAX_LEAVES_ALIVE,
  MAX_LEAVES_PER_GUST,
  TOUCH_SHED_MAX,
} from './config';

export interface Leaf {
  x: number;
  y: number;
  a: number;
  wob: number;
  r: number;
  /** Tremble amplitude (px) before a touch-shed leaf lets go. */
  tr: number;
  /** Alpha multiplier matching the source dot (bucket, soft mask), so it does not pop. */
  m: number;
  alive: boolean;
  anim: JSAnimation | null;
}

export interface Leaves {
  readonly pool: readonly Leaf[];
  /** Per-frame spawn attempt; `pos` resolves dot i's current viewport position. */
  maybeSpawn(
    strength: number,
    isGust: boolean,
    nowMs: number,
    field: DotField,
    pos: (i: number) => { x: number; y: number },
  ): void;
  /** A touch-shed leaf. Returns false if the pool, spacing or cap refuses. */
  shed(
    i: number,
    field: DotField,
    p: { x: number; y: number },
    vx: number,
    vy: number,
    nowMs: number,
    rect: Rect,
  ): boolean;
  /** Cheap pre-check for shed(): pool, shared spacing and touch cap (no RNG, no dot work). */
  canShed(nowMs: number): boolean;
  newGust(): void;
  count(): number;
  clear(): void;
  /** The runtime's timer restarted at 0: forget spacing measured on the old one. */
  resetClock(): void;
  /** Gust and touch detachments together. */
  detachedTotal(): number;
  touchShedTotal(): number;
}

const SPAWN_CHANCE = 0.05; // per frame while eligible

const clamp = (v: number, lo: number, hi: number): number =>
  v < lo ? lo : v > hi ? hi : v;

/** Source dot alpha relative to the leaf base (bucket 2, full mask). */
const alphaMatch = (field: DotField, i: number): number =>
  (ALPHA[field.bucket[i]] / ALPHA[2]) *
  (field.mask[i] === MASK_SOFT_CODE ? MASK_SOFT : 1);

export function createLeaves(rng: Rng): Leaves {
  const pool: Leaf[] = Array.from({ length: MAX_LEAVES_ALIVE }, () => ({
    x: 0,
    y: 0,
    a: 0,
    wob: 0,
    r: 0,
    tr: 0,
    m: 1,
    alive: false,
    anim: null,
  }));
  let alive = 0;
  let perGust = 0;
  let last = -Infinity;
  /** Gust detachments only (MAX_DETACHED); touch has its own TOUCH_SHED_MAX. */
  let gustDetached = 0;
  let touched = 0;

  const free = (leaf: Leaf): void => {
    if (!leaf.alive) return;
    leaf.alive = false;
    leaf.anim = null;
    alive--;
  };

  const canShed = (nowMs: number): boolean =>
    alive < MAX_LEAVES_ALIVE &&
    nowMs - last >= LEAF_MIN_SPACING &&
    touched < TOUCH_SHED_MAX;

  return {
    pool,
    canShed,
    maybeSpawn(strength, isGust, nowMs, field, pos) {
      if (!isGust || strength <= LEAF_SPAWN_STRENGTH) return;
      if (
        perGust >= MAX_LEAVES_PER_GUST ||
        alive >= MAX_LEAVES_ALIVE ||
        gustDetached >= MAX_DETACHED
      )
        return;
      if (nowMs - last < LEAF_MIN_SPACING || field.driftCandidates.length === 0)
        return;
      if (!rng.chance(SPAWN_CHANCE)) return;
      const cands = field.driftCandidates;
      let pick = -1;
      for (let tries = 0; tries < 8 && pick < 0; tries++) {
        const i = cands[rng.int(0, cands.length - 1)];
        if (field.hidden[i] === 0 && field.mask[i] !== MASK_HARD_CODE) pick = i;
      }
      if (pick < 0) return;
      const leaf = pool.find((l) => !l.alive);
      if (!leaf) return;
      const p = pos(pick);
      field.hidden[pick] = 1;
      leaf.x = p.x;
      leaf.y = p.y;
      leaf.a = 1;
      leaf.wob = 0;
      leaf.r = field.r[pick];
      leaf.tr = 0;
      leaf.m = alphaMatch(field, pick);
      leaf.alive = true;
      alive++;
      perGust++;
      gustDetached++;
      last = nowMs;
      leaf.anim = animate(leaf, {
        x: p.x + utils.random(90, 220),
        y: p.y + utils.random(40, 150),
        a: 0,
        wob: Math.PI * 4,
        duration: utils.random(2600, 4200),
        ease: 'outQuad',
        onComplete: () => free(leaf),
      });
    },
    shed(i, field, p, vx, vy, nowMs, rect) {
      if (!canShed(nowMs)) return false;
      const leaf = pool.find((l) => !l.alive);
      if (!leaf) return false;
      field.hidden[i] = 1;
      leaf.x = p.x;
      leaf.y = p.y;
      leaf.a = 1;
      leaf.wob = 0;
      leaf.tr = LEAF_TREMBLE_PX;
      leaf.r = field.r[i];
      leaf.m = alphaMatch(field, i);
      leaf.alive = true;
      alive++;
      touched++;
      last = nowMs;
      const D = LEAF_TREMBLE_MS;
      const dur = utils.random(2200, 3400);
      // Targets stay inside the canvas rect: the renderer culls anything outside it.
      leaf.anim = animate(leaf, {
        tr: { to: 0, duration: D, ease: 'inCubic' }, // holds the shiver, then lets go
        // Thrown with the swipe, then dragged to a stop.
        x: {
          to: clamp(
            p.x + vx * LEAF_THROW_MS + utils.random(-15, 15),
            rect.left + 6,
            rect.left + rect.width - 6,
          ),
          delay: D,
          duration: dur,
          ease: 'outQuad',
        },
        // Gravity.
        y: {
          to: Math.min(
            p.y + utils.random(90, 180) + Math.max(0, vy) * 60,
            rect.top + rect.height - 6,
          ),
          delay: D,
          duration: dur,
          ease: 'inQuad',
        },
        a: { to: 0, delay: D, duration: dur, ease: 'inQuad' },
        wob: { to: Math.PI * 4, delay: D, duration: dur, ease: 'inOutSine' },
        onComplete: () => free(leaf),
      });
      return true;
    },
    newGust() {
      perGust = 0;
    },
    count: () => alive,
    clear() {
      for (const leaf of pool) {
        leaf.anim?.cancel();
        free(leaf);
      }
    },
    resetClock() {
      last = -Infinity;
    },
    detachedTotal: () => gustDetached + touched,
    touchShedTotal: () => touched,
  };
}
