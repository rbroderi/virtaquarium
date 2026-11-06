// Air bubbles from an airstone. Rise speed from Mendelson's wave analogy (valid d > ~1.3 mm):
//   U = sqrt(2.14 sigma / (rho d) + 0.505 g d)
// Bubbles grow as hydrostatic pressure drops (Boyle), are flattened into oblate spheroids
// (aspect ~1 + 0.16 d[mm]) and zig-zag/spiral once d > ~2 mm. Shading: Fresnel reflection
// at the water->air interface with total internal reflection beyond the critical angle,
// which gives the bright rim and see-through centre of real bubbles.
import * as THREE from 'three';
import { range, type Rng } from '../util.js';
import { METRES_PER_UNIT, SURFACE_Y } from './medium.js';
import { NO_FLOW, type FlowField } from './flow.js';

const BUBBLE_COUNT = 90;
const RELEASE_SPREAD = 0.08;                     // units across the airstone
const DIAMETER_MIN_M = 1.5e-3, DIAMETER_MAX_M = 5e-3;
const WOBBLE_HZ_MIN = 4, WOBBLE_HZ_MAX = 8;
const PHASE_RANGE = 6.283;
const GRAVITY = 9.81, SURFACE_TENSION = 0.072, WATER_DENSITY = 1000;
const METRES_PER_ATMOSPHERE = 10.3;
const POP_BELOW_SURFACE = 0.02;
const ASPECT_PER_MM = 0.16;
const ZIGZAG_ONSET_MM = 2;
const ZIGZAG_M_PER_MM = 0.004;
const ZIGZAG_Z_FREQ = 0.7, ZIGZAG_Z_AMP = 0.6;
const TILT = 0.3;
const MIN_LIGHT = 0.25;
const DRAW_AFTER_SCENE = 3;

const BUBBLE_VERT = /* glsl */`
varying vec3 vN; varying vec3 vV;
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = m * instanceMatrix;
  #endif
  vec4 w = m * vec4(position, 1.0);
  vN = normalize(mat3(m) * normal);
  vV = normalize(cameraPosition - w.xyz);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const BUBBLE_FRAG = /* glsl */`
