// The cuttlefish's textures and its procedural parts: the arm bundle (bent in the vertex shader)
// and the fin skirt's topology.
import * as THREE from 'three';
import { range, clamp, lerp, makeCanvas, context2d, Noise, type Rng } from '../util.js';
import { canvasTexture } from './shared.js';
import { organicPass, type OrganicOptions } from '../core/organic.js';

const FULL_CIRCLE = 7;   // > 2 PI: canvas arcs drawn as whole discs

/** Mantle irregularity (mantle lengths): slow lumps, one flank fuller, a low ridge over the cuttlebone,
 * the tail tip off the midline. Kept inside the fin skirt's buried root (about 0.02). */
const BODY_LUMPS = 0.007, BODY_LUMP_FREQ = 4.5, BODY_FLANK = 0.005, BODY_CREST = 0.006, BODY_TAIL_SWAY = 0.025;

/** How far the mantle's tail end turns aside at x (ML = 1 frame): only the last part of the mantle. */
export const tailSwayAt = (sway: number, x: number): number => sway * clamp((-x - 0.55) / 0.45, 0, 1) ** 2;

/**
 * Each cuttlefish's own copy of the shared body mesh (built for ML = 1), no longer a perfect solid of
 * revolution: the mantle's share (aWeight) is pushed out or in along its normals by slow lumps, one
 * flank stands a little fuller, a low ridge runs over the cuttlebone, and the tail tip turns a little
 * to one side (tailSwayAt; the fin skirt follows it). The head, eye bulges and arm crown keep their shape (the eyes and arms sit on them).
 */
export function varyCuttleBody(base: THREE.BufferGeometry, rng: Rng): { geometry: THREE.BufferGeometry; tailSway: number } {
  const g = base.clone(), noise = new Noise(rng);
  const pos = g.getAttribute('position'), nrm = g.getAttribute('normal'), w = g.getAttribute('aWeight');
  const flank = range(rng, -1, 1) * BODY_FLANK, crest = range(rng, 0.2, 1) * BODY_CREST, sway = range(rng, -1, 1) * BODY_TAIL_SWAY;
  const lumps = BODY_LUMPS * range(rng, 0.6, 1), o = [rng() * 40, rng() * 40, rng() * 40];
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i), m = clamp(w.getX(i), 0, 1);
    if (m <= 0) continue;
    const d = m * (lumps * 2 * (noise.noise3(x * BODY_LUMP_FREQ + (o[0] ?? 0), y * BODY_LUMP_FREQ + (o[1] ?? 0), z * BODY_LUMP_FREQ + (o[2] ?? 0)) - 0.5)
      + flank * (z / 0.24) + crest * Math.exp(-((z / 0.07) ** 2)) * clamp(y / 0.05, 0, 1));
    const tail = m * tailSwayAt(sway, x);
    pos.setXYZ(i, x + nrm.getX(i) * d, y + nrm.getY(i) * d, z + nrm.getZ(i) * d + tail);
  }
  g.computeVertexNormals();
  // The UV seam's duplicated vertices: share one normal, or the seam shows as a crease.
  const n = g.getAttribute('normal'), same = new Map<string, number[]>();
  for (let i = 0; i < pos.count; i++) {
    const key = `${pos.getX(i).toFixed(5)},${pos.getY(i).toFixed(5)},${pos.getZ(i).toFixed(5)}`;
    const list = same.get(key);
    if (list) list.push(i); else same.set(key, [i]);
  }
  const v = new THREE.Vector3();
  for (const list of same.values()) {
    if (list.length < 2) continue;
    v.set(0, 0, 0);
    for (const i of list) v.x += n.getX(i), v.y += n.getY(i), v.z += n.getZ(i);
    v.normalize();
    for (const i of list) n.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeBoundingSphere();
  return { geometry: g, tailSway: sway };
}
/** Grown, not drawn: the bars and spot rows wander and the colour is patchy. u wraps round the mantle. */
const SKIN_ORGANIC: OrganicOptions = { warp: [[8, 4, 10, 6], [24, 12, 3, 2]], mottle: { cellsX: 10, cellsY: 5, value: 0.07, chroma: 0.03 }, wrapX: true };
const FIN_ORGANIC: OrganicOptions = { warp: [[10, 2, 4, 2]], mottle: { cellsX: 8, cellsY: 2, value: 0.06, chroma: 0.03 } };

