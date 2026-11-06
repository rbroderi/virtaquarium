// Organic imperfection. Painted from exact shapes, a pattern has ruled edges, sharp corners and flat
// colour, which no living thing has: edges wander and change width and angle along their length,
// corners are round, and each colour area is patchy. These helpers break up painted textures (fish
// skins and fins, critters, worms) so they read as grown, not drawn.
import { clamp, lerp } from './math.js';
import type { Rng } from './rng.js';

export type Point = readonly [number, number];
/** A smooth field over the unit square, in -1..1. */
export type Field2 = (x: number, y: number) => number;
/** A smooth curve over 0..1, about -1..1. */
export type Field1 = (s: number) => number;

/** Smooth value noise over the unit square on a cx x cy lattice. wrapX/wrapY: periodic in that direction. */
export function valueNoise(rng: Rng, cellsX: number, cellsY: number, wrapX = false, wrapY = false): Field2 {
  const cx = Math.max(1, Math.round(cellsX)), cy = Math.max(1, Math.round(cellsY));
  const W = cx + 2;
  const n = Float32Array.from({ length: W * (cy + 2) }, () => rng() * 2 - 1);
  const at = (i: number): number => n[i] ?? 0;
  // A periodic direction repeats its first lattice line at the far end.
  if (wrapX) for (let y = 0; y < cy + 2; y++) { n[y * W + cx] = at(y * W); n[y * W + cx + 1] = at(y * W + 1); }
  if (wrapY) for (let x = 0; x < W; x++) { n[cy * W + x] = at(x); n[(cy + 1) * W + x] = at(W + x); }
  return (x0, y0) => {
    const x = wrapX ? x0 - Math.floor(x0) : clamp(x0, 0, 1), y = wrapY ? y0 - Math.floor(y0) : clamp(y0, 0, 1);
    const fx = x * cx, fy = y * cy, ix = Math.min(Math.floor(fx), cx), iy = Math.min(Math.floor(fy), cy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const i = iy * W + ix;
    return lerp(lerp(at(i), at(i + 1), tx), lerp(at(i + W), at(i + W + 1), tx), ty);
  };
}

const WOBBLE_OCTAVES = [0.62, 0.3, 0.14] as const;
const WOBBLE_SPREAD = 1.7;
const TWO_PI_APPROX = 6.283;   // as the JS build, so the curves match exactly

/** Smooth 1D noise for wandering a line: three random sines with roughly `cycles` slow swings over 0..1. */
export function wobble(rng: Rng, cycles = 3): Field1 {
  const waves = WOBBLE_OCTAVES.map((a, k) => ({ f: cycles * (0.6 + 0.8 * rng()) * (1 + k * WOBBLE_SPREAD), p: rng() * TWO_PI_APPROX, a }));
  return (s) => waves.reduce((sum, q) => sum + q.a * Math.sin(q.f * TWO_PI_APPROX * s + q.p), 0);
}

const CORNER_STEPS = 6;

/**
 * Round a closed polygon's corners to radius ~r (at most half of either side): each corner becomes a
 * curve from r before it to r after it, so long sides (and corners off the canvas) keep their place.
 */
export function roundCorners(pts: readonly Point[], r: number): [number, number][] {
  const out: [number, number][] = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    if (!a || !b || !c) continue;
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, lc = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
    const ka = Math.min(r, la / 2) / la, kc = Math.min(r, lc / 2) / lc;
    const p = [lerp(b[0], a[0], ka), lerp(b[1], a[1], ka)] as const, q = [lerp(b[0], c[0], kc), lerp(b[1], c[1], kc)] as const;
    for (let k = 0; k <= CORNER_STEPS; k++) {
      const t = k / CORNER_STEPS, u = 1 - t;
      out.push([u * u * p[0] + 2 * u * t * b[0] + t * t * q[0], u * u * p[1] + 2 * u * t * b[1] + t * t * q[1]]);
    }
  }
  return out;
}

/** One warp octave: noise lattice size over the canvas and the largest shift in pixels. */
export type WarpOctave = readonly [cellsX: number, cellsY: number, ampX: number, ampY: number];

export interface Mottle {
  readonly cellsX: number;
  readonly cellsY: number;
  /** How far value (all channels together) varies, as a fraction. */
  readonly value: number;
  /** How far each channel varies on its own. */
  readonly chroma: number;
}

export interface OrganicOptions {
  readonly warp?: readonly WarpOctave[];
  readonly mottle?: Mottle | null;
  /** The canvas wraps (round a body, or tiles), so the warp and the mottle wrap too. */
  readonly wrapX?: boolean;
  readonly wrapY?: boolean;
}

