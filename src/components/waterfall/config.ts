/**
 * config.ts — every tunable constant for the dotted waterfall background.
 * Physical constants are in metres / seconds and are converted with
 * ppm = Hf / FALL_M (px per metre) and TIME_SCALE (sim s per wall s).
 * Shape constants feed the seeded terrain; the dev hook exposes this module.
 */

export type Variant = 'desktop' | 'mobile';

// ── Identity ────────────────────────────────────────────────────────────────
export const SEED = 0x46414c4c; // "FALL"
/** Sub-seeds: always SEED ^ const, so one seed reproduces the whole scene. */
export const SUB = {
  dither: 0xd17e,
  terrain: 0x50c4,
  fill: 0x0f11,
  bed: 0x0bed,
  crack: 0xc4ac,
  flow: 0x0f10,
  surge: 0x5a6e,
  lat: 0xb2,
  bundle: 0xc3,
  bundleFine: 0xc4,
  frag: 0xc5,
  weight: 0xa1,
  slug: 0x5106,
  boil: 0xb011,
  dash: 0x1a4e,
  spawn: 0x5ba3,
  curl: 0xc021,
  foam: 0xf0a3,
  shore: 0x5402,
  collar: 0xc011,
} as const;

// ── Lattice & look ──────────────────────────────────────────────────────────
export const BREAKPOINT = 768;
/** Below this width there is no scene lane: the whole scene is soft-masked. */
export const LANE_MIN_VW = 1024;
export const S = { desktop: 6, mobile: 5 } as const;
export const INK_RGB_DEFAULT = '26,25,23';
export const DITHER = 0.18;
/** Quantisation thresholds: v' below [0] draws nothing, then L1..L4. */
export const LEVEL_T = [0.1, 0.28, 0.5, 0.75] as const;
/** Water dot radius (× S) and alpha per level L1..L4. */
export const LEVEL_R = [0.17, 0.23, 0.28, 0.33] as const;
export const LEVEL_A = [0.14, 0.25, 0.38, 0.52] as const;
/** Rock levels: 0 light, 1 base, 2 dark, 3 wet, 4 recess. */
export const ROCK_R = [0.27, 0.31, 0.33, 0.34, 0.25] as const;
export const ROCK_A = [0.11, 0.17, 0.26, 0.28, 0.1] as const;
export const ROCK_DOT_BUDGET = { desktop: 5200, mobile: 2000 } as const;
export const ALPHA_MUL = { desktop: 1, mobile: 0.9, quiet: 0.8 } as const;

// ── Clock & physical scale ──────────────────────────────────────────────────
export const TIME_SCALE = 0.6;
export const FALL_M = 5;
export const G_MS = 9.81;
export const U0_MS = 1.2;
export const V0Y_MS = 0.3;
/** Screen projection of the outward throw (viewer ~20° off-axis): the fall bows left. */
export const VIEW_THROW = 0.35;
export const STEP_HZ = 60;
export const FIELD_HZ = 30;
/** Wall dt clamp per frame (ms): a stalled tab never fast-forwards. */
export const DT_MAX = 34;

// ── Layout (fractions of Hs or vh) ──────────────────────────────────────────
/** Desktop: the pool surface sits this fraction of vh above the bottom edge. */
export const LAKE_VIS = 0.22;
/**
 * Mobile (< 768 px): a small vignette in the empty top-right of the first
 * screen (right of the name block, above the statement), never behind text
 * at the top of the page. The lip sits at MOBILE_LIP × vh, the fall centre
 * MOBILE_INSET × vw from the right edge (clamped), the cliff runs off-screen.
 */
export const MOBILE_LIP = 0.125;
export const MOBILE_INSET: readonly [number, number, number] = [0.15, 48, 72];
export const HS_FRAC = { desktop: 0.88, mobile: 0.25 } as const;
export const HS_CLAMP = { desktop: [520, 1100], mobile: [180, 250] } as const;
export const HF_FRAC = { desktop: 0.57, mobile: 0.165 } as const;
export const HF_CLAMP = { desktop: [300, 600], mobile: [120, 165] } as const;
export const W0_FRAC = { desktop: 0.1, mobile: 0.1 } as const;
/**
 * Mirrors the `.page` margin rule in styles/global.css: column 680 + 2 × gutter
 * 44 (page box 768) + scene lane 440 (`--scene-lane`, styles/tokens.css).
 * Change them together.
 */
export const PAGE_LANE = 1208;
export const PAGE_BOX = 768;
export const PAGE_GUTTER = 44;
export const ROCK_CLEAR = 24;
/** Grid extent around (x_f, y_s), in Hs. */
export const GRID_LEFT = { desktop: 0.42, mobile: 0.42 } as const;
export const GRID_RIGHT = 0.8;
export const GRID_TOP_PAD = 0.2;
export const GRID_BOTTOM = 0.28;
/** Lake left fade length (× Hs). */
export const LAKE_FADE = 0.15;

