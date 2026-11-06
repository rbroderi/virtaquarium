// Silhouette-mask geometry for comparing a render's outline to a traced photo outline: boundaries and
// their distance, per-column extents, mapping a point to the same anatomical spot on another silhouette,
// and snapping a colour patch to the nearest area of the same colour class.
import { colourKind, linearToLab, toLinear, type ColourKind, type PixelBuffer } from './colour.js';

export type Pixel = readonly [x: number, y: number];

/** Per-column dorsal (top) and ventral (bot) extents; -1 where the column is empty. */
export interface Silhouette {
  readonly top: Int32Array;
  readonly bot: Int32Array;
  readonly x0: number;
  readonly x1: number;
  readonly len: number;
}

export interface BoundaryDistance { readonly mean: number; readonly max: number }

const RGBA = 4;
const MAX_BOUNDARY_POINTS = 1500;
const PARTIAL_SNAP_COVER = 0.8;

/**
 * Per-column dorsal/ventral extent of a silhouette mask. The fish faces +x on screen (mirror the photo
 * to match), so the snout is at x1.
 */
export function silhouette(mask: Uint8Array, w: number, h: number): Silhouette {
  const top = new Int32Array(w).fill(-1), bot = new Int32Array(w).fill(-1);
  let x0 = w, x1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!mask[y * w + x]) continue;
    if ((top[x] ?? 0) < 0) top[x] = y;
    bot[x] = y;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
  }
  return { top, bot, x0, x1, len: x1 - x0 + 1 };
}

export function boundary(mask: Uint8Array, w: number, h: number): Pixel[] {
  const pts: Pixel[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) pts.push([x, y]);
  }
  return pts;
}

function subsample(points: readonly Pixel[]): Pixel[] {
  const step = Math.max(1, Math.ceil(points.length / MAX_BOUNDARY_POINTS));
  return points.filter((_, i) => i % step === 0);
}

function oneWayDistance(P: readonly Pixel[], Q: readonly Pixel[]): BoundaryDistance {
  let sum = 0, max = 0;
  for (const [x, y] of P) {
    let m = Infinity;
    for (const [u, v] of Q) { const d = (x - u) ** 2 + (y - v) ** 2; if (d < m) m = d; }
    m = Math.sqrt(m); sum += m; if (m > max) max = m;
  }
  return { mean: sum / Math.max(1, P.length), max };
}

/** Symmetric boundary distance (mean and Hausdorff max), on up to 1500 points per side. */
export function boundaryDistance(A: readonly Pixel[], B: readonly Pixel[]): BoundaryDistance {
  const a = subsample(A), b = subsample(B);
  if (!a.length || !b.length) return { mean: NaN, max: NaN };
  const ab = oneWayDistance(a, b), ba = oneWayDistance(b, a);
  return { mean: (ab.mean + ba.mean) / 2, max: Math.max(ab.max, ba.max) };
}

const at = (column: Int32Array, x: number): number => column[x] ?? -1;

/** Screen point on silhouette A -> the same anatomical spot on silhouette B, or null if it is off A. */
export function mapAnatomy(A: Silhouette, B: Silhouette, x: number, y: number): Pixel | null {
  const xa = Math.min(A.x1, Math.max(A.x0, Math.round(x)));   // patches may sit right on the outline
  if (at(A.top, xa) < 0) return null;
  const u = (A.x1 - x) / A.len, v = (y - at(A.top, xa)) / Math.max(1, at(A.bot, xa) - at(A.top, xa));
  let xb = Math.round(B.x1 - u * B.len);
  // Columns can be empty between separated fins; step towards the body until one is filled.
  for (let d = 0; d < B.len && at(B.top, xb) < 0; d++) xb += xb > (B.x0 + B.x1) / 2 ? -1 : 1;
  if (at(B.top, xb) < 0) return null;
  return [xb, at(B.top, xb) + v * (at(B.bot, xb) - at(B.top, xb))];
}

/** Where to look for a patch's matching feature on the render frame. */
export interface SnapQuery {
  /** the rendered frame, at `k` buffer px per CSS px */
  readonly shot: PixelBuffer;
  /** the render's coverage mask, `w` CSS px wide */
  readonly mask: Uint8Array;
  readonly w: number;
  readonly k: number;
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly kind: ColourKind;
  readonly reach: number;
}

function snapAt({ shot, mask, w, k, cx, cy, r, kind, reach }: SnapQuery, need: number): Pixel | null {
  const { data, width } = shot;
  // Outside the buffer reads NaN, which classifies as 'other', as in the JS original.
  const channel = (i: number): number => toLinear(data[i] ?? NaN);
  const kindAt = (x: number, y: number): boolean => {
    const i = (Math.round(y * k) * width + Math.round(x * k)) * RGBA;
    return colourKind(linearToLab([channel(i), channel(i + 1), channel(i + 2)])) === kind;
  };
  const rr = Math.max(1, r / 2), step = Math.max(1, Math.round(rr / 2)), inner = Math.max(1, rr / 3);
  let best: Pixel | null = null, bestD = Infinity;
  for (let y = Math.round(cy - reach); y <= cy + reach; y += step) {
    for (let x = Math.round(cx - reach); x <= cx + reach; x += step) {
      const d = (x - cx) ** 2 + (y - cy) ** 2;
      if (d >= bestD || d > reach * reach || x < 0 || y < 0 || x >= w || !mask[y * w + x] || !kindAt(x, y)) continue;
      let n = 0, hit = 0;
      for (let dy = -rr; dy <= rr; dy += inner) for (let dx = -rr; dx <= rr; dx += inner) {
        if (dx * dx + dy * dy > rr * rr) continue;
        n++;
        if (mask[Math.round(y + dy) * w + Math.round(x + dx)] && kindAt(x + dx, y + dy)) hit++;
      }
      if (hit >= need * n) { best = [x, y]; bestD = d; }
    }
  }
  return best;
}

/**
 * Nearest point (CSS px) to (cx, cy), within `reach`, where a disc of radius r/2 on the render frame is
 * all `kind` and on the fish (or, failing that, at least 80%).
 */
export function snapToKind(query: SnapQuery): Pixel | null {
  return snapAt(query, 1) ?? snapAt(query, PARTIAL_SNAP_COVER);
}
