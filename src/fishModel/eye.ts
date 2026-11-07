// Eyes: the painted iris and pupil, the iridophore ring mask, and the eyeball cap set into the head.
import * as THREE from 'three';
import { clamp, mulberry32, makeCanvas, rgba, shade, context2d } from '../util.js';
import type { Species } from '../species/types.js';
import { valueNoise, type Field2 } from '../core/organic.js';
import { smooth01, type Profile } from './profile.js';
import { attribute, flankZ } from './section.js';

const EYE_TEX = 512;
const EYE_RING_TEX = 128;
/** Stroke widths below were tuned at this texture size. */
const TUNED_SIZE = 256;
const DEFAULT_IRIS_RADIUS = 0.98;
const DEFAULT_PUPIL_RADIUS = 0.44;
const FLECKS = 900;
const IRIS_FIBRES = 160;
const RING_STREAKS = 64;
// Organic imperfection (core/organic.ts valueNoise): the iris, pupil and rings are not perfect circles;
// their radii wander slowly around the eye, the iris is patchy, and the rings vary in width. The same
// seeded fields are sampled by paintEye and paintEyeRing, so the painted edges and the iridescence mask
// line up.
const TWO_PI = Math.PI * 2;
/** Points around a wobbled circle. */
const EYE_PATH_STEPS = 48;
/** Radius wobble: this many low-frequency cells around the eye. */
const EYE_EDGE_WOBBLE_CELLS = 3;
const EYE_RING_WOBBLE_CELLS = 5;
/** How far each edge wanders, as a fraction of its radius. */
const EYE_EDGE_WOBBLE_AMP_IRIS = 0.04;
const EYE_EDGE_WOBBLE_AMP_PUPIL = 0.06;
/** The guanine ring's centre and width wander by these fractions. */
const EYE_RING_CENTER_VARY = 0.3;
const EYE_RING_WIDTH_VARY = 0.5;
/** Guanine ring inset and base width, as fractions of the eyeball radius. */
const EYE_RING_INSET = 0.025;
const EYE_RING_WIDTH = 0.02;
/** Patchy iris colour: this many soft blotches, each up to this much lighter or darker. */
const EYE_PATCH_BLOTCHES = 14;
const EYE_PATCH_AMP = 0.1;
const EYE_PATCH_ALPHA = 0.35;
/** Edge softening in tuned-size pixels (scaled by K with the stroke widths below). */
const EYE_EDGE_SOFT = 1.5;
const EYE_PUPIL_SOFT = 1.25;
/** The ring mask's pupil boundary softens over this fraction of the eyeball radius. */
const EYE_RING_PUPIL_SOFT = 0.04;
/** Seed for the shared edge wobble fields. */
const EYE_WOBBLE_SEED = { perIdChar: 3079, offset: 23 } as const;

interface EyeWobbles { iris: Field2; pupil: Field2; ring: Field2; ringW: Field2 }

/** Shared seeded radius-wobble fields; a periodic 1D cut through value noise, so there is no seam at 0/360. */
function eyeWobbles(sp: Species): EyeWobbles {
  const rng = mulberry32(sp.id.length * EYE_WOBBLE_SEED.perIdChar + EYE_WOBBLE_SEED.offset);
  return {
    iris: valueNoise(rng, EYE_EDGE_WOBBLE_CELLS, 1, true, true),
    pupil: valueNoise(rng, EYE_EDGE_WOBBLE_CELLS, 1, true, true),
    ring: valueNoise(rng, EYE_RING_WOBBLE_CELLS, 1, true, true),
    ringW: valueNoise(rng, EYE_RING_WOBBLE_CELLS, 1, true, true),
  };
}

