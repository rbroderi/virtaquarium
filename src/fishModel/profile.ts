// The fish's side profile and the anatomical landmarks laid out on it (gill cover, nostrils, mouth).
// Units: total length 1, nose at x = +0.5; body position u runs 0 (nose) .. 1 (caudal peduncle) and
// v -1 (dorsal outline) .. +1 (ventral outline).
import { clamp, lerp } from '../util.js';
import type { Body, Mouth, Species } from '../species/types.js';

export type P2 = [number, number];
export type P3 = [number, number, number];

/** The lofted body's side profile, as functions of body position u. */
export interface Profile {
  /** Half the body depth at u. */
  half(u: number): number;
  /** x (fish space) of body position u. */
  x(u: number): number;
  /** Half-width (z) at u. */
  width(u: number): number;
  /** Height of the midline at u. */
  centre(u: number): number;
  top(u: number): number;
  bot(u: number): number;
  /** Half the maximum depth. */
  H: number;
  /** x of the caudal peduncle. */
  xPed: number;
}

/** The gill cover's free rear margin (see gillOf). */
export interface Gill {
  u: number;
  bow: number;
  top: number;
  bot: number;
  /** Body u of the margin at texture height v. */
  edge(v: number): number;
  /** 1 along the margin, closing to 0 at its ends. */
  fade(v: number): number;
}

export interface Naris { u: number; v: number; r: number }

const DEFAULT_SNOUT_TIP = 0.75;
const DEFAULT_SNOUT_WIDTH = 0.9;
const DEFAULT_HUMP = 0.05;
const MIN_HALF_DEPTH = 0.012;
const MIN_HALF_WIDTH = 0.004;

export const smooth01 = (t: number): number => { const c = clamp(t, 0, 1); return c * c * (3 - 2 * c); };

/** A smooth curve through control points [u, y] (sorted by u): Catmull-Rom between the points, held at
 *  the end values beyond them; 0 everywhere when there are none. */
export function outlineCurve(pts: readonly (readonly [number, number])[] | undefined): (u: number) => number {
  if (!pts || pts.length === 0) return () => 0;
  const n = pts.length;
  const at = (i: number): readonly [number, number] => pts[clamp(i, 0, n - 1)]!;
  // Tangent dy/du at point i from its neighbours (one-sided at the ends).
  const slope = (i: number): number => {
    const a = at(i - 1), b = at(i + 1);
    return b[0] > a[0] ? (b[1] - a[1]) / (b[0] - a[0]) : 0;
  };
  return (u: number): number => {
    if (u <= pts[0]![0]) return pts[0]![1];
    if (u >= pts[n - 1]![0]) return pts[n - 1]![1];
    let i = 0;
    while (u > pts[i + 1]![0]) i++;
    const [u0, y0] = pts[i]!, [u1, y1] = pts[i + 1]!, h = u1 - u0, t = (u - u0) / h;
    const t2 = t * t, t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * y0 + (t3 - 2 * t2 + t) * h * slope(i) + (-2 * t3 + 3 * t2) * y1 + (t3 - t2) * h * slope(i + 1);
  };
}

export function makeProfile(body: Body): Profile {
  const snout = body.snout || 0, snoutH = body.snoutH || 0;
  const m = body.m, ped = body.ped, H = body.depth / 2;
  // A moray head: a smooth bump (0 at u0 and u2, 1 at u1) that deepens the head over the jaw muscles,
  // carries most of the extra depth above the midline, and flattens the section laterally.
  const head = body.head;
  const headBump = (u: number): number => {
    if (!head) return 0;
    const rise = smooth01((u - head.u0) / (head.u1 - head.u0));
    const fall = 1 - smooth01((u - head.u1) / (head.u2 - head.u1));
    return rise * fall;
  };
  // snoutTip: the tube's height at the mouth as a share of its height at the base (a butterflyfish beak
  // barely tapers; a tang's snout is a cone). snoutBlend: the fillet (body units) where the tube runs
  // into the face, instead of a sharp step.
  const tip = body.snoutTip ?? DEFAULT_SNOUT_TIP, blend = body.snoutBlend ?? 0;
  const smax = (a: number, b: number, k: number): number => {
    if (k <= 0) return Math.max(a, b);
    const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1);
    return lerp(b, a, h) + k * h * (1 - h);
  };
  // outline: per-station moves of the top and bottom outlines (in H, + up), split into depth and midline.
  const dTop = outlineCurve(body.outline?.top), dBot = outlineCurve(body.outline?.bot);
  const half = (u: number): number => {
    if (u < snout) return snoutH * (tip + (1 - tip) * (u / snout));
    const uu = (u - snout) / (1 - snout);
    let f: number;
    // Convex head that ends in a blunt terminal mouth (snouted species end in their tube instead).
    if (uu < m) f = (snout ? 0 : 0.17) + (snout ? 1 : 0.83) * Math.pow(Math.sin((Math.PI / 2) * (uu / m)), body.headP);
    else f = ped + (1 - ped) * Math.pow(Math.cos((Math.PI / 2) * ((uu - m) / (1 - m))), body.tailP);
    f += head ? head.depth * headBump(u) : 0;
    f += (dTop(u) - dBot(u)) / 2;
    return snout ? smax(H * f, snoutH, blend) : Math.max(H * f, MIN_HALF_DEPTH);
  };
  const x = (u: number): number => 0.5 - u * body.len;
  const mEnd = snout + m * (1 - snout);
  // snoutW: the snout's width over its height (a butterflyfish beak is round; a tang's is flattened).
  // headW: the head's width at the snout relative to the usual, easing back to 1 by the deepest point:
  // strongly compressed fish narrow to a wedge at the front rather than carrying their width forward.
  const headW = body.headW ?? 1;
  const width = (u: number): number => Math.max(half(u) * body.width * (1.15 - 0.55 * u) * lerp(headW, 1, smooth01(u / mEnd)) * (head ? 1 - (1 - head.width) * headBump(u) : 1),
    snout && u < snout ? (body.snoutTip != null ? half(u) : snoutH) * (body.snoutW ?? DEFAULT_SNOUT_WIDTH) : MIN_HALF_WIDTH);   // a tapered snout narrows too
  // The back arches above the midline (epaxial muscle) while the mouth and tail stay on it.
  const hump = body.hump ?? DEFAULT_HUMP;
  // mouth: the snout's height off the midline (in H; negative is below). Tangs and butterflyfish carry
  // the mouth low under a steep forehead; the midline eases back to level by the deepest point.
  const mouth = body.mouth ?? 0;
  const centre = (u: number): number => hump * H * Math.sin(Math.PI * Math.min(1, u * 1.05)) ** 1.5 + mouth * H * (1 - smooth01(u / mEnd)) + (head ? head.top * head.depth * H * headBump(u) : 0) + H * (dTop(u) + dBot(u)) / 2;
  const top = (u: number): number => centre(u) + half(u), bot = (u: number): number => centre(u) - half(u);
  return { half, x, width, centre, top, bot, H, xPed: x(1) };
}

