// Water atmosphere: backdrop gradient, fog, caustic light on surfaces, god rays,
// drifting particles ("marine snow"), bubble column and the shimmering surface.
import * as THREE from 'three';
import { makeCanvas, range } from './util.js';

export const waterUniforms = {
  uTime: { value: 0 },
  uCaustic: { value: 1 },
};

// Tileable water caustic (after joltz0r's well-known shader).
export const CAUSTIC_GLSL = /* glsl */`
float caustic(vec2 uv, float time) {
  vec2 p = mod(uv * 6.28318, 6.28318) - 250.0;
  vec2 i = vec2(p);
  float c = 1.0;
  float inten = 0.005;
  for (int n = 0; n < 4; n++) {
    float t = time * (1.0 - (3.5 / float(n + 1)));
    i = p + vec2(cos(t - i.x) + sin(t + i.y), sin(t - i.y) + cos(t + i.x));
    c += 1.0 / length(vec2(p.x / (sin(i.x + t) / inten), p.y / (cos(i.y + t) / inten)));
  }
  c /= 4.0;
  c = 1.17 - pow(c, 1.4);
  return pow(abs(c), 8.0);
}
`;

// Adds animated caustic light to any lit material (chains with an existing onBeforeCompile).
export function addCaustics(mat, strength = 1) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    shader.uniforms.uTime = waterUniforms.uTime;
    shader.uniforms.uCaustic = waterUniforms.uCaustic;
    shader.uniforms.uCStrength = { value: strength };
    shader.vertexShader = 'varying vec3 vCW;\nvarying vec3 vCN;\n' + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec4 cw = vec4(transformed, 1.0);
        vec3 cn = objectNormal;
        #ifdef USE_INSTANCING
          cw = instanceMatrix * cw;
          cn = mat3(instanceMatrix) * cn;
        #endif
        cw = modelMatrix * cw;
        vCW = cw.xyz;
        vCN = normalize(mat3(modelMatrix) * cn);
      }`);
    shader.fragmentShader = 'uniform float uTime;\nuniform float uCaustic;\nuniform float uCStrength;\nvarying vec3 vCW;\nvarying vec3 vCN;\n'
      + CAUSTIC_GLSL + shader.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      {
        float up = clamp(vCN.y * 0.8 + 0.25, 0.0, 1.0);
        float depthFade = clamp(0.45 + vCW.y / 10.0, 0.0, 1.0);
        float c = caustic(vCW.xz * 0.16 + vec2(vCW.y * 0.04, 0.0), uTime * 0.5);
        totalEmissiveRadiance += diffuseColor.rgb * c * up * depthFade * uCaustic * uCStrength;
      }`);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|caustic' + strength;
  return mat;
}

// ---------- underwater light transport ----------
//
// World scale: 1 unit = 12.5 cm (tank is 2.0 m x 1.1 m x 0.75 m).
// Replaces three.js fog with a per-channel Beer-Lambert medium:
//   L = L_surface * Td(depth) * T(path) + L_inscatter(dir) * (1 - T(path))
// where T = exp(-c * path) uses beam attenuation c (absorption + scattering) and
// Td = exp(-Kd * depth below surface) dims light reaching deeper surfaces.
// Coefficients are for clear tropical reef water (per metre), converted to per unit.
export const METRES_PER_UNIT = 0.125;
const C_PER_M = [0.60, 0.17, 0.12];    // beam attenuation c, red/green/blue (1/m)
const KD_PER_M = [0.45, 0.07, 0.05];   // diffuse downwelling attenuation Kd (1/m)
export const SURFACE_Y = 9.4;
export const GLASS_Z = 3.3;

const v3 = (a) => `vec3(${a.map((x) => (x * METRES_PER_UNIT).toFixed(5)).join(', ')})`;
const UW_GLSL = /* glsl */`
const vec3 UW_C = ${v3(C_PER_M)};
const vec3 UW_KD = ${v3(KD_PER_M)};
const float UW_SURFACE = ${SURFACE_Y.toFixed(2)};
const float UW_GLASS = ${GLASS_Z.toFixed(2)};
// Camera white balance: undo the downwelling attenuation at reef depth, like an
// underwater photographer's custom white balance (the eye adapts the same way).
const vec3 UW_WB = exp(UW_KD * 7.0);   // balanced for the reef zone (~0.3 m above the sand)
// Radiance scattered towards the eye by an infinitely long water path in direction dir,
// starting at height y: brighter towards the sunlit surface, darker looking down and deeper.
vec3 uwInscatter(vec3 base, vec3 dir, float y) {
  float up = smoothstep(-0.7, 0.95, dir.y);
  vec3 c = base * (0.45 + 1.1 * up * up);
  return c * exp(-UW_KD * max(0.0, UW_SURFACE - y) * 1.5);
}
// Length of the part of the eye ray that lies inside the water (camera is outside the glass).
float uwPath(vec3 p, vec3 cam) {
  float d = length(p - cam);
  if (cam.z <= UW_GLASS) return d;
  return d * clamp((UW_GLASS - p.z) / max(1e-3, cam.z - p.z), 0.0, 1.0);
}
`;