/** The mantle skin: zebra bars on the back, white spots along the fin base, a pale belly. */
export function cuttleSkin(rng: Rng): THREE.CanvasTexture {
  const W = 1024, H = 512, c = makeCanvas(W, H), g = context2d(c), n = new Noise(rng);
  // u (x) round the mantle: 0.75 dorsal, 0.25 ventral, 0 / 0.5 the sides. v (y) tail (0) to head (1).
  const img = g.createImageData(W, H), d = img.data;
  const brown = [128, 74, 52] as const, dark = [62, 26, 16] as const, white = [236, 228, 218] as const;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, dd = Math.min(Math.abs(u - 0.75), 1 - Math.abs(u - 0.75)) * 2;   // 0 dorsal .. 1 ventral
    const dors = clamp((0.55 - dd) / 0.25, 0, 1);
    // Zebra: wavy transverse bars across the back.
    const wob = (n.fbm(u * 6, v * 5, 3) - 0.5) * 2.2 + Math.sin((u - 0.75) * 30) * 0.15;
    const bar = Math.sin((v * 22 + wob) * Math.PI);
    let r = 232, gg = 222, b = 212;                         // pale belly
    const z = bar > 0.05 ? dark : bar < -0.7 ? white : brown;
    const m = dors * clamp((v - 0.04) / 0.08, 0, 1) * clamp((0.97 - v) / 0.06, 0, 1);
    r = lerp(r, lerp(brown[0], z[0], 0.85), m); gg = lerp(gg, lerp(brown[1], z[1], 0.85), m); b = lerp(b, lerp(brown[2], z[2], 0.85), m);
    // Brown sides with a lilac-blue iridescent sheen below the spots.
    const side = clamp(1 - Math.abs(dd - 0.62) / 0.15, 0, 1);
    r = lerp(r, 150, side * 0.5); gg = lerp(gg, 110, side * 0.5); b = lerp(b, 120, side * 0.5);
    const k = (y * W + x) * 4;
    d[k] = r; d[k + 1] = gg; d[k + 2] = b; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  // White spots along the fin base, both sides (the base runs a third of the way down the flank).
  g.fillStyle = 'rgba(250,246,236,0.95)';
  const SPOTS = 70;
  for (const u0 of [0.093, 0.407]) {
    for (let i = 0; i < SPOTS; i++) { g.beginPath(); g.arc(u0 * W + range(rng, -4, 4), (0.05 + 0.9 * i / SPOTS) * H, range(rng, 1.5, 2.6), 0, FULL_CIRCLE); g.fill(); }
  }
  organicPass(g, W, H, rng, SKIN_ORGANIC);
  return canvasTexture(c);
}

/** The fin skirt: translucent, with dense white dots that crowd towards its edge. */
export function cuttleFinTex(rng: Rng): THREE.CanvasTexture {
  const W = 512, H = 64, c = makeCanvas(W, H), g = context2d(c);
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgb(120,78,70)'); gr.addColorStop(1, 'rgb(150,136,140)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(250,248,240,0.9)';
  const DOTS = 1400;
  for (let i = 0; i < DOTS; i++) {
    const y = H * Math.sqrt(rng());   // more towards the edge (v = 1)
    g.beginPath(); g.arc(rng() * W, y, range(rng, 0.6, 1.3), 0, FULL_CIRCLE); g.fill();
  }
  organicPass(g, W, H, rng, FIN_ORGANIC);
  return canvasTexture(c);
}

