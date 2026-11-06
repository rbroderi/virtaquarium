// Eyes: the painted iris and pupil, the iridophore ring mask, and the eyeball cap set into the head.
import * as THREE from 'three';
import { clamp, mulberry32, makeCanvas, shade, context2d } from '../util.js';
import type { Species } from '../species/types.js';
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

// Front view of the eye (planar UV): iris stroma with radial fibres, a round pupil about two thirds of
// the iris diameter (the spherical lens fills it), and a faint silvery ring at the pupil margin.
// sp.eye: pupil (radius / eyeball radius), irisR (iris radius / eyeball radius; outside it the eyeball
// shows the iris colour fading into the orbit skin rather than a dark limbus), fleck (melanophores
// around the pupil, e.g. the clownfish's dark inner iris).
export function paintEye(sp: Species): HTMLCanvasElement {
  const N = EYE_TEX, c = makeCanvas(N, N), g = context2d(c), R = N / 2, K = N / TUNED_SIZE;
  const e = sp.eye, rng = mulberry32(sp.id.length * 131 + 7), iris = e.iris;
  const ir = e.irisR ?? DEFAULT_IRIS_RADIUS, pr = e.pupil ?? DEFAULT_PUPIL_RADIUS;
  g.fillStyle = shade(iris, -0.15); g.fillRect(0, 0, N, N);
  const gr = g.createRadialGradient(R, R, R * pr * 0.7, R, R, R * ir);
  gr.addColorStop(0, shade(iris, 0.2)); gr.addColorStop(0.55, iris); gr.addColorStop(0.9, shade(iris, -0.2)); gr.addColorStop(1, shade(iris, -0.35));
  g.fillStyle = gr; g.beginPath(); g.arc(R, R, R * ir, 0, Math.PI * 2); g.fill();
  if (e.fleck) {
    const fr = e.fleckR ?? pr + (ir - pr) * 0.75;
    for (let i = 0; i < FLECKS; i++) {
      const a = rng() * Math.PI * 2, r = R * (pr + (fr - pr) * rng() ** 1.3);
      g.fillStyle = e.fleck; g.globalAlpha = 0.25 + rng() * 0.5;
      g.beginPath(); g.arc(R + Math.cos(a) * r, R + Math.sin(a) * r, (0.8 + rng() * 2) * K, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  }
  for (let i = 0; i < IRIS_FIBRES; i++) {
    const a = rng() * Math.PI * 2, r0 = R * (pr + rng() * 0.08), r1 = R * ir * (0.75 + rng() * 0.2);
    g.strokeStyle = rng() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.1)'; g.lineWidth = (1 + rng() * 1.5) * K;
    g.beginPath(); g.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0); g.lineTo(R + Math.cos(a + 0.05) * r1, R + Math.sin(a + 0.05) * r1); g.stroke();
  }
  g.strokeStyle = 'rgba(220,235,240,0.25)'; g.lineWidth = 2.5 * K;   // guanine ring at the pupil margin
  g.beginPath(); g.arc(R, R, R * (pr + 0.025), 0, Math.PI * 2); g.stroke();
  const pu = g.createRadialGradient(R * 0.94, R * 0.92, 0, R, R, R * pr);
  pu.addColorStop(0, '#0d1820'); pu.addColorStop(0.8, '#03060a'); pu.addColorStop(1, '#000');
  g.fillStyle = pu; g.beginPath(); g.arc(R, R, R * pr, 0, Math.PI * 2); g.fill();
  return c;
}

// Iridescence mask for the eye: the iris' iridophore ring, brightest just outside the pupil and fading
// out across the iris, with radial streaks (same layout as paintEye's texture).
export function paintEyeRing(sp: Species): HTMLCanvasElement {
  const N = EYE_RING_TEX, R = N / 2, e = sp.eye, ir = e.irisR ?? DEFAULT_IRIS_RADIUS, pr = e.pupil ?? DEFAULT_PUPIL_RADIUS;
  const img = new ImageData(N, N), d = img.data, rng = mulberry32(sp.id.length * 17 + 9);
  const streak = Float32Array.from({ length: RING_STREAKS }, () => 0.6 + 0.4 * rng());
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R, r = Math.hypot(dx, dy), o = (y * N + x) * 4;
    const a = ((Math.atan2(dy, dx) / (Math.PI * 2)) + 1) % 1;
    const ring = r < pr ? 0 : Math.exp(-(((r - pr - 0.04) / 0.05) ** 2)) + 0.35 * smooth01((ir - r) / 0.15) * smooth01((r - pr) / 0.05);
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
