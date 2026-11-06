// Fitted anatomy (tools/fit-anatomy.ts) merged over the hand-written species in species.ts.
// Each file holds body profile parameters, per-fin outlines (by index into sp.fins), the caudal spread and
// band positions and widths (by index into sp.pattern).
import type { ColourStop, FittedAnatomy, SpeciesDefinition, Vec3Tuple } from '../species/types.js';
import clownfish from './clownfish.js';
import lionfish from './lionfish.js';
import clowntrigger from './clowntrigger.js';
import copperband from './copperband.js';
import bluetang from './bluetang.js';
import yellowtang from './yellowtang.js';
import royalgramma from './royalgramma.js';
import emperorangel from './emperorangel.js';
import longnose from './longnose.js';
import chromis from './chromis.js';
import coralbeauty from './coralbeauty.js';

// (Not the Moorish idol: its traces cut through the tail and the fit can't raise a fin past 0.35 or
// reach past the tail, so it flattened the dorsal and its filament and thinned the snout to a needle.
// Its shape is hand-fitted to the photos in species.ts.)
const FITTED: Readonly<Record<string, FittedAnatomy>> = {
  clownfish, lionfish, clowntrigger, copperband, bluetang, yellowtang, royalgramma, emperorangel, longnose, chromis, coralbeauty,
};

/** Below this max channel a colour is black, not pigment. */
const BLACK_MAX_CHANNEL = 40;
/** Above this min/max channel ratio a colour is white or grey, not pigment. */
const NEUTRAL_RATIO = 0.7;
const SRGB_LINEAR_KNEE = 0.04045;
const SRGB_ENCODE_KNEE = 0.0031308;
const SRGB_GAMMA = 2.4;

const toLinear = (v8: number): number => {
  const v = v8 / 255;
  return v <= SRGB_LINEAR_KNEE ? v / 12.92 : ((v + 0.055) / 1.055) ** SRGB_GAMMA;
};
const toSrgb8 = (v: number): number =>
  Math.round(255 * Math.min(1, v <= SRGB_ENCODE_KNEE ? v * 12.92 : 1.055 * v ** (1 / SRGB_GAMMA) - 0.055));

/** Linear-light gain on a saturated colour; white and black are left alone (unless named). */
function gainHex(hex: string, gain: Vec3Tuple, named = false): string {
  const n = parseInt(hex.slice(1), 16);
  const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mx = Math.max(...channels), mn = Math.min(...channels);
  if (!named && (mx < BLACK_MAX_CHANNEL || mn > NEUTRAL_RATIO * mx)) return hex;
  return '#' + channels.map((v, i) => toSrgb8(toLinear(v) * gain[i as 0 | 1 | 2]).toString(16).padStart(2, '0')).join('');
}

/** Applies a gain to every colour of a species, or only to the colours in `only` (per-colour calibration). */
function gainColours(sp: SpeciesDefinition, gain: Vec3Tuple, only: ReadonlySet<string> | null = null): void {
  const g = (h: string): string => (h[0] === '#' && (!only || only.has(h.toLowerCase())) ? gainHex(h, gain, !!only) : h);
  const gStops = (stops: ColourStop[]): ColourStop[] => stops.map(([v, c]): ColourStop => [v, g(c)]);
  for (const p of sp.pattern) {
    if ('color' in p) p.color = g(p.color);
    if ('stops' in p) p.stops = gStops(p.stops);
  }
  for (const f of sp.fins) {
    if (f.kind === 'spines') f.fill = g(f.fill);
    else f.fill = Array.isArray(f.fill) ? gStops(f.fill) : g(f.fill);
  }
  sp.caudal.fill = g(sp.caudal.fill);
  if (sp.pectoral) sp.pectoral.fill = g(sp.pectoral.fill);
  sp.eye.iris = g(sp.eye.iris);
  if (sp.pelvic) sp.pelvic.fill = g(sp.pelvic.fill);
}

/** Colour calibration, then the fitted shape where one exists; marks fitted species. */
export function applyFitted(species: readonly (SpeciesDefinition & { fitted?: boolean })[]): void {
  for (const sp of species) {
    if (sp.albedoGain) gainColours(sp, sp.albedoGain);
    // Two-hue fish (purple and yellow, blue and orange) need a gain per colour group: one species gain
    // would push the hues in opposite directions.
    for (const { hex, gain } of sp.colourGain ?? []) gainColours(sp, gain, new Set(hex.map((h) => h.toLowerCase())));
    const fit = FITTED[sp.id];
    if (!fit) continue;
    Object.assign(sp.body, fit.body);
    fit.fins.forEach((fin, i) => {
      const target = sp.fins[i];
      if (target) Object.assign(target, fin);
    });
    Object.assign(sp.caudal, fit.caudal);
    if (fit.pelvic && sp.pelvic) Object.assign(sp.pelvic, fit.pelvic);
    if (fit.pectoral && sp.pectoral) Object.assign(sp.pectoral, fit.pectoral);
    for (const b of fit.bands ?? []) {
      const band = sp.pattern[b.index];
      if (band?.op === 'band') Object.assign(band, { u: b.u, w: b.w });
    }
    sp.fitted = true;
  }
}