// ── Fall ────────────────────────────────────────────────────────────────────
export const STRANDS_PER_COL = 2;
/** Visual gain on strand intensity: the fall must read above the rock halftone. */
export const FALL_GAIN = 2.0;
export const BREAK: readonly [number, number] = [0.22, 0.78];
export const RHO_EXP = 0.6;
/** Aeration: white water adds density back as the sheet breaks up. */
export const AERATION = 0.75;
export const SPREAD = 0.6;
export const SLUG_PERIOD = 1.25; // s of emission time between slug slots
export const SLUG_RISE = 0.03;
export const SLUG_TAIL = 0.18;
export const RIBS_HZ = 6.0;
export const SWAY_HZ = 0.55;
export const FLOW_NOISE = 0.12;
export const SURGE_GAP: readonly [number, number] = [10, 20]; // sim s
export const SURGE_FIRST: readonly [number, number] = [8, 12];
export const SURGE_AMP: readonly [number, number] = [0.15, 0.3];
/**
 * Intro: the scene opens already flowing. The sim is pre-rolled to PREROLL
 * (longer than the ~1 s fall time, so the sheet reaches the pool and the pool
 * and mist are warm) before the first frame, at INTRO_Q of full discharge,
 * which ramps to 1 over the INTRO emission window while the canvas fades in.
 */
export const PREROLL = 1.3; // sim s
export const INTRO_Q = 0.7;
export const INTRO: readonly [number, number] = [1.0, 2.4]; // emission s
export const INTRO_STATE_END = PREROLL + 0.36; // sim s (≈ 0.6 s wall)
export const INTRO_FADE_MS = 600;
/** The coherent first slug, as a later surge (emission s ≈ 4.5 s wall after load). */
export const TONGUE_E = 4.0;

// ── Droplets ────────────────────────────────────────────────────────────────
export const POOL = { desktop: 720, mobile: 180 } as const;
export const DRAG = 1.4; // 1/s
export const SPAWN = { breakup: 150, spray: 220, trickle: 8, pointerMax: 260 } as const; // per sim s

// ── Mist ────────────────────────────────────────────────────────────────────
export const MIST = {
  pitch: { desktop: 2, mobile: 3 },
  tau: 2.6,
  blur: 0.06,
  src: 1.1,
  side: 0.15,
  gain: 0.32,
} as const;
export const AIR = { breeze: 0.15, gust: 1.6, out: 0.9, rise: 0.35, down: 0.6, curl: 0.25 } as const; // m/s

// ── Lake ────────────────────────────────────────────────────────────────────
export const LAKE = {
  /** Ring speed (m/s). 0.53 (λ ≈ 18 cm ripples) made rings too small to read as rings on the lattice; 0.8 is the λ ≈ 40 cm gravity-wave speed. */
  speed: 0.8,
  damp: 0.994,
  aFar: 0.28,
  aNear: 0.45,
  sponge: 4,
  shoreReflect: 0.3,
  forcing: 0.6,
  reflectReach: 0.22,
} as const;
export const FOAM = { tau: 4, current: 0.08, reach: 0.35 } as const;

// ── Pointer ─────────────────────────────────────────────────────────────────
export const PTR = {
  /** Contact radius ≈ 0.6 × the sheet's half-width (W0 / 2 = 0.05 Hs), so a resting finger parts the sheet instead of cutting it. */
  rFrac: 0.03,
  rMin: 16,
  rMax: 28,
  keepMin: 0.45,
  /** The shadow under the finger refills over CLOSE × radius as the parted strands re-converge. */
  close: 1.5,
  spread: 0.28,
  drag: 0.45,
  wake: 0.35,
  pebble: 2.2,
  mistPush: 0.6,
  mistTau: 0.5,
  collar: 40,
  tapMs: 350,
  vCap: 3, // px/ms
  fresh: 100,
  stale: 50,
  decay: 40,
  ema: 40,
  teleport: 0.4, // × Hs
  pebbleGap: 250,
} as const;
export const SLOT_HZ = 120;
export const RING = 256;
export const K_SLOSH = 0.5;

// ── Frame budget ────────────────────────────────────────────────────────────
export const FPS = { desktop: 60, mobile: 30, quiet: 30 } as const;
export const FRAME_BUDGET_MS = 4.0;
/** Total backing-store pixels for both canvases together (see effectiveDpr). */
export const BACKING_MAX_PX = 5_000_000;

// ── Content-safe mask (same as the tree) ────────────────────────────────────
export const MASK_SOFT = 0.4;
export const MASK_FEATHER = 40;
export const MASK_INFLATE = 12;

// ── Resize ──────────────────────────────────────────────────────────────────
export const RESIZE_DEBOUNCE = 150;
export const RERASTER_DVH = 140;
export const RERASTER_DH_FRAC = 0.1;

export const TOUCH_MQ = '(hover: hover) and (pointer: fine)';
