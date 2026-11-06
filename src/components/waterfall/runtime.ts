/**
 * runtime.ts — mounts the dotted waterfall on a <dot-waterfall> host: layout,
 * terrain, the content-safe mask, the anime.js loop with a fixed-step
 * accumulator (droplets 60 Hz, pool / foam / mist 30 Hz, the fall analytic
 * per frame), the "sluice opens" intro, reduced motion (a long-exposure
 * still), visibility, resize / DPR, colour-scheme re-ink, pointer / touch /
 * scroll play, public events and the dev-only window.__waterfall hook.
 *
 * Clocks: the timer's `t` (wall ms) feeds the accumulator; sim time `ts`
 * advances by wall dt × TIME_SCALE. Pointer bookkeeping uses `clock()`
 * (performance.now(), or a simulated wall clock during dev `stepTo`).
 * Hot paths allocate nothing: every buffer lives in build().
 */
import { animate, createTimer, type JSAnimation, type Timer } from 'animejs';
import * as CONFIG from './config';
import {
  DT_MAX,
  FPS,
  FRAME_BUDGET_MS,
  INK_RGB_DEFAULT,
  INTRO_FADE_MS,
  INTRO_STATE_END,
  POOL,
  PREROLL,
  RERASTER_DH_FRAC,
  RERASTER_DVH,
  RESIZE_DEBOUNCE,
  SEED,
  SPAWN,
  STEP_HZ,
  SUB,
  TIME_SCALE,
  TOUCH_MQ,
  U0_MS,
  VIEW_THROW,
} from './config';
import {
  computeLayout,
  effectiveDpr,
  heightsFor,
  rasterKey,
  retarget,
  variantFor,
  type Layout,
  type Rect,
} from './layout';
import {
  applyMask,
  clearV,
  createGrid,
  MASK_FULL,
  MASK_HARD_CODE,
  MASK_SOFT_CODE,
  setOrigin,
  swapV,
  type AvoidRect,
  type SceneGrid,
} from './grid';
import { generateTerrain, type Terrain } from './terrain';
import { createFlow, type Flow } from './flow';
import { createFall, type Fall } from './fall';
import { createParticles, type Particles } from './particles';
import { createMist, type Mist } from './mist';
import { createLake, type Lake } from './lake';
import { createTouch, type Touch } from './touch';
import { createRenderer, type Renderer } from './render';
import { composeStill } from './still';
import { hash01 } from '../tree/rng';
import { createWind, type Wind } from '../tree/wind';
import { TREE_GUST_EVENT, type TreeGustDetail } from '../tree/events';
import {
  SCENE_GUST_EVENT,
  SCENE_SPLASH_EVENT,
  type SceneGustDetail,
  type SceneSplashDetail,
} from './events';

type SceneState = 'init' | 'intro' | 'flowing' | 'static';

export interface WaterfallStats {
  fps: number;
  avgFrameMs: number;
  maxFrameMs: number;
  emaFrameMs: number;
  frames: number;
  latticeDots: number;
  freeDots: number;
  particles: number;
  rockDots: number;
  dpr: number;
  backingPx: number;
  q: number;
  wind: number;
  ts: number;
  state: SceneState;
  degradeLevel: number;
  loopRunning: boolean;
  region: number;
  splashes: number;
  touchR: number;
  variant: string;
}

export interface WaterfallGeometry {
  lip: { x: number; y: number; w: number };
  impact: { x: number; y: number };
  ys: number;
  rect: Rect;
  lake: { left: number; right: number };
  contentR: number;
  rockMinX: number;
  S: number;
}

export interface WaterfallDevApi {
  getStats(): WaterfallStats;
  resetStats(): void;
  pause(): void;
  resume(): void;
  /** Pause, then advance the sim deterministically to sim time `ms` (from 0 if behind). */
  stepTo(ms: number): void;
  hash(): string;
  geometry(): WaterfallGeometry | null;
  /** Hold an obstacle at (x, y) for `ms` of wall time (works live and under stepTo). */
  poke(x: number, y: number, ms: number): void;
  swipe(x0: number, y0: number, x1: number, y1: number, ms: number): Promise<void>;
  drop(x: number, y: number): void;
  gust(peak?: number): void;
  surge(amount: number): void;
  /** Sum of V (this frame) over a viewport box. */
  sumV(x0: number, y0: number, x1: number, y1: number): number;
  mistCentroid(): { x: number; y: number; m: number };
  readonly config: typeof CONFIG;
}

declare global {
  interface Window {
    __waterfall?: WaterfallDevApi;
  }
}

