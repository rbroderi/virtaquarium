// Look variants: small, capped differences between fish of the same species (subtle size, hue /
// saturation / brightness and pattern seed). Fish of a variant share generated textures, so texture
// cost grows by the number of variants a species' stock actually uses, at most VARIANT_COUNT.
import { mulberry32, range, type Rng } from '../core/rng.js';
import type { ColourStop, Species } from '../species/types.js';

/** How many look variants each species can have (0..VARIANT_COUNT-1); 0 is the catalogued reference look. */
export const VARIANT_COUNT = 4;
/** The variant the Roku sprite-sheet bake uses for every fish of a species (one sheet per species). */
export const BAKE_VARIANT = 0;
/** Decorrelates a variant's pattern/mottle seeds; a prime so variants never share a sequence. */
export const VARIANT_SEED_STRIDE = 104729;
/** Per-variant hue rotation (degrees). */
const VARIANT_HUE_DEG = 8;
/** Per-variant saturation shift (0..1). */
const VARIANT_SAT = 0.07;
/** Per-variant brightness shift (0..1). */
const VARIANT_LIGHT = 0.06;
/** Per-variant size multiplier bounds (x the species size, on top of the per-fish spread). */
const VARIANT_SIZE_MIN = 0.97, VARIANT_SIZE_MAX = 1.03;

const FNV_OFFSET = 0x811c9dc5, FNV_PRIME = 0x01000193;
/** Below this max channel a colour is black, not pigment. */
const BLACK_MAX_CHANNEL = 40;
/** Above this min/max channel ratio a colour is white or grey, not pigment. */
const NEUTRAL_RATIO = 0.7;
const HEX = /^#[0-9a-f]{6}$/i;

/** FNV-1a: a stable 32-bit hash of the species id, so variant looks don't depend on the tank seed. */
function hashString(s: string): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), FNV_PRIME);
  return h >>> 0;
}

const clamp01 = (x: number): number => Math.max(0, Math.min(1, x));

function rgbToHsl(r: number, g: number, b: number): readonly [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn), d = mx - mn;
  const l = (mx + mn) / 2;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = mx === rn ? ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6 : mx === gn ? ((bn - rn) / d + 2) / 6 : ((rn - gn) / d + 4) / 6;
  return [h * 360, s, l];
}

function hslToRgb(h: number, s: number, l: number): readonly [number, number, number] {
  const hn = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [channel(hn + 1 / 3) * 255, channel(hn) * 255, channel(hn - 1 / 3) * 255];
}

/** A variant's colour and size shifts. */
export interface VariantTweak {
  readonly hue: number;
  readonly sat: number;
  readonly light: number;
  readonly size: number;
}

/** Stable per-(species, variant) tweaks, so a variant looks the same whichever seed stocks it. */
export function variantTweak(sp: Species, variant: number): VariantTweak {
  const rng = mulberry32(hashString(sp.id) ^ Math.imul(variant + 1, VARIANT_SEED_STRIDE));
  return {
    hue: range(rng, -VARIANT_HUE_DEG, VARIANT_HUE_DEG),
    sat: range(rng, -VARIANT_SAT, VARIANT_SAT),
    light: range(rng, -VARIANT_LIGHT, VARIANT_LIGHT),
    size: range(rng, VARIANT_SIZE_MIN, VARIANT_SIZE_MAX),
  };
}

/** A 6-digit hex colour shifted in hue/sat/light; black and near-neutral marks stay pure. */
function shiftHex(hex: string, t: VariantTweak): string {
  if (!HEX.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < BLACK_MAX_CHANNEL || mn > NEUTRAL_RATIO * mx) return hex;
  const [h, s, l] = rgbToHsl(r, g, b);
  const [r2, g2, b2] = hslToRgb(h + t.hue, clamp01(s + t.sat), clamp01(l + t.light));
  return '#' + [r2, g2, b2].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
}

const shiftStops = (stops: ColourStop[], t: VariantTweak): ColourStop[] => stops.map(([v, c]): ColourStop => [v, shiftHex(c, t)]);