// Front view of the eye (planar UV): iris stroma with radial fibres, a pupil about two thirds of the
// iris diameter (the spherical lens fills it), and a faint silvery ring at the pupil margin. The iris,
// pupil and ring edges are wobbled circles (valueNoise radii), the iris colour is patchy, and the ring
// width wanders, so the eye reads as living tissue rather than drawn geometry.
// sp.eye: pupil (radius / eyeball radius), irisR (iris radius / eyeball radius; outside it the eyeball
// shows the iris colour fading into the orbit skin rather than a dark limbus), fleck (melanophores
// around the pupil, e.g. the clownfish's dark inner iris).
export function paintEye(sp: Species): HTMLCanvasElement {
  const N = EYE_TEX, c = makeCanvas(N, N), g = context2d(c), R = N / 2, K = N / TUNED_SIZE;
  const e = sp.eye, rng = mulberry32(sp.id.length * 131 + 7), iris = e.iris;
  const ir = e.irisR ?? DEFAULT_IRIS_RADIUS, pr = e.pupil ?? DEFAULT_PUPIL_RADIUS;
  const wb = eyeWobbles(sp), ang = (a: number): number => a / TWO_PI;
  const irisRAt = (a: number): number => R * ir * (1 + EYE_EDGE_WOBBLE_AMP_IRIS * wb.iris(ang(a), 0.5));
  const pupilRAt = (a: number): number => R * pr * (1 + EYE_EDGE_WOBBLE_AMP_PUPIL * wb.pupil(ang(a), 0.5));
  const path = (rAt: (a: number) => number): void => {
    g.beginPath();
    for (let k = 0; k <= EYE_PATH_STEPS; k++) {
      const a = (k / EYE_PATH_STEPS) * TWO_PI, r = rAt(a), x = R + Math.cos(a) * r, y = R + Math.sin(a) * r;
      if (k === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
  };
  // The eyeball outside the iris shows the iris colour fading into the orbit skin.
  g.fillStyle = shade(iris, -0.15); g.fillRect(0, 0, N, N);
  const gr = g.createRadialGradient(R, R, R * pr * 0.7, R, R, R * ir);
  gr.addColorStop(0, shade(iris, 0.2)); gr.addColorStop(0.55, iris); gr.addColorStop(0.9, shade(iris, -0.2)); gr.addColorStop(1, shade(iris, -0.35));
  g.fillStyle = gr; path(irisRAt); g.fill();
  // Patchy iris colour: soft light and dark blotches clipped to the iris.
  g.save(); path(irisRAt); g.clip();
  for (let i = 0; i < EYE_PATCH_BLOTCHES; i++) {
    const a = rng() * TWO_PI, rr = R * (pr + (ir - pr) * rng() ** 0.6), x = R + Math.cos(a) * rr, y = R + Math.sin(a) * rr, rad = R * (0.06 + rng() * 0.16);
    const bl = g.createRadialGradient(x, y, 0, x, y, rad);
    const col = shade(iris, rng() < 0.5 ? -EYE_PATCH_AMP : EYE_PATCH_AMP);
    bl.addColorStop(0, rgba(col, EYE_PATCH_ALPHA)); bl.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bl; g.fillRect(x - rad, y - rad, rad * 2, rad * 2);
  }
  g.restore();
  // Feather the iris/limbus edge so it is not a ruled boundary.
  g.save(); g.filter = `blur(${EYE_EDGE_SOFT * K}px)`; g.strokeStyle = shade(iris, -0.35); g.lineWidth = EYE_EDGE_SOFT * 2 * K; path(irisRAt); g.stroke(); g.restore();
  if (e.fleck) {
    const fr = e.fleckR ?? pr + (ir - pr) * 0.75;
    for (let i = 0; i < FLECKS; i++) {
      const a = rng() * TWO_PI, r = R * (pr + (fr - pr) * rng() ** 1.3);
      g.fillStyle = e.fleck; g.globalAlpha = 0.25 + rng() * 0.5;
      g.beginPath(); g.arc(R + Math.cos(a) * r, R + Math.sin(a) * r, (0.8 + rng() * 2) * K, 0, TWO_PI); g.fill();
    }
    g.globalAlpha = 1;
  }
  for (let i = 0; i < IRIS_FIBRES; i++) {
    const a = rng() * TWO_PI, r0 = R * (pr + rng() * 0.08), r1 = R * ir * (0.75 + rng() * 0.2);
    g.strokeStyle = rng() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.1)'; g.lineWidth = (1 + rng() * 1.5) * K;
    g.beginPath(); g.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0); g.lineTo(R + Math.cos(a + 0.05) * r1, R + Math.sin(a + 0.05) * r1); g.stroke();
  }
  // Guanine ring at the pupil margin: a soft band whose inset and width wander around the eye.
  {
    const ringInner = (a: number): number => pupilRAt(a) + R * EYE_RING_INSET * (1 + EYE_RING_CENTER_VARY * wb.ring(ang(a), 0.5));
    const ringOuter = (a: number): number => ringInner(a) + R * EYE_RING_WIDTH * (1 + EYE_RING_WIDTH_VARY * wb.ringW(ang(a), 0.5));
    g.save(); g.filter = `blur(${EYE_EDGE_SOFT * K}px)`; g.fillStyle = 'rgba(220,235,240,0.25)';
    path(ringOuter); g.fill();
    g.globalCompositeOperation = 'destination-out';
    path(ringInner); g.fill();
    g.restore();
  }
  const pu = g.createRadialGradient(R * 0.94, R * 0.92, 0, R, R, R * pr);
  pu.addColorStop(0, '#0d1820'); pu.addColorStop(0.8, '#03060a'); pu.addColorStop(1, '#000');
  g.fillStyle = pu; g.save(); g.filter = `blur(${EYE_PUPIL_SOFT * K}px)`; path(pupilRAt); g.fill(); g.restore();
  return c;
}

