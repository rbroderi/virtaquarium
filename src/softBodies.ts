// The critters' blended bodies as distance fields (sdfMesh.ts), in the frames critters.ts builds them
// in: the octopus at mantle scale M = 1, the cuttlefish at mantle length ML = 1 (the meshes are scaled
// per animal). tools/softbodies.ts meshes these into web/models/critters/*.glb; critters.ts loads the
// files and falls back to meshing here only if one is missing. Each mesh carries a _WEIGHT attribute:
// the share of the part that moves on its own once the parts are merged (the octopus's mantle sac,
// which breathes; the cuttlefish's mantle, which squeezes in a jet), from the smooth minimum's blend.
import { smin, smix, ssub, ellipsoid, roundCone, vnoise, surfaceNets, type GlbMesh } from './sdfMesh.js';

type Vec3Tuple = readonly [number, number, number];
const val = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;
const MAX_UINT16_VERTICES = 65536;

// Octopus: mantle sac (behind and above the head, tipped 0.3 rad), head, eye turrets, the oral disc
// with the eight arm roots swelling out of it, and the siphon with its funnel mouth. Same centres and
// radii as the separate spheres it replaces, so the arms' obstacles (octopus untangle) still fit.
export const OCTO_SAC: { readonly c: Vec3Tuple; readonly r: Vec3Tuple; readonly rotZ: number } = { c: [-0.48, 0.3, 0], r: [0.58, 0.34, 0.36], rotZ: 0.3 };
const sacCos = Math.cos(-OCTO_SAC.rotZ), sacSin = Math.sin(-OCTO_SAC.rotZ);
function octoSac(x: number, y: number, z: number): number {
  const qx = x - OCTO_SAC.c[0], qy = y - OCTO_SAC.c[1];
  // wrinkled: the old sac's noise was +-9% of its radius
  return ellipsoid(qx * sacCos - qy * sacSin, qx * sacSin + qy * sacCos, z, 0, 0, 0, ...OCTO_SAC.r) - (vnoise(x * 9 + 3, y * 9, z * 9) - 0.5) * 0.045;
}
// The siphon: the old open cylinder (centre, axis from its Euler angles -1.1, 0, -0.9), wide end out.
const SIPH = ((): { a: Vec3Tuple; b: Vec3Tuple; out: Vec3Tuple } => {
  const c: Vec3Tuple = [-0.08, 0.12, 0.27], ax: Vec3Tuple = [Math.sin(0.9), Math.cos(0.9), 0];
  const cy = Math.cos(-1.1), sy = Math.sin(-1.1), a: Vec3Tuple = [ax[0], ax[1] * cy, ax[1] * sy];
  return {
    a: [c[0] + a[0] * 0.1, c[1] + a[1] * 0.1, c[2] + a[2] * 0.1],
    b: [c[0] - a[0] * 0.1, c[1] - a[1] * 0.1, c[2] - a[2] * 0.1],
    out: [-a[0], -a[1], -a[2]],
  };
})();
const ARM_COUNT = 8;
const ROOTS: readonly (readonly [number, number])[] = Array.from({ length: ARM_COUNT }, (_, i) => { const a = ((i + 0.5) / ARM_COUNT) * Math.PI * 2; return [Math.cos(a), Math.sin(a)] as const; });
function octoRest(x: number, y: number, z: number): number {
  let d = ellipsoid(x, y, z, 0.05, 0.18, 0, 0.3, 0.26, 0.32);                      // head
  d = smin(d, ellipsoid(x, y, z, 0, 0.02, 0, 0.36, 0.11, 0.36), 0.1);               // oral disc
  for (const s of [1, -1]) d = smin(d, ellipsoid(x, y, z, 0.13, 0.36, s * 0.2, 0.1, 0.1, 0.1), 0.06);   // eye turrets
  // Arm roots: short, so they stay under the disc's rim whichever way the arms leave (in a cave the
  // tucked arms fan out of the mouth, away from these angles); the ArmTubes start inside them.
  for (const [c, s] of ROOTS) d = smin(d, roundCone(x, y, z, 0.12 * c, 0.02, 0.12 * s, 0.26 * c, -0.045, 0.26 * s, 0.095, 0.08), 0.07);
  const sf = roundCone(x, y, z, ...SIPH.a, ...SIPH.b, 0.055, 0.075);
  d = smin(d, sf, 0.05);
  // the funnel's mouth, hollowed into its wide end
  d = ssub(d, ellipsoid(x, y, z, SIPH.b[0] + SIPH.out[0] * 0.02, SIPH.b[1] + SIPH.out[1] * 0.02, SIPH.b[2] + SIPH.out[2] * 0.02, 0.04, 0.04, 0.04), 0.02);
  return d;
}
// (the fine wrinkles at 3+ cells a wave: finer, the grid aliases them into lumps)
const octoField = (x: number, y: number, z: number): number => smin(octoSac(x, y, z), octoRest(x, y, z), 0.12) - (vnoise(x * 11, y * 11, z * 11) - 0.5) * 0.012;
const OCTOPUS_CELL = 0.03;
export function octopusBody(h = OCTOPUS_CELL): GlbMesh {
  const m = surfaceNets(octoField, { x0: -1.16, x1: 0.48, y0: -0.2, y1: 0.74, z0: -0.48, z1: 0.48 }, h,
    { w: (x: number, y: number, z: number) => 1 - smix(octoSac(x, y, z), octoRest(x, y, z), 0.12) });
  return { name: 'octopus-body', attributes: { POSITION: { array: m.position, size: 3 }, NORMAL: { array: m.normal, size: 3 }, _WEIGHT: { array: m.attrs.w, size: 1 } }, index: m.index };
}

