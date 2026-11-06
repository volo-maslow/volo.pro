/**
 * runtime.ts — mounts the dotted wind-tree on a <dot-tree> host: generation,
 * layout, content-safe mask, the anime.js render loop and its settle logic,
 * reduced motion, visibility, resize and DPR handling, data attributes, the
 * public gust command (events.ts), the desktop cursor brush (touch.ts) and the
 * dev-only window.__dotTree hook.
 *
 * Idle cost is zero: between wind events and cursor brushes the anime timer is
 * paused, so the engine has no live tickables and stops requesting frames.
 *
 * Two clocks: the timer's `t` drives settle bookkeeping and leaf spacing; the
 * pointer (velocity, staleness, shake, touch shed spacing) uses performance.now()
 * / event timeStamp. Never mix them.
 */
import { animate, createTimer, type JSAnimation, type Timer } from 'animejs';
import * as CONFIG from './config';
import {
  FPS_ACTIVE,
  INK_RGB_DEFAULT,
  LAG_LEVELS,
  LAG_MAX,
  MAX_ORDER,
  MOBILE_MAX_ORDER,
  RERASTER_DH_FRAC,
  RERASTER_DVH,
  RESIZE_DEBOUNCE,
  SEED,
  SETTLE_DISP_PX,
  SETTLE_FRAMES,
  SETTLE_MAX,
  SETTLE_VEL,
  DIRTY_PX,
  JOINT_BUDGET,
  ANCHOR_BUDGET,
  TURB_BANDS,
  TURB_FREQ,
  TURB_SPEED,
  TOUCH_MQ,
  TOUCH_SHED_PICK,
  TOUCH_V_MIN,
  type Variant,
} from './config';
import { generateSkeleton, type Skeleton } from './skeleton';
import {
  canvasRect,
  computeLayout,
  effectiveDpr,
  heightFor,
  retarget,
  variantFor,
  type Layout,
  type Rect,
} from './layout';
import {
  applyMask,
  fieldHash,
  MASK_HARD_CODE,
  MASK_SOFT_CODE,
  rasterize,
  type AvoidRect,
  type DotField,
} from './rasterize';
import {
  commitTips,
  createPose,
  dotPosition,
  measureTips,
  resetDynamics,
  solveRest,
  step,
  translatePose,
  type Pose,
  type TipMetrics,
} from './pose';
import { createHistory } from './history';
import { createLeaves } from './leaves';
import { createRenderer, type Renderer } from './render';
import { createRng, valueNoise1 } from './rng';
import { createWind, type Wind, type WindEventType } from './wind';
import {
  createTouch,
  type ShedBudget,
  type ShedMode,
  type Touch,
} from './touch';
import { TREE_GUST_EVENT, type TreeGustDetail } from './events';

type TreeState = 'init' | 'static' | 'idle' | 'touch' | WindEventType;

interface EventLog {
  type: WindEventType;
  start: number;
  envEnd: number | null;
  idleAt: number | null;
}

export interface DotTreeStats {
  dots: number;
  joints: number;
  anchors: number;
  variant: Variant | null;
  state: TreeState;
  loopRunning: boolean;
  avgFrameMs: number;
  maxFrameMs: number;
  tipDeflectionDeg: number;
  peakTipDeflectionDeg: number;
  leaves: number;
  detachedTotal: number;
  dpr: number;
  backingPx: number;
  events: EventLog[];
  touchOn: boolean;
  touchLive: boolean;
  touchJoints: number;
  touchRustleMax: number;
  touchStreak: number;
  touchShedTotal: number;
  touchR: number;
}

export interface BrushReport {
  peakTipPx: number;
  trunkPx: number;
  peakJoints: number;
  frames: number;
  avgFrameMs: number;
  maxFrameMs: number;
  shed: number;
}

export interface BrushOptions {
  shed?: ShedMode;
}

