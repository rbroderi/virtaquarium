// The reef's non-fish animals: common cuttlefish, day octopus and a juvenile green turtle.
//
// Each is its own model and behaviour (they don't swim like fish), lit by the same materials as the
// reef (addCaustics: caustics and the baked reef light), so they sit in the tank's light. They live in
// World.critters: fish keep their distance from them, and small fish treat the two cephalopods as
// predators. References: pc/ref/cuttlefish, pc/ref/octopus, pc/ref/turtle (CREDITS.md in each).
//
// Frame: like the fish, +x is forward, +y up; yaw turns about y (heading (cos yaw, 0, sin yaw)).
import * as THREE from 'three';
import { addCaustics } from './water.js';
import { addTranslucency } from './softSkin.js';
import { range, clamp, lerp, wrapAngle, makeCanvas, mulberry32, Noise } from './util.js';

// The blended (distance-field) bodies, meshed offline by tools/softbodies.mjs into
// pc/models/critters/*.glb (shapes: softBodies.js), loaded once here before any critter is made
// (a top-level await: main.js waits for it). A missing file is meshed in the page instead (slow, a
// second or so each), with a warning.
function readGLB(buf) {   // one indexed mesh of float attributes, as sdfMesh.js writeGLB writes it
  const dv = new DataView(buf), jl = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl))), bin = 20 + jl + 8;
  const get = (a) => {
    const acc = json.accessors[a], view = json.bufferViews[acc.bufferView], size = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
    const T = acc.componentType === 5126 ? Float32Array : acc.componentType === 5123 ? Uint16Array : Uint32Array;
    return { array: new T(buf.slice(bin + view.byteOffset, bin + view.byteOffset + view.byteLength)), size };
  };
  const prim = json.meshes[0].primitives[0], attributes = {};
  for (const [name, a] of Object.entries(prim.attributes)) attributes[name] = get(a);
  return { attributes, index: get(prim.indices).array };
}
const SOFT = {};
{
  const t0 = performance.now();
  await Promise.all(['octopus-body', 'cuttlefish-body'].map(async (name) => {
    let m;
    try {
      const r = await fetch(new URL(`../models/critters/${name}.glb`, import.meta.url));
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      m = readGLB(await r.arrayBuffer());
    } catch (e) {
      console.warn(`critters: pc/models/critters/${name}.glb not loaded (${e.message}); meshing it here instead (node tools/softbodies.mjs writes it)`);
      m = (await import('./softBodies.js')).SOFT_BODIES[name]();
    }
    const g = new THREE.BufferGeometry(), A = m.attributes;
    g.setAttribute('position', new THREE.BufferAttribute(A.POSITION.array, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(A.NORMAL.array, 3));
    if (A.TEXCOORD_0) g.setAttribute('uv', new THREE.BufferAttribute(A.TEXCOORD_0.array, 2));
    g.setAttribute('aWeight', new THREE.BufferAttribute(A._WEIGHT.array, 1));
    g.setIndex(new THREE.BufferAttribute(m.index, 1));
    g.computeBoundingSphere();
    SOFT[name] = g;
  }));
  console.info(`Soft bodies: ${Object.entries(SOFT).map(([k, g]) => `${k} ${g.index.count / 3} tris`).join(', ')}, ${(performance.now() - t0).toFixed(0)} ms`);
}

export const CRITTER_SPECIES = [
  {
    id: 'cuttlefish', name: 'Common Cuttlefish', sci: 'Sepia officinalis', habitat: 'reef', count: 1,
    fact: 'Changes colour in a fraction of a second; hunts by stealth, then shoots out two long tentacles.',
    radius: 0.7, predator: true,
  },
  {
    id: 'octopus', name: 'Day Octopus', sci: 'Octopus cyanea', habitat: 'reef', count: 1,
    fact: 'Hunts by day, crawling over the reef and changing colour and skin texture as it goes.',
    radius: 0.8, predator: true,
  },
  {
    id: 'turtle', name: 'Green Sea Turtle (juvenile)', sci: 'Chelonia mydas', habitat: 'reef', count: 1,
    fact: 'Flies through the water with its long front flippers and comes up every few minutes to breathe.',
    radius: 1.1,
  },
];

const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _q = new THREE.Quaternion(), _e = new THREE.Euler(0, 0, 0, 'YZX');
const _mInv = new THREE.Matrix4();

// A damped spring, s = { x, v } pulled towards target (natural frequency hz, damping ratio zeta).
function spring(s, target, hz, zeta, dt) {
  const w = 2 * Math.PI * hz, n = Math.ceil(dt * hz * 8), h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (w * w * (target - s.x) - 2 * zeta * w * s.v) * h; s.x += s.v * h; }
  return s.x;
}

function canvasTexture(c, srgb = true) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// A reef-lit material with an optional shader hook; key keeps three.js from sharing the program with
// a plain material of the same parameters. sss: light through the skin for the soft bodies
// (softSkin.js options: wrap, back, tint, thin), null for the turtle's horn and scales.
function skin(opts, key, hook = null, sss = null) {
  const m = new THREE.MeshStandardMaterial(opts);
  if (hook) m.onBeforeCompile = hook;
  m.customProgramCacheKey = () => key;
  addCaustics(m);
  return sss ? addTranslucency(m, sss) : m;
}
const CEPH_SSS = { wrap: 0.45, back: 0.7, tint: [1.0, 0.45, 0.35], thin: 0.15 };   // red-brown cephalopod tissue

// Shared steering for animals that swim freely: turn-rate-limited yaw and pitch towards a target,
// climbing over reef that lies ahead, kept inside the tank.
class Swimmer {
  constructor(pos, yaw) {
    this.pos = pos; this.yaw = yaw; this.pitch = 0; this.roll = 0; this.speed = 0;
    this.dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  }
  steer(dt, world, target, { turn, speed, accel, clearance, look = 1.5, reverse = false }) {
    _v.subVectors(target, this.pos);
    const flat = Math.hypot(_v.x, _v.z);
    let yawT = Math.atan2(_v.z, _v.x);
    if (reverse) yawT = wrapAngle(yawT + Math.PI);   // back towards the target (cuttlefish swim backwards)
    let pitchT = clamp(Math.atan2(_v.y, Math.max(flat, 0.3)) * (reverse ? -1 : 1), -0.45, 0.45);
    const s = Math.sign(this.speed || 1);
    const ahead = world.reefHeight(this.pos.x + this.dir.x * look * s, this.pos.z + this.dir.z * look * s) + clearance;
    if (this.pos.y < ahead) pitchT = Math.max(pitchT, 0.35 * s);
    const dy = wrapAngle(yawT - this.yaw);
    const rate = clamp(dy * 1.5, -turn, turn);
    this.yaw = wrapAngle(this.yaw + rate * dt);
    this.roll = lerp(this.roll, -rate * 0.25, Math.min(1, dt * 2));
    this.pitch = lerp(this.pitch, pitchT, Math.min(1, dt * 1.2));
    this.speed = lerp(this.speed, speed, Math.min(1, dt * accel));
    const cp = Math.cos(this.pitch);
    this.dir.set(Math.cos(this.yaw) * cp, Math.sin(this.pitch), Math.sin(this.yaw) * cp);
    this.pos.addScaledVector(this.dir, this.speed * dt);
    const B = world.bounds;
    this.pos.x = clamp(this.pos.x, B.x0, B.x1);
    this.pos.z = clamp(this.pos.z, B.z0, B.z1);
    this.pos.y = clamp(this.pos.y, Math.max(B.y0, world.reefHeight(this.pos.x, this.pos.z) + clearance * 0.6), B.y1);
    return flat;
  }
  place(model) {
    model.position.copy(this.pos);
    model.rotation.copy(_e.set(this.roll, -this.yaw, this.pitch, 'YZX'));
  }
}

const randomTarget = (rng, world, lo, hi) => {
  const B = world.bounds, x = range(rng, B.x0 + 1.5, B.x1 - 1.5), z = range(rng, B.z0 + 0.6, B.z1 - 0.8);
  return new THREE.Vector3(x, Math.max(world.reefHeight(x, z) + lo, range(rng, lo, hi)), z);
};

// Underside of a cave roof over (x, z), or Infinity in the open (roofs overhang, so the height field
// doesn't hold them: see reef.js caves[].roof).
function ceilingAt(world, x, z) {
  const r = world.roofAt(x, z);
  return r ? r.y : Infinity;
}
// Floor for things lying on the bottom. The height field holds the cave roof's top, dilated for the
// fishes' clearance, so just outside the mouth (open sand under the overhang's edge) it reads as rock;
// there the floor is the cave's own ground.
function floorAt(world, x, z) {
  for (const c of world.reef.caves || []) {
    const r = c.roof;
    if (!r) continue;
    const dx = x - c.x, dz = z - c.z, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
    const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
    if (Math.abs(lx) < r.hx && lz > r.z1 - 0.15 && lz < r.z1 + 0.8) return Math.min(world.reefHeight(x, z), c.ground);
  }
  return world.reefHeight(x, z);
}

// A big, fast animal close by (the turtle, a lionfish, a chasing fish) startles the cephalopods.
function threatNear(me, world, r) {
  for (const o of world.critters) if (o !== me && !o.sp.predator && o.pos.distanceTo(me.pos) < r + o.radius) return o;
  for (const f of world.fish) if (f.size > 1.0 && f.speed > f.size * 0.6 && f.pos.distanceTo(me.pos) < r) return f;
  return null;
}

// =====================================================================================================
// Common cuttlefish
// =====================================================================================================
//
// Mantle 1.0-1.3 units (13-16 cm). A flattened oval mantle with a fin skirt round its whole edge that
// carries waves (forward or backward: they hover, cruise and swim backwards on the fins alone), a broad
// head with W-shaped pupils, eight short arms held together in a point. The dorsal mantle shows the
// zebra display of the reference photos (dark brown bars with white between), a row of white spots
// along the fin base and a pale belly; when hunting, dark "passing clouds" sweep forward over the back,
// and resting on the sand it turns mottled.

function cuttleSkin(rng) {
  const W = 1024, H = 512, c = makeCanvas(W, H), g = c.getContext('2d'), n = new Noise(rng);
  // u (x) round the mantle: 0.75 dorsal, 0.25 ventral, 0 / 0.5 the sides. v (y) tail (0) to head (1).
  const img = g.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const u = x / W, v = y / H, dd = Math.min(Math.abs(u - 0.75), 1 - Math.abs(u - 0.75)) * 2;   // 0 dorsal .. 1 ventral
    const dors = clamp((0.55 - dd) / 0.25, 0, 1);
    // Zebra: wavy transverse bars across the back.
    const wob = (n.fbm(u * 6, v * 5, 3) - 0.5) * 2.2 + Math.sin((u - 0.75) * 30) * 0.15;
    const bar = Math.sin((v * 22 + wob) * Math.PI);
    let r = 232, gg = 222, b = 212;                         // pale belly
    const brown = [128, 74, 52], dark = [62, 26, 16], white = [236, 228, 218];
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
  for (const u0 of [0.093, 0.407]) {
    for (let i = 0; i < 70; i++) { g.beginPath(); g.arc(u0 * W + range(rng, -4, 4), (0.05 + 0.9 * i / 70) * H, range(rng, 1.5, 2.6), 0, 7); g.fill(); }
  }
  return canvasTexture(c);
}

// Mantle half-width (per unit mantle length) from the tail (t 0) to the head end (1). From the side
// photos (carvalho_side.jpg): nearly parallel-sided, a blunt rounded tail, and still almost full depth
// at the front opening the head sits in (a superellipse, deepest at 0.6), 0.29 ML deep and ~0.48 ML
// wide (delso_arrabida.jpg, from above).
const mantleR = (t) => { const s = t < 0.6 ? (0.6 - t) / 0.6 : ((t - 0.6) / 0.4) * 0.7; return 0.24 * Math.cbrt(Math.max(0, 1 - s ** 3)); };