/** A golden eye with the W-shaped pupil. */
export function wPupilEye(): THREE.CanvasTexture {
  const s = 128, c = makeCanvas(s, s), g = context2d(c);
  const gr = g.createRadialGradient(s / 2, s / 2, 4, s / 2, s / 2, s / 2);
  // Golden iris with the iridescent green-blue ring of the photos.
  gr.addColorStop(0, '#c8a860'); gr.addColorStop(0.45, '#b09050'); gr.addColorStop(0.75, '#6a9a86'); gr.addColorStop(1, '#3a5a5a');
  g.fillStyle = gr; g.fillRect(0, 0, s, s);
  // The W pupil (lying sideways on the eye, as in side views).
  g.strokeStyle = '#0c0a08'; g.lineWidth = 8; g.lineJoin = 'round'; g.lineCap = 'round';
  g.beginPath(); g.moveTo(30, 52); g.lineTo(48, 78); g.lineTo(64, 58); g.lineTo(80, 78); g.lineTo(98, 52); g.stroke();
  return canvasTexture(c);
}

// The arms: tubes along a centre line in the crown's frame that bends down towards the tip (curl),
// each arm keeping its place (angle a) in a ring about the bundle's line, the ring narrowing with
// the taper. Built once in the rest pose; the vertex shader recomputes the line from uExt (a
// tentacle's stretch: it straightens as it shoots out), so per vertex the geometry holds only where
// it sits on the section: aSec (fraction along, offsets along the tangent, the line's normal and z),
// aArm (a, L, tentacle) and aNrm (the normal in that frame). ML = 1 units (the mesh is scaled).
const ARM_R0 = 0.022, ARM_R1 = 0.008, ARM_STEPS = 10;
const ARM_CURL = 0.7;
const BUNDLE_RING = 3.4;   // the ring of arms about the bundle's line, in arm radii
export const CUTTLE_ARM_GLSL = /* glsl */`
attribute vec4 aSec;
attribute vec3 aArm, aNrm;
attribute vec3 aVar;
uniform float uExt;
// The bend at q along the arm: the curl, plus this arm's own slight kink (a sine, fading out as a tentacle straightens).
float cuttleBend(float q, float curl, float straight) {
  return curl * q * q + (1.0 - straight) * aVar.y * sin(aVar.z + 6.0 * q) * q;
}
void cuttleArm(out vec3 P, out vec3 Nrm) {
  float tent = aArm.z, L = aArm.y, ext = 1.0 + tent * (uExt - 1.0), s = aSec.x * L * ext;
  float straight = tent * clamp((ext - 1.0) / 0.4, 0.0, 1.0);
  float curl = ${ARM_CURL} * aVar.x * (1.0 - straight);
  vec2 c = vec2(0.0);
  float du = s / ${ARM_STEPS}.0;
  for (int i = 0; i < ${ARM_STEPS}; i++) { float q = min((float(i) + 0.5) * du, L) / L, th = cuttleBend(q, curl, straight); c += vec2(cos(th), -sin(th)) * du; }
  float q = min(s, L) / L, th = cuttleBend(q, curl, straight);
  vec3 T = vec3(cos(th), -sin(th), 0.0), N = vec3(sin(th), cos(th), 0.0), Z = vec3(0.0, 0.0, 1.0);
  float rho = 3.4 * mix(${ARM_R0}, ${ARM_R1}, q);
  P = vec3(c, 0.0) + N * (rho * sin(aArm.x) + aSec.z) + Z * (rho * cos(aArm.x) + aSec.w) + T * aSec.y;
  Nrm = T * aNrm.x + N * aNrm.y + Z * aNrm.z;
}
`;

type Vec3Tuple = readonly [number, number, number];
interface ArmFrame { readonly P: Vec3Tuple; readonly T: Vec3Tuple; readonly N: Vec3Tuple }

/**
 * One arm's own character, so the eight are not copies: its curl, the slight kink in its line (amplitude
 * and phase), its girth, how fast it tapers, how its tip ends and how its girth wanders along it.
 */