/** Shifts every body and fin colour (not the eye) of a cloned species, leaving black/white marks pure. */
function shiftSpeciesColours(sp: Species, t: VariantTweak): void {
  for (const p of sp.pattern) {
    if ('stops' in p) p.stops = shiftStops(p.stops, t);
    if ('color' in p) p.color = shiftHex(p.color, t);
    if ('edge' in p && p.edge) p.edge = shiftHex(p.edge, t);
    if (p.op === 'blotches') {
      if (p.inner) p.inner = shiftHex(p.inner, t);
      if (p.speck) p.speck = shiftHex(p.speck, t);
    }
  }
  for (const f of sp.fins) {
    if (f.kind === 'spines') {
      f.fill = shiftHex(f.fill, t);
      f.color = shiftHex(f.color, t);
      if (f.stripes) f.stripes = shiftHex(f.stripes, t);
    } else {
      f.fill = Array.isArray(f.fill) ? shiftStops(f.fill, t) : shiftHex(f.fill, t);
      if (f.edge) f.edge = shiftHex(f.edge, t);
      if (f.fringe) f.fringe = shiftHex(f.fringe, t);
      if (f.rays) f.rays = shiftHex(f.rays, t);
      if (f.spots) f.spots = shiftHex(f.spots, t);
      for (const pnt of f.paint ?? []) pnt.color = shiftHex(pnt.color, t);
      if (f.spot) {
        f.spot.color = shiftHex(f.spot.color, t);
        if (f.spot.ring) f.spot.ring = shiftHex(f.spot.ring, t);
      }
    }
  }
  sp.caudal.fill = shiftHex(sp.caudal.fill, t);
  if (sp.caudal.edge) sp.caudal.edge = shiftHex(sp.caudal.edge, t);
  if (sp.caudal.fringe) sp.caudal.fringe = shiftHex(sp.caudal.fringe, t);
  if (sp.caudal.rays) sp.caudal.rays = shiftHex(sp.caudal.rays, t);
  if (sp.caudal.spots) sp.caudal.spots = shiftHex(sp.caudal.spots, t);
  if (sp.caudal.band) sp.caudal.band.color = shiftHex(sp.caudal.band.color, t);
  if (sp.pectoral) {
    sp.pectoral.fill = shiftHex(sp.pectoral.fill, t);
    if (sp.pectoral.edge) sp.pectoral.edge = shiftHex(sp.pectoral.edge, t);
    if (sp.pectoral.stripes) sp.pectoral.stripes = shiftHex(sp.pectoral.stripes, t);
    if (sp.pectoral.rayColor) sp.pectoral.rayColor = shiftHex(sp.pectoral.rayColor, t);
    if (sp.pectoral.spots) sp.pectoral.spots = shiftHex(sp.pectoral.spots, t);
  }
  if (sp.pelvic) {
    sp.pelvic.fill = shiftHex(sp.pelvic.fill, t);
    if (sp.pelvic.edge) sp.pelvic.edge = shiftHex(sp.pelvic.edge, t);
    if (sp.pelvic.spots) sp.pelvic.spots = shiftHex(sp.pelvic.spots, t);
  }
  for (const a of sp.appendages ?? []) {
    a.color = shiftHex(a.color, t);
    if (a.stripes) a.stripes = shiftHex(a.stripes, t);
  }
  if (sp.scalpel) sp.scalpel.color = shiftHex(sp.scalpel.color, t);
}

/**
 * The species as its variant paints it: variant 0 is the original (so its cached skins and keys are
 * unchanged); other variants are a deep clone with shifted colours and per-variant spot/blotch seeds.
 * Species-defining marks (band/spot counts, fins, silhouette) are kept, so a variant's textures can be
 * swapped onto a fish built from variant 0 without changing its geometry.
 */
export function variantSpecies(sp: Species, variant: number): Species {
  if (variant <= 0) return sp;
  const v = JSON.parse(JSON.stringify(sp)) as Species;
  v.variant = variant;
  const t = variantTweak(sp, variant);
  shiftSpeciesColours(v, t);
  for (const p of v.pattern) {
    if (p.op === 'spots' || p.op === 'blotches') p.seed = p.seed + variant * VARIANT_SEED_STRIDE;
  }
  return v;
}

/** Picks a variant from the stock's seed stream, so a seed assigns the same variants to the same fish. */
export function pickVariant(rng: Rng): number {
  return Math.floor(rng() * VARIANT_COUNT);
}

/** The variant the Roku bake uses for the fish at `index` in a species' stocking order (always 0). */
export function bakeVariant(_fishIndex: number): number {
  return BAKE_VARIANT;
}