// The fin skirt: translucent, with dense white dots that crowd towards its edge.
function cuttleFinTex(rng) {
  const W = 512, H = 64, c = makeCanvas(W, H), g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, H);
  gr.addColorStop(0, 'rgb(120,78,70)'); gr.addColorStop(1, 'rgb(150,136,140)');
  g.fillStyle = gr; g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(250,248,240,0.9)';
  for (let i = 0; i < 1400; i++) {
    const y = H * Math.sqrt(rng());   // more towards the edge (v = 1)
    g.beginPath(); g.arc(rng() * W, y, range(rng, 0.6, 1.3), 0, 7); g.fill();
  }
  return canvasTexture(c);
}

function wPupilEye(rng) {
  const s = 128, c = makeCanvas(s, s), g = c.getContext('2d');
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
const CUTTLE_ARM_GLSL = /* glsl */`
attribute vec4 aSec;
attribute vec3 aArm, aNrm;
uniform float uExt;
void cuttleArm(out vec3 P, out vec3 Nrm) {
  float tent = aArm.z, L = aArm.y, ext = 1.0 + tent * (uExt - 1.0), s = aSec.x * L * ext;
  float curl = 0.7 * (1.0 - tent * clamp((ext - 1.0) / 0.4, 0.0, 1.0));
  vec2 c = vec2(0.0);
  float du = s / ${ARM_STEPS}.0;
  for (int i = 0; i < ${ARM_STEPS}; i++) { float q = min((float(i) + 0.5) * du, L) / L, th = curl * q * q; c += vec2(cos(th), -sin(th)) * du; }
  float q = min(s, L) / L, th = curl * q * q;
  vec3 T = vec3(cos(th), -sin(th), 0.0), N = vec3(sin(th), cos(th), 0.0), Z = vec3(0.0, 0.0, 1.0);
  float rho = 3.4 * mix(${ARM_R0}, ${ARM_R1}, q);
  P = vec3(c, 0.0) + N * (rho * sin(aArm.x) + aSec.z) + Z * (rho * cos(aArm.x) + aSec.w) + T * aSec.y;
  Nrm = T * aNrm.x + N * aNrm.y + Z * aNrm.z;
}
`;
// The same line on the CPU (ext 1), for the rest pose the geometry is built in.
function cuttleArmFrame(f, L, a) {
  const s = f * L, curl = 0.7, du = s / ARM_STEPS;
  let cx = 0, cy = 0;
  for (let i = 0; i < ARM_STEPS; i++) { const q = Math.min((i + 0.5) * du, L) / L, th = curl * q * q; cx += Math.cos(th) * du; cy -= Math.sin(th) * du; }
  const q = Math.min(s, L) / L, th = curl * q * q, rho = 3.4 * lerp(ARM_R0, ARM_R1, q);
  const T = [Math.cos(th), -Math.sin(th), 0], N = [Math.sin(th), Math.cos(th), 0];
  return { P: [cx + N[0] * rho * Math.sin(a), cy + N[1] * rho * Math.sin(a), rho * Math.cos(a)], T, N };
}
function cuttleArmGeometry(a, L, tentacle) {
  // Rings along a curved taper (quick thinning near the root, long and slender after), a closed base
  // (inside the head) and a rounded tip cap.
  const NS = 20, RAD = 12, rings = [[0, -0.6 * ARM_R0, 0]];   // [fraction, tangent offset, radius]
  for (let k = 0; k <= NS; k++) { const f = k / NS; rings.push([f, 0, ARM_R1 + (ARM_R0 - ARM_R1) * (1 - f) ** 1.4]); }
  for (const ph of [0.6, 1.1, 1.45]) rings.push([1, ARM_R1 * Math.sin(ph), ARM_R1 * Math.cos(ph)]);
  rings.push([1, ARM_R1, 0]);
  const pos = [], sec = [], arm = [], thin = [], idx = [];
  for (const [f, tOff, r] of rings) {
    const { P, T, N } = cuttleArmFrame(f, L, a), n = r > 0 ? RAD : 1;
    for (let j = 0; j < n; j++) {
      const b = (j / RAD) * Math.PI * 2, nO = r * Math.cos(b), zO = r * Math.sin(b);
      pos.push(P[0] + T[0] * tOff + N[0] * nO, P[1] + T[1] * tOff + N[1] * nO, P[2] + zO);
      sec.push(f, tOff, nO, zO); arm.push(a, L, tentacle ? 1 : 0); thin.push(0.2 + 0.8 * f);
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
  const nrm = g.attributes.normal, an = new Float32Array(nrm.count * 3);
  let v = 0;
  for (const [f, , r] of rings) {
    const { T, N } = cuttleArmFrame(f, L, a);
    for (let j = 0; j < (r > 0 ? RAD : 1); j++, v++) {
      const x = nrm.getX(v), y = nrm.getY(v), z = nrm.getZ(v);
      an[3 * v] = x * T[0] + y * T[1]; an[3 * v + 1] = x * N[0] + y * N[1]; an[3 * v + 2] = z;
    }
  }
  g.setAttribute('aNrm', new THREE.BufferAttribute(an, 3));
  g.setAttribute('aSec', new THREE.Float32BufferAttribute(sec, 4));
  g.setAttribute('aArm', new THREE.Float32BufferAttribute(arm, 3));
  g.setAttribute('aThin', new THREE.Float32BufferAttribute(thin, 1));
  g.computeBoundingSphere();
  return g;
}

// The fin skirt's rows across (k: 0 at the mantle's surface, 1 at the edge; the first lies inside the
// mantle), each on the top surface and again on the bottom, a closed lens-shaped loop.
const FIN_K = [-0.25, 0, 0.18, 0.38, 0.58, 0.76, 0.9, 1.0];
function finGeometry(finN) {
  const R = FIN_K.length, per = 2 * R, n = (finN + 1) * per, uv = new Float32Array(n * 2), thin = new Float32Array(n), idx = [];
  for (let i = 0; i <= finN; i++) for (let j = 0; j < per; j++) {
    const k = FIN_K[j < R ? j : per - 1 - j], o = i * per + j;
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

export class Cuttlefish {
  constructor(sp, rng, world) {
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
    const ML = this.ML = range(rng, 1.0, 1.3);
    this.model = new THREE.Group();
    this.u = { uTime: { value: 0 }, uCloud: { value: 0 }, uMottle: { value: 0 }, uPale: { value: 0 }, uSqueeze: { value: new THREE.Vector3(1, 1, 1) }, uExt: { value: 1 } };
    const hook = (shader) => {
      Object.assign(shader.uniforms, this.u);
      // The mantle and head are one mesh (softBodies.js): the mantle's share (aWeight) squeezes in a
      // jet, about the head end, and the head takes its own colour.
      shader.vertexShader = 'uniform vec3 uSqueeze;\nattribute float aWeight;\nvarying float vMantle;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed *= mix(vec3(1.0), uSqueeze, aWeight);
        vMantle = aWeight;`);
      shader.fragmentShader = 'uniform float uTime, uCloud, uMottle, uPale;\nvarying float vMantle;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        {
          float dors = smoothstep(0.35, 0.0, min(abs(vMapUv.x - 0.75), 1.0 - abs(vMapUv.x - 0.75)));
          diffuseColor.rgb = mix(vec3(0.3, 0.16, 0.11) * (1.1 - 0.35 * dors), diffuseColor.rgb, smoothstep(0.15, 0.7, vMantle));   // the head
          float cloud = smoothstep(0.55, 0.95, sin(vMapUv.y * 18.0 - uTime * 3.0 + sin(vMapUv.x * 30.0) * 0.6));
          float mott = smoothstep(0.4, 0.7, fract(sin(dot(floor(vec2(fract(vMapUv.x), vMapUv.y) * vec2(60.0, 40.0)), vec2(12.9898, 78.233))) * 43758.5453));
          diffuseColor.rgb *= 1.0 - dors * (uCloud * 0.55 * cloud + uMottle * 0.35 * mott);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.78, 0.74), uPale * 0.6);
        }`);
    };
    const skinTex = cuttleSkin(rng);
    skinTex.wrapS = THREE.RepeatWrapping;   // the seam's own vertices run on past u = 1
    const mantleMat = skin({ map: skinTex, roughness: 0.45, metalness: 0 }, 'cuttle-mantle', hook, CEPH_SSS);

    // Mantle, head, eye bulges and the arm crown: one blended mesh (built for ML = 1).
    const body = new THREE.Mesh(SOFT['cuttlefish-body'], mantleMat);
    body.scale.setScalar(ML);
    body.castShadow = true;
    body.name = 'mantle';
    this.model.add(body);
    this.mantle = body;
    this.sArmY = { x: 0, v: 0 }; this.sArmZ = { x: 0, v: 0 }; this.sSqueeze = { x: 0, v: 0 };
    // Eyes (in their bulges on the head).
    const eyeMat = skin({ map: wPupilEye(rng), roughness: 0.15 }, 'cuttle-eye');
    for (const s of [1, -1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06 * ML, 20, 14), eyeMat);
      eye.position.set(0.09 * ML, 0.065 * ML, s * 0.14 * ML);   // set high on the head
      eye.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      eye.name = `eye${s > 0 ? 0 : 1}`;
      this.model.add(eye);
    }
    // Arms: eight thick, tapering arms held together in a bundle, angled forward and down with the
    // tips curling under; pale below (the photos).
    // Built once, in the rest pose, and bent in the vertex shader (cuttleArm): a tentacle's strike is
    // the uExt uniform, so nothing is rebuilt per frame.
    const armMat = skin({ color: 0xd2bcae, roughness: 0.5 }, 'cuttle-arm', (shader) => {
      shader.uniforms.uExt = this.u.uExt;
      shader.vertexShader = CUTTLE_ARM_GLSL + shader.vertexShader
        .replace('#include <beginnormal_vertex>', `vec3 armP, objectNormal;
          cuttleArm(armP, objectNormal);`)
        .replace('#include <begin_vertex>', 'vec3 transformed = armP;');
    }, { ...CEPH_SSS, thin: 'attr' });
    // A crown on the front of the head carries them. The bundle bends as one (rigid in section, so
    // the arms never cross): each arm keeps its place in a ring about the bundle's centre line, the
    // ring narrowing with the arms' taper so neighbours stay just apart to the tips. Two of the upper
    // arms stand in for the tentacles: on a strike they straighten and shoot out ahead, clear above
    // the rest as those curl under.
    this.crown = new THREE.Group();
    this.crown.position.set(0.19 * ML, -0.03 * ML, 0);
    this.model.add(this.crown);
    this.arms = [];
    const t0 = performance.now();
    for (let i = 0; i < 8; i++) {
      const tentacle = i === 1 || i === 3;
      const arm = new THREE.Mesh(cuttleArmGeometry((i / 8) * Math.PI * 2, 0.27 * (tentacle ? 0.85 : 1), tentacle), armMat);
      arm.scale.setScalar(ML);   // (built for ML = 1)
      arm.frustumCulled = false;   // a strike reaches well past the rest pose's bounds
      arm.name = `arm${i}`;
      this.crown.add(arm);
      this.arms.push(arm);
    }
    // Fin skirt: along each side of the mantle, a thick strip with a lens-shaped section that thins to
    // a translucent edge; its root row lies inside the mantle, so it grows out of it. Waved on the CPU
    // each frame (_fins).
    this.finN = 48;
    const finTex = cuttleFinTex(rng);
    this.fins = [1, -1].map((side) => {
      const mesh = new THREE.Mesh(finGeometry(this.finN), skin({ map: finTex, roughness: 0.5, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }, 'cuttle-fin', null, { ...CEPH_SSS, back: 1.0, thin: 'attr' }));
      mesh.userData.side = side; mesh.name = `fin${side > 0 ? 0 : 1}`;
      this.model.add(mesh);
      return mesh;
    });
    this.finPhase = 0;
    this.buildMs = performance.now() - t0;
    // Where parts are attached (and may run into each other): critterCheck.js.
    this.joins = [['eye*', 'mantle'], ['arm*', 'mantle'], ['fin*', 'mantle']];

    const B = world.bounds;
    this.body = new Swimmer(new THREE.Vector3(range(rng, B.x0 + 2, B.x1 - 2), range(rng, 1.8, 4.5), range(rng, -1, 1.5)), range(rng, -3, 3));
    this.pos = this.body.pos;
    this.mode = 'hover'; this.modeT = 0; this.target = this.pos.clone();
    this.jet = 0;
  }

  _fins(dt, speed) {
    // Waves run tail-wards to go forward, head-wards to back up; amplitude and rate grow with speed.
    const ML = this.ML, dirn = speed >= 0 ? 1 : -1, a = 0.035 * ML + Math.abs(speed) * 0.03 * ML;
    const ms = this.u.uSqueeze.value;   // the skirt's root follows the mantle as it squeezes
    this.finPhase += dt * (3 + Math.abs(speed) * 6) * dirn;
    const R = FIN_K.length;
    for (const f of this.fins) {
      const p = f.geometry.attributes.position, side = f.userData.side;
      // the section's normal (across the skirt x along it), for the lens thickness
      const ny = 1 / Math.hypot(1, 0.4), nz = 0.4 * side * ny;
      for (let i = 0; i <= this.finN; i++) {
        const t = i / this.finN, x = -ML * (0.04 + 0.94 * t);                   // head -> tail
        const half = mantleR(0.96 - 0.94 * t) * ML;
        const w = 0.085 * ML * Math.sin(Math.PI * Math.min(1, t * 1.02 + 0.02)) ** 0.2;   // even width, full length
        for (let j = 0; j < R; j++) {
          // The base runs along the lower flank (a third of the way down, where the mantle is ~0.84
          // of its width) and the skirt droops, so from the side it shows as a band below the bars.
          // Rows from the root (k < 0: inside the mantle) out to the edge (k 1), on the top surface
          // then back along the bottom one.
          const k = FIN_K[j], kk = Math.max(0, k), y = Math.sin(this.finPhase + t * 9) * a * kk * kk;
          const th = 0.5 * 0.022 * ML * (1 - kk) ** 0.6 * (0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.03)) ** 0.5);
          const X = x * ms.x, Y = y - 0.62 * 0.55 * half * ms.y - 0.4 * w * k, Z = side * (half * 0.82 * ms.z + w * k);
          p.setXYZ(i * 2 * R + j, X, Y + ny * th, Z + nz * th);
          p.setXYZ(i * 2 * R + 2 * R - 1 - j, X, Y - ny * th, Z - nz * th);
        }
      }
      p.needsUpdate = true;
      f.geometry.computeVertexNormals();
      f.geometry.computeBoundingSphere();
    }
  }

  update(dt, world) {
    this.modeT -= dt;
    this.u.uTime.value += dt;
    const rng = this.rng, b = this.body;
    // Startle: jet away backwards, going pale.
    this.calm = (this.calm || 0) - dt;   // after a jet it stays put a while before it can startle again
    const threat = this.calm <= 0 && this.mode !== 'jet' ? threatNear(this, world, 1.6) : null;
    if (threat) {
      this.mode = 'jet'; this.modeT = 1.4; this.jet = 1; this.calm = 12;
      this.target.copy(this.pos).addScaledVector(_v.subVectors(this.pos, threat.pos).setY(0).normalize(), 3);
    }
    // Food: stalk, then strike with the tentacles.
    let food = null;
    if (this.mode !== 'jet') {
      let best = 3.5;
      for (const f of world.food) if (!f.eaten) { const d = f.pos.distanceTo(this.pos); if (d < best) { best = d; food = f; } }
      if (food && this.mode !== 'hunt') { this.mode = 'hunt'; this.modeT = 20; }
    }
    if (this.modeT <= 0) {
      const r = rng();
      this.mode = r < 0.4 ? 'hover' : r < 0.85 ? 'cruise' : 'rest';
      this.modeT = this.mode === 'rest' ? range(rng, 25, 50) : range(rng, 8, 18);
      this.reverse = this.mode === 'cruise' && rng() < 0.3;
      this.target = this.mode === 'rest'
        ? (() => { const t = randomTarget(rng, world, 0, 0); t.y = world.reefHeight(t.x, t.z) + 0.12 * this.ML; return t; })()
        : this.mode === 'hover' ? this.pos.clone().add(new THREE.Vector3(range(rng, -0.5, 0.5), range(rng, -0.2, 0.2), range(rng, -0.3, 0.3)))
          : randomTarget(rng, world, 1.2, 5);
    }
    const cl = 0.25 * this.ML;
    let speed = 0;
    if (this.mode === 'jet') { speed = -2.2 * this.jet; this.jet = Math.max(0, this.jet - dt * 0.9); if (this.modeT <= 0) this.mode = 'hover'; }
    else if (this.mode === 'hunt' && food) {
      this.target.copy(food.pos);
      const d = this.pos.distanceTo(food.pos);
      speed = d > 0.6 ? 0.35 : 0.08;
      if (d < 0.5 * this.ML + 0.2) { food.eaten = true; this.strike = 0.4; }
    } else if (this.mode === 'hunt') this.modeT = 0;
    else if (this.mode === 'cruise') speed = this.reverse ? -0.3 : 0.4;
    else if (this.mode === 'rest') speed = this.pos.distanceTo(this.target) > 0.3 ? 0.25 : 0;
    else speed = 0.05;
    const yaw0 = b.yaw, pitch0 = b.pitch;
    b.steer(dt, world, this.target, { turn: 0.9, speed, accel: this.mode === 'jet' ? 6 : 1.2, clearance: cl, reverse: speed < 0 });
    if (this.mode === 'rest' && this.pos.distanceTo(this.target) < 0.4) b.pitch = lerp(b.pitch, 0, dt);
    // Secondary motion: the arm bundle swings behind a turn or a pitch change and settles (soft
    // springs), and the mantle squeezes as it jets.
    const yawRate = wrapAngle(b.yaw - yaw0) / Math.max(dt, 1e-4), pitchRate = (b.pitch - pitch0) / Math.max(dt, 1e-4);
    const armY = spring(this.sArmY, clamp(yawRate * 0.5, -0.35, 0.35), 1.2, 0.35, dt);
    const armZ = spring(this.sArmZ, clamp(-pitchRate * 0.4, -0.3, 0.3), 1.2, 0.35, dt);
    const squeeze = spring(this.sSqueeze, this.mode === 'jet' ? this.jet : 0, 3, 0.4, dt);
    this.u.uSqueeze.value.set(1 + 0.04 * squeeze, 1 - 0.14 * squeeze, 1 - 0.05 * squeeze);   // fins sit on the edge: keep the width

    // Skin: passing clouds while hunting, mottled at rest, pale in a jet.
    const U = this.u;
    U.uCloud.value = lerp(U.uCloud.value, this.mode === 'hunt' ? 1 : 0, Math.min(1, dt * 2));
    U.uMottle.value = lerp(U.uMottle.value, this.mode === 'rest' ? 1 : 0, Math.min(1, dt * 0.8));
    U.uPale.value = lerp(U.uPale.value, this.mode === 'jet' ? 1 : 0, Math.min(1, dt * 5));
    // Arms: sway together; the two tentacles flick out on a strike.
    this.strike = Math.max(0, (this.strike || 0) - dt);
    const t = U.uTime.value;
    this.crown.rotation.set(0, Math.sin(t * 0.9) * 0.06 + armY, -0.3 + Math.sin(t * 1.3) * 0.05 + (this.mode === 'jet' ? 0.2 : 0) + armZ);
    U.uExt.value = this.strike > 0 ? 1 + 2.5 * Math.sin((this.strike / 0.4) * Math.PI) : 1;   // the tentacles' stretch (cuttleArm)
    this._fins(dt, b.speed);
    b.place(this.model);
  }
}

// =====================================================================================================
// Day octopus
// =====================================================================================================
//
// Mantle ~1.0 unit (12 cm), arms ~3x the mantle. A wrinkled mantle sac behind the head, eyes on raised
// turrets with a bar pupil, eight arms as tubes along chains of points that curl and reach, draped over
// the reef (each point stays above the rock or sand). Skin: red-brown with papillae, pale spots and
// pale suckers on the underside of the arms. It keeps a den (a cave the moray doesn't use, or a crevice
// low in the reef), sits there with arms curled, makes forays crawling over the reef, pounces on food
// that lands near it, and jets away when startled.

function octoSkin(rng, armSpots = 0) {
  const W = 512, H = 256, c = makeCanvas(W, H), g = c.getContext('2d'), n = new Noise(rng);
  const img = g.createImageData(W, H), d = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const m = n.fbm(x / 22, y / 22, 3), p = n.noise2(x / 4, y / 4);
    const k = (y * W + x) * 4;
    const base = [150, 58, 34], darkc = [88, 30, 20];
    // A net of dark grooves between raised patches (ridged noise: lines where the noise crosses 0.5).
    const rid = 1 - Math.abs(2 * n.noise2(x / 6 + 40, y / 6) - 1), net = clamp((rid - 0.88) / 0.1, 0, 1) * 0.35;
    const t = clamp((m - 0.45) * 3, 0, 1);
    const sh = (0.85 + 0.3 * p) * (1 - net);
    d[k] = lerp(base[0], darkc[0], t) * sh;
    d[k + 1] = lerp(base[1], darkc[1], t) * sh;
    d[k + 2] = lerp(base[2], darkc[2], t) * sh;
    d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  g.fillStyle = 'rgba(245,200,170,0.55)';
  for (let i = 0; i < 260; i++) { g.beginPath(); g.arc(rng() * W, rng() * H, range(rng, 1, 3), 0, 7); g.fill(); }
  // Bold white spots, densest on the arms (the left quarter of the texture is the arms' strip).
  g.fillStyle = 'rgba(248,240,232,0.85)';
  for (let i = 0; i < armSpots; i++) { g.beginPath(); g.ellipse(rng() * W * 0.25, rng() * H, range(rng, 2, 4.5), range(rng, 1.5, 3), rng() * 3, 0, 7); g.fill(); }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// An octopus eye: a pale ring round a golden iris with a horizontal bar pupil, drawn where the
// sphere's +x side faces (the centre of the texture).
function octoEyeTex() {
  const W = 256, H = 128, c = makeCanvas(W, H), g = c.getContext('2d');
  g.fillStyle = '#8a4a30'; g.fillRect(0, 0, W, H);   // skin round the eye
  const cx = W / 2, cy = H / 2;
  g.fillStyle = '#d8c8b0'; g.beginPath(); g.ellipse(cx, cy, 30, 34, 0, 0, 7); g.fill();
  const gr = g.createRadialGradient(cx, cy, 2, cx, cy, 24);
  gr.addColorStop(0, '#d8b070'); gr.addColorStop(1, '#a07a48');
  g.fillStyle = gr; g.beginPath(); g.ellipse(cx, cy, 22, 26, 0, 0, 7); g.fill();
  g.fillStyle = '#0a0806'; g.fillRect(cx - 4, cy - 15, 8, 30);   // the bar (texture v runs down the sphere: vertical here is horizontal on the eye)
  return canvasTexture(c);
}
function octoBump(rng) {
  const s = 256, c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 1400; i++) {
    const x = rng() * s, y = rng() * s, r = range(rng, 1, 4);
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    gr.addColorStop(0, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

// A sucker: a shallow cupped lathe (rim and dimple) standing on the arm's oral face, its base sunk
// into the arm. 0.03 across at the root (M = 1); the instance matrices scale and place it.
const SUCKER_R = 0.03, SUCKERS_PER_ARM = 36;
function suckerGeometry() {
  const prof = [[1.0, -0.5], [1.0, 0.2], [0.86, 0.52], [0.6, 0.5], [0.38, 0.28], [0.0, 0.2]];
  const g = new THREE.LatheGeometry(prof.map(([r, y]) => new THREE.Vector2(r * SUCKER_R, y * SUCKER_R)), 8);
  g.deleteAttribute('uv');
  return g;
}

// A tube along a chain of points, rebuilt in place each frame. The section isn't round: the oral
// (sucker) side, facing the ground, is broad and flat (a superellipse), the aboral side domed. The
// taper is a curve (quick thinning near the root, long and slender after) closed by a rounded tip,
// and the normals follow the section and the taper. Two rings per chain segment (Catmull-Rom between
// the points), so the coils read smooth; the chain itself (towing, _untangle, the web) is as it was.
// Two staggered rows of suckers (one InstancedMesh for all the arms) follow its frames.
const ARM_RING = 16, ARM_SUB = 2, ARM_CAP = [0.55, 1.0, 1.35];   // cap rings' angles over the tip
const ORAL_N = 3.5, ORAL_H = 0.6, ABORAL_H = 0.95, ARM_W = 1.05;      // section: half-depths and half-width per radius
// The section per unit radius, once: x across (along Bn), y towards the ground (Nn), and its normal.
// The oral side is a superellipse, flat and broad; the aboral side an ellipse.
const ARM_SEC = (() => {
  const S = new Float32Array(ARM_RING * 4), e = 2 / ORAL_N;
  for (let j = 0; j < ARM_RING; j++) {
    const b = (j / ARM_RING) * Math.PI * 2, cs = Math.cos(b), sn = Math.sin(b);
    let x, y, gx, gy;
    if (cs > 0) {
      x = ARM_W * Math.sign(sn) * Math.abs(sn) ** e; y = ORAL_H * cs ** e;
      gx = Math.sign(x) * Math.abs(x / ARM_W) ** (ORAL_N - 1) / ARM_W; gy = (y / ORAL_H) ** (ORAL_N - 1) / ORAL_H;
    } else { x = ARM_W * sn; y = ABORAL_H * cs; gx = x / (ARM_W * ARM_W); gy = y / (ABORAL_H * ABORAL_H); }
    const gl = Math.hypot(gx, gy) || 1;
    S.set([x, y, gx / gl, gy / gl], 4 * j);
  }
  return S;
})();
class ArmTube {
  constructor(n, r0, r1, mat, suckers, first) {
    this.n = n; this.r0 = r0; this.r1 = r1;
    this.suckers = suckers; this.first = first;   // its instances: first .. first + SUCKERS_PER_ARM
    const ring = ARM_RING, nr = (n - 1) * ARM_SUB + 1, rings = nr + ARM_CAP.length, count = rings * ring + 1, g = new THREE.BufferGeometry();
    this.nr = nr; this.rings = rings;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    const col = new Float32Array(count * 3), uv = new Float32Array(count * 2), thin = new Float32Array(count), idx = [];
    for (let i = 0; i < rings; i++) for (let j = 0; j < ring; j++) {
      const f = Math.min(1, i / (nr - 1)), k = i * ring + j, cs = Math.cos((j / ring) * Math.PI * 2);
      uv[2 * k] = j / ring * 0.25; uv[2 * k + 1] = f * 2;
      thin[k] = 0.1 + 0.9 * f ** 1.5;   // thin and translucent towards the tip
      // the oral face paler (no painted stripes: the suckers are real now)
      const pale = 0.45 * clamp(cs, 0, 1) ** 2;
      col[3 * k] = lerp(1, 2.0, pale); col[3 * k + 1] = lerp(1, 2.7, pale); col[3 * k + 2] = lerp(1, 3.0, pale);
      // (wound to face out: the old tube faced in, and showed its far wall's inside)
      if (i < rings - 1) { const a = k, b = i * ring + (j + 1) % ring; idx.push(a, b, a + ring, b, b + ring, a + ring); }
      else idx.push(k, i * ring + (j + 1) % ring, count - 1);   // the tip's last fan
    }
    col.fill(1, (count - 1) * 3); thin[count - 1] = 1;
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    g.setAttribute('aThin', new THREE.BufferAttribute(thin, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e3);
    this.mesh = new THREE.Mesh(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = true;
    this.pts = Array.from({ length: n }, () => new THREE.Vector3());
    this.prevW = [];   // last frame's world positions (Octopus.update tows them)
    this._c = new Float32Array(nr * 3); this._f = new Float32Array(nr * 9);   // ring centres and frames (T, Nn, Bn), for the suckers
  }
  // Radius at f (0 root .. 1 tip), and the section's half-depth on the oral side (for the floor).
  rAt(f) { return this.r1 + (this.r0 - this.r1) * (1 - f) ** 1.6; }
  // pts in the octopus's local frame; 'down' is the local direction of the ground.
  build(down) {
    const g = this.mesh.geometry, P = g.attributes.position.array, N = g.attributes.normal.array, n = this.n, nr = this.nr, ring = ARM_RING;
    const T = new THREE.Vector3(), Nn = new THREE.Vector3(), Bn = new THREE.Vector3(), c = new THREE.Vector3(), o = new THREE.Vector3(), q = new THREE.Vector3();
    const C = this._c, F = this._f, pts = this.pts, S = ARM_SEC;
    // centres: through the chain's points, Catmull-Rom between
    for (let i = 0; i < nr; i++) {
      const s = Math.floor(i / ARM_SUB), t = (i % ARM_SUB) / ARM_SUB;
      const p0 = pts[Math.max(0, s - 1)], p1 = pts[s], p2 = pts[Math.min(n - 1, s + 1)], p3 = pts[Math.min(n - 1, s + 2)];
      const t2 = t * t, t3 = t2 * t;
      const w0 = 0.5 * (-t + 2 * t2 - t3), w1 = 0.5 * (2 - 5 * t2 + 3 * t3), w2 = 0.5 * (t + 4 * t2 - 3 * t3), w3 = 0.5 * (t3 - t2);   // Catmull-Rom weights
      C[3 * i] = w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x;
      C[3 * i + 1] = w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y;
      C[3 * i + 2] = w0 * p0.z + w1 * p1.z + w2 * p2.z + w3 * p3.z;
    }
    const L = this.seg / ARM_SUB || 1e-3;   // a ring's spacing, for the taper's slope
    for (let i = 0; i < this.rings; i++) {
      const ic = Math.min(i, nr - 1), cap = i - ic;   // cap: 1.. on the rings over the tip
      if (!cap) {
        const a = Math.max(0, ic - 1), b = Math.min(nr - 1, ic + 1);
        T.set(C[3 * b] - C[3 * a], C[3 * b + 1] - C[3 * a + 1], C[3 * b + 2] - C[3 * a + 2]).normalize();
        // Towards the ground, across the arm; where the arm hangs nearly straight down that is ill
        // defined, so the last ring's carries on (else the ring flips over and the tube folds shut).
        _w.copy(down).addScaledVector(T, -down.dot(T));
        if (i > 0 && _w.lengthSq() < 0.09) _w.copy(Nn).addScaledVector(T, -Nn.dot(T));
        Nn.copy(_w).normalize();
        if (Nn.lengthSq() < 1e-6) Nn.set(1, 0, 0);
        Bn.crossVectors(T, Nn);
        const o9 = 9 * ic;
        F[o9] = T.x; F[o9 + 1] = T.y; F[o9 + 2] = T.z; F[o9 + 3] = Nn.x; F[o9 + 4] = Nn.y; F[o9 + 5] = Nn.z; F[o9 + 6] = Bn.x; F[o9 + 7] = Bn.y; F[o9 + 8] = Bn.z;
      }
      const f = ic / (nr - 1), r = this.rAt(f), slope = (this.rAt(Math.min(1, f + 0.02)) - this.rAt(Math.max(0, f - 0.02))) / (0.04 * (nr - 1) * L);
      // over the tip: a rounded cap, the section shrinking on a quarter circle
      const ang = cap ? ARM_CAP[cap - 1] : 0, sc = Math.cos(ang), ahead = r * Math.sin(ang);
      c.set(C[3 * ic], C[3 * ic + 1], C[3 * ic + 2]).addScaledVector(T, ahead);
      for (let j = 0; j < ring; j++) {
        const x = S[4 * j], y = S[4 * j + 1];
        o.copy(Nn).multiplyScalar(y).addScaledVector(Bn, x);
        q.copy(Nn).multiplyScalar(S[4 * j + 3]).addScaledVector(Bn, S[4 * j + 2]);
        if (cap) q.multiplyScalar(sc).addScaledVector(T, Math.sin(ang));
        else q.addScaledVector(T, -slope).normalize();   // the taper tilts the skin forward
        const k = (i * ring + j) * 3;
        P[k] = c.x + o.x * r * sc; P[k + 1] = c.y + o.y * r * sc; P[k + 2] = c.z + o.z * r * sc;
        N[k] = q.x; N[k + 1] = q.y; N[k + 2] = q.z;
      }
    }
    const k = (this.rings * ring) * 3, r1 = this.rAt(1);   // the tip's point
    P[k] = C[3 * (nr - 1)] + T.x * r1; P[k + 1] = C[3 * (nr - 1) + 1] + T.y * r1; P[k + 2] = C[3 * (nr - 1) + 2] + T.z * r1;
    N[k] = T.x; N[k + 1] = T.y; N[k + 2] = T.z;
    g.attributes.position.needsUpdate = g.attributes.normal.needsUpdate = true;
    this._suckers();
  }
  // Two staggered rows on the oral face, shrinking to the tip, each cup standing on the face (its
  // axis along Nn, out of the sucker side), placed from the ring frames just built.
  _suckers() {
    const S = this.suckers, m = S.instanceMatrix.array, C = this._c, F = this._f, nr = this.nr;
    for (let k = 0; k < SUCKERS_PER_ARM; k++) {
      const f = 0.05 + 0.88 * (k / (SUCKERS_PER_ARM - 1)) ** 1.15, side = k % 2 ? 1 : -1;
      const x = f * (nr - 1), i0 = Math.min(nr - 2, Math.floor(x)), t = x - i0, r = this.rAt(f);
      const at = (o) => F[9 * i0 + o] + (F[9 * (i0 + 1) + o] - F[9 * i0 + o]) * t, ct = (d) => C[3 * i0 + d] + (C[3 * (i0 + 1) + d] - C[3 * i0 + d]) * t;
      _v.set(at(3), at(4), at(5)).normalize(); _w.set(at(6), at(7), at(8)).normalize();   // Nn, Bn
      const s = (0.34 * r) / SUCKER_R, lat = 0.42 * ARM_W * r, up = 0.58 * r;   // on the flat face, ~0.4 of the way out
      const o = 16 * (this.first + k);
      // columns: Bn, Nn (the cup's axis), Bn x Nn (= -T: a right-handed frame, so the cup isn't mirrored)
      const tx = _w.y * _v.z - _w.z * _v.y, ty = _w.z * _v.x - _w.x * _v.z, tz = _w.x * _v.y - _w.y * _v.x;
      m.set([_w.x * s, _w.y * s, _w.z * s, 0, _v.x * s, _v.y * s, _v.z * s, 0, tx * s, ty * s, tz * s, 0,
        ct(0) + _w.x * lat * side + _v.x * up, ct(1) + _w.y * lat * side + _v.y * up, ct(2) + _w.z * lat * side + _v.z * up, 1], o);
    }
    S.instanceMatrix.needsUpdate = true;
    S.boundingBox = null;   // (recomputed only if asked: the shape check)
  }
}

export class Octopus {
  constructor(sp, rng, world, den) {
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
    const M = this.M = range(rng, 0.85, 1.05);
    this.model = new THREE.Group();
    this.u = { uShade: { value: 0 }, uBreath: { value: 0 } };
    const hook = (shader) => {
      Object.assign(shader.uniforms, this.u);
      shader.fragmentShader = 'uniform float uShade;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.55, 0.5), uShade);`);
    };
    // The body is one blended mesh without UVs: its skin is mapped triplanar (three taps, blended by
    // the normal, so the wrinkles run on across the joins), and it breathes in the vertex shader: the
    // sac's share of each vertex (aWeight) swells about the sac's centre.
    const bodyHook = (shader) => {
      Object.assign(shader.uniforms, this.u);
      shader.vertexShader = 'uniform float uBreath;\nattribute float aWeight;\nvarying vec3 vTriP, vTriN;\n' + shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed = vec3(-0.48, 0.3, 0.0) + (transformed - vec3(-0.48, 0.3, 0.0)) * (1.0 + uBreath * aWeight);
        vTriP = position; vTriN = normal;`);
      shader.fragmentShader = 'uniform float uShade;\nvarying vec3 vTriP, vTriN;\n' + shader.fragmentShader.replace('#include <map_fragment>', `{
          vec3 bw = pow(abs(normalize(vTriN)), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
          vec3 tp = vTriP * 0.45;
          diffuseColor *= texture2D(map, tp.zy) * bw.x + texture2D(map, tp.xz + 0.37) * bw.y + texture2D(map, tp.xy + 0.71) * bw.z;
        }
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.55, 0.5), uShade);`);
    };
    const tex = octoSkin(mulberry32(17)), armTex = octoSkin(mulberry32(17), 180), bump = octoBump(rng);   // the same skin; the arms add bold white spots
    const mat = skin({ map: armTex, bumpMap: bump, bumpScale: 2.5, roughness: 0.55, vertexColors: true }, 'octo-skin', hook, { ...CEPH_SSS, thin: 'attr' });
    const bodyMat = skin({ map: tex, roughness: 0.55 }, 'octo-body', bodyHook, CEPH_SSS);
    // Mantle sac, head, eye turrets, oral disc with the arm roots, and siphon: one mesh (built for
    // M = 1, softBodies.js), so the arms grow out of the body rather than meeting it at seams.
    const body = new THREE.Mesh(SOFT['octopus-body'], bodyMat);
    body.scale.setScalar(M);
    body.castShadow = true;
    body.name = 'body';
    this.model.add(body);
    // Invisible stand-ins for the parts the arms keep clear of (_untangle, _buildWeb), with the old
    // parts' places, scales and radii.
    this.sac = new THREE.Object3D();
    this.sac.scale.set(0.58 * M, 0.34 * M, 0.36 * M);   // a long sac held low behind the head
    this.sac.position.set(-0.48 * M, 0.3 * M, 0); this.sac.rotation.z = 0.3;
    this.sac.name = 'sac';
    this.model.add(this.sac);
    const eyeMat = skin({ map: octoEyeTex(), roughness: 0.25 }, 'octo-eye');
    for (const s of [1, -1]) {
      const turret = new THREE.Object3D();
      turret.userData.radius = 0.1 * M;
      turret.position.set(0.13 * M, 0.36 * M, s * 0.2 * M);
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.07 * M, 20, 14), eyeMat);
      eye.position.set(0.15 * M, 0.4 * M, s * 0.24 * M);
      eye.rotation.set(Math.PI / 2, -s * Math.PI / 2 + s * 0.5, 0, 'YXZ');   // bar turned horizontal, then the iris turned out and a little forward
      turret.name = `turret${s > 0 ? 0 : 1}`; eye.name = `eye${s > 0 ? 0 : 1}`;
      this.model.add(turret, eye);
    }
    // The siphon (funnel, in the body mesh): a muscular tube opening low on one side of the head,
    // behind the eye, pointing out, forward and a little up. Two balls along the tube, for keeping
    // the arms off it (_untangle).
    const siphPos = new THREE.Vector3(-0.08 * M, 0.12 * M, 0.27 * M), sax = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(-1.1, 0, -0.9));
    this.siphonBalls = [-1, 1].map((s) => { const o = new THREE.Object3D(); o.position.copy(siphPos).addScaledVector(sax, s * 0.055 * M); this.model.add(o); return o; });
    // Arms. Proportions from octopod morphometrics: the arm width index (base width of the stoutest arm
    // over mantle length) runs ~13-23%, so with the mantle ~1.1 M long the arms are ~0.19 M across at
    // the base, tapering to fine tips; they run ~3x the mantle here (O. cyanea's reach 4-5x, but
    // longer chains read as spider legs at this scale).
    const t0 = performance.now();
    this.suckers = new THREE.InstancedMesh(suckerGeometry(), skin({ color: 0xf0d6c8, roughness: 0.4 }, 'octo-sucker', hook, { ...CEPH_SSS, thin: 0.6 }), 8 * SUCKERS_PER_ARM);
    this.suckers.name = 'suckers';
    this.suckers.frustumCulled = false;
    // (critterCheck.js sees only the base cup, at the model's origin inside the body: a sheet, joined)
    this.suckers.userData.sheet = true;
    this.model.add(this.suckers);
    this.arms = [];
    for (let i = 0; i < 8; i++) {
      const tube = new ArmTube(22, 0.095 * M, 0.01 * M, mat, this.suckers, i * SUCKERS_PER_ARM);
      tube.angle = ((i + 0.5) / 8) * Math.PI * 2;
      tube.len = 3.0 * M * range(rng, 0.85, 1.05);
      tube.curl = range(rng, 0.5, 1.5); tube.ph = rng() * 6;
      tube.mesh.name = `arm${i}`;
      this.model.add(tube.mesh);
      this.arms.push(tube);
    }
    this.buildMs = performance.now() - t0;
    // The oral disc under the head (in the body mesh), which the arms' roots merge into: a stand-in
    // with its ellipsoid's place and radii, for _untangle.
    const disc = new THREE.Object3D();
    disc.scale.set(0.36 * M, 0.11 * M, 0.36 * M);
    disc.position.set(0, 0.02 * M, 0);
    disc.name = 'disc';
    this.model.add(disc);
    this.disc = disc;
    // The interbrachial web: a membrane joining each pair of neighbouring arms over their first
    // quarter, rebuilt with the arms each frame. It is what makes the arms rise into the body as one
    // skirt instead of leaving it as separate legs.
    this.webK = 6;
    {
      const K = this.webK, cols = 3, rows = K + 1, per = rows * cols, g = new THREE.BufferGeometry(), idx = [], uv = [];
      for (let a = 0; a < 8; a++) for (let k = 0; k < rows; k++) for (let c = 0; c < cols; c++) {
        uv.push(0.3 + (a + c / 2) / 8 * 0.7, k / K * 0.5);
        if (k < K && c < cols - 1) { const i0 = a * per + k * cols + c, i1 = i0 + 1, i2 = i0 + cols, i3 = i2 + 1; idx.push(i0, i2, i1, i1, i2, i3); }
      }
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(8 * per * 3), 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      g.setIndex(idx);
      g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e3);
      this.web = new THREE.Mesh(g, skin({ map: tex, bumpMap: bump, bumpScale: 2.5, roughness: 0.55, side: THREE.DoubleSide }, 'octo-web', hook, { ...CEPH_SSS, thin: 0.8 }));
      this.web.frustumCulled = false;
      this.web.castShadow = true;
      this.web.name = 'web';
      this.model.add(this.web);
    }

    // Where parts are attached (and may run into each other): critterCheck.js.
    this.joins = [['eye*', 'body'], ['arm*', 'body'], ['web', 'arm*'], ['web', 'body'], ['suckers', '*']];
    this.den = den.clone();
    this.pos = this.den.clone();
    this.yaw = range(rng, -Math.PI, Math.PI);
    this.mode = 'den'; this.modeT = range(rng, 20, 60);
    this.target = this.pos.clone();
    this.lift = 0; this.jet = 0; this.t = 0;
    this._down = new THREE.Vector3(0, -1, 0);
    this._m = new THREE.Matrix4();
  }

  update(dt, world) {
    this.t += dt; this.modeT -= dt;
    const rng = this.rng, M = this.M;
    this.calm = (this.calm || 0) - dt;
    const threat = this.calm <= 0 && this.mode !== 'jet' ? threatNear(this, world, 1.4) : null;
    if (threat) this._jet(world, threat.pos);
    let food = null;
    if (this.mode === 'den' || this.mode === 'forage') {
      for (const f of world.food) if (!f.eaten && f.resting && f.pos.distanceTo(this.pos) < 3) { food = f; break; }
      if (food) { this.mode = 'pounce'; this.target.copy(food.pos); this.food = food; this.modeT = 8; }
    }
    if (this.modeT <= 0) {
      if (this.mode === 'den') {
        this.mode = 'forage'; this.modeT = range(rng, 25, 50);
        this.target = randomTarget(rng, world, 0, 0);
        this.target.x = clamp(this.den.x + range(rng, -4, 4), world.bounds.x0 + 1.5, world.bounds.x1 - 1.5);
      } else { this.mode = 'den'; this.target.copy(this.den); this.modeT = range(rng, 40, 90); }
    }
    // Body: crawl over the surface (or jet clear of it).
    let speed = 0;
    if (this.mode === 'jet') {
      this.pos.addScaledVector(this.jetDir, 2.0 * this.jet * dt);
      // Mantle first: it turns its sac into the jet, so the arms stream out behind it, clear of the sac.
      const yawT = Math.atan2(-this.jetDir.z, -this.jetDir.x);
      this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(yawT - this.yaw), -1, 1) * dt * 6);
      this.jet = Math.max(0, this.jet - dt * 0.7);
      if (this.modeT <= 0) { this.mode = 'den'; this.target.copy(this.den); this.modeT = range(rng, 30, 60); }
    } else {
      _v.subVectors(this.target, this.pos).setY(0);
      const d = _v.length();
      speed = this.mode === 'pounce' ? 0.6 : this.mode === 'den' && d < 0.2 ? 0 : 0.18;
      if (d > 0.05) {
        const yawT = Math.atan2(_v.z, _v.x);
        this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(yawT - this.yaw), -1, 1) * dt * 0.8);
        this.pos.addScaledVector(_v.normalize(), Math.min(d, speed * dt));
      }
      if (this.mode === 'pounce' && this.food && (this.food.eaten || d < 0.35)) { this.food.eaten = true; this.food = null; this.mode = 'den'; this.target.copy(this.den); this.modeT = range(rng, 30, 60); }
    }
    const ground = Math.max(floorAt(world, this.pos.x, this.pos.z), 0);
    this.stand = lerp(this.stand ?? 0, this.mode === 'forage' || this.mode === 'pounce' ? 1 : 0, Math.min(1, dt));
    const restY = ground + lerp(0.12, 0.34, this.stand) * M;
    if (this.mode === 'jet') this.pos.y = Math.max(this.pos.y, restY);
    else this.pos.y = lerp(this.pos.y, restY, Math.min(1, dt * 3));
    const B = world.bounds;
    this.pos.x = clamp(this.pos.x, B.x0, B.x1); this.pos.z = clamp(this.pos.z, B.z0, B.z1); this.pos.y = Math.min(this.pos.y, B.y1);
    // Under a roof the body flattens to fit (octopuses squeeze into gaps), and never rises through it.
    const ceil = ceilingAt(world, this.pos.x, this.pos.z), room = ceil - ground;
    this.pos.y = Math.min(this.pos.y, ceil - 0.5 * M);
    this.squash = lerp(this.squash ?? 1, clamp((room - 0.04) / (0.78 * M), 0.55, 1), Math.min(1, dt * 2));

    // Colour: darker and cryptic in the den, paler in a jet.
    this.u.uShade.value = lerp(this.u.uShade.value, this.mode === 'den' ? 0.6 : this.mode === 'jet' ? -0.3 : 0.1, Math.min(1, dt));
    // Breathing: the mantle swells and relaxes.
    const br = 1 + 0.04 * Math.sin(this.t * 2.2);
    this.sac.scale.set(0.58 * M * br, 0.34 * M * br, 0.36 * M * br);   // (the stand-in, for the arms)
    this.u.uBreath.value = br - 1;
    this.model.scale.set(1, this.squash, 1);

    this.model.position.copy(this.pos);
    this.model.rotation.set(0, -this.yaw, 0);
    this.model.updateMatrixWorld(true);
    this._m.copy(this.model.matrixWorld).invert();
    const local = new THREE.Vector3(), world_ = new THREE.Vector3();
    // Arms: from the crown, curling chains that reach and drape over the ground.
    // In the den the arms coil close round the body; foraging they sprawl and step; in a jet they
    // trail behind together.
    const coil = this.mode === 'den' ? 1 : this.mode === 'jet' ? 0 : 0.35;
    const jet = this.mode === 'jet';
    for (const arm of this.arms) {
      // In the den the arms are drawn in (tucked under and round the body), not spread over the rock.
      this.tuck = lerp(this.tuck ?? 1, this.mode === 'den' ? 1 : 0, Math.min(1, dt * 0.5));
      // In a cave the den's walls are behind and beside it, so the tucked arms spread out of the mouth
      // (over most of the ring: any narrower and eight arms can't lie side by side).
      const a = this.cave ? wrapAngle(arm.angle) * (1 - 0.4 * this.tuck) : arm.angle;
      const n = arm.n, seg = arm.len * (1 - 0.55 * this.tuck) / (n - 1);
      arm.seg = seg;   // (its rest length, for _untangle)
      const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
      const dir = jet
        ? new THREE.Vector3(1, -0.3, 0).addScaledVector(out, 0.35).normalize()
        : out.clone().multiplyScalar(0.75).setY(lerp(-0.2, -0.45, this.stand ?? 0)).normalize();   // out from the mouth before they drape (straight down, the roots ran into one another)
      const p = local.set(Math.cos(a) * 0.12 * M, 0.02 * M, Math.sin(a) * 0.12 * M);
      const walk = this.mode === 'forage' || this.mode === 'pounce' ? Math.sin(this.t * 2.5 + arm.ph) : 0;
      // Per segment: turn about the vertical (a flat spiral that tightens towards the tip), a slow
      // wave, a crawling step, and a little lift of the tip (arm tips curl up off the rock).
      const sense = arm.curl > 1 ? 1 : -1;
      let gap = 0;   // how far the last point hung above the rock: unsupported arm sags into the hollow
      let lastY = world_.copy(p).applyMatrix4(this.model.matrixWorld).y;   // the last point's height (world)
      for (let i = 0; i < n; i++) {
        arm.pts[i].copy(p);
        const s = i / (n - 1);
        if (!jet) {
          // (the coil turns every arm the same way, a pinwheel whose curves nest, and by under a
          // radian in all, so each keeps to about its own sector: turned either way at random, or
          // wrapped round the body, they ran into one another)
          const turn = coil * (0.01 + 0.12 * s ** 3) * arm.curl + sense * ((Math.sin(this.t * 0.7 + arm.ph + s * 6) + 0.5 * Math.sin(this.t * 0.45 + arm.ph * 2 + s * 11)) * (0.06 + 0.16 * (1 - coil)) + walk * 0.06 * (1 - s));
          dir.applyAxisAngle(UP, turn);
          if (i > 2) dir.y = lerp(dir.y, s > 0.8 ? 0.25 * (1 - coil * 0.5) : -0.05 - clamp(gap * 3, 0, 0.8), 0.35);   // drape down, then the tip lifts
          dir.normalize();
        } else dir.y = -0.3 + Math.sin(this.t * 6 + s * 3 + arm.ph) * 0.08;   // streaming out ahead of the head, away from the sac
        if (!jet && i > 1) {
          // A wall ahead (rock rising more than a step): the arm turns along it rather than standing
          // up it. Try turning either way and take the lower ground.
          const here = world_.copy(p).applyMatrix4(this.model.matrixWorld).y;
          const rise = (d) => { _w.copy(p).addScaledVector(d, seg).applyMatrix4(this.model.matrixWorld); return floorAt(world, _w.x, _w.z) - here; };
          if (rise(dir) > seg * 1.2) {
            let best = dir.clone(), bestR = rise(dir);
            for (const ang of [0.6, -0.6, 1.2, -1.2]) {
              const d = dir.clone().applyAxisAngle(UP, ang * sense), rr = rise(d);
              if (rr < bestR) { bestR = rr; best = d; }
            }
            dir.copy(best);
          }
        }
        p.addScaledVector(dir, seg);
        // Keep the chain above the reef (in world space).
        world_.copy(p).applyMatrix4(this.model.matrixWorld);
        // Soft arms: each point is towed through the water towards its pose rather than placed there,
        // more loosely towards the tip, so the arms trail a jet, swing after a turn and settle. The
        // first two points, the root, turn with the body (towed, they swung in across a neighbour's).
        const pw = (arm.prevW[i] ??= world_.clone());
        if (i < 2) pw.copy(world_); else pw.lerp(world_, 1 - Math.exp(-dt * lerp(20, 2.5, s)));
        world_.copy(pw);
        p.copy(world_).applyMatrix4(this._m);
        // Rock and sand below, and a cave roof above (the model is squashed under a roof: undo that
        // for the world-space limits).
        const r = arm.rAt(s) * ARM_W;   // (the section's half-width: its half-depth is less on either side)
        // Under a roof the height field is the roof's own top (it's splatted for the fishes' sake), so
        // the underside caps the floor.
        // Nor can an arm climb more than a step per segment, or above the roof over the body: past a
        // ledge's edge, where no roof is mapped, the height field is still the ledge's top, and an arm
        // lifted onto it would run up through the rock and the body.
        // Under a roof the height field is the roof's top, not the floor below: there the arms lie at
        // the level of the body's own underside (pressed up to the roof, they rose above the head).
        // (and in a den, under its roof, they keep below the eyes rather than climb its walls: there the
        // web between them would cut through the eye turrets)
        const roof = ceilingAt(world, world_.x, world_.z), top = Math.min(roof, ceil, ceil < Infinity ? this.pos.y + 0.15 * M * this.squash + r : Infinity) - r;
        const below = roof < Infinity ? this.pos.y - 0.1 * M * this.squash : Math.max(floorAt(world, world_.x, world_.z), 0);
        const floor = Math.min(below + r * 0.9, top, lastY + 1.2 * seg);
        gap = world_.y - floor;
        if (gap < 0) { world_.y = floor; gap = 0; dir.y = Math.max(dir.y, 0); }
        if (world_.y > top) { world_.y = top; dir.y = Math.min(dir.y, 0); }
        p.copy(world_).applyMatrix4(this._m);
        pw.copy(world_);
        lastY = world_.y;
      }
    }
    this._untangle();
    for (const arm of this.arms) {
      // tow on from where they settled, so the next frame starts nearly untangled
      for (let i = 1; i < arm.n; i++) arm.prevW[i - 1].copy(arm.pts[i]).applyMatrix4(this.model.matrixWorld);
      arm.build(this._down);
    }
    this._buildWeb();
  }

  // The arms are towed each on its own, so nothing stops them passing through one another, or the
  // body: points of different arms nearer the other's segments than their radii are pushed apart,
  // and segments out of the sac, the eye turrets and the eyes, each arm keeping its length. (Their
  // roots, inside the oral disc, are left merged.) Solved by turns (position-based): the contacts,
  // then each segment back to its length (both ends giving, the root held), until nothing touches.
  // The towing carries on from the result, so each frame starts from the last one's settled pose and
  // a few passes do. On flat arrays, with the segments binned in a coarse grid so each point meets
  // only those near it: it runs every frame.
  _untangle() {
    const arms = this.arms, NA = arms.length, n = arms[0].n, N = NA * n, gap = 0.01 * this.M, D = this.disc;
    const X = (this._ux ??= new Float64Array(N * 3)), R = (this._ur ??= new Float64Array(N));
    const L = (this._ul ??= new Float64Array(N)), root = (this._uf ??= new Uint8Array(N));
    for (let A = 0; A < NA; A++) {
      const a = arms[A];
      for (let i = 0; i < n; i++) {
        const k = A * n + i, q = a.pts[i];
        X[3 * k] = q.x; X[3 * k + 1] = q.y; X[3 * k + 2] = q.z;
        R[k] = a.rAt(i / (n - 1)) * ARM_W;   // the section's half-width (its widest)
        L[k] = a.seg;   // segment i-1..i, at its rest length (towed, it can bunch up)
      }
    }
    // The obstacles are spheres in their own frames (the sac's stretched, its bumpy skin up to 9%
    // proud): their matrices to and from the model's frame.
    const obst = this.obstacles ??= [[this.sac, 1.1], ...this.model.children.filter((o) => /^(turret|eye)/.test(o.name)).map((o) => [o, o.userData.radius ?? o.geometry.parameters.radius]),   // (turrets: stand-ins)
      ...this.siphonBalls.map((o) => [o, 0.08 * this.M])];   // the siphon's tube, in two balls along it
    const OB = obst.map(([o, r]) => ({ to: _mInv.copy(o.matrix).invert().elements.slice(), from: o.matrix.elements, r, sc: Math.min(o.scale.x, o.scale.y, o.scale.z) }));
    const reach = arms[0].r0 * 2 + gap, tol = gap;
    let hits;   // real overlaps found this pass, deeper than the gap kept (none: settled, though a pass still opens the gap)
    // the point s along k..k+1 (s 0: point k itself) against segment j..j+1 (both in X)
    const push = (k, j, s = 0) => {
      const q = s ? 3 : 0;
      const px = X[3 * k] + (X[3 * k + q] - X[3 * k]) * s, py = X[3 * k + 1] + (X[3 * k + 1 + q] - X[3 * k + 1]) * s, pz = X[3 * k + 2] + (X[3 * k + 2 + q] - X[3 * k + 2]) * s;
      const ax = X[3 * j], ay = X[3 * j + 1], az = X[3 * j + 2];
      const ex = X[3 * j + 3] - ax, ey = X[3 * j + 4] - ay, ez = X[3 * j + 5] - az;
      const t = clamp(((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / Math.max(ex * ex + ey * ey + ez * ez, 1e-12), 0, 1);
      let dx = px - ax - ex * t, dy = py - ay - ey * t, dz = pz - az - ez * t;
      const need = R[k] + (s ? (R[k + 1] - R[k]) * s : 0) + R[j] + (R[j + 1] - R[j]) * t + gap, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 >= need * need) return;
      const d = Math.sqrt(d2);
      if (need - d > tol) hits++;
      if (d < 1e-9) { dx = 0; dy = 1; dz = 0; } else { dx /= d; dy /= d; dz /= d; }
      // shared, except that a root is stiff (held at its base): what meets one does all the giving
      const wk = root[k] || (s && root[k + 1]) ? 0 : root[j] || root[j + 1] ? 1 : 0.5, mk = (need - d) * wk, m = (need - d) * (1 - wk), m0 = m * (1 - t), m1 = m * t;
      if (s) {   // a segment's middle: both its ends move, so that it moves by mk
        const w = mk / ((1 - s) ** 2 + s * s), w0 = w * (1 - s), w1 = w * s;
        X[3 * k] += dx * w0; X[3 * k + 1] += dy * w0; X[3 * k + 2] += dz * w0;
        X[3 * k + 3] += dx * w1; X[3 * k + 4] += dy * w1; X[3 * k + 5] += dz * w1;
      } else { X[3 * k] += dx * mk; X[3 * k + 1] += dy * mk; X[3 * k + 2] += dz * mk; }
      X[3 * j] -= dx * m0; X[3 * j + 1] -= dy * m0; X[3 * j + 2] -= dz * m0;
      X[3 * j + 3] -= dx * m1; X[3 * j + 4] -= dy * m1; X[3 * j + 5] -= dz * m1;
    };
    const keepOut = () => {
      for (const { to: T, from: F, r, sc } of OB) for (let A = 0; A < NA; A++) for (let i = 1; i < n; i++) {
        // the segment's nearest point to the obstacle's centre (a segment can cut a corner its two
        // ends keep clear of): both ends move out by what it lacks (only the far one at the root)
        const k0 = A * n + i - 1, k1 = k0 + 1, a0 = 3 * k0, a1 = 3 * k1;
        if (root[k0] && root[k1]) continue;   // the root, merged into the disc (and so the body)
        const s0x = T[0] * X[a0] + T[4] * X[a0 + 1] + T[8] * X[a0 + 2] + T[12], s0y = T[1] * X[a0] + T[5] * X[a0 + 1] + T[9] * X[a0 + 2] + T[13], s0z = T[2] * X[a0] + T[6] * X[a0 + 1] + T[10] * X[a0 + 2] + T[14];
        const s1x = T[0] * X[a1] + T[4] * X[a1 + 1] + T[8] * X[a1 + 2] + T[12], s1y = T[1] * X[a1] + T[5] * X[a1 + 1] + T[9] * X[a1 + 2] + T[13], s1z = T[2] * X[a1] + T[6] * X[a1 + 1] + T[10] * X[a1 + 2] + T[14];
        const ex = s1x - s0x, ey = s1y - s0y, ez = s1z - s0z;
        const t = clamp(-(s0x * ex + s0y * ey + s0z * ez) / Math.max(ex * ex + ey * ey + ez * ez, 1e-12), 0, 1);
        const cx = s0x + ex * t, cy = s0y + ey * t, cz = s0z + ez * t, d = Math.hypot(cx, cy, cz);
        const need = r + (R[k0] + (R[k1] - R[k0]) * t + gap) / sc;
        if (d >= need || d < 1e-9) continue;
        if ((need - d) * sc > tol) hits++;
        const f = (need - d) / d, mx = cx * f, my = cy * f, mz = cz * f;
        const put = (o, x, y, z) => { X[o] = F[0] * x + F[4] * y + F[8] * z + F[12]; X[o + 1] = F[1] * x + F[5] * y + F[9] * z + F[13]; X[o + 2] = F[2] * x + F[6] * y + F[10] * z + F[14]; };
        if (i > 1) put(a0, s0x + mx, s0y + my, s0z + mz);
        put(a1, s1x + mx, s1y + my, s1z + mz);
      }
      // Nor can an arm, past its root, coil under the oral disc: there it would be squeezed between
      // the floor and the other arms' roots. Below the disc's top it keeps outside the disc's rim.
      const top = D.position.y + D.scale.y;
      for (let A = 0; A < NA; A++) for (let i = 5; i < n; i++) {
        const a = 3 * (A * n + i);
        if (X[a + 1] >= top) continue;
        const rho = Math.hypot(X[a], X[a + 2]), need = D.scale.x + R[A * n + i] + gap;
        if (rho >= need) continue;
        if (need - rho > tol) hits++;
        const f = rho > 1e-9 ? need / rho : 1;
        if (rho > 1e-9) { X[a] *= f; X[a + 2] *= f; } else X[a] = need;
      }
    };
    const near2 = (k, j, l) => { const dx = X[3 * k] - X[3 * j], dy = X[3 * k + 1] - X[3 * j + 1], dz = X[3 * k + 2] - X[3 * j + 2]; return dx * dx + dy * dy + dz * dz < (reach + l) ** 2; };
    // The grid: cells a contact's reach plus a segment and a half across (a segment's middle meets
    // another's), G to a side about the body.
    let maxL = 0;
    for (let k = 0; k < N; k++) if (k % n) maxL = Math.max(maxL, L[k]);
    const G = 32, CS = reach + 1.5 * maxL, head = (this._gh ??= new Int32Array(G * G * G)), next = (this._gn ??= new Int32Array(N));
    const cell = (v) => Math.min(G - 1, Math.max(0, Math.floor(v / CS) + G / 2));
    for (let pass = 0; pass < 6; pass++) {
      hits = 0;
      head.fill(-1);
      for (let k = 0; k < N; k++) {
        // the roots: an arm's first few points while within the oral disc, where they merge. Roots
        // don't meet roots; anything else (an arm coiled back under the body) meets them all the same.
        const x = X[3 * k] / D.scale.x, y = (X[3 * k + 1] - D.position.y) / D.scale.y, z = X[3 * k + 2] / D.scale.z;
        root[k] = k % n <= 4 && x * x + y * y + z * z < 1 ? 1 : 0;
      }
      for (let k = 0; k < N; k++) {   // bin each segment k..k+1 (from point 1 on) by its middle
        const i = k % n;
        if (i < 1 || i > n - 2) continue;
        const c = cell((X[3 * k] + X[3 * k + 3]) / 2) + G * (cell((X[3 * k + 1] + X[3 * k + 4]) / 2) + G * cell((X[3 * k + 2] + X[3 * k + 5]) / 2));
        next[k] = head[c]; head[c] = k;
      }
      for (let k = 0; k < N; k++) {
        if (k % n < 1) continue;
        const A = Math.floor(k / n), cx = cell(X[3 * k]), cy = cell(X[3 * k + 1]), cz = cell(X[3 * k + 2]);
        for (let z = Math.max(0, cz - 1); z <= Math.min(G - 1, cz + 1); z++) for (let y = Math.max(0, cy - 1); y <= Math.min(G - 1, cy + 1); y++) for (let x = Math.max(0, cx - 1); x <= Math.min(G - 1, cx + 1); x++)
          for (let j = head[x + G * (y + G * z)]; j >= 0; j = next[j])
            if (Math.floor(j / n) !== A && !(root[k] && (root[j] || root[j + 1])) && near2(k, j, L[j + 1] + (k % n < n - 1 ? L[k + 1] / 2 : 0))) {
              push(k, j);
              // and the middle of the segment it starts (two segments crossing middle to middle
              // come nearer than either's ends do)
              if (k % n < n - 1 && !(root[k + 1] && (root[j] || root[j + 1]))) push(k, j, 0.5);
            }
      }
      keepOut();
      for (let A = 0; A < NA; A++) for (let i = 1; i < n; i++) {
        const k = A * n + i, a1 = 3 * k, a0 = a1 - 3;
        const ex = X[a1] - X[a0], ey = X[a1 + 1] - X[a0 + 1], ez = X[a1 + 2] - X[a0 + 2], l = Math.hypot(ex, ey, ez);
        const f = (l - L[k]) / Math.max(l, 1e-9), w1 = i === 1 ? f : f / 2, w0 = i === 1 ? 0 : f / 2;
        X[a1] -= ex * w1; X[a1 + 1] -= ey * w1; X[a1 + 2] -= ez * w1;
        X[a0] += ex * w0; X[a0 + 1] += ey * w0; X[a0 + 2] += ez * w0;
      }
      if (!hits) break;
    }
    keepOut();
    for (let A = 0; A < NA; A++) for (let i = 1; i < n; i++) { const k = A * n + i; arms[A].pts[i].set(X[3 * k], X[3 * k + 1], X[3 * k + 2]); }
  }

  // Startled by something at 'from': jet away (critterCheck.js calls this too).
  _jet(world, from) {
    this.mode = 'jet'; this.modeT = 2.2; this.jet = 1; this.calm = 15;
    // Away from the threat and a little up; under the den's roof, straight out of the mouth instead.
    this.jetDir = this.cave && ceilingAt(world, this.pos.x, this.pos.z) < Infinity
      ? this.cave.dir.clone().setY(0.05).normalize()
      : _w.subVectors(this.pos, from).setY(0.4).normalize().clone();
  }

  _buildWeb() {
    const K = this.webK, P = this.web.geometry.attributes.position.array, cols = 3, per = (K + 1) * cols;
    const order = this.arms.map((a, i) => i).sort((i, j) => wrapAngle(this.arms[i].angle) - wrapAngle(this.arms[j].angle));
    for (let a = 0; a < 8; a++) {
      const L = this.arms[order[a]], R = this.arms[order[(a + 1) % 8]];
      for (let k = 0; k <= K; k++) {
        const pl = L.pts[k], pr = R.pts[k], f = k / K;
        // The free edge is scalloped: the middle of the web is drawn back towards the body.
        _v.addVectors(pl, pr).multiplyScalar(0.5);
        _w.set(0, _v.y + 0.03 * this.M, 0);
        _v.lerp(_w, 0.45 * f ** 1.5);
        // (and clear of the eye turrets and eyes, which it would sweep through when the arms rise
        // past the head under a roof)
        for (const [ob, r] of this.obstacles) {
          if (ob === this.sac) continue;
          _w.copy(_v).sub(ob.position);
          if (_w.lengthSq() < (r + 0.02 * this.M) ** 2) _v.copy(ob.position).addScaledVector(_w.normalize(), r + 0.02 * this.M);
        }
        for (let c = 0; c < cols; c++) {
          const q = c === 0 ? pl : c === 2 ? pr : _v, o = (a * per + k * cols + c) * 3;
          P[o] = q.x; P[o + 1] = q.y; P[o + 2] = q.z;
        }
      }
    }
    this.web.geometry.attributes.position.needsUpdate = true;
    this.web.geometry.computeVertexNormals();
  }
}

// =====================================================================================================
// Juvenile green turtle
// =====================================================================================================
//
// Carapace 2.0 units (25 cm). An oval, gently domed carapace with five vertebral, four pairs of costal
// and the marginal scutes, each with the radiating orange-brown streaks of a juvenile; a pale plastron;
// head and flippers dark with pale seams between the scales. The long front flippers fly (a
// dorsoventral stroke with feathering, then a glide), the rear flippers steer. It cruises the tank,
// comes up to the surface to breathe every few minutes, rests on the sand, and grazes on the rock.

function carapaceTex(rng) {
  const S = 1024, c = makeCanvas(S, S), g = c.getContext('2d'), n = new Noise(rng);
  g.fillStyle = '#6a3a1e'; g.fillRect(0, 0, S, S);
  // Scute centres in planform coordinates (x along the body, y across), unit carapace.
  const scutes = [];
  for (let i = 0; i < 5; i++) scutes.push([lerp(0.78, 0.2, i / 4), 0.5, 0.11]);
  for (const s of [1, -1]) for (let i = 0; i < 4; i++) scutes.push([lerp(0.7, 0.28, i / 3), 0.5 + s * 0.24, 0.12]);
  for (const s of [1, -1]) for (let i = 0; i < 12; i++) {
    const a = lerp(-1.35, 1.35, i / 11);
    scutes.push([0.5 + Math.sin(a) * 0.44, 0.5 + s * Math.cos(a) * 0.43, 0.05]);
  }
  // Voronoi cells: each pixel belongs to the nearest scute; streaks radiate from its centre.
  const img = g.createImageData(S, S), d = img.data;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const u = x / S, v = y / S;
    let b1 = 9, b2 = 9, bi = 0;
    for (let i = 0; i < scutes.length; i++) {
      const [cx, cy, r] = scutes[i], dd = Math.hypot(u - cx, (v - cy) * 1.05) / (r + 0.06);
      if (dd < b1) { b2 = b1; b1 = dd; bi = i; } else if (dd < b2) b2 = dd;
    }
    const [cx, cy] = scutes[bi];
    // Dark olive-brown scutes; irregular amber streaks radiate from each scute's growth centre, broken
    // up by noise so they read as a juvenile's sunburst, not a regular star.
    const ang = Math.atan2(v - cy, u - cx), wav = n.noise2(u * 40, v * 40);
    const streak = Math.pow(0.5 + 0.5 * Math.sin(ang * (8 + (bi % 3)) + wav * 7), 2) * (0.25 + 0.75 * n.noise2(u * 9 + bi, v * 9));   // ~8-10 broad, broken streaks per scute
    const seam = clamp((b2 - b1) * 16, 0, 1);
    const centre = clamp(1 - b1 * 1.3, 0, 1);
    const k = (y * S + x) * 4;
    const dark = [62, 40, 22], amber = [170, 100, 48], seamC = [168, 140, 104];
    const t = clamp(streak * (0.5 + 0.6 * b1) + centre * 0.25, 0, 1);
    let r = lerp(dark[0], amber[0], t), gg = lerp(dark[1], amber[1], t), bb = lerp(dark[2], amber[2], t);
    r = lerp(seamC[0], r, seam); gg = lerp(seamC[1], gg, seam); bb = lerp(seamC[2], bb, seam);
    d[k] = r; d[k + 1] = gg; d[k + 2] = bb; d[k + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return canvasTexture(c);
}
function scaleTex(rng) {
  const S = 256, c = makeCanvas(S, S), g = c.getContext('2d');
  // Dark brown polygonal scales with thin pale seams between them (head and flippers).
  g.fillStyle = '#b8a888'; g.fillRect(0, 0, S, S);
  const N = 12, cell = S / N;
  for (let gy = -1; gy <= N; gy++) for (let gx = -1; gx <= N; gx++) {
    const x = (gx + 0.5 + (gy & 1) * 0.5 + range(rng, -0.15, 0.15)) * cell, y = (gy + 0.5 + range(rng, -0.15, 0.15)) * cell, r = cell * range(rng, 0.52, 0.6);
    g.fillStyle = ['#3a2614', '#4a3018', '#2e1e10', '#54381c'][(gx * 7 + gy * 3) & 3];
    g.beginPath();
    for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2 + 0.5 + rng() * 0.2; g.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r); }
    g.fill();
  }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(1.4, 1.4);
  return t;
}

export class Turtle {
  constructor(sp, rng, world) {
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
    const L = this.L = range(rng, 1.8, 2.1);
    this.model = new THREE.Group();
    // Carapace: an upper half-ellipsoid. Mapped by angle from the top of the dome (not flat from above),
    // so the costal scutes reach down the steep sides and the marginals stay a narrow rim.
    const cg = new THREE.SphereGeometry(1, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2);
    const cp = cg.attributes.position, cuv = cg.attributes.uv;
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i);
      // A slightly pointed tail end and a broader front.
      const taper = x < 0 ? 1 - 0.12 * x * x : 1;
      cp.setXYZ(i, x * L * 0.5, Math.pow(y, 0.85) * L * 0.24 * (1 + 0.12 * x), z * L * 0.4 * taper);   // domed highest over the front third (bourjon_immature.jpg)
      const rr = (Math.acos(clamp(y, -1, 1)) / (Math.PI / 2)) * 0.5, hz = Math.hypot(x, z) || 1;
      cuv.setXY(i, 0.5 + (x / hz) * rr, 0.5 + (z / hz) * rr);
    }
    cg.computeVertexNormals();
    const shellMat = skin({ map: carapaceTex(rng), roughness: 0.42, metalness: 0 }, 'turtle-shell');
    const shell = new THREE.Mesh(cg, shellMat);
    shell.castShadow = true;
    // Plastron: a shallow lower dome on the carapace's own rim, closing the shell.
    const pg = new THREE.SphereGeometry(1, 56, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), pp = pg.attributes.position;
    for (let i = 0; i < pp.count; i++) {
      const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i), taper = x < 0 ? 1 - 0.12 * x * x : 1;
      pp.setXYZ(i, x * L * 0.5, y * L * 0.05, z * L * 0.4 * taper);
    }
    pg.computeVertexNormals();
    const plast = new THREE.Mesh(pg, skin({ color: 0xe8d8a8, roughness: 0.6 }, 'turtle-plastron'));
    shell.name = 'shell'; plast.name = 'plastron';
    this.model.add(shell, plast);
    // Head on a short neck.
    const scales = scaleTex(rng);
    const fleshMat = skin({ map: scales, roughness: 0.55 }, 'turtle-flesh');
    this.head = new THREE.Group();
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), fleshMat);
    head.scale.set(L * 0.13, L * 0.085, L * 0.09);
    head.position.x = L * 0.07;
    // The neck runs from the head back under the front of the carapace.
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(L * 0.062, L * 0.085, L * 0.26, 16), fleshMat);
    neck.rotation.z = Math.PI / 2;
    neck.position.x = -L * 0.07;
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x080706, roughness: 0.1 });
    for (const s of [1, -1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(L * 0.03, 12, 10), eyeMat);
      eye.position.set(L * 0.125, L * 0.035, s * L * 0.062);
      eye.name = `eye${s > 0 ? 0 : 1}`;
      this.head.add(eye);
    }
    head.name = 'head'; neck.name = 'neck';
    this.head.add(head, neck);
    this.head.position.set(L * 0.52, -L * 0.01, 0);
    this.model.add(this.head);
    // Soft skin filling the shell's openings: a collar round the neck at the front, shoulders at the
    // front flipper roots and a pad over the hips.
    const collar = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), fleshMat);
    collar.scale.set(L * 0.1, L * 0.065, L * 0.17);
    collar.position.set(L * 0.38, -L * 0.015, 0);
    collar.name = 'collar';
    this.model.add(collar);
    for (const s of [1, -1]) {
      const sh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), fleshMat);
      sh.scale.set(L * 0.1, L * 0.05, L * 0.08);
      sh.position.set(L * 0.22, -L * 0.025, s * L * 0.28);
      const hip = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), fleshMat);
      hip.scale.set(L * 0.08, L * 0.04, L * 0.07);
      hip.position.set(-L * 0.38, -L * 0.03, s * L * 0.16);
      sh.name = `shoulder${s > 0 ? 0 : 1}`; hip.name = `hip${s > 0 ? 0 : 1}`;
      this.model.add(sh, hip);
    }
    // Flippers: flattened, tapering paddles pivoting at the shoulder / hip.
    const paddle = (len, wid, sweep) => {
      const g = new THREE.SphereGeometry(1, 24, 12);
      const p = g.attributes.position;
      for (let i = 0; i < p.count; i++) {
        let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
        const t = (z + 1) / 2;   // 0 root .. 1 tip (out along +z)
        const w = wid * (0.55 + 0.75 * Math.sin(Math.PI * Math.min(1, t * 1.3))) * (1 - 0.45 * t) * Math.sqrt(Math.max(0, 1 - z * z) + 0.02);
        p.setXYZ(i, x * w - t * t * sweep, y * 0.12 * wid * (1 - 0.6 * t), (z + 1) * 0.5 * len);
      }
      g.computeVertexNormals();
      return g;
    };
    this.flip = [];
    for (const s of [1, -1]) {
      const front = new THREE.Group(), fm = new THREE.Mesh(paddle(L * 0.6, L * 0.075, L * 0.16), fleshMat);
      fm.scale.z = s; front.add(fm);
      front.position.set(L * 0.22, -L * 0.02, s * L * 0.3);
      const rear = new THREE.Group(), rm = new THREE.Mesh(paddle(L * 0.2, L * 0.08, L * 0.03), fleshMat);
      rm.scale.z = s; rear.add(rm);
      rear.position.set(-L * 0.4, -L * 0.045, s * L * 0.18);   // just under the plastron, clear of it as it turns
      rear.rotation.y = s * 0.9;
      fm.name = `flipper${s > 0 ? 0 : 1}`; rm.name = `rearflipper${s > 0 ? 0 : 1}`;
      this.model.add(front, rear);
      this.flip.push({ front, rear, s });
    }
    for (const m of this.model.children) m.castShadow = true;
    // Where parts are attached (and may run into each other): critterCheck.js.
    this.joins = [['shell', 'plastron'], ['head', 'neck'], ['eye*', 'head'], ['neck', 'collar'], ['neck', 'shell'], ['neck', 'plastron'], ['collar', 'shell'], ['collar', 'plastron'],
      ['shoulder*', 'shell'], ['shoulder*', 'plastron'], ['shoulder*', 'collar'], ['flipper*', 'shoulder*'], ['hip*', 'shell'], ['hip*', 'plastron'], ['rearflipper*', 'hip*']];

    const B = world.bounds;
    this.body = new Swimmer(new THREE.Vector3(range(rng, B.x0 + 3, B.x1 - 3), range(rng, 4, 7), range(rng, -0.5, 1.2)), rng() < 0.5 ? 0 : Math.PI);
    this.pos = this.body.pos;
    this.mode = 'cruise'; this.modeT = range(rng, 15, 30); this.target = randomTarget(rng, world, 3, 7);
    this.breath = range(rng, 60, 200);   // seconds until it needs air
    this.stroke = 0; this.t = 0;
  }

  update(dt, world) {
    this.t += dt; this.modeT -= dt; this.breath -= dt;
    const rng = this.rng, b = this.body, B = world.bounds, L = this.L;
    if (this.breath <= 0 && this.mode !== 'breathe') { this.mode = 'breathe'; this.target.set(this.pos.x + range(rng, -2, 2), B.y1, this.pos.z); }
    if (this.mode === 'breathe' && this.pos.y > B.y1 - 0.4) { this.mode = 'cruise'; this.modeT = range(rng, 15, 30); this.breath = range(rng, 150, 300); this.target = randomTarget(rng, world, 2, 6); }
    if (this.modeT <= 0 && this.mode !== 'breathe') {
      const r = rng();
      this.mode = r < 0.55 ? 'cruise' : r < 0.8 ? 'rest' : 'graze';
      this.modeT = this.mode === 'rest' ? range(rng, 30, 70) : range(rng, 15, 30);
      if (this.mode === 'cruise') this.target = randomTarget(rng, world, 2, 7);
      else {
        // Rest on open sand (low height field), graze on rock.
        let best = null;
        for (let k = 0; k < 30; k++) {
          const t = randomTarget(rng, world, 0, 0), h = world.reefHeight(t.x, t.z);
          if (this.mode === 'rest' ? h < 0.25 : h > 0.8) { t.y = Math.max(h, 0) + L * 0.12; best = t; break; }
        }
        if (best) this.target = best; else { this.mode = 'cruise'; this.target = randomTarget(rng, world, 2, 7); }
      }
    }
    const d = this.pos.distanceTo(this.target);
    if (this.mode === 'cruise' && d < 1) this.target = randomTarget(rng, world, 2, 7);
    const settled = (this.mode === 'rest' || this.mode === 'graze') && d < 0.5;
    const speed = settled ? 0 : this.mode === 'breathe' ? 0.6 : (this.mode === 'cruise' ? 0.45 : 0.3) * clamp(d, 0.3, 1);
    b.steer(dt, world, this.target, { turn: 0.45, speed, accel: 0.6, clearance: L * 0.14, look: L * 1.2 });
    if (settled) { b.pitch = lerp(b.pitch, 0, dt); b.roll = lerp(b.roll, 0, dt); }

    // Front flippers: a power stroke down and back, recovery up, then a glide when slow; feathered.
    const beat = settled ? 0 : clamp(Math.abs(b.speed) / 0.45, 0.25, 1.2);
    this.stroke += dt * 0.55 * Math.PI * 2 * beat;
    const ph = this.stroke, flap = Math.sin(ph), feather = Math.cos(ph);
    for (const f of this.flip) {
      const s = f.s;
      const amp = settled ? 0.05 : 0.55;
      f.front.rotation.set(s * (flap * amp - 0.15), s * (0.55 + 0.15 * feather), -0.25 * feather * (settled ? 0 : 1), 'YXZ');
      f.rear.rotation.x = s * (0.1 + 0.15 * Math.sin(ph * 0.5 + 1) * (settled ? 0.2 : 1));
    }
    // Head: looks about, bobs down to graze.
    const grazing = this.mode === 'graze' && settled;
    this.head.rotation.y = Math.sin(this.t * 0.3) * 0.25;
    this.head.rotation.z = grazing ? -0.35 + 0.15 * Math.max(0, Math.sin(this.t * 3)) : Math.sin(this.t * 0.4) * 0.06;
    b.place(this.model);
  }
}
