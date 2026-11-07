// A fish's body as collision sees it, roughly as the model draws it (fishModel/profile.ts): a straight
// axis from the snout (x = 0.5 L ahead of pos) back to the peduncle (x = (0.5 - len) L), with an
// elliptical cross-section of half-depth H = depth / 2 and half-width about H * width, tapering like an
// ellipsoid towards both ends. Used by the rock and fish-fish collision (fish.ts) and the motion check.
import * as THREE from 'three';

/** The share of the profile's width at its deepest point (profile width(u) ~ 1.15 - 0.55 u). */
const WIDTH_AT_DEEPEST = 0.95;
/** The ellipsoid taper never closes below this share of the full section (blunt head, peduncle). */
const MIN_TAPER = 0.3;
/** The dorsal and anal fins stand above and below the body: the section's height is padded by this. */
const FIN_PAD = 1.15;
/** The caudal fin, from the peduncle to the tail tip (x = -0.5 L): a thin blade, this share of the section. */
const CAUDAL_DEPTH = 0.6;
const CAUDAL_WIDTH = 0.25;

export interface BodyFish {
  readonly pos: THREE.Vector3;
  readonly dir: THREE.Vector3;
  readonly size: number;
  readonly sp: { readonly body: { readonly len: number; readonly depth: number; readonly width: number } };
}

/**
 * Axis ends as offsets along dir from pos (units): snout, peduncle (tail) and the caudal fin's tip
 * (fin), and the section's half-depth (fins included) and half-width.
 */
export interface BodyDims {
  readonly nose: number;
  readonly tail: number;
  readonly fin: number;
  readonly halfDepth: number;
  readonly halfWidth: number;
}

export function bodyDims(f: BodyFish): BodyDims {
  const b = f.sp.body, L = f.size, H = (b.depth / 2) * L;
  return { nose: 0.5 * L, tail: (0.5 - b.len) * L, fin: -0.5 * L, halfDepth: H * FIN_PAD, halfWidth: Math.max(H * b.width * WIDTH_AT_DEEPEST, 0.004 * L) };
}

/** Taper at axis offset s (units): 1 at the middle of the axis, an ellipsoid's falloff to the ends. */
export function taperAt(d: BodyDims, s: number): number {
  const mid = (d.nose + d.tail) / 2, half = (d.nose - d.tail) / 2;
  const t = (s - mid) / half;
  return Math.max(MIN_TAPER, Math.sqrt(Math.max(0, 1 - t * t)));
}

const _up = new THREE.Vector3();

/**
 * The body's radius at axis offset s towards unit direction n (perpendicular-ish to the axis): the
 * ellipse of the cross-section, half-depth up and half-width across, scaled by the taper. The fish's
 * up is taken as world up off the heading (fish.ts orient, without the bank). Behind the peduncle
 * (s < tail) it is the caudal fin: tall and thin.
 */
export function radiusToward(f: BodyFish, d: BodyDims, s: number, n: THREE.Vector3): number {
  _up.set(0, 1, 0).addScaledVector(f.dir, -f.dir.y);
  const ul = _up.length();
  const c = ul > 1e-6 ? n.dot(_up) / ul : 0;
  const a = n.dot(f.dir);
  // The part of n across the axis: c along up, the rest along the side.
  const across = Math.max(1e-6, 1 - a * a), cu = (c * c) / across, cs = Math.max(0, 1 - cu);
  const caudal = s < d.tail;
  const h = caudal ? d.halfDepth * CAUDAL_DEPTH : d.halfDepth, w = caudal ? d.halfWidth * CAUDAL_WIDTH : d.halfWidth;
  const r = 1 / Math.sqrt(cu / (h * h) + cs / (w * w));
  return caudal ? r : r * taperAt(d, s);
}

/**
 * Closest points between two segments p0-p1 and q0-q1 (Ericson, Real-Time Collision Detection 5.1.9):
 * the parameters (0..1) along each, written into out[0], out[1].
 */
export function closestSegmentParams(p0: THREE.Vector3, p1: THREE.Vector3, q0: THREE.Vector3, q1: THREE.Vector3, out: [number, number]): void {
  const d1x = p1.x - p0.x, d1y = p1.y - p0.y, d1z = p1.z - p0.z;
  const d2x = q1.x - q0.x, d2y = q1.y - q0.y, d2z = q1.z - q0.z;
  const rx = p0.x - q0.x, ry = p0.y - q0.y, rz = p0.z - q0.z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z, f = d2x * rx + d2y * ry + d2z * rz;
  const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
  let s = 0, t = 0;
  if (a <= 1e-12 && e <= 1e-12) { out[0] = 0; out[1] = 0; return; }
  if (a <= 1e-12) { t = clamp01(f / e); }
  else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= 1e-12) { s = clamp01(-c / a); }
    else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z, den = a * e - b * b;
      s = den > 1e-12 ? clamp01((b * f - c * e) / den) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); }
      else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  out[0] = s; out[1] = t;
}