// Iridescence mask for the eye: the iris' iridophore ring, brightest just outside the pupil and fading
// out across the iris, with radial streaks (same layout as paintEye's texture, same wobbled radii).
export function paintEyeRing(sp: Species): HTMLCanvasElement {
  const N = EYE_RING_TEX, R = N / 2, e = sp.eye, ir = e.irisR ?? DEFAULT_IRIS_RADIUS, pr = e.pupil ?? DEFAULT_PUPIL_RADIUS;
  const img = new ImageData(N, N), d = img.data, rng = mulberry32(sp.id.length * 17 + 9);
  const streak = Float32Array.from({ length: RING_STREAKS }, () => 0.6 + 0.4 * rng());
  const wb = eyeWobbles(sp);
  // Here `a` is already the normalised angle fraction (0..1), unlike paintEye's radians.
  const irisRAt = (a: number): number => ir * (1 + EYE_EDGE_WOBBLE_AMP_IRIS * wb.iris(a, 0.5));
  const pupilRAt = (a: number): number => pr * (1 + EYE_EDGE_WOBBLE_AMP_PUPIL * wb.pupil(a, 0.5));
  const ringC = (a: number): number => pupilRAt(a) + EYE_RING_INSET * (1 + EYE_RING_CENTER_VARY * wb.ring(a, 0.5));
  const ringW = (a: number): number => EYE_RING_WIDTH * (1 + EYE_RING_WIDTH_VARY * wb.ringW(a, 0.5));
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R, r = Math.hypot(dx, dy), o = (y * N + x) * 4;
    const a = ((Math.atan2(dy, dx) / TWO_PI) + 1) % 1;
    const ring = smooth01((r - pupilRAt(a)) / EYE_RING_PUPIL_SOFT)
      * (Math.exp(-(((r - ringC(a)) / ringW(a)) ** 2)) + 0.35 * smooth01((irisRAt(a) - r) / 0.15));
    d[o] = d[o + 1] = d[o + 2] = clamp(ring * (streak[Math.floor(a * RING_STREAKS)] ?? 0), 0, 1) * 255; d[o + 3] = 255;
  }
  const c = makeCanvas(N, N); context2d(c).putImageData(img, 0, 0);
  return c;
}

// Eyeball geometry already placed in fish space (so the swim shader moves it with the head).
export function eyeGeometry(prof: Profile, sp: Species, side: number): THREE.BufferGeometry {
  const e = sp.eye, geo = new THREE.SphereGeometry(1, 32, 20);
  const p = attribute(geo, 'position'), uv = attribute(geo, 'uv');
  for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 - p.getX(i) * 0.5, 0.5 + p.getY(i) * 0.5);   // planar, looking along +z
  const ex = prof.x(e.u), ey = prof.centre(e.u) - e.v * prof.half(e.u);
  const zAt = (u: number, v: number): number => flankZ(sp, prof, u, v);
  const ez = zAt(e.u, e.v);
  // The cornea sits nearly flush with the head (only the lens bulges a little), so the eyeball is a
  // shallow cap just proud of the socket, turned to the head's surface there: the head narrows towards
  // the snout and rounds over at the top, and a cap facing straight out would stand proud at its front
  // and upper edges (bug eyes, head-on).
  const du = 0.01, dv = 0.02, len = sp.body.len;
  const dzdx = (zAt(e.u + du, e.v) - zAt(e.u - du, e.v)) / (2 * du) / -len;
  const dzdy = (zAt(e.u, e.v + dv) - zAt(e.u, e.v - dv)) / (2 * dv) / -Math.max(prof.half(e.u), 1e-3);
  // The surface normal in the cap's own frame (the left cap is the right one turned half round y).
  const n = new THREE.Vector3(-dzdx * side, -dzdy, 1).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const m = new THREE.Matrix4().makeTranslation(ex, ey, side * ez * 0.96)
    .multiply(new THREE.Matrix4().makeRotationY(side > 0 ? 0 : Math.PI))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeScale(e.r, e.r, e.r * 0.3));
  geo.applyMatrix4(m);
  // Which eye (+1 right, -1 left): the gaze shader moves the iris forward on both.
  geo.setAttribute('eyeSide', new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(side), 1));
  return geo;
}