export interface DotTreeDevApi {
  trigger(type: WindEventType, peak?: number): void;
  getStats(): DotTreeStats;
  siblingPair(): [number, number] | null;
  traceTips(
    ids: readonly number[],
    ms: number,
  ): Promise<{ t: number; deg: number[] }[]>;
  pause(): void;
  resume(): void;
  hash(): string;
  readonly config: typeof CONFIG;
  /** Crown rest box in viewport px (rootX/rootY + field.restBBox), for scripting stroke lines. */
  crown(): { left: number; top: number; right: number; bottom: number } | null;
  /**
   * Replay a straight stroke through touch.feed on rAF (bypasses the hover media
   * query and pointerType; respects wind/variant). Resolves 1500 ms after the
   * stroke ends with the peaks measured over the stroke and that window.
   */
  brush(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    ms: number,
    opts?: BrushOptions,
  ): Promise<BrushReport>;
  /** Horizontal back-and-forth shake around (cx, cy): amplitude px, frequency Hz, duration ms. */
  wiggle(
    cx: number,
    cy: number,
    amp: number,
    hz: number,
    ms: number,
    opts?: BrushOptions,
  ): Promise<BrushReport>;
}

declare global {
  interface Window {
    __dotTree?: DotTreeDevApi;
  }
}

interface Built {
  sk: Skeleton;
  layout: Layout;
  field: DotField;
  pose: Pose;
  rect: Rect;
  dpr: number;
  hash: string;
  rasterVh: number;
  touch: Touch;
}

const DEG = Math.PI / 180;
const LAG_STEP = LAG_MAX / (LAG_LEVELS - 1);
const TURB_SEED = SEED ^ 0x7e1;
/** Used only when the page sets no [data-scene-avoid] / [data-tree-avoid] markers: headings stay softened, controls and footer text hard-masked. */
const AVOID_FALLBACK_SOFT = 'main h1';
const AVOID_FALLBACK_HARD =
  'main form input:not([tabindex="-1"]), main form button, main form p:not(.visually-hidden), footer nav a, footer p';
/** The cursor over these never stirs the tree (form, links, text controls). */
const CONTROL_SEL = 'input,button,a,textarea,select,label';

/** The site-wide scene contract (layouts/Base.astro) first, then the tree's own name. */
function readInk(host: HTMLElement): string {
  const cs = getComputedStyle(host);
  for (const name of ['--scene-ink', '--tree-ink']) {
    const v = cs.getPropertyValue(name).trim();
    if (/^\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}$/.test(v)) return v;
  }
  return INK_RGB_DEFAULT;
}