// Patch the fog chunks once, before any material compiles. fogColor = inscatter base radiance,
// fogDensity = turbidity multiplier (1 = nominal).
let patched = false;
export function installUnderwaterMedium() {
  if (patched) return;
  patched = true;
  const SC = THREE.ShaderChunk;
  SC.fog_pars_vertex = '#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vUWWorld;\n#endif\n';
  SC.fog_vertex = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    {
      vec4 uwW = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        uwW = instanceMatrix * uwW;
      #endif
      vUWWorld = (modelMatrix * uwW).xyz;
    }
  #endif\n`;
  SC.fog_pars_fragment = `#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vUWWorld;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif
    ${UW_GLSL}
  #endif\n`;
  SC.fog_fragment = `#ifdef USE_FOG
    {
      vec3 uwDir = normalize(vUWWorld - cameraPosition);
      #ifdef FOG_EXP2
        float uwK = fogDensity;
      #else
        float uwK = 1.0;
      #endif
      vec3 T = exp(-UW_C * uwPath(vUWWorld, cameraPosition) * uwK);
      vec3 Td = exp(-UW_KD * max(0.0, UW_SURFACE - vUWWorld.y));
      float yMid = mix(vUWWorld.y, min(cameraPosition.y, UW_SURFACE), 0.5);
      gl_FragColor.rgb = (gl_FragColor.rgb * Td * T + uwInscatter(fogColor, uwDir, yMid) * (1.0 - T)) * UW_WB;
    }
  #endif\n`;
}

// Inscatter base radiance (linear) at full daylight: blue-green, as seen in reef water.
export const INSCATTER_DAY = new THREE.Color(0.030, 0.20, 0.33);

