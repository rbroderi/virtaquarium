// Moon jellies (Aurelia aurita) and the jelly tank they live in.
//
// Public aquariums show moon jellies in a kreisel: a round tank with a slow circular current that keeps
// them suspended, nothing else in the water, and a backlit deep-blue background. The jellies glow
// because light passes through them and scatters in the jelly: the rim and the folds catch the most,
// so a bell reads as a bright outline with fine radial canals, four horseshoe-shaped gonads (pale
// lavender, the brightest part) and a fringe of short marginal tentacles, with four frilly oral arms
// trailing below. (References: aquarium photos of Aurelia aurita, e.g. National Aquarium, Baltimore.)
//
// Rendering: additive translucent shaders (the jelly adds light; it barely blocks any), dimmed and
// tinted by the water with distance. Motion: one pulse a second or so, a quick contraction of the bell
// margin that thrusts along the bell axis and a slow relaxation, slight negative buoyancy, a righting
// tendency that keeps the bell up, and the tank's current carrying them round.
import * as THREE from 'three';
import { range, clamp, mulberry32 } from './util.js';
import { METRES_PER_UNIT } from './water.js';

export const JELLY_SPECIES = [
  {
    id: 'moonjelly', name: 'Moon Jelly', sci: 'Aurelia aurita', habitat: 'jelly', count: 10,
    fact: 'Ninety-five per cent water; drifts on the current, pulsing about once a second to stay up.',
    size: [0.6, 1.2],   // bell radius, units (15-30 cm across, as in public-aquarium exhibits)
  },
];

// Water between the jelly and the eye: blue survives longest (per unit, as water.js).
const WATER_C = `vec3(${[0.6, 0.17, 0.12].map((c) => (c * METRES_PER_UNIT * 1.6).toFixed(4)).join(', ')})`;

const COMMON = /* glsl */`
uniform float uPulse;     // 0 relaxed .. 1 fully contracted
uniform float uR;         // bell radius
uniform float uTime, uSeed, uLight;
varying vec3 vView;
varying float vDist;
// Bell margin under contraction: s = 0 at the apex .. 1 at the margin.
vec2 bellShape(float r, float y, float s) {
  float c = uPulse * s * s;
  return vec2(r * (1.0 - 0.22 * c), y + uR * (0.1 * c - 0.03 * uPulse));
}
vec3 waterFade(vec3 col) { return col * exp(-${WATER_C} * vDist); }
`;