interface Built {
  layout: Layout;
  key: string;
  rasterVh: number;
  g: SceneGrid;
  t: Terrain;
  fall: Fall;
  lake: Lake;
  mist: Mist;
  parts: Particles;
  touch: Touch;
  rect: Rect;
  dpr: number;
  /** Reduced motion: the composed long exposure (V + streak flags), made once per build. */
  stillV: Float32Array | null;
  stillStreak: Uint8Array | null;
}

const AVOID_SEL = '[data-scene-avoid],[data-tree-avoid]';
const AVOID_FALLBACK_SOFT = 'main h1';
const AVOID_FALLBACK_HARD =
  'main form input:not([tabindex="-1"]), main form button, main form p:not(.visually-hidden), footer nav a, footer p';
const CONTROL_SEL = 'input,button,a,textarea,select,label';
const INK_RE = /^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/;
const S_SPAWN = SEED ^ SUB.spawn;
const STEP_MS = 1000 / STEP_HZ;

function readInk(host: HTMLElement): string {
  const cs = getComputedStyle(host);
  for (const name of ['--scene-ink', '--tree-ink']) {
    const v = cs.getPropertyValue(name).trim();
    if (INK_RE.test(v)) return v;
  }
  return INK_RGB_DEFAULT;
}

/** Water may carry its own ink (white water on a dark page); else the rock ink. */
function readWaterInk(host: HTMLElement): string {
  const v = getComputedStyle(host).getPropertyValue('--scene-water-ink').trim();
  return INK_RE.test(v) ? v : readInk(host);
}

const readQuiet = (host: HTMLElement): boolean =>
  getComputedStyle(host).getPropertyValue('--scene-quiet').trim() === '1';

