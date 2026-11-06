// Colour maths for comparing a render to a reference photo: sRGB <-> linear, CIE L*a*b*, CIEDE2000,
// and a coarse colour class used to match pattern features.

export type LinearRgb = readonly [r: number, g: number, b: number];
export type Lab = readonly [L: number, a: number, b: number];
export type ColourKind = 'dark' | 'white' | 'colour' | 'other';

/** The pixel buffer shape meanLinear reads (ImageData satisfies it). */
export interface PixelBuffer {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

const BYTE_MAX = 255;
const SRGB_LINEAR_KNEE = 0.04045, SRGB_ENCODE_KNEE = 0.0031308, SRGB_LINEAR_SLOPE = 12.92;
const SRGB_OFFSET = 0.055, SRGB_SCALE = 1.055, SRGB_GAMMA = 2.4;
const RGBA = 4;

export const toLinear = (byte: number): number => {
  const c = byte / BYTE_MAX;
  return c <= SRGB_LINEAR_KNEE ? c / SRGB_LINEAR_SLOPE : ((c + SRGB_OFFSET) / SRGB_SCALE) ** SRGB_GAMMA;
};

export const toSrgbByte = (c: number): number =>
  Math.round(BYTE_MAX * Math.min(1, Math.max(0, c <= SRGB_ENCODE_KNEE ? c * SRGB_LINEAR_SLOPE : SRGB_SCALE * c ** (1 / SRGB_GAMMA) - SRGB_OFFSET)));

export const linearToHex = (c: LinearRgb): string => '#' + c.map((v) => toSrgbByte(v).toString(16).padStart(2, '0')).join('');

/** Linear RGB of the pixel at byte offset i. */
export const linearAt = (data: Uint8ClampedArray, i: number): LinearRgb =>
  [toLinear(data[i] ?? 0), toLinear(data[i + 1] ?? 0), toLinear(data[i + 2] ?? 0)];

/** Mean linear RGB of a disc (centre and radius in the image's pixels); null if it misses the image. */
export function meanLinear({ data, width, height }: PixelBuffer, cx: number, cy: number, r: number): LinearRgb | null {
  let n = 0, R = 0, G = 0, B = 0;
  for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
      const [lr, lg, lb] = linearAt(data, (y * width + x) * RGBA);
      R += lr; G += lg; B += lb; n++;
    }
  }
  return n ? [R / n, G / n, B / n] : null;
}

// Linear sRGB (D65) -> XYZ, normalised by the D65 white point.
const D65_X = 0.95047, D65_Z = 1.08883;
const LAB_EPSILON = 216 / 24389, LAB_KAPPA = 24389 / 27;

/** Linear sRGB (D65) -> CIE L*a*b*. */
export function linearToLab([r, g, b]: LinearRgb): Lab {
  const X = (0.4124564 * r + 0.3575761 * g + 0.1804375 * b) / D65_X;
  const Y = 0.2126729 * r + 0.7151522 * g + 0.0721750 * b;
  const Z = (0.0193339 * r + 0.1191920 * g + 0.9503041 * b) / D65_Z;
  const f = (t: number): number => (t > LAB_EPSILON ? Math.cbrt(t) : (LAB_KAPPA * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

/** CIEDE2000 colour difference (Sharma, Wu & Dalal 2005). */
export function ciede2000([L1, a1, b1]: Lab, [L2, a2, b2]: Lab): number {
  const rad = Math.PI / 180, p7 = (c: number): number => c ** 7 / (c ** 7 + 25 ** 7);
  const G = 0.5 * (1 - Math.sqrt(p7((Math.hypot(a1, b1) + Math.hypot(a2, b2)) / 2)));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1 = Math.hypot(a1p, b1), C2 = Math.hypot(a2p, b2);
  const hue = (b: number, a: number): number => (a === 0 && b === 0 ? 0 : (Math.atan2(b, a) / rad + 360) % 360);
  const h1 = hue(b1, a1p), h2 = hue(b2, a2p);
  let dh = 0;
  if (C1 * C2 !== 0) { dh = h2 - h1; if (dh > 180) dh -= 360; else if (dh < -180) dh += 360; }
  const dL = L2 - L1, dC = C2 - C1, dH = 2 * Math.sqrt(C1 * C2) * Math.sin((dh * rad) / 2);
  const Lm = (L1 + L2) / 2, Cm = (C1 + C2) / 2;
  let hm = h1 + h2;
  if (C1 * C2 !== 0) hm = Math.abs(h1 - h2) <= 180 ? hm / 2 : hm < 360 ? (hm + 360) / 2 : (hm - 360) / 2;
  const T = 1 - 0.17 * Math.cos((hm - 30) * rad) + 0.24 * Math.cos(2 * hm * rad) + 0.32 * Math.cos((3 * hm + 6) * rad) - 0.2 * Math.cos((4 * hm - 63) * rad);
  const Rt = -2 * Math.sqrt(p7(Cm)) * Math.sin(2 * 30 * Math.exp(-(((hm - 275) / 25) ** 2)) * rad);
  const SL = 1 + (0.015 * (Lm - 50) ** 2) / Math.sqrt(20 + (Lm - 50) ** 2), SC = 1 + 0.045 * Cm, SH = 1 + 0.015 * Cm * T;
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + Rt * (dC / SC) * (dH / SH));
}

const DARK_L = 30, WHITE_MAX_CHROMA = 18, WHITE_MIN_L = 50, COLOUR_MIN_CHROMA = 30;

/**
 * Coarse colour class of a patch: pattern whites (bright and unsaturated, even if under-exposed), black
 * margins, saturated colour, or in between.
 */
export function colourKind([L, a, b]: Lab): ColourKind {
  const C = Math.hypot(a, b);
  if (L < DARK_L) return 'dark';
  if (C < WHITE_MAX_CHROMA && L > WHITE_MIN_L) return 'white';
  if (C > COLOUR_MIN_CHROMA) return 'colour';
  return 'other';
}