// Background: the same inscatter function evaluated for an infinitely long path,
// so distant objects fade seamlessly into the "open water" behind them.
export function makeWaterBackdrop() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { uBase: { value: INSCATTER_DAY.clone() } },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; gl_Position.z = gl_Position.w; }',
    fragmentShader: UW_GLSL + `
      uniform vec3 uBase; varying vec3 vW;
      void main(){
        vec3 dir = normalize(vW - cameraPosition);
        // Start the infinite path at the glass, at the height the ray crosses it.
        float t = (UW_GLASS - cameraPosition.z) / min(-1e-3, dir.z);
        float y = cameraPosition.y + dir.y * max(t, 0.0);
        gl_FragColor = vec4(uwInscatter(uBase, dir, y) * UW_WB, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const m = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), mat);
  m.frustumCulled = false;
  m.renderOrder = -1;
  return m;
}

// Image-based ambient light for the underwater radiance field: Snell's window overhead
// (the whole sky squeezed into a ~97 degree cone), blue-green inscatter around it,
// and dim sand-coloured upwelling from below.
export function makeEnvironment(renderer) {
  const scene = new THREE.Scene();
  const geo = new THREE.SphereGeometry(10, 64, 32);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: { uBase: { value: INSCATTER_DAY.clone() } },
    vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: UW_GLSL + `uniform vec3 uBase; varying vec3 vP; void main(){
      vec3 dir = normalize(vP);
      vec3 water = uwInscatter(uBase, dir, 5.0);
      float win = smoothstep(cos(radians(50.0)), cos(radians(46.0)), dir.y);
      vec3 sky = vec3(0.95, 1.0, 1.05) * 2.2 * exp(-UW_KD * (UW_SURFACE - 5.0));
      vec3 sand = vec3(0.32, 0.29, 0.24) * 0.35;
      vec3 c = mix(water, sky, win);
      c = mix(c, sand, smoothstep(-0.1, -0.6, dir.y));
      gl_FragColor = vec4(c, 1.0);
    }`,
  });
  scene.add(new THREE.Mesh(geo, mat));
  const pm = new THREE.PMREMGenerator(renderer);
  const rt = pm.fromScene(scene, 0.02);
  pm.dispose();
  return rt.texture;
}

// ---------- god rays ----------

function rayTexture() {
  const c = makeCanvas(128, 512), g = c.getContext('2d');
  const h = g.createLinearGradient(0, 0, 128, 0);
  h.addColorStop(0, 'rgba(255,255,255,0)');
  h.addColorStop(0.5, 'rgba(255,255,255,1)');
  h.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = h; g.fillRect(0, 0, 128, 512);
  g.globalCompositeOperation = 'destination-in';
  const v = g.createLinearGradient(0, 0, 0, 512);
  v.addColorStop(0, 'rgba(0,0,0,1)');
  v.addColorStop(0.6, 'rgba(0,0,0,0.35)');
  v.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = v; g.fillRect(0, 0, 128, 512);
  const t = new THREE.CanvasTexture(c);
  return t;
}

export class GodRays {
  constructor(scene, width, rng) {
    this.rays = [];
    const tex = rayTexture();
    for (let i = 0; i < 9; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
        color: new THREE.Color(0.75, 0.95, 1.0), opacity: 0.0, fog: false, side: THREE.DoubleSide,
      });
      const w = range(rng, 0.8, 2.6), h = 13;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      m.position.set(range(rng, -width * 0.55, width * 0.55), 9.5 - h / 2 + 1.5, range(rng, -3.5, 1.5));
      m.rotation.z = range(rng, -0.25, -0.1);
      m.userData = { phase: rng() * 10, speed: range(rng, 0.05, 0.12), base: range(rng, 0.03, 0.08), x0: m.position.x };
      scene.add(m);
      this.rays.push(m);
    }
  }
  update(t, light) {
    for (const r of this.rays) {
      const u = r.userData;
      r.material.opacity = light * u.base * (0.55 + 0.45 * Math.sin(t * u.speed * 2 + u.phase));
      r.position.x = u.x0 + Math.sin(t * u.speed + u.phase) * 0.6;
    }
  }
}

// ---------- marine snow ----------

function dotTexture() {
  const c = makeCanvas(32, 32), g = c.getContext('2d');
  const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(0.4, 'rgba(255,255,255,0.5)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 32, 32);
  return new THREE.CanvasTexture(c);
}

// Water velocity field supplied by the World (pump circulation). Particles are advected by it.
const NO_FLOW = (p, out) => out.set(0, 0, 0);

// Marine snow: fine organic particles sinking at Stokes velocity (~1-3 mm/s) and drifting with the flow.
export class MarineSnow {
  constructor(scene, width, rng) {
    const n = 600;
    this.w = width;
    const pos = new Float32Array(n * 3);
    this.vs = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      pos[i * 3] = range(rng, -width / 2, width / 2);
      pos[i * 3 + 1] = range(rng, 0, SURFACE_Y);
      pos[i * 3 + 2] = range(rng, -4, GLASS_Z - 0.1);
      // Stokes: v = 2/9 (dp/mu) g r^2. r = 10-40 um, excess density ~50 kg/m^3.
      const r = range(rng, 10e-6, 40e-6);
      this.vs[i] = ((2 / 9) * (50 / 1.0e-3) * 9.81 * r * r) / METRES_PER_UNIT;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.points = new THREE.Points(g, new THREE.PointsMaterial({
      size: 0.035, map: dotTexture(), transparent: true, opacity: 0.5, depthWrite: false,
      color: 0xe8f6ff, blending: THREE.AdditiveBlending,
    }));
    scene.add(this.points);
    this._p = new THREE.Vector3();
    this._f = new THREE.Vector3();
  }
  update(dt, t, flow = NO_FLOW) {
    const attr = this.points.geometry.attributes.position, a = attr.array, p = this._p, f = this._f;
    for (let i = 0; i < a.length / 3; i++) {
      p.set(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]);
      flow(p, f);
      a[i * 3] += f.x * dt;
      a[i * 3 + 1] += (f.y - this.vs[i]) * dt;
      a[i * 3 + 2] += f.z * dt;
      if (a[i * 3 + 1] < 0) a[i * 3 + 1] = SURFACE_Y - 0.05;
      if (a[i * 3] > this.w / 2) a[i * 3] -= this.w;
      if (a[i * 3] < -this.w / 2) a[i * 3] += this.w;
    }
    attr.needsUpdate = true;
  }
}

// ---------- bubbles ----------
//
// Air bubbles from an airstone. Rise speed from Mendelson's wave analogy (valid d > ~1.3 mm):
//   U = sqrt(2.14 sigma / (rho d) + 0.505 g d)
// Bubbles grow as hydrostatic pressure drops (Boyle), are flattened into oblate spheroids
// (aspect ~1 + 0.16 d[mm]) and zig-zag/spiral once d > ~2 mm. Shading: Fresnel reflection
// at the water->air interface with total internal reflection beyond the critical angle,
// which gives the bright rim and see-through centre of real bubbles.

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

export class Bubbles {
  constructor(scene, origin, rng) {
    this.origin = origin.clone();
    this.rng = rng;
    this.n = 90;
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false,
      uniforms: {
        uWater: { value: new THREE.Color(0.05, 0.25, 0.35) },
        uSky: { value: new THREE.Color(1.2, 1.3, 1.35) },
        uSun: { value: new THREE.Vector3(3, 22, 7) },
        uLight: { value: 1 },
      },
      vertexShader: BUBBLE_VERT, fragmentShader: BUBBLE_FRAG,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 16, 12), this.mat, this.n);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.b = [];
    this.spawnClock = 0;
    for (let i = 0; i < this.n; i++) { const b = this._spawn({}); b.y = this.origin.y + rng() * (SURFACE_Y - this.origin.y); this.b.push(b); }
    scene.add(this.mesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3();
    this._p = new THREE.Vector3();
    this._f = new THREE.Vector3();
  }
  _spawn(b) {
    b.x = this.origin.x + (this.rng() - 0.5) * 0.08;
    b.z = this.origin.z + (this.rng() - 0.5) * 0.08;
    b.y = this.origin.y;
    b.d0 = range(this.rng, 1.5e-3, 5e-3);   // diameter at release (m)
    b.ph = this.rng() * 6.283;
    b.f = range(this.rng, 4, 8);             // zig-zag frequency (Hz)
    return b;
  }
  update(dt, t, flow = NO_FLOW, light = 1) {
    const g = 9.81, sigma = 0.072, rho = 1000;
    this.mat.uniforms.uLight.value = 0.25 + 0.75 * light;
    for (let i = 0; i < this.n; i++) {
      const b = this.b[i];
      // Boyle's law: pressure (atm) at depth, 1 atm per 10.3 m.
      const depth = (SURFACE_Y - b.y) * METRES_PER_UNIT;
      const pr = (1 + (SURFACE_Y - this.origin.y) * METRES_PER_UNIT / 10.3) / (1 + depth / 10.3);
      const d = b.d0 * Math.cbrt(pr);
      const U = Math.sqrt((2.14 * sigma) / (rho * d) + 0.505 * g * d) / METRES_PER_UNIT;
      this._p.set(b.x, b.y, b.z);
      flow(this._p, this._f);
      b.y += (U + this._f.y) * dt;
      b.x += this._f.x * dt;
      b.z += this._f.z * dt;
      if (b.y > SURFACE_Y - 0.02) this._spawn(b);
      const r = (d / 2) / METRES_PER_UNIT;
      const dmm = d * 1000;
      const aspect = 1 + 0.16 * Math.max(0, dmm - 1);
      const zz = dmm > 2 ? (dmm - 2) * 0.004 / METRES_PER_UNIT : 0;
      const ox = Math.sin(t * b.f * 6.283 + b.ph) * zz, oz = Math.cos(t * b.f * 6.283 * 0.7 + b.ph) * zz * 0.6;
      this._q.setFromEuler(this._e.set(Math.cos(t * b.f * 6.283 + b.ph) * 0.3, 0, Math.sin(t * b.f * 6.283 + b.ph) * 0.3));
      this._m.compose(this._p.set(b.x + ox, b.y, b.z + oz), this._q, this._s.set(r * Math.cbrt(aspect), r / Math.pow(aspect, 2 / 3), r * Math.cbrt(aspect)));
      this.mesh.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------- surface ----------

export function makeSurface(width) {
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false,
    uniforms: { uTime: waterUniforms.uTime, uLight: { value: 1 } },
    vertexShader: 'varying vec2 vUv; varying vec3 vW; void main(){ vUv = uv; vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: CAUSTIC_GLSL + `
      uniform float uTime; uniform float uLight; varying vec2 vUv; varying vec3 vW;
      void main(){
        float c = caustic(vW.xz * 0.12, uTime * 0.35);
        vec3 col = mix(vec3(0.20, 0.55, 0.80), vec3(0.85, 0.97, 1.0), c * 0.8);
        float edge = smoothstep(0.0, 0.25, vUv.y);
        gl_FragColor = vec4(col * (0.35 + 0.65 * uLight), (0.35 + c * 0.45) * edge);
      }`,
  });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.8, 16), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(0, 9.6, -2);
  return m;
}