export interface ArmVariation {
  readonly curl: number;
  readonly kink: number;
  readonly kinkPhase: number;
  readonly girth: number;
  readonly taper: number;
  /** The tip's slide along the arm and its flattening, as fractions of the tip radius. */
  readonly tipSlide: number;
  readonly tipFlat: number;
  readonly wobblePhase: number;
}

/** The arm as it was before any variation. */
export const PLAIN_ARM: ArmVariation = { curl: 1, kink: 0, kinkPhase: 0, girth: 1, taper: 1.4, tipSlide: 0, tipFlat: 1, wobblePhase: 0 };

/** A variation for one arm from a stream of its own (the arms draw nothing from the animal's rng). */
export function armVariation(rng: Rng): ArmVariation {
  const sign = rng() < 0.5 ? -1 : 1;
  return {
    curl: range(rng, 0.8, 1.25), kink: sign * range(rng, 0.05, 0.2), kinkPhase: range(rng, 0, 6.28), girth: range(rng, 0.9, 1.1),
    taper: range(rng, 1.15, 1.9), tipSlide: range(rng, -0.4, 0.9), tipFlat: range(rng, 0.75, 1.15), wobblePhase: range(rng, 0, 6.28),
  };
}

const armBend = (q: number, v: ArmVariation): number => ARM_CURL * v.curl * q * q + v.kink * Math.sin(v.kinkPhase + 6 * q) * q;

/** The same line on the CPU (ext 1), for the rest pose the geometry is built in. */
function cuttleArmFrame(f: number, L: number, a: number, v: ArmVariation): ArmFrame {
  const s = f * L, du = s / ARM_STEPS;
  let cx = 0, cy = 0;
  for (let i = 0; i < ARM_STEPS; i++) { const q = Math.min((i + 0.5) * du, L) / L, th = armBend(q, v); cx += Math.cos(th) * du; cy -= Math.sin(th) * du; }
  const q = Math.min(s, L) / L, th = armBend(q, v), rho = BUNDLE_RING * lerp(ARM_R0, ARM_R1, q);
  const T: Vec3Tuple = [Math.cos(th), -Math.sin(th), 0], N: Vec3Tuple = [Math.sin(th), Math.cos(th), 0];
  return { P: [cx + N[0] * rho * Math.sin(a), cy + N[1] * rho * Math.sin(a), rho * Math.cos(a)], T, N };
}

const ARM_RINGS = 20, ARM_RING_VERTICES = 12;
type Ring = readonly [fraction: number, tangentOffset: number, radius: number];

function armRings(v: ArmVariation): Ring[] {
  // Rings along a curved taper (quick thinning near the root, long and slender after), a closed base
  // (inside the head) and a rounded tip cap. The girth swells and thins along the arm, and the tip
  // may slide on past its last ring (a blunt, a pointed or a drawn-out end).
  const rings: Ring[] = [[0, -0.6 * ARM_R0, 0]], tip = ARM_R1 * v.girth, slide = 1 + v.tipSlide;
  for (let k = 0; k <= ARM_RINGS; k++) {
    const f = k / ARM_RINGS, wob = 1 + (0.09 * Math.sin(9 * f + v.wobblePhase) + 0.05 * Math.sin(23 * f + 2 * v.wobblePhase)) * (1 - f * f);
    rings.push([f, 0, (tip + (ARM_R0 * v.girth - tip) * (1 - f) ** v.taper) * wob]);
  }
  for (const ph of [0.6, 1.1, 1.45]) rings.push([1, tip * slide * Math.sin(ph), tip * Math.cos(ph)]);
  rings.push([1, tip * slide, 0]);
  return rings;
}

const verticesInRing = (r: number): number => (r > 0 ? ARM_RING_VERTICES : 1);

