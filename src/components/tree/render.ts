/**
 * render.ts — Canvas 2D renderer. One small canvas sized to the tree bbox (+
 * motion margin), geometry in viewport CSS px via setTransform. Each draw code
 * (bucket × mask level) is one fillStyle, one path of arcs, one fill().
 */
import type { DotField } from './rasterize';
import type { Pose } from './pose';
import type { Leaves } from './leaves';
import type { Rect } from './layout';
import { DRAW_CODES } from './rasterize';
import { ALPHA, MASK_SOFT } from './config';

const TAU = Math.PI * 2;

export interface Renderer {
  setRect(rect: Rect, dpr: number): void;
  setInk(inkRgb: string, alphaMul: number): void;
  draw(
    field: DotField,
    pose: Pose,
    leaves: Leaves | null,
    rootX: number,
    rootY: number,
    tMs: number,
    wFlutter: number,
  ): void;
  clear(): void;
  backingPx(): number;
}

export function createRenderer(
  canvas: HTMLCanvasElement,
  inkRgb: string,
  alphaMul: number,
): Renderer {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('DotTree: 2D canvas context unavailable');
  let rect: Rect = { left: 0, top: 0, width: 0, height: 0 };
  let ink = inkRgb;
  let mul = alphaMul;
  const styles: string[] = [];
  let leafAlpha = ALPHA[2] * mul;

  const buildStyles = (): void => {
    for (let code = 0; code < DRAW_CODES; code++) {
      const a = ALPHA[code >> 1] * mul * (code & 1 ? MASK_SOFT : 1);
      styles[code] = `rgba(${ink},${a.toFixed(4)})`;
    }
    leafAlpha = ALPHA[2] * mul;
  };
  buildStyles();

  return {
    setRect(r, dpr) {
      rect = r;
      const s = canvas.style;
      s.left = `${r.left}px`;
      s.top = `${r.top}px`;
      s.width = `${r.width}px`;
      s.height = `${r.height}px`;
      const bw = Math.max(1, Math.round(r.width * dpr));
      const bh = Math.max(1, Math.round(r.height * dpr));
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      ctx.setTransform(dpr, 0, 0, dpr, -r.left * dpr, -r.top * dpr);
    },
    setInk(inkRgb2, alphaMul2) {
      ink = inkRgb2;
      mul = alphaMul2;
      buildStyles();
    },
    draw(field, pose, leaves, rootX, rootY, tMs, wFlutter) {
      const L = rect.left - 2;
      const T = rect.top - 2;
      const R = rect.left + rect.width + 2;
      const B = rect.top + rect.height + 2;
      ctx.clearRect(rect.left, rect.top, rect.width, rect.height);
      const { anchor, lx, ly, r, hidden, flutterAmp, fPhase, restX, restY } =
        field;
      const { ax, ay, ac, as } = pose;
      const atRest = pose.atRest;
      const fl = wFlutter;
      const tf = tMs * 0.012;
      // Light foliage first, trunk last (darker wood sits on top).
      for (let code = DRAW_CODES - 1; code >= 0; code--) {
        const list = field.byDraw[code];
        if (!list || list.length === 0) continue;
        ctx.fillStyle = styles[code];
        ctx.beginPath();
        for (let n = 0; n < list.length; n++) {
          const i = list[n];
          if (hidden[i]) continue;
          let x: number;
          let y: number;
          if (atRest) {
            x = rootX + restX[i];
            y = rootY + restY[i];
          } else {
            const a = anchor[i];
            x = ax[a] + ac[a] * lx[i] - as[a] * ly[i];
            y = ay[a] + as[a] * lx[i] + ac[a] * ly[i];
            const fa = flutterAmp[i];
            if (fa > 0 && fl > 0) {
              const d = fa * fl * Math.sin(tf + fPhase[i]);
              x += d;
              y += d * 0.5;
            }
          }
          if (x < L || x > R || y < T || y > B) continue;
          const rr = r[i];
          ctx.moveTo(x + rr, y);
          ctx.arc(x, y, rr, 0, TAU);
        }
        ctx.fill();
      }
      if (leaves && leaves.count() > 0) {
        for (const leaf of leaves.pool) {
          if (!leaf.alive || leaf.a <= 0) continue;
          // The source dot is already hidden: the trembling dot is the leaf itself (±tr px).
          // ~20 Hz, not 30: at 60 fps a 30 Hz sine sits on Nyquist and can sample near zero for the whole tremble.
          const x =
            leaf.x + Math.sin(leaf.wob) * 3 + leaf.tr * Math.sin(tMs * 0.126);
          if (x < L || x > R || leaf.y < T || leaf.y > B) continue;
          ctx.fillStyle = `rgba(${ink},${(leafAlpha * leaf.m * leaf.a).toFixed(4)})`;
          ctx.beginPath();
          ctx.arc(x, leaf.y, leaf.r, 0, TAU);
          ctx.fill();
        }
      }
    },
    clear() {
      ctx.clearRect(rect.left, rect.top, rect.width, rect.height);
    },
    backingPx: () => canvas.width * canvas.height,
  };
}
