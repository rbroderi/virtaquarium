// Pixel maths for the moving-water loop: alpha overlays that take one image to another, and the
// contrast-preserving crossfade. Pure functions over RGBA byte arrays.

export type Rgba = Uint8ClampedArray<ArrayBuffer>;

/** Grows to the pixel area an overlay ever touches. */
export interface DirtyBox { x0: number; y0: number; x1: number; y1: number }

export const emptyBox = (w: number, h: number): DirtyBox => ({ x0: w, y0: h, x1: 0, y1: 0 });

/** Mask values below this leave the pixel alone. */
const MASK_MIN = 8;
/** Channel differences up to this are 8-bit noise: leave the backdrop alone. */
const NOISE_LEVEL = 2;
const FULL = 255;

/**
 * The overlay that takes base B to target F: per pixel the smallest alpha a and colour C with
 * B(1 - a) + C a = F. mask (0-255 per pixel, or null for all) limits it. Grows box.
 */
export function encodeOverlay(F: Rgba, B: Rgba, mask: Rgba | null, box: DirtyBox, w: number): Rgba {
  const out = new Uint8ClampedArray(F.length);
  for (let p = 0, i = 0; i < F.length; p++, i += 4) {
    const m = mask ? (mask[p] ?? 0) : FULL;
    if (m < MASK_MIN) continue;
    let a = 0, big = 0;
    for (let c = 0; c < 3; c++) {
      const b = B[i + c] ?? 0, d = (F[i + c] ?? 0) - b;
      big = Math.max(big, Math.abs(d));
      a = Math.max(a, d > 0 ? d / Math.max(1, FULL - b) : -d / Math.max(1, b));
    }
    if (big <= NOISE_LEVEL) continue;
    const a8 = Math.min(FULL, Math.ceil(a * FULL)), aa = a8 / FULL;
    for (let c = 0; c < 3; c++) {
      const b = B[i + c] ?? 0;
      out[i + c] = Math.round(b + ((F[i + c] ?? 0) - b) / aa);
    }
    out[i + 3] = Math.round((a8 * m) / FULL);
    const x = p % w, y = (p / w) | 0;
    box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x + 1); box.y1 = Math.max(box.y1, y + 1);
  }
  return out;
}

/** What the screen shows after drawing overlay O over base B (the result is opaque). */
export function composite(B: Rgba, O: Rgba): Rgba {
  const out = new Uint8ClampedArray(B.length);
  for (let i = 0; i < B.length; i += 4) {
    const a = (O[i + 3] ?? 0) / FULL;
    for (let c = 0; c < 3; c++) out[i + c] = (B[i + c] ?? 0) * (1 - a) + (O[i + c] ?? 0) * a;
    out[i + 3] = FULL;
  }
  return out;
}

/** Per-channel mean of equally sized images. */
export function meanOf(list: readonly Rgba[]): Float32Array {
  const M = new Float32Array(list[0]?.length ?? 0);
  for (const d of list) for (let i = 0; i < M.length; i++) M[i] = (M[i] ?? 0) + (d[i] ?? 0);
  for (let i = 0; i < M.length; i++) M[i] = (M[i] ?? 0) / list.length;
  return M;
}

/** RMS offset of an image from the mean M. */
export function rmsOffset(d: Rgba, M: Float32Array): number {
  let s = 0;
  for (let i = 0; i < d.length; i++) s += ((d[i] ?? 0) - (M[i] ?? 0)) ** 2;
  return Math.sqrt(s / d.length);
}

/**
 * A crossfade of a (weight w) and b about the mean M, rescaled to rms contrast: a plain crossfade of
 * two unrelated caustic patterns halves their contrast mid-loop.
 */
export function contrastMix(a: Rgba, b: Rgba, w: number, M: Float32Array, rms: number): Rgba {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const m = M[i] ?? 0;
    o[i] = ((a[i] ?? 0) - m) * w + ((b[i] ?? 0) - m) * (1 - w);
  }
  let s = 0;
  for (let i = 0; i < o.length; i++) s += (o[i] ?? 0) ** 2;
  const k = rms / Math.max(1e-6, Math.sqrt(s / o.length)), out = new Uint8ClampedArray(a.length);
  for (let i = 0; i < a.length; i++) out[i] = (M[i] ?? 0) + (o[i] ?? 0) * k;
  return out;
}