/** Mount the waterfall on `host` (two canvases). Returns a disposer. */
export function mountWaterfall(host: HTMLElement): () => void {
  const rockCanvas = host.querySelector<HTMLCanvasElement>('canvas[data-layer="rock"]');
  const waterCanvas = host.querySelector<HTMLCanvasElement>('canvas[data-layer="water"]');
  if (!rockCanvas || !waterCanvas) return () => {};
  const rockEl: HTMLCanvasElement = rockCanvas;
  const waterEl: HTMLCanvasElement = waterCanvas;

  const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hoverMq = window.matchMedia(TOUCH_MQ);
  const darkMq = window.matchMedia('(prefers-color-scheme: dark)');
  const flow: Flow = createFlow();

  let renderer: Renderer | null = null;
  let b: Built | null = null;
  let state: SceneState = 'init';
  let loop: Timer | null = null;
  let wind: Wind | null = null;
  let fades: JSAnimation[] = [];
  let ts = 0;
  let tsPrev = 0;
  let acc = 0;
  let stepIdx = 0;
  let spawnAccB = 0;
  let spawnAccS = 0;
  let lastT = 0;
  let freshDt = true;
  let fps: number = FPS.desktop;
  let degrade = 0;
  let lastDegrade = 0;
  let ema = 0;
  let frameSum = 0;
  let frameCount = 0;
  let frameMax = 0;
  let avoidRects: AvoidRect[] = [];
  let avoidKey = '';
  let idleHandle = 0;
  let idleIsRic = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let stillTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollRaf = 0;
  let dprMq: MediaQueryList | null = null;
  let disposed = false;
  let ctlTarget: EventTarget | null = null;
  let overCtl = false;
  let listening = false;
  let devMode = false; // stepTo drives the clock
  let simWall = 0;
  let wheelY = 0;
  let quiet = false;

  const clock = (): number => (devMode ? simWall : performance.now());
  const setState = (s: SceneState): void => {
    if (state === s) return;
    state = s;
    host.dataset.state = s;
  };
  const viewport = (): { vw: number; vh: number } => ({
    vw: host.clientWidth || window.innerWidth,
    vh: host.clientHeight || window.innerHeight,
  });
  const deviceDpr = (): number => Math.min(window.devicePixelRatio || 1, 2);
  const loopRunning = (): boolean => loop !== null && !loop.paused;

  function canvasRect(l: Layout, g: SceneGrid): Rect {
    const S = g.S;
    const left = Math.max(0, Math.floor(g.gx0 + g.vi0 * S - S));
    const right = Math.min(l.vw, Math.ceil(g.gx0 + (g.vi1 - 1) * S + S));
    const top = Math.max(0, Math.floor(g.gy0 + g.vj0 * S - S));
    const bottom = Math.min(l.vh, Math.ceil(g.gy0 + (g.vj1 - 1) * S + S));
    return { left, top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
  }

  /**
   * Narrow desktop windows (768–1023 px) keep the scene behind the column, so
   * everything is softened. The mobile vignette sits in clear space and only
   * softens under marked text, like the lane.
   */
  function baseMask(l: Layout): number {
    return l.narrow && l.variant !== 'mobile' ? MASK_SOFT_CODE : MASK_FULL;
  }

  function setAttrs(): void {
    if (!b) return;
    host.dataset.variant = b.layout.variant;
    host.dataset.dots = String(b.t.rockN);
    host.dataset.seed = String(SEED);
    host.dataset.hash = b.t.hash;
    host.dataset.fps = String(fps);
  }

  function targetFps(l: Layout): number {
    const base = l.quiet ? FPS.quiet : l.variant === 'mobile' ? FPS.mobile : FPS.desktop;
    return degrade >= 1 ? Math.min(base, 30) : base;
  }

  function build(vw: number, vh: number): void {
    if (!renderer) return;
    quiet = readQuiet(host);
    const rough = computeLayout(vw, vh, deviceDpr(), quiet);
    let g = createGrid(rough);
    let rect = canvasRect(rough, g);
    const dpr = effectiveDpr(deviceDpr(), rect.width, rect.height);
    const layout = computeLayout(vw, vh, dpr, quiet);
    g = createGrid(layout);
    rect = canvasRect(layout, g);
    const t = generateTerrain(layout, g);
    const fall = createFall(layout, g, t, flow);
    const lake = createLake(layout, g, t, fall.wBot);
    const mist = createMist(layout, g, fall.wBot);
    const cap = Math.round(POOL[layout.variant] * (quiet ? 0.5 : 1));
    const parts = createParticles(cap, layout, g, t);
    if (degrade >= 2) parts.limit = Math.round(cap * 0.5);
    if (degrade >= 3) mist.enabled = false;
    const touch = createTouch(layout, g, fall, flow, lake, mist, parts);
    b?.touch.reset();
    b = {
      layout,
      key: rasterKey(layout),
      rasterVh: vh,
      g,
      t,
      fall,
      lake,
      mist,
      parts,
      touch,
      rect,
      dpr,
      stillV: null,
      stillStreak: null,
    };
    renderer.setGrid(g);
    renderer.edgeFade = layout.variant === 'mobile' ? 0.15 * layout.Hs : 120;
    renderer.setInk(readInk(host), readWaterInk(host), layout.alphaMul);
    renderer.setRect(rect, dpr);
    applyMask(g, avoidRects, baseMask(layout), t.rockCells, 0);
    renderer.drawRocks(t, g);
    const f = targetFps(layout);
    if (f !== fps) {
      fps = f;
      if (loop) loop.fps = fps;
    }
    setAttrs();
    if (state === 'static') drawStill();
    else if (!loopRunning()) renderFrame(0);
  }

  function reposition(vw: number, vh: number): void {
    if (!b || !renderer) return;
    const prev = b.layout;
    const next = retarget(prev, vw, vh, prev.dpr);
    Object.assign(prev, next); // modules hold this object: mutate in place
    const gw = b.g;
    const win = `${gw.vi0},${gw.vi1},${gw.vj0},${gw.vj1}`;
    setOrigin(b.g, prev);
    // The still is composed over the visible window only: a new window needs a new one.
    if (win !== `${gw.vi0},${gw.vi1},${gw.vj0},${gw.vj1}`) {
      b.stillV = null;
      b.stillStreak = null;
    }
    const rect = canvasRect(prev, b.g);
    const dpr = effectiveDpr(deviceDpr(), rect.width, rect.height);
    prev.dpr = dpr;
    b.rect = rect;
    b.dpr = dpr;
    b.parts.clear();
    b.touch.reset();
    renderer.setRect(rect, dpr);
    applyMask(b.g, avoidRects, baseMask(prev), b.t.rockCells, 0);
    renderer.drawRocks(b.t, b.g);
    if (state === 'static') drawStill();
    else if (!loopRunning()) renderFrame(0);
  }

  function measureAvoid(): void {
    if (!b) return;
    let els = document.querySelectorAll<HTMLElement>(AVOID_SEL);
    let fallback = false;
    if (els.length === 0) {
      els = document.querySelectorAll<HTMLElement>(`${AVOID_FALLBACK_SOFT}, ${AVOID_FALLBACK_HARD}`);
      fallback = true;
    }
    const rects: AvoidRect[] = [];
    let key = '';
    const mobile = b.layout.variant === 'mobile';
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      const soft =
        mobile ||
        (fallback
          ? el.matches(AVOID_FALLBACK_SOFT)
          : (el.dataset.sceneAvoid ?? el.dataset.treeAvoid) === 'soft');
      const level = soft ? MASK_SOFT_CODE : MASK_HARD_CODE;
      rects.push({ x: r.left, y: r.top, w: r.width, h: r.height, level });
      key += `${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)},${Math.round(r.height)},${level};`;
    });
    if (key === avoidKey) return;
    avoidKey = key;
    avoidRects = rects;
    const g = b.g;
    if (applyMask(g, avoidRects, baseMask(b.layout), b.t.rockCells, b.t.rockCells.length))
      renderer?.drawRocks(b.t, g);
    // Cheap in the static state: the still is cached, this only re-masks it.
    if (state === 'static') drawStill();
  }

  // ── Simulation ────────────────────────────────────────────────────────────
  let spawnK = 0;
  const r = (): number => hash01(stepIdx, spawnK++, S_SPAWN);

  /** Breakup drops from the ropes and spray from the plunge, per 60 Hz step. */
  function spawnSources(h: number, qImp: number): void {
    if (!b) return;
    const { fall, parts, layout: l } = b;
    const ppm = l.ppm;
    const qNow = flow.q(ts - fall.tauF * 0.5);
    spawnAccB += SPAWN.breakup * Math.max(0, qNow) * h;
    spawnAccS += SPAWN.spray * Math.pow(Math.max(0, qImp), 1.3) * h;
    spawnK = 0;
    const K = fall.K;
    const jSpan = fall.jBot - 2 - fall.jTop;
    while (spawnAccB >= 1) {
      spawnAccB -= 1;
      const rimPick = r() < 0.6;
      const k = rimPick
        ? r() < 0.5
          ? Math.floor(r() * 2)
          : K - 1 - Math.floor(r() * 2)
        : Math.floor(r() * K);
      // Rows where the sheet has broken up (β > 0.5).
      const j = fall.jTop + Math.floor(jSpan * (0.5 + 0.48 * r()));
      if (fall.beta[j] < 0.5) continue;
      const e = ts - fall.tau[j];
      if (e < 0) continue;
      fall.evalStrand(k, j, ts, flow.q(e), flow.tongue(e));
      if (fall.oI < 0.25) continue;
      const side = k < K / 2 ? -1 : 1;
      const lat = (0.3 + 0.9 * r()) * ppm * (rimPick ? side : r() < 0.5 ? -1 : 1);
      const y = b.g.gy0 + j * b.g.S;
      const u = r();
      parts.spawn(
        fall.ox + (r() - 0.5) * 3,
        y,
        -VIEW_THROW * U0_MS * ppm + lat,
        fall.vel[j] * 0.92,
        u < 0.25 ? 0 : u < 0.75 ? 1 : 2,
      );
    }
    const xi = l.xi;
    while (spawnAccS >= 1) {
      spawnAccS -= 1;
      const left = r() < 0.6;
      const ang = ((20 + 55 * r()) * Math.PI) / 180;
      const sp = (0.15 + 0.25 * r()) * fall.vImp;
      const f = (sp / fall.vImp - 0.15) / 0.25; // fast spray is fine spray
      parts.spawn(
        xi + (r() - 0.5) * fall.wBot * 0.9,
        l.ys - 1 - r() * 4,
        (left ? -1 : 1) * Math.cos(ang) * sp + fall.wind * 0.5 * ppm,
        -Math.sin(ang) * sp,
        f > 0.66 ? 0 : f > 0.3 ? 1 : 2,
      );
    }
  }

  /** Advance by one wall frame of dtw ms (no drawing). */
  function advance(dtw: number): void {
    if (!b) return;
    const { fall, lake, mist, parts, touch } = b;
    tsPrev = ts;
    ts += (dtw / 1000) * TIME_SCALE;
    acc += dtw;
    const w = devMode || !wind ? 0 : wind.state.strength;
    fall.wind = w;
    mist.wind = w;
    lake.wind = w;
    fall.advance(ts);
    touch.update(ts, tsPrev, clock(), stepIdx);
    const qImp = flow.q(ts - fall.tauF) + flow.tongue(ts - fall.tauF);
    const h = (STEP_MS / 1000) * TIME_SCALE;
    let n = 0;
    while (acc >= STEP_MS && n < 4) {
      acc -= STEP_MS;
      n++;
      stepIdx++;
      spawnSources(h, qImp);
      parts.step(h, mist, lake, stepIdx);
      if ((stepIdx & 1) === 0) {
        lake.step(2 * h, ts, qImp, stepIdx);
        mist.step(2 * h, ts, qImp, flow.q(ts - fall.tauF * 0.85));
        touch.fieldStep(ts);
      }
    }
    if (n === 4) acc = 0;
  }

  /** Compose V for the current ts and draw the water layer. */
  function renderFrame(dtw: number): void {
    if (!b || !renderer) return;
    const { g, fall, lake, mist, parts, touch } = b;
    swapV(g);
    clearV(g);
    const qImp = flow.q(ts - fall.tauF) + flow.tongue(ts - fall.tauF);
    fall.splat(g, ts);
    fall.approach(g, ts);
    fall.impact(g, ts, qImp);
    lake.shade(g, ts);
    mist.contribute(g);
    renderer.drawWater(g, parts, touch, (dtw / 1000) * TIME_SCALE);
  }

  /**
   * The reduced-motion frame. Composing the long exposure is costly (warm-up
   * plus 2 × 48 splats), so it runs once per build (or new visible window) and
   * is cached; scroll, mask and ink changes only copy it back and redraw.
   */
  function drawStill(): void {
    if (!b || !renderer) return;
    const g = b.g;
    if (b.stillV && b.stillStreak) {
      g.V.set(b.stillV);
      g.streak.set(b.stillStreak);
      renderer.drawWater(g, null, null, 0);
      return;
    }
    // Compose in its own task, so it never stacks onto build() in one long task.
    if (stillTimer !== null) return;
    stillTimer = setTimeout(() => {
      stillTimer = null;
      if (!b || !renderer || disposed || state !== 'static') return;
      b.parts.clear();
      composeStill({ g: b.g, fall: b.fall, flow, lake: b.lake, mist: b.mist });
      b.stillV = b.g.V.slice();
      b.stillStreak = b.g.streak.slice();
      renderer.drawWater(b.g, null, null, 0);
    }, 0);
  }

  function frame(t: number): void {
    if (!b || !renderer) return;
    const f0 = performance.now();
    let dt = freshDt ? 1000 / fps : t - lastT;
    freshDt = false;
    lastT = t;
    if (dt < 0) dt = 0;
    else if (dt > DT_MAX) dt = DT_MAX;
    advance(dt);
    renderFrame(dt);
    if (state === 'intro' && ts > INTRO_STATE_END) setState('flowing');
    const ms = performance.now() - f0;
    frameSum += ms;
    frameCount++;
    if (ms > frameMax) frameMax = ms;
    ema += (ms - ema) / 120;
    if (frameCount > 120 && ema > FRAME_BUDGET_MS && degrade < 3 && f0 - lastDegrade > 2000) {
      lastDegrade = f0;
      degrade++;
      if (degrade === 1) {
        fps = 30;
        if (loop) loop.fps = 30;
        setAttrs();
      } else if (degrade === 2) b.parts.limit = Math.round(b.parts.cap * 0.5);
      else b.mist.enabled = false;
    }
  }

  function startMotion(skipIntro: boolean): void {
    if (loop || disposed || !b) return;
    if (skipIntro) ts = Math.max(ts, INTRO_STATE_END);
    // Open already flowing: run the sim (no drawing) until the sheet has
    // reached the pool and the pool and mist are warm.
    const pre = (1000 / 30) | 0;
    while (ts < PREROLL) advance(pre);
    acc = 0;
    loop = createTimer({
      autoplay: false,
      frameRate: fps,
      onUpdate: (self) => frame(self.currentTime),
    });
    wind = createWind({ onEventStart: () => {}, onEnvelopeEnd: () => {} });
    wind.start();
    setState(ts > INTRO_STATE_END ? 'flowing' : 'intro');
    if (document.hidden) wind.pauseScheduler();
    else {
      freshDt = true;
      loop.resume();
    }
    syncListeners();
  }

  function stopMotion(): void {
    wind?.stop();
    wind = null;
    loop?.cancel();
    loop = null;
    syncListeners();
    b?.touch.reset();
    b?.parts.clear();
  }

  // ── Listeners ─────────────────────────────────────────────────────────────
  function syncListeners(): void {
    const on = loop !== null && !disposed;
    if (on === listening) return;
    listening = on;
    if (on) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      window.addEventListener('pointerdown', onPointerDown, { passive: true });
      window.addEventListener('pointerup', onPointerUp, { passive: true });
      window.addEventListener('pointercancel', onPointerUp, { passive: true });
      window.addEventListener('wheel', onWheel, { passive: true });
      document.documentElement.addEventListener('pointerleave', onPointerGone);
      window.addEventListener('blur', onPointerGone);
    } else {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('wheel', onWheel);
      document.documentElement.removeEventListener('pointerleave', onPointerGone);
      window.removeEventListener('blur', onPointerGone);
      ctlTarget = null;
      overCtl = false;
    }
  }

  const onPointerGone = (): void => b?.touch.lift();

  const inScene = (x: number, y: number, pad: number): boolean => {
    if (!b) return false;
    const r = b.rect;
    return !(x < r.left - pad || x > r.left + r.width + pad || y < r.top - pad || y > r.top + r.height + pad);
  };

  const overControl = (target: EventTarget | null): boolean => {
    if (target !== ctlTarget) {
      ctlTarget = target;
      overCtl = target instanceof Element && target.closest(CONTROL_SEL) !== null;
    }
    return overCtl;
  };

  // Never preventDefault, never capture; the host keeps pointer-events: none.
  const onPointerMove = (e: PointerEvent): void => {
    if (!b || devMode || document.hidden) return;
    const tc = b.touch;
    if (e.pointerType === 'touch') {
      tc.touchMove(e.clientX, e.clientY);
      return;
    }
    if (!hoverMq.matches) return;
    if (e.buttons !== 0 || host.style.transform !== '') {
      tc.lift();
      return;
    }
    const x = e.clientX;
    const y = e.clientY;
    if (!inScene(x, y, tc.R)) {
      tc.lift(); // over the content column: four comparisons, nothing else
      return;
    }
    if (overControl(e.target)) {
      tc.lift();
      return;
    }
    tc.feed(x, y, e.timeStamp);
  };

  const onPointerDown = (e: PointerEvent): void => {
    if (!b || devMode || document.hidden || e.button !== 0) return;
    if (host.style.transform !== '') return;
    const x = e.clientX;
    const y = e.clientY;
    if (!inScene(x, y, 0)) return;
    const tgt = e.target;
    // With a lane, text marks the edge of the playground. On narrow layouts the
    // scene lies under static text (the soft mask draws it there), so a tap on
    // text plays too; only real controls and an active text selection don't.
    const sel = b.layout.narrow ? CONTROL_SEL : `${CONTROL_SEL},${AVOID_SEL}`;
    if (tgt instanceof Element && tgt.closest(sel)) return;
    if (b.layout.narrow && !(window.getSelection()?.isCollapsed ?? true)) return;
    b.touch.down(x, y, e.pointerType === 'touch', clock(), ts);
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (e.pointerType === 'touch') b?.touch.touchEnd();
  };

  const onWheel = (e: WheelEvent): void => {
    // Only when the page itself cannot scroll (otherwise scroll events count).
    const doc = document.documentElement;
    if (doc.scrollHeight > window.innerHeight + 1 || !b) return;
    wheelY += e.deltaY;
    b.touch.scroll(wheelY, clock());
  };

  const onHoverChange = (): void => b?.touch.lift();

  function handleResize(): void {
    if (!b) return;
    const { vw, vh } = viewport();
    const L = b.layout;
    const variant = variantFor(vw);
    const { Hs } = heightsFor(variant, vh);
    const q2 = readQuiet(host);
    const probe = retarget(L, vw, vh, L.dpr);
    const clipChanged = rasterKey(probe) !== b.key;
    const narrowChanged = probe.narrow !== L.narrow;
    const dprNow = effectiveDpr(deviceDpr(), b.rect.width, b.rect.height);
    if (
      variant !== L.variant ||
      q2 !== quiet ||
      narrowChanged ||
      (Math.abs(vh - b.rasterVh) >= RERASTER_DVH && Math.abs(Hs - L.Hs) / L.Hs > RERASTER_DH_FRAC) ||
      (clipChanged && Math.abs(vh - b.rasterVh) < 1)
    ) {
      build(vw, vh);
    } else if (vw !== L.vw || vh !== L.vh || Math.abs(dprNow - b.dpr) > 1e-3) {
      reposition(vw, vh);
    }
    avoidKey = '';
    measureAvoid();
  }

  const onResizeObserved = (): void => {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      handleResize();
    }, RESIZE_DEBOUNCE);
  };
  const ro = new ResizeObserver(onResizeObserved);

  const onDprChange = (): void => {
    watchDpr();
    handleResize();
  };
  function watchDpr(): void {
    dprMq?.removeEventListener('change', onDprChange);
    dprMq = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    dprMq.addEventListener('change', onDprChange);
  }

  const onScroll = (): void => {
    if (b && loop) b.touch.scroll(window.scrollY, clock());
    if (scrollRaf) return;
    const doc = document.documentElement;
    if (doc.scrollHeight <= window.innerHeight && doc.scrollWidth <= window.innerWidth) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      measureAvoid();
    });
  };

  const onVisibility = (): void => {
    if (document.hidden) {
      b?.touch.reset();
      wind?.pauseScheduler();
      loop?.pause();
    } else {
      wind?.resumeScheduler();
      if (loop && !devMode) {
        freshDt = true;
        acc = 0; // no catch-up
        loop.resume();
      }
    }
  };

  const onGust = (e: CustomEvent<SceneGustDetail | TreeGustDetail>): void => {
    if (!wind || document.hidden) return;
    const { peak, attack } = e.detail ?? {};
    wind.trigger('gust', peak === undefined ? undefined : Math.min(1, Math.max(0, peak)), attack);
  };

  const onSplash = (e: CustomEvent<SceneSplashDetail>): void => {
    if (!b || !loop || document.hidden) return;
    const l = b.layout;
    const x = e.detail?.x ?? l.xi - 0.12 * l.Hs;
    const y = e.detail?.y ?? Math.min(l.vh - 20, l.ys + 0.06 * l.Hs);
    if (b.lake.isWater(x, y)) b.touch.pebble(x, y, ts);
  };

  const onScheme = (): void => {
    if (!b || !renderer) return;
    renderer.setInk(readInk(host), readWaterInk(host), b.layout.alphaMul);
    renderer.drawRocks(b.t, b.g);
    if (state === 'static') drawStill();
  };

  const onReducedChange = (e: MediaQueryListEvent): void => {
    if (!b) return;
    if (e.matches) {
      stopMotion();
      for (const f of fades) f.cancel();
      fades = [];
      rockEl.style.opacity = '1';
      waterEl.style.opacity = '1';
      setState('static');
      drawStill();
    } else {
      setState('flowing');
      startMotion(true);
    }
  };

  // ── Startup ───────────────────────────────────────────────────────────────
  function init(): void {
    idleHandle = 0;
    if (disposed) return;
    try {
      renderer = createRenderer(rockEl, waterEl, readInk(host));
    } catch {
      return; // no 2D context: leave the background empty
    }
    if (reducedMq.matches) state = 'static';
    const { vw, vh } = viewport();
    build(vw, vh);
    measureAvoid();
    ro.observe(host);
    watchDpr();
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener(SCENE_GUST_EVENT, onGust);
    document.addEventListener(TREE_GUST_EVENT, onGust);
    document.addEventListener(SCENE_SPLASH_EVENT, onSplash);
    reducedMq.addEventListener('change', onReducedChange);
    hoverMq.addEventListener('change', onHoverChange);
    darkMq.addEventListener('change', onScheme);
    document.fonts?.ready.then(() => {
      if (!disposed) {
        avoidKey = '';
        measureAvoid();
      }
    });
    if (reducedMq.matches) {
      // build() already drew the still (state was 'static' before it ran).
      rockEl.style.opacity = '1';
      waterEl.style.opacity = '1';
      host.dataset.state = 'static';
    } else {
      fades = [rockEl, waterEl].map((el) =>
        animate(el, { opacity: [0, 1], duration: INTRO_FADE_MS, ease: 'outQuad' }),
      );
      startMotion(false);
    }
  }

  if ('requestIdleCallback' in window) {
    idleIsRic = true;
    idleHandle = window.requestIdleCallback(init, { timeout: 500 });
  } else {
    idleHandle = setTimeout(init, 0) as unknown as number;
  }

  const stats = (): WaterfallStats => ({
    fps,
    avgFrameMs: frameCount ? frameSum / frameCount : 0,
    maxFrameMs: frameMax,
    emaFrameMs: ema,
    frames: frameCount,
    latticeDots: renderer?.latticeDots ?? 0,
    freeDots: renderer?.freeDots ?? 0,
    particles: b?.parts.count ?? 0,
    rockDots: b?.t.rockN ?? 0,
    dpr: b?.dpr ?? 0,
    backingPx: renderer?.backingPx() ?? 0,
    q: flow.q(ts),
    wind: wind?.state.strength ?? 0,
    ts,
    state,
    degradeLevel: degrade,
    loopRunning: loopRunning(),
    region: b?.touch.region ?? 0,
    splashes: b?.touch.splashes ?? 0,
    touchR: b?.touch.R ?? 0,
    variant: b?.layout.variant ?? '',
  });
  (host as WaterfallElement).getStats = stats;

  // ── Dev hook ──────────────────────────────────────────────────────────────
  if (import.meta.env.DEV) {
    const resetSim = (): void => {
      if (!b) return;
      ts = 0;
      tsPrev = 0;
      acc = 0;
      stepIdx = 0;
      spawnAccB = 0;
      spawnAccS = 0;
      simWall = 0;
      flow.reset();
      b.fall.resetMemory();
      b.lake.clear();
      b.mist.clear();
      b.parts.clear();
      b.touch.reset();
    };
    window.__waterfall = {
      getStats: stats,
      resetStats() {
        frameSum = 0;
        frameCount = 0;
        frameMax = 0;
      },
      pause() {
        wind?.pauseScheduler();
        loop?.pause();
      },
      resume() {
        devMode = false;
        wind?.resumeScheduler();
        if (loop) {
          freshDt = true;
          acc = 0;
          loop.resume();
        }
      },
      stepTo(ms) {
        if (!b) return;
        loop?.pause();
        wind?.pauseScheduler();
        if (!devMode || ms / 1000 < ts) {
          devMode = true;
          resetSim();
        }
        const target = ms / 1000;
        const dtw = 1000 / 60;
        let last = 0;
        while (ts + (dtw / 1000) * TIME_SCALE <= target + 1e-9) {
          simWall += dtw;
          advance(dtw);
          last = dtw;
        }
        // Twice: the first pass fills Vprev, so reflections never see a live frame.
        renderFrame(last || dtw);
        renderFrame(last || dtw);
      },
      hash: () => b?.t.hash ?? '',
      geometry() {
        if (!b) return null;
        const l = b.layout;
        return {
          lip: { x: l.xf, y: l.ylip, w: l.W0 },
          impact: { x: l.xi, y: l.ys },
          ys: l.ys,
          rect: { ...b.rect },
          // Where the pool visibly starts (its fade-in), not the grid edge.
          lake: {
            left: b.g.gx0 + Math.max(0, b.t.lakeFade.findIndex((f) => f > 0.01)) * b.g.S,
            right: Math.min(l.vw, b.g.gx0 + b.g.cols * b.g.S),
          },
          contentR: l.contentR,
          rockMinX: l.rockMinX,
          S: l.S,
        };
      },
      poke(x, y, ms) {
        b?.touch.hold(x, y, ms, clock());
      },
      swipe(x0, y0, x1, y1, ms) {
        return new Promise((resolve) => {
          if (!b) return resolve();
          const t0 = performance.now();
          const tick = (): void => {
            if (!b) return resolve();
            const el = Math.min(ms, performance.now() - t0);
            const u = el / Math.max(1, ms);
            b.touch.feed(x0 + (x1 - x0) * u, y0 + (y1 - y0) * u, performance.now());
            if (el < ms) requestAnimationFrame(tick);
            else {
              b.touch.lift();
              resolve();
            }
          };
          requestAnimationFrame(tick);
        });
      },
      drop(x, y) {
        if (b && b.lake.isWater(x, y)) b.touch.pebble(x, y, ts);
      },
      gust(peak) {
        wind?.trigger('gust', peak);
      },
      surge(amount) {
        flow.surgeNow(ts, amount);
      },
      sumV(x0, y0, x1, y1) {
        if (!b) return 0;
        const g = b.g;
        let s = 0;
        const i0 = Math.max(0, Math.ceil((x0 - g.gx0) / g.S));
        const i1 = Math.min(g.cols - 1, Math.floor((x1 - g.gx0) / g.S));
        const j0 = Math.max(0, Math.ceil((y0 - g.gy0) / g.S));
        const j1 = Math.min(g.rows - 1, Math.floor((y1 - g.gy0) / g.S));
        for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) s += g.V[j * g.cols + i];
        return s;
      },
      mistCentroid: () => b?.mist.centroid() ?? { x: 0, y: 0, m: 0 },
      config: CONFIG,
    };
  }

  return () => {
    disposed = true;
    if (idleHandle) {
      if (idleIsRic) window.cancelIdleCallback(idleHandle);
      else clearTimeout(idleHandle);
    }
    stopMotion();
    for (const f of fades) f.cancel();
    fades = [];
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    if (stillTimer !== null) clearTimeout(stillTimer);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    ro.disconnect();
    dprMq?.removeEventListener('change', onDprChange);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener(SCENE_GUST_EVENT, onGust);
    document.removeEventListener(TREE_GUST_EVENT, onGust);
    document.removeEventListener(SCENE_SPLASH_EVENT, onSplash);
    reducedMq.removeEventListener('change', onReducedChange);
    hoverMq.removeEventListener('change', onHoverChange);
    darkMq.removeEventListener('change', onScheme);
    renderer?.clear();
    if (import.meta.env.DEV) delete window.__waterfall;
  };
}

export class WaterfallElement extends HTMLElement {
  #dispose: (() => void) | null = null;
  /** Cheap, production-safe stats (set on mount). */
  getStats: (() => WaterfallStats) | null = null;

  connectedCallback(): void {
    if (!this.#dispose) this.#dispose = mountWaterfall(this);
  }

  disconnectedCallback(): void {
    this.#dispose?.();
    this.#dispose = null;
  }
}

if (!customElements.get('dot-waterfall'))
  customElements.define('dot-waterfall', WaterfallElement);
