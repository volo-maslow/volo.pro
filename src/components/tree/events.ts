/**
 * events.ts — the tree's public, production-safe command surface. Other page
 * modules dispatch these on `document` instead of importing the runtime, so the
 * tree stays optional: with no tree mounted (or under reduced motion) a command
 * is simply ignored.
 */

/** Fire a gust now. `attack` shortens the first swell to a sudden blast (ms). */
export const TREE_GUST_EVENT = 'dot-tree:gust';

export interface TreeGustDetail {
  /** Peak strength in [0, 1]. */
  peak?: number;
  /** Duration of the first swell in ms; omitted keeps the natural gust shape. */
  attack?: number;
}

declare global {
  interface DocumentEventMap {
    [TREE_GUST_EVENT]: CustomEvent<TreeGustDetail>;
  }
}
