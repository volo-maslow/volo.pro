/**
 * wind.ts — anime.js timelines drive a single wind envelope { strength ∈ [0,1] }.
 * Events are gusts (multi-swell, fast drop) or soft breaths. Between events the
 * scheduler is a plain setTimeout: a pending anime timer would keep the engine's
 * rAF alive, and the goal is zero idle cost.
 */
import { createTimeline, utils, type Timeline } from 'animejs';
import { FIRST_EVENT, GAP, P_GUST } from './config';

export type WindEventType = 'gust' | 'breath';

export interface WindHandlers {
  onEventStart(type: WindEventType): void;
  onEnvelopeEnd(type: WindEventType): void;
}

export interface Wind {
  readonly state: { strength: number };
  current(): WindEventType | null;
  start(): void;
  stop(): void;
  pauseScheduler(): void;
  resumeScheduler(): void;
  /** `attack` (ms, gusts only) replaces the slow first swell with a sudden blast. */
  trigger(type: WindEventType, peak?: number, attack?: number): void;
}

const rand = (range: readonly [number, number]): number =>
  utils.random(range[0], range[1]);

export function createWind(handlers: WindHandlers): Wind {
  const state = { strength: 0 };
  let tl: Timeline | null = null;
  let current: WindEventType | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let due = 0;
  let remaining = -1;
  let first = true;
  let running = false;

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const schedule = (ms: number): void => {
    clearTimer();
    remaining = -1;
    due = performance.now() + ms;
    timer = setTimeout(fire, ms);
  };

  function fire(): void {
    timer = null;
    const type: WindEventType =
      first || utils.random(0, 1, 4) < P_GUST ? 'gust' : 'breath';
    run(type);
  }

  function run(type: WindEventType, peakArg?: number, attack?: number): void {
    first = false;
    tl?.cancel();
    current = type;
    handlers.onEventStart(type);
    const next = createTimeline({
      onComplete: () => {
        if (tl !== next) return;
        tl = null;
        current = null;
        handlers.onEnvelopeEnd(type);
        if (running) schedule(rand(GAP));
      },
    });
    if (type === 'gust') {
      const peak = peakArg ?? utils.random(0.55, 1, 2);
      if (attack !== undefined) {
        // Blast: hit near peak at once, so the crown whips instead of leaning in.
        next.add(state, {
          strength: peak * 0.9,
          duration: Math.max(60, attack),
          ease: 'outQuad',
        });
      } else {
        next.add(state, {
          strength: peak * 0.55,
          duration: utils.random(900, 1400),
          ease: 'inOutSine',
        });
      }
      next
        .add(state, {
          strength: peak,
          duration: utils.random(600, 1000),
          ease: 'inOutQuad',
        })
        .add(state, {
          strength: peak * utils.random(0.55, 0.75, 2),
          duration: utils.random(500, 900),
          ease: 'inOutSine',
        });
      if (utils.random(0, 1, 2) < 0.5) {
        next.add(state, {
          strength: peak * utils.random(0.8, 0.95, 2),
          duration: utils.random(500, 800),
          ease: 'inOutSine',
        });
      }
      // Fast drop: branches spring back through their own inertia.
      next.add(state, {
        strength: 0,
        duration: utils.random(900, 1400),
        ease: 'outSine',
      });
    } else {
      const peak = peakArg ?? utils.random(0.25, 0.4, 2);
      next
        .add(state, {
          strength: peak,
          duration: utils.random(1200, 1800),
          ease: 'inOutSine',
        })
        .add(state, {
          strength: 0,
          duration: utils.random(1400, 2000),
          ease: 'inOutSine',
        });
    }
    tl = next;
  }

  return {
    state,
    current: () => current,
    start() {
      if (running) return;
      running = true;
      if (!tl) schedule(first ? rand(FIRST_EVENT) : rand(GAP));
    },
    stop() {
      running = false;
      clearTimer();
      remaining = -1;
      if (tl) {
        tl.cancel();
        tl = null;
      }
      current = null;
      state.strength = 0;
    },
    pauseScheduler() {
      if (timer === null) return;
      remaining = Math.max(0, due - performance.now());
      clearTimer();
    },
    resumeScheduler() {
      if (!running || remaining < 0 || timer !== null) return;
      schedule(remaining);
    },
    trigger(type, peak, attack) {
      clearTimer();
      remaining = -1;
      run(type, peak, attack);
    },
  };
}
