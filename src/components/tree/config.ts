/**
 * config.ts — every tunable constant for the dotted wind-tree background.
 * Shape constants feed the seeded generator; motion/timing constants feed the
 * wind envelope, oscillators and the acceptance validator (dev hook exposes them).
 */

export type Variant = 'desktop' | 'mobile';

// ── Shape & look ────────────────────────────────────────────────────────────
export const SEED = 0x41524354; // "ARCT"
/** Base alpha per draw bucket: 0 trunk, 1 branches, 2 foliage, 3 light foliage. */
/** Raised from [0.2, 0.16, 0.12, 0.07]: the crown must read as distinct dots, not haze, while staying secondary to text. */
export const ALPHA: readonly [number, number, number, number] = [
  0.32, 0.26, 0.2, 0.13,
];
export const INK_RGB_DEFAULT = '26,25,23';
export const BREAKPOINT = 768;
export const MAX_ORDER = 6;
export const MOBILE_MAX_ORDER = 5;
export const DOT_BUDGET: Readonly<Record<Variant, number>> = {
  desktop: 5000,
  mobile: 2600,
};
export const JOINT_BUDGET: Readonly<Record<Variant, number>> = {
  desktop: 700,
  mobile: 450,
};
export const ANCHOR_BUDGET = 1100;
export const BACKING_MAX_PX = 5_000_000;
/** Motion margin around the rest bbox, as a fraction of tree height H. */
export const MOTION_MARGIN = 0.1;

// ── Motion ──────────────────────────────────────────────────────────────────
/** Tuned from the planned 1.2: generated paths are ~20 joints deep, so 1.2 peaked near 20°; 0.58 keeps the peak (incl. turbulence) inside 6–14°. */
export const GUST_DEG = 0.58;
/** Kept low so foliage patches mostly translate with their owner joint; higher values counter-rotate neighbouring patches into overlaps and moiré seams. */
export const CLUSTER_DEG = 0.4;
export const FLUTTER_DEG = 0.6;
export const TURB_AMP = 0.35;
export const TURB_FREQ = 2.5;
export const TURB_SPEED = 0.00035; // field units per ms
export const TURB_BANDS = 16;
export const LAG_LEVELS = 12;
export const LAG_MAX = 900; // ms
export const F_TRUNK = 0.7; // Hz
export const F_TWIG = 2.0; // Hz
export const FPS_ACTIVE = 60;
export const P_GUST = 0.65;
/** +1: branches bend toward the right edge, away from the centred content. */
export const WIND_DIR = 1;

// ── Timing (ms) ─────────────────────────────────────────────────────────────
export const FIRST_EVENT: readonly [number, number] = [1800, 3000];
export const GAP: readonly [number, number] = [5000, 11000];
/** Derived from the gust/breath timeline step ranges in wind.ts. */
export const GUST_ENV: readonly [number, number] = [2900, 5500];
export const BREATH_ENV: readonly [number, number] = [2600, 3800];
export const SETTLE_MAX = 4000;
export const SETTLE_FRAMES = 10;
export const SETTLE_DISP_PX = 0.12;
export const SETTLE_VEL = 0.002; // deg per ms
export const DIRTY_PX = 0.1;

// ── Leaves ──────────────────────────────────────────────────────────────────
export const MAX_DETACHED = 12;
export const MAX_LEAVES_ALIVE = 4;
export const MAX_LEAVES_PER_GUST = 3;
export const LEAF_MIN_SPACING = 400; // ms
export const LEAF_SPAWN_STRENGTH = 0.7;

// ── Content-safe mask ───────────────────────────────────────────────────────
export const MASK_SOFT = 0.4;
export const MASK_FEATHER = 40; // px outside the inflated rect
export const MASK_INFLATE = 12; // px

// ── Resize ──────────────────────────────────────────────────────────────────
export const RESIZE_DEBOUNCE = 150;
export const RERASTER_DVH = 140;
export const RERASTER_DH_FRAC = 0.1;