/** One arm of the bundle at angle a, length L (ML = 1). */
export function cuttleArmGeometry(a: number, L: number, tentacle: boolean, v: ArmVariation = PLAIN_ARM): THREE.BufferGeometry {
  const RAD = ARM_RING_VERTICES, rings = armRings(v);
  const pos: number[] = [], sec: number[] = [], arm: number[] = [], thin: number[] = [], vary: number[] = [], idx: number[] = [];
  for (const [f, tOff, r] of rings) {
    const { P, T, N } = cuttleArmFrame(f, L, a, v), n = verticesInRing(r);
    // The section is slightly oval, flattening towards the tip by the arm's own amount.
    const flat = lerp(1, v.tipFlat, clamp((f - 0.5) / 0.5, 0, 1));
    for (let j = 0; j < n; j++) {
      const b = (j / RAD) * Math.PI * 2, nO = r * Math.cos(b), zO = r * Math.sin(b) * flat;
      pos.push(P[0] + T[0] * tOff + N[0] * nO, P[1] + T[1] * tOff + N[1] * nO, P[2] + zO);
      sec.push(f, tOff, nO, zO); arm.push(a, L, tentacle ? 1 : 0); thin.push(0.2 + 0.8 * f); vary.push(v.curl, v.kink, v.kinkPhase);
    }
  }
  // indices: the base point, NS + 4 rings of RAD, the tip point
  const ring0 = 1, nr = rings.length - 2, tip = ring0 + nr * RAD;
  for (let j = 0; j < RAD; j++) {
    const j1 = (j + 1) % RAD;
    idx.push(0, ring0 + j1, ring0 + j);
    for (let k = 0; k < nr - 1; k++) { const p0 = ring0 + k * RAD + j, p1 = ring0 + k * RAD + j1; idx.push(p0, p1, p0 + RAD, p1, p1 + RAD, p0 + RAD); }
    idx.push(tip, ring0 + (nr - 1) * RAD + j, ring0 + (nr - 1) * RAD + j1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nrm = g.getAttribute('normal'), an = new Float32Array(nrm.count * 3);
  let vi = 0;
  for (const [f, , r] of rings) {
    const { T, N } = cuttleArmFrame(f, L, a, v);
    for (let j = 0; j < verticesInRing(r); j++, vi++) {
      const x = nrm.getX(vi), y = nrm.getY(vi), z = nrm.getZ(vi);
      an[3 * vi] = x * T[0] + y * T[1]; an[3 * vi + 1] = x * N[0] + y * N[1]; an[3 * vi + 2] = z;
    }
  }
  g.setAttribute('aNrm', new THREE.BufferAttribute(an, 3));
  g.setAttribute('aSec', new THREE.Float32BufferAttribute(sec, 4));
  g.setAttribute('aArm', new THREE.Float32BufferAttribute(arm, 3));
  g.setAttribute('aThin', new THREE.Float32BufferAttribute(thin, 1));
  g.setAttribute('aVar', new THREE.Float32BufferAttribute(vary, 3));
  g.computeBoundingSphere();
  return g;
}

/**
 * The fin skirt's rows across (k: 0 at the mantle's surface, 1 at the edge; the first lies inside the
 * mantle), each on the top surface and again on the bottom, a closed lens-shaped loop.
 */
export const FIN_K: readonly number[] = [-0.25, 0, 0.18, 0.38, 0.58, 0.76, 0.9, 1.0];

/** The skirt's topology; its positions are written each frame (Cuttlefish fins). */
export function finGeometry(finN: number): THREE.BufferGeometry {
  const R = FIN_K.length, per = 2 * R, n = (finN + 1) * per, uv = new Float32Array(n * 2), thin = new Float32Array(n), idx: number[] = [];
  for (let i = 0; i <= finN; i++) for (let j = 0; j < per; j++) {
    const k = FIN_K[j < R ? j : per - 1 - j] ?? 0, o = i * per + j;
    uv[2 * o] = i / finN; uv[2 * o + 1] = clamp(k, 0, 1); thin[o] = 0.3 + 0.7 * clamp(k, 0, 1);
    if (i < finN) { const a = o, b = i * per + (j + 1) % per; idx.push(a, b, a + per, b, b + per, a + per); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aThin', new THREE.BufferAttribute(thin, 1));
  g.setIndex(idx);
  return g;
}