// Cuttlefish: the flattened mantle (a solid of revolution about x, tail at -1, open front at 0 with the
// head in it), the head with its eye bulges, and the crown the arms grow from.
// Mantle half-width per unit mantle length from tail (t 0) to head end (1): cuttlefish mantleR.
export const mantleR = (t: number): number => { const s = t < 0.6 ? (0.6 - t) / 0.6 : ((t - 0.6) / 0.4) * 0.7; return 0.24 * Math.cbrt(Math.max(0, 1 - s ** 3)); };
const FLAT = 0.62;   // depth over width
function cuttleMantle(x: number, y: number, z: number): number {
  const ys = y / FLAT, rho = Math.hypot(ys, z), t = Math.min(1, Math.max(0, x + 1));
  const R = mantleR(t), dR = (mantleR(Math.min(1, t + 0.01)) - mantleR(Math.max(0, t - 0.01))) / 0.02;
  // the radial gap, slope-corrected, back to real units (the section is squashed in y)
  let d = (rho - R) / Math.sqrt(1 + Math.min(dR * dR, 100));
  if (x < -1) d = Math.hypot(rho, x + 1);
  d *= rho > 1e-6 ? FLAT + (1 - FLAT) * (z / rho) ** 2 : FLAT;
  return -smin(-d, -(x - 0.004), 0.025);   // the open front, cut with a rounded lip
}
function cuttleRest(x: number, y: number, z: number): number {
  let d = ellipsoid(x, y, z, 0.06, 0.005, 0, 0.19, 0.135, 0.19);                    // head
  for (const s of [1, -1]) d = smin(d, ellipsoid(x, y, z, 0.09, 0.058, s * 0.118, 0.06, 0.052, 0.048), 0.04);   // eye bulges
  d = smin(d, roundCone(x, y, z, 0.15, -0.025, 0, 0.215, -0.035, 0, 0.085, 0.07), 0.04);   // arm crown
  return d;
}
const cuttleField = (x: number, y: number, z: number): number => smin(cuttleMantle(x, y, z), cuttleRest(x, y, z), 0.05) - (vnoise(x * 18, y * 18, z * 18) - 0.5) * 0.003;
const CUTTLE_CELL = 0.017;
export function cuttleBody(h = CUTTLE_CELL): GlbMesh {
  const m = surfaceNets(cuttleField, { x0: -1.06, x1: 0.3, y0: -0.2, y1: 0.18, z0: -0.3, z1: 0.3 }, h,
    // (the weight blended wider than the fillet, so the head's colour and the squeeze fade in softly)
    { w: (x: number, y: number, z: number) => 1 - smix(cuttleMantle(x, y, z), cuttleRest(x, y, z), 0.16) });
  // UVs as the old lathe had them: u round the mantle (0.75 dorsal, 0.25 ventral), v tail to head.
  // The seam (u 0 / 1, on the +z flank) gets its own vertices at u + 1 (the skin repeats in u).
  const P = m.position, nv = P.length / 3, uv: number[] = [];
  for (let i = 0; i < nv; i++) {
    const u = Math.atan2(-val(P, 3 * i + 1) / FLAT, val(P, 3 * i + 2)) / (2 * Math.PI);
    uv.push(u < 0 ? u + 1 : u, Math.min(1, Math.max(0, val(P, 3 * i) + 1)));
  }
  const ix = Array.from(m.index), pos = Array.from(P), nrm = Array.from(m.normal), w = Array.from(m.attrs.w), dup = new Map<number, number>();
  for (let t = 0; t < ix.length; t += 3) {
    const us = [0, 1, 2].map((k) => val(uv, 2 * val(ix, t + k)));
    if (Math.max(...us) - Math.min(...us) < 0.5) continue;
    for (let k = 0; k < 3; k++) {
      const v = val(ix, t + k);
      if (val(uv, 2 * v) >= 0.5) continue;
      let copy = dup.get(v);
      if (copy === undefined) {
        copy = pos.length / 3;
        dup.set(v, copy);
        pos.push(val(pos, 3 * v), val(pos, 3 * v + 1), val(pos, 3 * v + 2)); nrm.push(val(nrm, 3 * v), val(nrm, 3 * v + 1), val(nrm, 3 * v + 2));
        w.push(val(w, v)); uv.push(val(uv, 2 * v) + 1, val(uv, 2 * v + 1));
      }
      ix[t + k] = copy;
    }
  }
  const n2 = pos.length / 3;
  return {
    name: 'cuttlefish-body',
    attributes: { POSITION: { array: Float32Array.from(pos), size: 3 }, NORMAL: { array: Float32Array.from(nrm), size: 3 }, TEXCOORD_0: { array: Float32Array.from(uv), size: 2 }, _WEIGHT: { array: Float32Array.from(w), size: 1 } },
    index: n2 < MAX_UINT16_VERTICES ? Uint16Array.from(ix) : Uint32Array.from(ix),
  };
}

export type SoftBodyName = 'octopus-body' | 'cuttlefish-body';
export const SOFT_BODIES: Readonly<Record<SoftBodyName, () => GlbMesh>> = { 'octopus-body': () => octopusBody(), 'cuttlefish-body': () => cuttleBody() };