// ── Touch (desktop pointer) ────────────────────────────────────────────────
/** Gate: real hover + fine pointer. Width is gated by layout.variant === 'desktop'. */
export const TOUCH_MQ = '(hover: hover) and (pointer: fine)';
/** Contact radius R = clamp(TOUCH_R_FRAC·H, MIN, MAX) px (~59 px at H = 792). */
export const TOUCH_R_FRAC = 0.075;
export const TOUCH_R_MIN = 48;
export const TOUCH_R_MAX = 80;
/** Cursor speeds, px/ms. Below V_MIN nothing is pushed and the loop does not wake; the drive ramps to full by V_KNEE. */
export const TOUCH_V_MIN = 0.12;
export const TOUCH_V_KNEE = 0.35;
/** Cross-branch speed that gives full drive (clamped at ±1). */
export const TOUCH_V_REF = 0.8;
/** Raw speed clamp (mouse noise, re-entry). */
export const TOUCH_V_CAP = 3;
/** An event gap above this restarts velocity at 0 (ms). */
export const TOUCH_FRESH = 100;
/** With no event for this long, velocity decays with TOUCH_V_DECAY (ms). */
export const TOUCH_STALE = 50;
export const TOUCH_V_DECAY = 40;
/** A frame segment longer than this × H counts as a teleport: no drive that frame. */
export const TOUCH_TELEPORT = 0.4;
/** Joint target per unit of drive (deg) and how much of the push carries to each parent. */
export const TOUCH_DEG = 1.1;
export const TOUCH_PROP = 0.6;
/** Ceiling on |wind + touch| joint target (deg). ~0.69·THETA_MAX leaves room for ~40% overshoot under the 1.74° clamp. Never lowers a wind-only target. */
export const TOUCH_TGT_MAX = 1.2;
/** Push envelope time constants (ms): fast attack, fast release, so letting go reads as a twang. */
export const TOUCH_ATTACK = 20;
export const TOUCH_RELEASE = 90;
/** Release stretch for a fast cursor: τ = RELEASE·(1 + HOLD·clamp((v − V_REF)/V_REF, 0, 2)). A flick crosses a twig in ~40 ms, too short for a 2 Hz spring to answer; holding its wake a little longer makes fast read stronger than slow. The cursor's velocity decays within ~100 ms of stopping, so the twang on letting go stays crisp. */
export const TOUCH_RELEASE_HOLD = 0.6;
/** Cluster spin per unit of drive (deg); reach = R + REACH·cR·H; |wind + touch| cluster target ≤ CLUSTER_TGT_MAX. Kept low for the CLUSTER_DEG moiré reason. */
export const TOUCH_CLUSTER_DEG = 0.6;
export const TOUCH_CLUSTER_REACH = 0.35;
export const TOUCH_CLUSTER_TGT_MAX = 1.0;
/** Local rustle: extra flutter on order ≥ 3 joints along the cursor path. */
export const RUSTLE_GAIN = 0.8;
export const RUSTLE_ATTACK = 60; // ms; avoids a kinematic pop
export const RUSTLE_TAU = 380; // ms release
export const RUSTLE_V0 = 0.08; // px/ms: rustle starts
export const RUSTLE_V1 = 0.4; // px/ms: rustle full
/** Values below these count as zero. */
export const TOUCH_EPS = 1e-3;
export const RUSTLE_EPS = 0.02;
/** Shake streak: a reversal on an axis with |v| > SHAKE_V on both sides, within SHAKE_WINDOW (ms). */
export const SHAKE_V = 0.45;
export const SHAKE_WINDOW = 450;
/** Shedding a leaf by touch. */
export const TOUCH_SHED_V = 1.2; // px/ms, swipe counts toward travel above this
export const TOUCH_SHED_RESET_V = 0.5; // swipe ends below this
export const TOUCH_SHED_TRAVEL = 90; // px of fast travel through foliage → one roll
export const TOUCH_SHED_CLUSTERS = 2; // clusters with falloff > 0.3 this frame
export const TOUCH_SHED_P: readonly [number, number] = [0.35, 0.65]; // by peak speed 1.2 → 2.8 px/ms
export const TOUCH_SHED_STREAK_BONUS = 0.15; // shake streak ≥ 2
export const TOUCH_SHED_MAX = 40; // per page view, separate from MAX_DETACHED
export const TOUCH_SHED_PICK = 0.7; // pick radius × R
export const LEAF_TREMBLE_MS = 140;
export const LEAF_TREMBLE_PX = 1;
/** Throw distance per unit of cursor velocity (px per px/ms). 150 sent a 2.5 px/ms flick ~375 px, into the canvas-edge clamp; 70 lands it near a gust leaf's 90–220 px drift. */
export const LEAF_THROW_MS = 70;