uniform vec3 uWater; uniform vec3 uSky; uniform vec3 uSun; uniform float uLight;
varying vec3 vN; varying vec3 vV;
void main() {
  vec3 n = normalize(vN), v = normalize(vV);
  float c = abs(dot(n, v));
  // Water (n=1.33) to air (n=1.0): critical angle 48.8 deg -> cos 0.659.
  float s2 = (1.0 - c * c) * 1.33 * 1.33;
  float F;
  if (s2 >= 1.0) F = 1.0;
  else {
    float ct = sqrt(1.0 - s2);
    float rs = (1.33 * c - ct) / (1.33 * c + ct);
    float rp = (c - 1.33 * ct) / (c + 1.33 * ct);
    F = 0.5 * (rs * rs + rp * rp);
  }
  vec3 r = reflect(-v, n);
  vec3 env = mix(uWater, uSky, smoothstep(0.2, 0.9, r.y));
  float spec = pow(max(dot(r, normalize(uSun)), 0.0), 120.0) * 6.0;
  vec3 col = (env * F + spec) * uLight;
  gl_FragColor = vec4(col, clamp(F * 0.9 + spec, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

interface Bubble {
  x: number;
  y: number;
  z: number;
  /** Diameter at release (m). */
  d0: number;
  /** Zig-zag phase (rad). */
  ph: number;
  /** Zig-zag frequency (Hz). */
  f: number;
}

interface BubbleUniforms {
  uWater: THREE.IUniform<THREE.Color>;
  uSky: THREE.IUniform<THREE.Color>;
  uSun: THREE.IUniform<THREE.Vector3>;
  uLight: THREE.IUniform<number>;
}

export class Bubbles {
  readonly mesh: THREE.InstancedMesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  private readonly origin: THREE.Vector3;
  private readonly uniforms: BubbleUniforms = {
    uWater: { value: new THREE.Color(0.05, 0.25, 0.35) },
    uSky: { value: new THREE.Color(1.2, 1.3, 1.35) },
    uSun: { value: new THREE.Vector3(3, 22, 7) },
    uLight: { value: 1 },
  };
  private readonly bubbles: Bubble[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly e = new THREE.Euler();
  private readonly s = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly f = new THREE.Vector3();

  constructor(scene: THREE.Object3D, origin: THREE.Vector3, private readonly rng: Rng) {
    this.origin = origin.clone();
    const material = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, uniforms: { ...this.uniforms },
      vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), material, BUBBLE_COUNT);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = DRAW_AFTER_SCENE;
    for (let i = 0; i < BUBBLE_COUNT; i++) {
      const b = this.spawn({ x: 0, y: 0, z: 0, d0: 0, ph: 0, f: 0 });
      b.y = this.origin.y + rng() * (SURFACE_Y - this.origin.y);
      this.bubbles.push(b);
    }
    scene.add(this.mesh);
  }

  private spawn(b: Bubble): Bubble {
    b.x = this.origin.x + (this.rng() - 0.5) * RELEASE_SPREAD;
    b.z = this.origin.z + (this.rng() - 0.5) * RELEASE_SPREAD;
    b.y = this.origin.y;
    b.d0 = range(this.rng, DIAMETER_MIN_M, DIAMETER_MAX_M);
    b.ph = this.rng() * PHASE_RANGE;
    b.f = range(this.rng, WOBBLE_HZ_MIN, WOBBLE_HZ_MAX);
    return b;
  }

  update(dt: number, t: number, flow: FlowField = NO_FLOW, light = 1): void {
    this.uniforms.uLight.value = MIN_LIGHT + (1 - MIN_LIGHT) * light;
    const releaseDepthM = (SURFACE_Y - this.origin.y) * METRES_PER_UNIT;
    this.bubbles.forEach((b, i) => {
      // Boyle's law: pressure (atm) at depth, 1 atm per 10.3 m.
      const depth = (SURFACE_Y - b.y) * METRES_PER_UNIT;
      const pressureRatio = (1 + releaseDepthM / METRES_PER_ATMOSPHERE) / (1 + depth / METRES_PER_ATMOSPHERE);
      const d = b.d0 * Math.cbrt(pressureRatio);
      const rise = Math.sqrt((2.14 * SURFACE_TENSION) / (WATER_DENSITY * d) + 0.505 * GRAVITY * d) / METRES_PER_UNIT;
      this.p.set(b.x, b.y, b.z);
      flow(this.p, this.f);
      b.y += (rise + this.f.y) * dt;
      b.x += this.f.x * dt;
      b.z += this.f.z * dt;
      if (b.y > SURFACE_Y - POP_BELOW_SURFACE) this.spawn(b);
      this.mesh.setMatrixAt(i, this.pose(b, d, t));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The bubble's matrix: an oblate spheroid of diameter d (m), zig-zagging once it is large. */
  private pose(b: Bubble, d: number, t: number): THREE.Matrix4 {
    const r = (d / 2) / METRES_PER_UNIT;
    const dmm = d * 1000;
    const aspect = 1 + ASPECT_PER_MM * Math.max(0, dmm - 1);
    const zigzag = dmm > ZIGZAG_ONSET_MM ? (dmm - ZIGZAG_ONSET_MM) * ZIGZAG_M_PER_MM / METRES_PER_UNIT : 0;
    const phase = t * b.f * PHASE_RANGE + b.ph;
    const ox = Math.sin(phase) * zigzag;
    const oz = Math.cos(t * b.f * PHASE_RANGE * ZIGZAG_Z_FREQ + b.ph) * zigzag * ZIGZAG_Z_AMP;
    this.q.setFromEuler(this.e.set(Math.cos(phase) * TILT, 0, Math.sin(phase) * TILT));
    const widen = Math.cbrt(aspect);
    return this.m.compose(this.p.set(b.x + ox, b.y, b.z + oz), this.q, this.s.set(r * widen, r / Math.pow(aspect, 2 / 3), r * widen));
  }
}