/** Fields: warp x, warp y, then the three channel gains. */
const FIELD_COUNT = 5;
const LAST_TEXEL = 1.001;

/**
 * Resample a canvas (context g, W x H) through a smooth random warp, then mottle its colour. A coarse
 * octave bends an edge and swings its angle; a fine one moves the two edges of a band apart and
 * together, so its width varies. Alpha is carried through the warp but not mottled.
 */
export function organicPass(g: CanvasRenderingContext2D, W: number, H: number, rng: Rng, options: OrganicOptions = {}): void {
  const { warp = [], mottle = null, wrapX = false, wrapY = false } = options;
  if (!warp.length && !mottle) return;
  const wx = warp.map(([cx, cy]) => [valueNoise(rng, cx, cy, wrapX, wrapY), valueNoise(rng, cx, cy, wrapX, wrapY)] as const);
  const nm = mottle ? [0, 1, 2, 3].map(() => valueNoise(rng, mottle.cellsX, mottle.cellsY, wrapX, wrapY)) : null;
  const fields = sampleFields(W, H, warp, wx, mottle, nm);
  resample(g, W, H, fields, wrapX, wrapY);
}

interface FieldGrid { readonly FW: number; readonly FH: number; readonly F: readonly Float32Array[] }

/** The fields at half resolution, read back bilinearly (the noise is smooth at that scale). */
function sampleFields(
  W: number, H: number, warp: readonly WarpOctave[], wx: readonly (readonly [Field2, Field2])[],
  mottle: Mottle | null, nm: readonly Field2[] | null,
): FieldGrid {
  const FW = Math.ceil(W / 2) + 1, FH = Math.ceil(H / 2) + 1;
  const F = Array.from({ length: FIELD_COUNT }, () => new Float32Array(FW * FH));
  const [dx, dy, ...gains] = F as [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const u = (x * 2) / W, v = (y * 2) / H, i = y * FW + x;
    for (let o = 0; o < warp.length; o++) {
      const oct = warp[o], fld = wx[o];
      if (!oct || !fld) continue;
      dx[i] = (dx[i] ?? 0) + oct[2] * fld[0](u, v);
      dy[i] = (dy[i] ?? 0) + oct[3] * fld[1](u, v);
    }
    const m = nm && mottle ? mottle.value * (nm[3]?.(u, v) ?? 0) : 0;
    gains.forEach((gain, c) => { gain[i] = 1 + m + (nm && mottle ? mottle.chroma * (nm[c]?.(u, v) ?? 0) : 0); });
  }
  return { FW, FH, F };
}

function resample(g: CanvasRenderingContext2D, W: number, H: number, { FW, FH, F }: FieldGrid, wrapX: boolean, wrapY: boolean): void {
  const s = g.getImageData(0, 0, W, H).data, out = g.createImageData(W, H), d = out.data;
  const wrap = (q: number, n: number): number => ((q % n) + n) % n;
  const px = (i: number): number => s[i] ?? 0;
  for (let y = 0; y < H; y++) {
    const fy = y / 2, jy = Math.min(Math.floor(fy), FH - 2), ty = fy - jy;
    for (let x = 0; x < W; x++) {
      const fx = x / 2, jx = Math.min(Math.floor(fx), FW - 2), tx = fx - jx, i0 = jy * FW + jx;
      const f = (A: Float32Array | undefined): number => (A
        ? lerp(lerp(A[i0] ?? 0, A[i0 + 1] ?? 0, tx), lerp(A[i0 + FW] ?? 0, A[i0 + FW + 1] ?? 0, tx), ty)
        : 0);
      let sx = x + f(F[0]), sy = y + f(F[1]);
      sx = wrapX ? wrap(sx, W) : clamp(sx, 0, W - LAST_TEXEL);
      sy = wrapY ? wrap(sy, H) : clamp(sy, 0, H - LAST_TEXEL);
      const x0 = Math.floor(sx), y0 = Math.floor(sy), kx = sx - x0, ky = sy - y0;
      const x1 = wrapX ? (x0 + 1) % W : Math.min(x0 + 1, W - 1), y1 = wrapY ? (y0 + 1) % H : Math.min(y0 + 1, H - 1);
      const p00 = (y0 * W + x0) * 4, p10 = (y0 * W + x1) * 4, p01 = (y1 * W + x0) * 4, p11 = (y1 * W + x1) * 4, o4 = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = lerp(lerp(px(p00 + c), px(p10 + c), kx), lerp(px(p01 + c), px(p11 + c), kx), ky);
        d[o4 + c] = c < 3 ? v * f(F[2 + c]) : v;
      }
    }
  }
  g.putImageData(out, 0, 0);
}
