/**
 * events.ts — the waterfall's public, production-safe command surface. Page
 * modules dispatch these on `document`; with no scene mounted (or under
 * reduced motion) a command is simply ignored. The tree's `dot-tree:gust` is
 * honoured too, so existing dispatchers keep working.
 */

/** Fire a gust now (same detail as the tree's gust). */
export const SCENE_GUST_EVENT = 'dot-scene:gust';
/** Drop a pebble into the pool at (x, y) viewport px; defaults to mid-lake. */
export const SCENE_SPLASH_EVENT = 'dot-scene:splash';

export interface SceneGustDetail {
  /** Peak strength in [0, 1]. */
  peak?: number;
  /** Duration of the first swell in ms. */
  attack?: number;
}

export interface SceneSplashDetail {
  x?: number;
  y?: number;
}

declare global {
  interface DocumentEventMap {
    [SCENE_GUST_EVENT]: CustomEvent<SceneGustDetail>;
    [SCENE_SPLASH_EVENT]: CustomEvent<SceneSplashDetail>;
  }
}
