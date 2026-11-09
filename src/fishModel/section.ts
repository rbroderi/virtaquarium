// The body's cross-section: how far the skin stands from the midplane at body position (u, v), shared
// by the body mesh, the eyes and the appendages so they all sit on the same surface.
import * as THREE from 'three';
import { lerp } from '../util.js';
import type { BodySection, Species } from '../species/types.js';
import { coverOf, gillOf, outlineCurve, smooth01, type Gill, type Profile } from './profile.js';

// Gill cover: how far it stands proud of the body (a share of the body's half-width), rising over
// its rear half to a step at the free margin. cover: whether the point is on the cover (the body mesh
// puts two coincident rings on the margin, one each side of the step); by default, ahead of the margin.
// (COVER and coverOf live in profile.ts, with the gill margin.)
export { coverOf };
export function coverAt(G: Gill | null, u: number, v: number, cover?: boolean): number {
  if (!G) return 0;
  const edge = G.edge(v);
  if (!(cover ?? u <= edge)) return 0;
  return smooth01((u - (edge - 0.13)) / 0.12) * G.fade(v);
}

// Angular cross-section (sp.body.section, the triggerfish's plated head): flat cheeks at full width
// between cy = lo and hi (cy = +1 dorsal), tapering straight to the dorsal and ventral keels, the
// corners rounded over `round` (no sharp edges: bone under skin). sharp blends it over the round
// section between u0 and u1 (eased in and out over `ease`).
function angularSection(S: BodySection | undefined, u: number, cy: number, z: number, W: number): number {
  if (!S) return z;
  const ease = S.ease ?? 0.06;
  const s = (S.sharp ?? 0.7) * smooth01((u - S.u0) / ease + 1) * (1 - smooth01((u - S.u1) / ease));
  if (s <= 0) return z;
  const r = S.round ?? 0.15, lo = S.lo ?? -0.3, hi = S.hi ?? 0.4;
  const ramp = (x: number): number => 0.5 * (x + Math.sqrt(x * x + r * r)) - 0.5 * r;   // softened max(0, x)
  const a = Math.max(0, 1 - ramp((cy - hi) / (1 - hi)) - ramp((lo - cy) / (1 + lo))) * smooth01((1 - Math.abs(cy)) / 0.05);
  return lerp(z, a * W, s);
}

const eggs = new WeakMap<Species, (u: number) => number>();
const eggOf = (sp: Species): ((u: number) => number) => {
  let f = eggs.get(sp);
  if (!f) { f = outlineCurve(sp.body.egg); eggs.set(sp, f); }
  return f;
};

// The skin's distance from the midplane at body position u and texture height v (-1 dorsal, +1
// ventral), before relief: the body mesh's cross-section, shared with the eyes so they sit on it.
export function flankZ(sp: Species, prof: Profile, u: number, v: number, cover?: boolean): number {
  const e = sp.eye, len = sp.body.len, cy = -v;
  // Section exponent: compressed fish (tangs, angels) have a lens-shaped section, thickest along the
  // spine and sharp at the fin bases (> 1); round-bodied fish (gramma, lionfish) are fuller (< 1).
  const flank = sp.body.flank ?? 1.6 - sp.body.width * 1.6;
  const h = prof.half(u);
  let z = Math.pow(Math.sqrt(Math.max(0, 1 - cy * cy)), flank) * prof.width(u);
  z = angularSection(sp.body.section, u, cy, z, prof.width(u));
  z *= 1 - 0.25 * Math.max(0, cy) ** 4;                                  // narrow dorsal ridge (fin base)
  z *= 1 + 0.12 * Math.max(0, -cy) * (1 - smooth01(u / 0.6));            // fuller belly over the gut
  z *= 1 - eggOf(sp)(u) * cy;                                           // egg-shaped section (sp.body.egg)
  z *= 1 + coverOf(sp) * coverAt(gillOf(sp), u, v, cover);              // gill cover overhangs the flank
  const du = (u - e.u) / (e.r * 1.6 / len), dv = (v - e.v) / (e.r * 1.6 / Math.max(h, 1e-3));
  const socket = Math.exp(-(du * du + dv * dv));
  z *= 1 + 0.07 * socket;                                                // eye socket
  if (e.boss) z += e.boss * e.r * Math.exp(-0.6 * (du * du + dv * dv));  // the eye's mound (sp.eye.boss)
  return z;
}

/** A geometry's named attribute, which this module's own geometries always have. */
export function attribute(geo: THREE.BufferGeometry, name: string): THREE.BufferAttribute {
  const a = geo.getAttribute(name);
  if (!(a instanceof THREE.BufferAttribute)) throw new Error(`geometry has no ${name} attribute`);
  return a;
}