const UINT32_RANGE = 4294967296;

// Integer hash of a scale's lattice cell (a, b) and a channel k, to [0, 1): per-scale variation that is
// the same every load (the Roku bake must reproduce).
export const cellHash = (a: number, b: number, k: number): number => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e37, 0x165667b1) ^ Math.imul((k | 0) + 1, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / UINT32_RANGE;
};

// Rear edge of the gill cover (operculum), in body u.
export const gillU = (sp: Species): number => sp.eye.u + (0.09 / sp.body.len) + sp.eye.r * 0.6;

const GILL_BOW = 0.035, GILL_TOP = -0.55, GILL_BOTTOM = 0.85;

// The gill cover's free rear margin: it bows back in the middle (u at its ends, g0 - bow at the
// middle) and runs from about level with the top of the pectoral base (v = top) down and forward
// to the throat (v = bot). Null for fish without a gill cover (morays: a small round gill opening).
const gills = new WeakMap<Species, Gill>();
export function gillOf(sp: Species): Gill | null {
  if (sp.gill === false) return null;
  const cached = gills.get(sp);
  if (cached) return cached;
  const u = gillU(sp), bow = GILL_BOW, top = GILL_TOP, bot = GILL_BOTTOM;
  const s = (v: number): number => (2 * v - top - bot) / (bot - top);   // -1 at the top end, +1 at the throat
  const G: Gill = {
    u, bow, top, bot,
    edge: (v) => u - bow * Math.max(0, 1 - s(v) ** 2),
    fade: (v) => 1 - smooth01((Math.abs(s(v)) - 0.7) / 0.3),   // the margin closes at its ends
  };
  gills.set(sp, G);
  return G;
}

// Nostrils (nares), each side: the posterior one just ahead of the eye and a little above its
// centre, the anterior one further forward; r in body units (about a tenth of the eye's radius).
export function naresOf(sp: Species): Naris[] {
  const e = sp.eye, len = sp.body.len, sn = sp.body.snout || 0;
  // On the face, not out on a snout: snouted fish have them just ahead of the eye.
  // (and back from the nose's rounded tip, where they would stretch over its front)
  const lo = sn ? sn + 0.45 * (e.u - e.r / len - sn) : Math.max(0.025, 0.3 * e.u), front = e.u - e.r / len;
  const uA = Math.max(lo, e.u - (e.r * 2.9) / len), uP = Math.max((uA + front) / 2, e.u - (e.r * 1.7) / len);
  return [
    { u: uP, v: e.v - 0.05, r: Math.min(e.r * 0.14, 0.0055) },
    { u: uA, v: e.v + 0.06, r: Math.min(e.r * 0.11, 0.0045) },
  ];
}

// The mouth, for the hinged lower jaw and the lips: the gape runs from the tip (v0) back to the corner
// of the mouth (u, v), where the lower jaw hinges (v as for the eye: +1 is ventral). sp.mouth sets it
// (the moray's long gape); otherwise a small terminal mouth ending under the front of the eye, or a
// tiny one at the end of a snout.
export function mouthOf(sp: Species): Mouth {
  if (sp.mouth) return sp.mouth;
  const sn = sp.body.snout || 0;
  return sn ? { u: Math.min(0.03, sn * 0.25), v: 0.12, v0: 0.04 } : { u: sp.eye.u * 0.55, v: 0.2, v0: 0.08 };
}