/** Mount the tree on `host` (which must contain a <canvas>). Returns a disposer. */
export function mountDotTree(host: HTMLElement): () => void {
  const canvasEl = host.querySelector('canvas');
  if (!canvasEl) return () => {};
  const canvas: HTMLCanvasElement = canvasEl;

  const reducedMq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const hoverMq = window.matchMedia(TOUCH_MQ);
  const touchRng = createRng(SEED ^ 0x70c4);
  // Per page view: survives rebuilds (each build() makes a new Touch).
  const shedBudget: ShedBudget = { total: 0, lastT: -Infinity };
  const skCache = new Map<Variant, Skeleton>();
  const history = createHistory(128);
  const env = new Float32Array(LAG_LEVELS);
  const turb = new Float32Array(TURB_BANDS);
  const leaves = createLeaves(createRng(SEED ^ 0x5bd1e995));
  const metrics: TipMetrics = { moved: 0, fromRest: 0, deflDeg: 0 };
  const posOut = { x: 0, y: 0 };
  const events: EventLog[] = [];

  let renderer: Renderer | null = null;
  let b: Built | null = null;
  let state: TreeState = 'init';
  let loop: Timer | null = null;
  let wind: Wind | null = null;
  let fade: JSAnimation | null = null;
  let lastT = 0;
  let freshDt = true;
  let envEnded = true;
  let envEndT = 0;
  let settleFrames = 0;
  let forceDraw = false;
  let frameSum = 0;
  let frameCount = 0;
  let frameMax = 0;
  let peakDefl = 0;
  let tracer: ((t: number) => void) | null = null;
  let avoidRects: AvoidRect[] = [];
  let avoidKey = '';
  let idleHandle = 0;
  let idleIsRic = false;
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  let scrollRaf = 0;
  let dprMq: MediaQueryList | null = null;
  let disposed = false;
  let touchOn = false;
  let touchLive = false;
  /** Timer time (lastT domain) of the last live touch frame. */
  let touchQuietT = 0;
  let ctlTarget: EventTarget | null = null;
  let overCtl = false;

  const setState = (s: TreeState): void => {
    state = s;
    host.dataset.state = s;
  };

  const getSk = (v: Variant): Skeleton => {
    let sk = skCache.get(v);
    if (!sk) {
      sk = generateSkeleton(
        SEED,
        v === 'desktop' ? MAX_ORDER : MOBILE_MAX_ORDER,
      );
      if (
        import.meta.env.DEV &&
        (sk.nJ > JOINT_BUDGET[v] || sk.nJ + sk.nC > ANCHOR_BUDGET)
      ) {
        console.warn(
          `[dot-tree] ${v} skeleton over budget: ${sk.nJ} joints, ${sk.nJ + sk.nC} anchors`,
        );
      }
      skCache.set(v, sk);
    }
    return sk;
  };

  const viewport = (): { vw: number; vh: number } => ({
    vw: host.clientWidth || window.innerWidth,
    vh: host.clientHeight || window.innerHeight,
  });
  const deviceDpr = (): number => Math.min(window.devicePixelRatio || 1, 2);
  const loopRunning = (): boolean => loop !== null && !loop.paused;

  /** Root snapped to the effective backing DPR, canvas rect around the bbox. */
  function place(
    layout: Layout,
    field: DotField,
  ): { layout: Layout; rect: Rect; dpr: number } {
    const rough = canvasRect(layout, field.restBBox);
    const dpr = effectiveDpr(deviceDpr(), rough.width, rough.height);
    const snapped = retarget(layout, layout.vw, layout.vh, dpr);
    return { layout: snapped, rect: canvasRect(snapped, field.restBBox), dpr };
  }

  function drawNow(t: number, wFlutter: number): void {
    if (!b || !renderer) return;
    renderer.draw(
      b.field,
      b.pose,
      leaves,
      b.layout.rootX,
      b.layout.rootY,
      t,
      wFlutter,
    );
    commitTips(b.pose);
  }

  function setAttrs(): void {
    if (!b) return;
    host.dataset.variant = b.layout.variant;
    host.dataset.dots = String(b.field.n);
    host.dataset.joints = String(b.sk.nJ);
    host.dataset.seed = String(SEED);
    host.dataset.hash = b.hash;
  }

  function build(vw: number, vh: number): void {
    if (!renderer) return;
    const base = computeLayout(vw, vh, deviceDpr());
    const sk = getSk(base.variant);
    const field = rasterize(sk, base, SEED);
    const placed = place({ ...base, S: field.S }, field);
    const pose = createPose(sk);
    solveRest(
      sk,
      pose,
      placed.layout.rootX,
      placed.layout.rootY,
      placed.layout.H,
    );
    leaves.clear();
    b?.touch.lift();
    renderer.setInk(readInk(host), placed.layout.alphaMul);
    renderer.setRect(placed.rect, placed.dpr);
    b = {
      sk,
      layout: placed.layout,
      field,
      pose,
      rect: placed.rect,
      dpr: placed.dpr,
      hash: fieldHash(field, placed.layout),
      rasterVh: vh,
      touch: createTouch(sk, touchRng, placed.layout.H, shedBudget),
    };
    applyMask(field, b.layout, avoidRects);
    setAttrs();
    if (loopRunning()) forceDraw = true;
    else drawNow(lastT, 0);
    syncTouch(); // the variant may have changed
  }

  function reposition(vw: number, vh: number): void {
    if (!b || !renderer) return;
    const prev = b.layout;
    const placed = place(retarget(prev, vw, vh, prev.dpr), b.field);
    translatePose(
      b.pose,
      placed.layout.rootX - prev.rootX,
      placed.layout.rootY - prev.rootY,
    );
    b.layout = placed.layout;
    b.rect = placed.rect;
    b.dpr = placed.dpr;
    b.touch.lift(); // the root moved: the next segment must start fresh
    renderer.setRect(placed.rect, placed.dpr);
    applyMask(b.field, b.layout, avoidRects);
    if (loopRunning()) forceDraw = true;
    else drawNow(lastT, 0);
  }

  function measureAvoid(): void {
    if (!b) return;
    // Explicit markers win; without any, fall back to the common content landmarks.
    let els: NodeListOf<HTMLElement> =
      document.querySelectorAll<HTMLElement>('[data-scene-avoid],[data-tree-avoid]');
    let fallback = false;
    if (els.length === 0) {
      els = document.querySelectorAll<HTMLElement>(
        `${AVOID_FALLBACK_SOFT}, ${AVOID_FALLBACK_HARD}`,
      );
      fallback = true;
    }
    const rects: AvoidRect[] = [];
    let key = '';
    els.forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return;
      // Mobile keeps the tree whole behind the content: every marker only softens.
      const soft =
        b!.layout.variant === 'mobile' ||
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
    if (applyMask(b.field, b.layout, avoidRects)) {
      if (loopRunning()) forceDraw = true;
      else drawNow(lastT, 0);
    }
  }

  // ── Render loop ───────────────────────────────────────────────────────────
  const leafPos = (i: number): { x: number; y: number } => {
    if (b)
      dotPosition(b.field, b.pose, b.layout.rootX, b.layout.rootY, i, posOut);
    return posOut;
  };

  /**
   * A full-mask foliage dot (bucket 2 or 3) near (x, y), chosen uniformly by
   * reservoir sampling, or -1. Soft codes are skipped so leaves never come off
   * over the lede; hard codes are not in byDraw. Runs only for a pending shed.
   */
  function pickShedDot(x: number, y: number, R: number): number {
    if (!b) return -1;
    const { field, pose, layout } = b;
    const r = TOUCH_SHED_PICK * R;
    const r2 = r * r;
    let pick = -1;
    let seen = 0;
    for (let code = 4; code <= 6; code += 2) {
      const list = field.byDraw[code];
      if (!list) continue;
      for (let n = 0; n < list.length; n++) {
        const i = list[n];
        if (field.hidden[i]) continue;
        dotPosition(field, pose, layout.rootX, layout.rootY, i, posOut);
        const dx = posOut.x - x;
        const dy = posOut.y - y;
        if (dx * dx + dy * dy >= r2) continue;
        seen++;
        if (touchRng.chance(1 / seen)) pick = i;
      }
    }
    return pick;
  }

  function frame(t: number): void {
    if (!b || !renderer || !wind) return;
    const f0 = performance.now();
    let dt = freshDt ? 1000 / FPS_ACTIVE : t - lastT;
    freshDt = false;
    lastT = t;
    if (dt < 0) dt = 0;
    else if (dt > 34) dt = 34;

    const { sk, pose, field, layout } = b;
    history.push(t, wind.state.strength);
    for (let l = 0; l < LAG_LEVELS; l++)
      env[l] = history.sample(t - l * LAG_STEP);
    for (let k = 0; k < TURB_BANDS; k++)
      turb[k] = valueNoise1(
        (k / TURB_BANDS) * TURB_FREQ - t * TURB_SPEED,
        TURB_SEED,
      );
    const tc = b.touch;
    touchLive = tc.update(sk, pose, layout.H, dt, performance.now());
    if (touchLive) touchQuietT = t;
    step(
      sk,
      pose,
      env,
      turb,
      t,
      dt,
      layout.rootX,
      layout.rootY,
      layout.H,
      touchLive ? tc : null,
    );
    leaves.maybeSpawn(
      wind.state.strength,
      wind.current() === 'gust',
      t,
      field,
      leafPos,
    );
    const req = tc.takeShed();
    // The roll is spent even if the pool refuses or no dot qualifies: one
    // swipe, one roll. canShed() first so a refusal skips the pick scan.
    if (req && leaves.canShed(t)) {
      const i = pickShedDot(req.x, req.y, tc.R);
      // Leaf spacing is shared with maybeSpawn, so it takes timer time `t`;
      // the touch budget and its own spacing are on the performance clock.
      if (
        i >= 0 &&
        leaves.shed(i, field, leafPos(i), req.vx, req.vy, t, b.rect)
      )
        tc.noteShed(performance.now());
    }
    measureTips(sk, pose, layout.H, metrics);
    if (Math.abs(metrics.deflDeg) > Math.abs(peakDefl))
      peakDefl = metrics.deflDeg;

    if (metrics.moved > DIRTY_PX || leaves.count() > 0 || forceDraw) {
      forceDraw = false;
      drawNow(t, env[LAG_LEVELS >> 1]);
    }
    const ms = performance.now() - f0;
    frameSum += ms;
    frameCount++;
    if (ms > frameMax) frameMax = ms;
    tracer?.(t); // dev instrumentation stays out of the frame timing

    if (envEnded && !touchLive) {
      const calm =
        metrics.fromRest < SETTLE_DISP_PX &&
        pose.maxVel < SETTLE_VEL &&
        leaves.count() === 0;
      settleFrames = calm ? settleFrames + 1 : 0;
      // The fallback counts from whichever ended last, so a touch that wakes the
      // loop long (timer time) after an envelope is not force-snapped at once.
      if (
        settleFrames >= SETTLE_FRAMES ||
        t - Math.max(envEndT, touchQuietT) > SETTLE_MAX + 1000
      )
        settle();
    }
  }

  function settle(): void {
    if (!b) return;
    leaves.clear();
    resetDynamics(b.pose);
    b.touch.reset();
    touchLive = false;
    solveRest(b.sk, b.pose, b.layout.rootX, b.layout.rootY, b.layout.H);
    drawNow(lastT, 0);
    loop?.pause();
    settleFrames = 0;
    const last = events[events.length - 1];
    if (last && last.idleAt === null) last.idleAt = performance.now();
    setState('idle');
  }

  function onEventStart(type: WindEventType): void {
    history.reset();
    envEnded = false;
    settleFrames = 0;
    if (type === 'gust') leaves.newGust();
    events.push({ type, start: performance.now(), envEnd: null, idleAt: null });
    if (events.length > 200) events.shift();
    frameSum = 0;
    frameCount = 0;
    frameMax = 0;
    peakDefl = 0;
    if (loop && loop.paused) {
      freshDt = true;
      loop.resume();
    }
    setState(type);
  }

  function onEnvelopeEnd(): void {
    envEnded = true;
    envEndT = lastT;
    const last = events[events.length - 1];
    if (last && last.envEnd === null) last.envEnd = performance.now();
  }

  function startMotion(): void {
    if (wind || disposed || !b) return;
    // A new timer counts from 0: drop bookkeeping measured on the old one.
    lastT = 0;
    envEndT = 0;
    touchQuietT = 0;
    leaves.resetClock();
    loop = createTimer({
      autoplay: false,
      frameRate: FPS_ACTIVE,
      onUpdate: (self) => frame(self.currentTime),
    });
    wind = createWind({ onEventStart, onEnvelopeEnd });
    wind.start();
    if (document.hidden) wind.pauseScheduler();
    setState('idle');
    syncTouch();
  }

  function stopMotion(): void {
    wind?.stop();
    wind = null;
    syncTouch();
    touchLive = false;
    loop?.cancel();
    loop = null;
    envEnded = true;
    leaves.clear();
    if (b) {
      resetDynamics(b.pose);
      solveRest(b.sk, b.pose, b.layout.rootX, b.layout.rootY, b.layout.H);
      drawNow(lastT, 0);
    }
  }

  // ── Listeners ─────────────────────────────────────────────────────────────
  /** Brush only with motion on, a real hovering fine pointer and the desktop variant. */
  function syncTouch(): void {
    const on =
      wind !== null &&
      !disposed &&
      hoverMq.matches &&
      b?.layout.variant === 'desktop';
    if (on === touchOn) return;
    touchOn = on;
    if (on) {
      window.addEventListener('pointermove', onPointerMove, { passive: true });
      document.documentElement.addEventListener('pointerleave', onPointerGone);
      window.addEventListener('blur', onPointerGone);
    } else {
      window.removeEventListener('pointermove', onPointerMove);
      document.documentElement.removeEventListener(
        'pointerleave',
        onPointerGone,
      );
      window.removeEventListener('blur', onPointerGone);
      ctlTarget = null;
      overCtl = false;
      b?.touch.reset();
    }
  }

  /**
   * Wake the paused loop for a cursor moving over the crown (per-session stats
   * like onEventStart). A paused tree is at rest, so the rest bbox plus R is
   * exactly where contact is possible; the wider canvas margin only feeds.
   */
  function wakeForTouch(x: number, y: number): void {
    if (!b || !loop || !loop.paused || document.hidden) return;
    if (b.touch.speed() < TOUCH_V_MIN) return;
    const bb = b.field.restBBox;
    const { rootX, rootY } = b.layout;
    const R = b.touch.R;
    if (
      x < rootX + bb.minX - R ||
      x > rootX + bb.maxX + R ||
      y < rootY + bb.minY - R ||
      y > rootY + bb.maxY + R
    )
      return;
    freshDt = true;
    settleFrames = 0;
    // Timer time stood still while paused, so this is "now" for the settle fallback.
    touchQuietT = lastT;
    frameSum = 0;
    frameCount = 0;
    frameMax = 0;
    peakDefl = 0;
    loop.resume();
    if (state === 'idle') setState('touch');
  }

  const onPointerGone = (): void => b?.touch.lift();

  // No layout reads: b.rect is cached and the host is fixed at inset 0, so client
  // coordinates are tree coordinates. Never preventDefault, never capture; the
  // host keeps pointer-events: none, so selection, the form and scrolling are untouched.
  const onPointerMove = (e: PointerEvent): void => {
    if (!b || (e.pointerType !== 'mouse' && e.pointerType !== 'pen')) return;
    const tc = b.touch;
    // Selection drag, or the celebration camera transforming the host (screen
    // coordinates no longer match the pose; resetCamera restores '').
    if (e.buttons !== 0 || host.style.transform !== '') {
      tc.lift();
      return;
    }
    const x = e.clientX;
    const y = e.clientY;
    const r = b.rect;
    const R = tc.R;
    if (
      x < r.left - R ||
      x > r.left + r.width + R ||
      y < r.top - R ||
      y > r.top + r.height + R
    ) {
      tc.lift(); // over the content column: four comparisons, nothing else
      return;
    }
    if (e.target !== ctlTarget) {
      // closest() only when the hovered element changes.
      ctlTarget = e.target;
      overCtl =
        e.target instanceof Element && e.target.closest(CONTROL_SEL) !== null;
    }
    if (overCtl) {
      tc.lift();
      return;
    }
    tc.feed(x, y, e.timeStamp);
    wakeForTouch(x, y);
  };

  const onHoverChange = (): void => syncTouch();

  function handleResize(): void {
    if (!b) return;
    const { vw, vh } = viewport();
    const L = b.layout;
    const variant = variantFor(vw);
    const H = heightFor(variant, vh);
    const dprChanged =
      Math.abs(effectiveDpr(deviceDpr(), b.rect.width, b.rect.height) - b.dpr) >
      1e-3;
    if (
      variant !== L.variant ||
      (Math.abs(vh - b.rasterVh) >= RERASTER_DVH &&
        Math.abs(H - L.H) / L.H > RERASTER_DH_FRAC)
    ) {
      build(vw, vh);
    } else if (vw !== L.vw || vh !== L.vh || dprChanged) {
      reposition(vw, vh);
    }
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
    dprMq = window.matchMedia(
      `(resolution: ${window.devicePixelRatio || 1}dppx)`,
    );
    dprMq.addEventListener('change', onDprChange);
  }

  const onScroll = (): void => {
    if (scrollRaf) return;
    const doc = document.documentElement;
    if (
      doc.scrollHeight <= window.innerHeight &&
      doc.scrollWidth <= window.innerWidth
    )
      return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      measureAvoid();
    });
  };

  const onVisibility = (): void => {
    if (document.hidden) b?.touch.lift();
    if (!wind) return;
    if (document.hidden) wind.pauseScheduler();
    else wind.resumeScheduler();
  };

  // Public command: other modules ask for a gust; ignored while motion is off.
  const onGustCommand = (e: CustomEvent<TreeGustDetail>): void => {
    if (!wind || document.hidden) return;
    const { peak, attack } = e.detail ?? {};
    wind.trigger(
      'gust',
      peak === undefined ? undefined : Math.min(1, Math.max(0, peak)),
      attack,
    );
  };

  const onReducedChange = (e: MediaQueryListEvent): void => {
    if (!b) return;
    if (e.matches) {
      stopMotion();
      fade?.cancel();
      fade = null;
      canvas.style.opacity = '1';
      setState('static');
    } else {
      startMotion();
    }
  };

  // ── Startup ───────────────────────────────────────────────────────────────
  function init(): void {
    idleHandle = 0;
    if (disposed) return;
    try {
      renderer = createRenderer(canvas, readInk(host), 1);
    } catch {
      return; // no 2D context: leave the background empty
    }
    const { vw, vh } = viewport();
    build(vw, vh);
    measureAvoid();
    ro.observe(host);
    watchDpr();
    window.addEventListener('scroll', onScroll, { passive: true });
    document.addEventListener('visibilitychange', onVisibility);
    document.addEventListener(TREE_GUST_EVENT, onGustCommand);
    reducedMq.addEventListener('change', onReducedChange);
    hoverMq.addEventListener('change', onHoverChange);
    document.fonts?.ready.then(() => {
      if (!disposed) {
        avoidKey = '';
        measureAvoid();
      }
    });
    if (reducedMq.matches) {
      canvas.style.opacity = '1';
      setState('static');
    } else {
      fade = animate(canvas, {
        opacity: [0, 1],
        duration: 1400,
        ease: 'outQuad',
        onComplete: () => (fade = null),
      });
      startMotion();
    }
  }

  if ('requestIdleCallback' in window) {
    idleIsRic = true;
    idleHandle = window.requestIdleCallback(init, { timeout: 500 });
  } else {
    idleHandle = setTimeout(init, 0) as unknown as number;
  }

  // ── Dev hook ──────────────────────────────────────────────────────────────
  if (import.meta.env.DEV) {
    const noBrush: BrushReport = {
      peakTipPx: 0,
      trunkPx: 0,
      peakJoints: 0,
      frames: 0,
      avgFrameMs: 0,
      maxFrameMs: 0,
      shed: 0,
    };
    /** Feeds `at(elapsedMs)` to the touch on every rAF for `ms`, then measures 1500 ms more. */
    const replay = (
      ms: number,
      at: (el: number, out: { x: number; y: number }) => void,
      opts: BrushOptions | undefined,
    ): Promise<BrushReport> =>
      new Promise((resolve) => {
        if (!b || !wind || b.layout.variant !== 'desktop') {
          resolve({ ...noBrush });
          return;
        }
        const { sk, layout } = b;
        b.touch.setShedMode(opts?.shed ?? 'auto');
        // Rest end of the trunk chain (chain 0 is the trunk alone, parent-first).
        let trunkTop = 0;
        let restX = layout.rootX;
        let restY = layout.rootY;
        for (let j = 0; j < sk.nJ; j++) {
          if (sk.chain[j] !== 0) continue;
          trunkTop = j;
          restX += sk.len[j] * layout.H * Math.cos(sk.restAng[j]);
          restY += sk.len[j] * layout.H * Math.sin(sk.restAng[j]);
        }
        const shed0 = leaves.touchShedTotal();
        let peakTipPx = 0;
        let trunkPx = 0;
        let peakJoints = 0;
        frameSum = 0;
        frameCount = 0;
        frameMax = 0;
        const prev = tracer;
        const trace = (t: number): void => {
          prev?.(t);
          if (!b) return;
          const { pose, sk: s2, layout: l2 } = b;
          if (metrics.fromRest > peakTipPx) peakTipPx = metrics.fromRest;
          const L = s2.len[trunkTop] * l2.H;
          const d = Math.hypot(
            pose.ox[trunkTop] + L * pose.c[trunkTop] - restX,
            pose.oy[trunkTop] + L * pose.s[trunkTop] - restY,
          );
          if (d > trunkPx) trunkPx = d;
          const lj = b.touch.joints;
          if (lj > peakJoints) peakJoints = lj;
        };
        tracer = trace;
        const p = { x: 0, y: 0 };
        const t0 = performance.now();
        const finish = (): void => {
          if (tracer === trace) tracer = prev;
          b?.touch.setShedMode('auto');
          resolve({
            peakTipPx,
            trunkPx,
            peakJoints,
            frames: frameCount,
            avgFrameMs: frameCount ? frameSum / frameCount : 0,
            maxFrameMs: frameMax,
            shed: leaves.touchShedTotal() - shed0,
          });
        };
        const tick = (): void => {
          if (!b || !wind) {
            finish();
            return;
          }
          const now = performance.now();
          const el = Math.min(ms, now - t0);
          at(el, p);
          b.touch.feed(p.x, p.y, now);
          wakeForTouch(p.x, p.y);
          if (el < ms) requestAnimationFrame(tick);
          else setTimeout(finish, 1500);
        };
        requestAnimationFrame(tick);
      });

    window.__dotTree = {
      trigger(type, peak) {
        if (!wind) return;
        wind.trigger(type, peak);
      },
      getStats: () => ({
        dots: b?.field.n ?? 0,
        joints: b?.sk.nJ ?? 0,
        anchors: b ? b.sk.nJ + b.sk.nC : 0,
        variant: b?.layout.variant ?? null,
        state,
        loopRunning: loopRunning(),
        avgFrameMs: frameCount ? frameSum / frameCount : 0,
        maxFrameMs: frameMax,
        tipDeflectionDeg: metrics.deflDeg,
        peakTipDeflectionDeg: peakDefl,
        leaves: leaves.count(),
        detachedTotal: leaves.detachedTotal(),
        dpr: b?.dpr ?? 0,
        backingPx: renderer?.backingPx() ?? 0,
        events: events.map((e) => ({ ...e })),
        touchOn,
        touchLive,
        touchJoints: b?.touch.stats().joints ?? 0,
        touchRustleMax: b?.touch.stats().rustleMax ?? 0,
        touchStreak: b?.touch.stats().streak ?? 0,
        touchShedTotal: leaves.touchShedTotal(),
        touchR: b?.touch.R ?? 0,
      }),
      siblingPair() {
        if (!b) return null;
        const { sk } = b;
        const byRoot = new Map<number, number>();
        for (let t = 0; t < sk.tips.length; t++) {
          const j = sk.tips[t];
          if (sk.order[j] < 3) continue;
          const root = sk.chainRoot[sk.chain[j]];
          const other = byRoot.get(root);
          if (other !== undefined && sk.chain[other] !== sk.chain[j])
            return [other, j];
          if (other === undefined) byRoot.set(root, j);
        }
        return null;
      },
      traceTips(ids, ms) {
        const out: { t: number; deg: number[] }[] = [];
        return new Promise((resolve) => {
          const prev = tracer;
          tracer = (t) => {
            prev?.(t);
            if (!b) return;
            const { pose, sk } = b;
            out.push({
              t,
              deg: ids.map((j) => (pose.ang[j] - sk.restAng[j]) / DEG),
            });
          };
          setTimeout(() => {
            tracer = prev;
            resolve(out);
          }, ms);
        });
      },
      pause() {
        wind?.pauseScheduler();
        loop?.pause();
      },
      resume() {
        wind?.resumeScheduler();
        if (loop && !envEnded) {
          freshDt = true;
          loop.resume();
        }
      },
      hash: () => b?.hash ?? '',
      config: CONFIG,
      crown() {
        if (!b) return null;
        const { restBBox: bb } = b.field;
        const { rootX, rootY } = b.layout;
        return {
          left: rootX + bb.minX,
          top: rootY + bb.minY,
          right: rootX + bb.maxX,
          bottom: rootY + bb.maxY,
        };
      },
      brush(x0, y0, x1, y1, ms, opts) {
        const dur = Math.max(1, ms);
        return replay(
          dur,
          (el, out) => {
            const u = el / dur;
            out.x = x0 + (x1 - x0) * u;
            out.y = y0 + (y1 - y0) * u;
          },
          opts,
        );
      },
      wiggle(cx, cy, amp, hz, ms, opts) {
        return replay(
          Math.max(1, ms),
          (el, out) => {
            out.x = cx + amp * Math.sin((2 * Math.PI * hz * el) / 1000);
            out.y = cy;
          },
          opts,
        );
      },
    };
  }

  return () => {
    disposed = true;
    if (idleHandle) {
      if (idleIsRic) window.cancelIdleCallback(idleHandle);
      else clearTimeout(idleHandle);
    }
    stopMotion();
    fade?.cancel();
    fade = null;
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    ro.disconnect();
    dprMq?.removeEventListener('change', onDprChange);
    window.removeEventListener('scroll', onScroll);
    document.removeEventListener('visibilitychange', onVisibility);
    document.removeEventListener(TREE_GUST_EVENT, onGustCommand);
    reducedMq.removeEventListener('change', onReducedChange);
    hoverMq.removeEventListener('change', onHoverChange);
    renderer?.clear();
    if (import.meta.env.DEV) delete window.__dotTree;
  };
}

class DotTreeElement extends HTMLElement {
  #dispose: (() => void) | null = null;

  connectedCallback(): void {
    if (!this.#dispose) this.#dispose = mountDotTree(this);
  }

  disconnectedCallback(): void {
    this.#dispose?.();
    this.#dispose = null;
  }
}

if (!customElements.get('dot-tree'))
  customElements.define('dot-tree', DotTreeElement);