const BELL_VERT = COMMON + /* glsl */`
varying vec2 vUv;
varying vec3 vN;
void main() {
  vUv = uv;
  float s = uv.y;   // lathe profile: 0 apex .. 1 margin
  float r = length(position.xz);
  vec2 rs = bellShape(r, position.y, s);
  vec2 dxz = r > 1e-5 ? position.xz / r : vec2(0.0);
  vec3 p = vec3(dxz.x * rs.x, rs.y, dxz.y * rs.x);
  // A little irregularity so the bells aren't perfect domes.
  float a = uv.x * 6.2831853;
  p.xz *= 1.0 + 0.025 * sin(a * 3.0 + uSeed) * s;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vN = normalize(mat3(modelMatrix) * normal);
  vView = cameraPosition - w.xyz;
  vDist = length(vView);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;

const BELL_FRAG = COMMON + /* glsl */`
varying vec2 vUv;
varying vec3 vN;
uniform vec3 uTint, uGonad;
float line(float x, float w) { return 1.0 - smoothstep(0.0, w, abs(fract(x) - 0.5) * 2.0); }
void main() {
  vec3 V = normalize(vView), N = normalize(vN);
  float f = pow(1.0 - abs(dot(N, V)), 2.2);   // folds seen edge-on catch the most light
  float s = vUv.y, a = vUv.x;
  // Radial canals: 16 from the centre, branching towards the margin; the ring canal at the margin.
  float canal = line(a * 16.0, 0.06) * smoothstep(0.15, 0.3, s) + line(a * 32.0 + 0.5, 0.05) * smoothstep(0.55, 0.8, s) * 0.8;
  float ring = smoothstep(0.93, 0.985, s) * (1.0 - smoothstep(0.985, 1.0, s));
  // Four horseshoe gonads around the centre, open towards the margin.
  vec2 q = s * vec2(cos(a * 6.2831853), sin(a * 6.2831853));
  float g = 0.0;
  for (int k = 0; k < 4; k++) {
    float ang = (float(k) + 0.5) * 1.5707963 + 0.15 * sin(uSeed + float(k));
    vec2 dir = vec2(cos(ang), sin(ang)), c = dir * 0.27, d = q - c;
    float rr = length(d), open = dot(normalize(d + 1e-5), dir);
    g += (1.0 - smoothstep(0.02, 0.045, abs(rr - 0.12))) * (1.0 - smoothstep(0.35, 0.75, open));
  }
  // Light from above and behind: the top of the bell is a little brighter.
  float top = 0.75 + 0.25 * N.y;
  vec3 col = uTint * (0.1 + 0.8 * f + 0.14 * canal + 0.6 * ring) * top + uGonad * g * (0.45 + 0.4 * f);
  gl_FragColor = vec4(waterFade(col) * uLight, 1.0);
}`;

// Marginal tentacles: short fine threads from the margin, swept by the pulse.
const TENT_VERT = COMMON + /* glsl */`
attribute float aAng, aS, aLen;
varying float vS;
void main() {
  vS = aS;
  vec2 rim = bellShape(uR * 1.0, -uR * 0.02, 1.0);
  float a = aAng * 6.2831853;
  vec3 dir = vec3(cos(a), 0.0, sin(a));
  float L = aLen * uR;
  // Hang down and a little outwards, flicked out by each contraction, swaying slowly.
  float sweep = 0.35 + 0.5 * uPulse;
  vec3 p = dir * rim.x + vec3(0.0, rim.y, 0.0)
         + (dir * sweep * aS - vec3(0.0, aS, 0.0)) * L
         + vec3(sin(uTime * 0.7 + a * 5.0 + uSeed), 0.0, cos(uTime * 0.6 + a * 4.0)) * 0.08 * L * aS * aS;
  vec4 w = modelMatrix * vec4(p, 1.0);
  vView = cameraPosition - w.xyz;
  vDist = length(vView);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const TENT_FRAG = COMMON + /* glsl */`
uniform vec3 uTint;
varying float vS;
void main() { gl_FragColor = vec4(waterFade(uTint * 0.22 * (1.0 - 0.7 * vS)) * uLight, 1.0); }`;

// Oral arms: four frilly ribbons trailing from the centre of the bell.
const ARM_VERT = COMMON + /* glsl */`
attribute float aArm;
varying float vEdge, vS;
void main() {
  float s = uv.y, x = uv.x * 2.0 - 1.0;   // along the arm (0 at the bell) and across it
  vS = s; vEdge = abs(x);
  float a = (aArm + 0.5) * 1.5707963 + 0.7854;
  vec3 out_ = vec3(cos(a), 0.0, sin(a)), side = vec3(-out_.z, 0.0, out_.x);
  float L = uR * 1.05, w = uR * 0.16 * (1.0 - 0.6 * s);
  // Ruffled edges: the frill folds in and out along the length.
  float ruffle = sin(s * 26.0 + x * 2.0 + aArm * 1.7) * vEdge * vEdge;
  vec3 p = vec3(0.0, -uR * 0.02, 0.0) + out_ * (uR * 0.06 + s * L * 0.18) + side * x * w
         + vec3(0.0, -s * L, 0.0) + out_ * ruffle * w * 0.9
         + vec3(sin(uTime * 0.5 + aArm * 2.1 + uSeed), 0.0, cos(uTime * 0.43 + aArm)) * 0.12 * L * s * s;
  p.y += uPulse * 0.06 * uR * (1.0 - s);
  vec4 wp = modelMatrix * vec4(p, 1.0);
  vView = cameraPosition - wp.xyz;
  vDist = length(vView);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const ARM_FRAG = COMMON + /* glsl */`
uniform vec3 uTint;
varying float vEdge, vS;
void main() {
  float frill = smoothstep(0.55, 1.0, vEdge);
  gl_FragColor = vec4(waterFade(uTint * (0.04 + 0.22 * frill) * (1.0 - 0.6 * vS)) * uLight, 1.0);
}`;

const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false };

let shared = null;
function sharedGeometry() {
  if (shared) return shared;
  // Bell: a shallow dome (height ~0.35 R) with the margin curling slightly under, unit radius.
  const prof = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24, r = Math.sin(t * Math.PI / 2) * 1.0;
    prof.push(new THREE.Vector2(Math.max(1e-4, r + (t > 0.9 ? (t - 0.9) * 0.15 : 0)), 0.36 * Math.cos(t * Math.PI / 2) ** 1.4 - (t > 0.9 ? (t - 0.9) * 0.4 : 0)));
  }
  const bell = new THREE.LatheGeometry(prof, 64);
  // Tentacles: line segments, a few points each.
  const N = 160, K = 5, pos = [], ang = [], ss = [], len = [], rng = mulberry32(5);
  for (let i = 0; i < N; i++) {
    const a = (i + rng() * 0.5) / N, l = 0.16 + rng() * 0.1;
    for (let k = 0; k < K; k++) for (const kk of [k, k + 1]) { pos.push(0, 0, 0); ang.push(a); ss.push(kk / K); len.push(l); }
  }
  const tent = new THREE.BufferGeometry();
  tent.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tent.setAttribute('aAng', new THREE.Float32BufferAttribute(ang, 1));
  tent.setAttribute('aS', new THREE.Float32BufferAttribute(ss, 1));
  tent.setAttribute('aLen', new THREE.Float32BufferAttribute(len, 1));
  // Arms: four ribbons, one geometry with an arm index per vertex.
  const ribbon = new THREE.PlaneGeometry(1, 1, 6, 40), arms = [];
  for (let k = 0; k < 4; k++) {
    const g = ribbon.clone();
    g.setAttribute('aArm', new THREE.Float32BufferAttribute(new Array(g.attributes.position.count).fill(k), 1));
    arms.push(g);
  }
  const big = 1e3;   // shaders move every vertex: never cull on the rest-pose bounds
  for (const g of [bell, tent, ...arms]) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), big);
  shared = { bell, tent, arms };
  return shared;
}

export class Jelly {
  constructor(sp, rng, bounds) {
    this.sp = sp;
    this.rng = rng;
    this.R = range(rng, sp.size[0], sp.size[1]);
    const g = sharedGeometry();
    this.u = {
      uPulse: { value: 0 }, uR: { value: this.R }, uTime: { value: 0 }, uSeed: { value: rng() * 10 }, uLight: { value: 1 },
      uTint: { value: new THREE.Color(0.55, 0.75, 1.0) }, uGonad: { value: new THREE.Color(0.95, 0.8, 1.0) },
    };
    const mat = (v, f) => new THREE.ShaderMaterial({ uniforms: this.u, vertexShader: v, fragmentShader: f, ...additive });
    this.model = new THREE.Group();
    // The shapes are built for a unit bell (uR = 1) and scaled with the group.
    this.u.uR.value = 1;
    const bell = new THREE.Mesh(g.bell, mat(BELL_VERT, BELL_FRAG));
    const tent = new THREE.LineSegments(g.tent, mat(TENT_VERT, TENT_FRAG));
    const arms = g.arms.map((a) => new THREE.Mesh(a, mat(ARM_VERT, ARM_FRAG)));
    this.inner = new THREE.Group();
    this.inner.scale.setScalar(this.R);
    this.inner.add(bell, tent, ...arms);
    this.model.add(this.inner);
    for (const m of [bell, tent, ...arms]) m.frustumCulled = false;

    const B = bounds;
    this.pos = new THREE.Vector3(range(rng, B.x0 + 1, B.x1 - 1), range(rng, 1.5, B.y1 - 1), range(rng, B.z0 + 0.8, B.z1 - 0.8));
    this.vel = new THREE.Vector3();
    this.prefY = range(rng, 0.6, B.y1 - 1.8);
    this.prefX = this.pos.x;
    this.axis = new THREE.Vector3(range(rng, -0.4, 0.4), 1, range(rng, -0.4, 0.4)).normalize();
    this.hz = range(rng, 0.55, 0.95) * (0.9 / Math.sqrt(this.R / 0.5));   // bigger bells pulse slower
    this.phase = rng();
    this.wander = new THREE.Vector3();
    this.wanderT = 0;
    this._q = new THREE.Quaternion();
    this._f = new THREE.Vector3();
  }

  // Bell contraction over one pulse cycle: quick (30%), then a slow relaxation.
  static contraction(ph) {
    return ph < 0.3 ? Math.sin((ph / 0.3) * Math.PI / 2) : Math.cos(((ph - 0.3) / 0.7) * Math.PI / 2) ** 2;
  }

  update(dt, world, others = []) {
    // Bells that touch bump softly apart.
    for (const o of others) {
      if (o === this) continue;
      const d = this.pos.distanceTo(o.pos), min = (this.R + o.R) * 1.15;
      if (d < min && d > 1e-4) this.vel.addScaledVector(this._f.subVectors(this.pos, o.pos), ((min - d) / min) * 0.6 * dt / d);
    }
    const prev = Jelly.contraction(this.phase);
    this.phase = (this.phase + dt * this.hz) % 1;
    const c = Jelly.contraction(this.phase);
    // Thrust while the bell closes (m/s per unit of contraction), along the bell axis.
    // About 1-2 cm/s on average. Each jelly holds a loose depth: above it the pulses weaken and it sinks
    // (they're slightly heavier than water), below it they strengthen.
    const effort = clamp(0.6 + (this.prefY - this.pos.y) * 0.35, 0.15, 1.3);
    const push = Math.max(0, c - prev) * this.R * 0.3 * effort;
    this.vel.addScaledVector(this.axis, push);
    this.vel.y -= 0.04 * dt;
    this.vel.multiplyScalar(Math.exp(-dt * 1.2));   // drag
    world.flow(this.pos, this._f);
    this.pos.addScaledVector(this.vel, dt).addScaledVector(this._f, dt);   // the kreisel current

    // The bell rights itself (the heavy, gelatinous margin hangs below) and wanders slowly; near the
    // walls it tips away from them.
    this.wanderT -= dt;
    if (this.wanderT <= 0) { this.wander.set(range(this.rng, -0.6, 0.6), 0, range(this.rng, -0.4, 0.4)); this.wanderT = range(this.rng, 4, 9); }
    const B = world.bounds, want = this._f.set(0, 1, 0).add(this.wander);
    want.x += clamp((this.prefX - this.pos.x) * 0.12, -0.5, 0.5);   // a loose home column, so they spread out
    const m = 1.2;
    if (this.pos.x < B.x0 + m) want.x += (B.x0 + m - this.pos.x) * 2;
    if (this.pos.x > B.x1 - m) want.x -= (this.pos.x - B.x1 + m) * 2;
    if (this.pos.z < B.z0 + 0.6) want.z += 1.5;
    if (this.pos.z > B.z1 - 0.6) want.z -= 1.5;
    if (this.pos.y > B.y1 - 1.0) want.y -= 2.5;   // near the top: tip over and drift back down
    if (this.pos.y < 1.2) want.y += 1.5;
    this.axis.lerp(want.normalize(), Math.min(1, dt * 0.25)).normalize();
    this.pos.x = clamp(this.pos.x, B.x0, B.x1);
    this.pos.y = clamp(this.pos.y, 0.6, B.y1);
    this.pos.z = clamp(this.pos.z, B.z0, B.z1);

    this.model.position.copy(this.pos);
    this.model.quaternion.copy(this._q.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.axis));
    this.u.uPulse.value = c;
    this.u.uTime.value += dt;
    this.u.uLight.value = 0.25 + 0.75 * world.light;
  }
}

// The jelly tank: a backlit deep-blue void (brightest above and behind, falling off to navy at the
// edges), no reef, sand or surface in view. Returns the reef-shaped stub the World expects.
export function buildJellyTank(scene) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uBase: { value: new THREE.Color(1, 1, 1) }, uLight: { value: 1 } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
    fragmentShader: /* glsl */`
      uniform float uLight; varying vec3 vW;
      void main() {
        vec3 d = normalize(vW - cameraPosition);
        // Light panel behind and above the tank: a broad glow, brightest a little above the centre.
        float glow = exp(-pow(length(vec2(d.x * 1.1, d.y - 0.12)) / 0.42, 2.0));
        float halo = exp(-pow(length(vec2(d.x * 0.8, d.y - 0.05)) / 0.9, 2.0));
        // Azure at the panel (exhibit photos read ~#1a70ff), navy towards the edges.
        vec3 col = vec3(0.006, 0.13, 0.75) * glow + vec3(0.0, 0.025, 0.16) * halo + vec3(0.0, 0.003, 0.016);
        gl_FragColor = vec4(col * uLight, 1.0);
      }`,
  });
  const backdrop = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), mat);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  scene.add(backdrop);
  return {
    backdrop,
    group: new THREE.Group(),
    heightAt: () => -10,
    anemones: [],
    homes: [],
    caves: [],
    bubbler: null,
  };
}
