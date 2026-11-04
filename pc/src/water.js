// Water atmosphere: backdrop gradient, fog, caustic light on surfaces, god rays,
// drifting particles ("marine snow"), bubble column and the shimmering surface.
import * as THREE from 'three';
import { makeCanvas, range, mulberry32 } from './util.js';
import { reefLightUniforms, REEF_LIGHT_GLSL, REEF_LIGHT_EVAL, REEF_LIGHT_APPLY } from './reefLight.js';

export const waterUniforms = {
  uTime: { value: 0 },
  uCaustic: { value: 1 },
};

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

// ---------- surface waves ----------
//
// The surface of an aquarium has no wind waves. What ripples it is roughness stirred up by the
// return pump, which the slow surface current carries along (a few cm/s) while it slowly re-forms
// (Taylor's frozen-turbulence picture). So the pattern drifts at the current's speed and evolves over
// seconds, instead of racing across at free-wave phase speeds (30-90 cm/s at these wavelengths).
// Wave vectors sit on a lattice of the tile, so the field (and its caustics) repeats seamlessly every
// WAVE_TILE units. Wavelengths run 5-50 cm with ~2% slope each (rms slope ~0.07).
export const WAVE_TILE = 4.0;   // units (0.5 m)
const NWAVES = 24;
const SURFACE_CURRENT = [0.03, 0.008];   // m/s, along the pump's outflow (+x) with a slight cross drift
const waves = (() => {
  const rng = mulberry32(911), out = [], seen = new Set();
  while (out.length < NWAVES) {
    const n = 1 + Math.floor(Math.pow(rng(), 1.4) * 10);
    const a = (rng() - 0.5) * 2.4 + (rng() < 0.2 ? Math.PI : 0);   // mostly along the pump's flow (+x)
    const nx = Math.round(n * Math.cos(a)), nz = Math.round(n * Math.sin(a));
    if ((!nx && !nz) || seen.has(nx + ',' + nz)) continue;
    seen.add(nx + ',' + nz);
    const kx = (2 * Math.PI * nx) / WAVE_TILE, kz = (2 * Math.PI * nz) / WAVE_TILE, k = Math.hypot(kx, kz);
    // Advection by the current (k . U) plus slow re-forming: a few seconds for ripples, longer for swells.
    const advect = (kx * SURFACE_CURRENT[0] + kz * SURFACE_CURRENT[1]) / METRES_PER_UNIT;
    const evolve = (rng() < 0.5 ? -1 : 1) * (0.08 + 0.25 * rng()) * Math.sqrt(n / 5);
    out.push({ kx, kz, amp: (0.02 * (0.7 + 0.6 * rng())) / k, omega: advect + evolve, phi: rng() * Math.PI * 2 });
  }
  return out;
})();

export const waveUniforms = {
  uWaves: { value: waves.map((w) => new THREE.Vector4(w.kx, w.kz, w.amp, w.phi)) },
  uSunAir: { value: new THREE.Vector3(0, -1, 0) },   // direction the light travels above the surface
};

// Advance the waves (phases are wrapped in double precision on the CPU).
export function updateWaves(t) {
  waves.forEach((w, i) => { waveUniforms.uWaves.value[i].w = (w.phi + w.omega * t) % (Math.PI * 2); });
}

// Light set up as an underwater direction (as three.js lights are) -> the direction it travels in
// air before refracting at the surface (inverse Snell's law).
export function setSunDirection(dirTowardsLight) {
  const d = dirTowardsLight.clone().normalize(), h = Math.hypot(d.x, d.z);
  const sinAir = Math.min(0.995, h * 1.34);
  const cosAir = Math.sqrt(1 - sinAir * sinAir), sx = h > 1e-6 ? d.x / h : 0, sz = h > 1e-6 ? d.z / h : 0;
  waveUniforms.uSunAir.value.set(-sx * sinAir, -cosAir, -sz * sinAir);
}

const WAVE_GLSL = /* glsl */`
#define NWAVES ${NWAVES}
uniform vec4 uWaves[NWAVES];
vec2 waveGrad(vec2 p) {
  vec2 g = vec2(0.0);
  for (int i = 0; i < NWAVES; i++) { vec4 w = uWaves[i]; g += w.z * w.xy * cos(dot(w.xy, p) - w.w); }
  return g;
}
`;

// ---------- caustics ----------
//
// Caustics are simulated, not painted: every point of a fine grid on the wave surface refracts the
// light (Snell, per-channel IOR so the bright lines fringe slightly), the grid is projected onto a
// horizontal plane at depth D, and irradiance there is the ratio of a triangle's area on the surface
// to its area on the plane (energy conservation), times the Fresnel transmittance relative to flat
// water. Three depth layers are simulated because the pattern sharpens towards a focal depth and
// then breaks up. Surfaces look the pattern up along the flat-water refracted ray; the light
// source's angular size blurs it in proportion to depth (a soft sun / LED fixture).
const CAU_RES = 512;
const SEAWATER_IOR = [1.3370, 1.3405, 1.3445];   // ~650, 550, 450 nm
const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
white.needsUpdate = true;

export const causticUniforms = {
  uCau0: { value: white }, uCau1: { value: white }, uCau2: { value: white },
  uCauDepth: { value: new THREE.Vector3(2.8, 6.0, 9.2) },   // simulated depths below the surface (units)
  uCauR0: { value: new THREE.Vector3(0, -1, 0) },          // flat-water refracted light direction
  uCauTile: { value: WAVE_TILE },
  uCauBlur: { value: Math.tan(THREE.MathUtils.degToRad(0.35)) },   // light source angular radius (LED / halide)
  uCauOn: { value: 0 },                                    // 0 until a simulation runs (lab, bake)
};

// Irradiance multiplier for the direct light at world point p (mean 1 over the tile).
const CAUSTIC_LOOKUP_GLSL = /* glsl */`
uniform sampler2D uCau0;
uniform sampler2D uCau1;
uniform sampler2D uCau2;
uniform vec3 uCauDepth;
uniform vec3 uCauR0;
uniform float uCauTile;
uniform float uCauBlur;
uniform float uCauOn;
// lodBias > 0 looks up a softer pattern (used for light scattered in the volume).
vec3 causticAt(vec3 p, float lodBias) {
  if (uCauOn < 0.5) return vec3(1.0);
  float D = max(${SURFACE_Y.toFixed(2)} - p.y, 0.0);
  vec2 uv = (p.xz - uCauR0.xz * (D / -uCauR0.y)) / uCauTile;
  float lod = log2(max(1.0, D * uCauBlur / uCauTile * ${CAU_RES.toFixed(1)})) + lodBias;
  vec3 a = textureLod(uCau0, uv, lod).rgb, b = textureLod(uCau1, uv, lod).rgb, c = textureLod(uCau2, uv, lod).rgb;
  vec3 k = D < uCauDepth.y ? mix(a, b, clamp((D - uCauDepth.x) / (uCauDepth.y - uCauDepth.x), 0.0, 1.0))
                           : mix(b, c, clamp((D - uCauDepth.y) / (uCauDepth.z - uCauDepth.y), 0.0, 1.0));
  return mix(vec3(1.0), k, clamp(D / uCauDepth.x, 0.0, 1.0));   // focusing needs some depth
}
vec3 causticAt(vec3 p) { return causticAt(p, 0.0); }
`;

const CAUSTIC_SIM_VERT = WAVE_GLSL + /* glsl */`
uniform vec3 uSunAir;
uniform float uIor;
uniform float uDepth;
uniform float uTile;
varying vec2 vOld;
varying vec2 vNew;
varying float vT;
float fresnelT(vec3 I, vec3 n, vec3 T, float eta) {
  float ci = -dot(I, n), ct = -dot(T, n);
  float rs = (ci - eta * ct) / (ci + eta * ct), rp = (ct - eta * ci) / (ct + eta * ci);
  return 1.0 - 0.5 * (rs * rs + rp * rp);
}
void main() {
  vec2 xz = position.xz;
  vec2 g = waveGrad(xz);
  vec3 n = normalize(vec3(-g.x, 1.0, -g.y)), up = vec3(0.0, 1.0, 0.0);
  vec3 r = refract(uSunAir, n, 1.0 / uIor), r0 = refract(uSunAir, up, 1.0 / uIor);
  vec2 p = xz + r.xz * (uDepth / -r.y) - r0.xz * (uDepth / -r0.y);
  vOld = xz;
  vNew = p;
  vT = fresnelT(uSunAir, n, r, uIor) / fresnelT(uSunAir, up, r0, uIor);
  gl_Position = vec4(p / uTile * 2.0 - 1.0, 0.0, 1.0);
}
`;
const CAUSTIC_SIM_FRAG = /* glsl */`
uniform vec3 uChannel;
varying vec2 vOld;
varying vec2 vNew;
varying float vT;
float area(vec2 a, vec2 b) { return abs(a.x * b.y - a.y * b.x); }
void main() {
  float ratio = area(dFdx(vOld), dFdy(vOld)) / max(area(dFdx(vNew), dFdy(vNew)), 1e-12);
  gl_FragColor = vec4(uChannel * min(ratio, 40.0) * vT, 1.0);
}
`;

export class Caustics {
  constructor(renderer, { grid = 288 } = {}) {
    this.renderer = renderer;
    this.targets = [0, 1, 2].map(() => {
      const t = new THREE.WebGLRenderTarget(CAU_RES, CAU_RES, {
        type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true,
        wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
        minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
      });
      return t;
    });
    // The grid covers the tile plus a margin: light refracted in from the neighbouring (periodic)
    // tiles lands inside, and what leaves is counted by its periodic copy entering on the far side.
    const geo = new THREE.PlaneGeometry(WAVE_TILE * 1.5, WAVE_TILE * 1.5, grid, grid);
    geo.rotateX(-Math.PI / 2);
    geo.translate(WAVE_TILE / 2, 0, WAVE_TILE / 2);
    this.depth = { value: 0 };
    this.scene = new THREE.Scene();
    SEAWATER_IOR.forEach((ior, c) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...waveUniforms, uIor: { value: ior }, uDepth: this.depth, uTile: { value: WAVE_TILE },
          uChannel: { value: new THREE.Vector3(c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0) },
        },
        vertexShader: CAUSTIC_SIM_VERT, fragmentShader: CAUSTIC_SIM_FRAG,
        blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      });
      const m = new THREE.Mesh(geo, mat);
      m.frustumCulled = false;
      this.scene.add(m);
    });
    this.camera = new THREE.Camera();
    causticUniforms.uCau0.value = this.targets[0].texture;
    causticUniforms.uCau1.value = this.targets[1].texture;
    causticUniforms.uCau2.value = this.targets[2].texture;
    causticUniforms.uCauOn.value = 1;
  }

  update() {
    const r = this.renderer, prev = r.getRenderTarget(), clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    causticUniforms.uCauR0.value.copy(refractDir(waveUniforms.uSunAir.value, 1 / SEAWATER_IOR[1]));
    r.setClearColor(0x000000, 0);
    const D = causticUniforms.uCauDepth.value;
    [D.x, D.y, D.z].forEach((d, i) => {
      this.depth.value = d;
      r.setRenderTarget(this.targets[i]);
      r.clear(true, false, false);
      r.render(this.scene, this.camera);
    });
    r.setRenderTarget(prev);
    r.setClearColor(clear, alpha);
  }
}

// Snell refraction through a flat (y-up) surface, for a downward direction.
function refractDir(I, eta) {
  const ci = -I.y, k = 1 - eta * eta * (1 - ci * ci);
  return new THREE.Vector3(I.x * eta, I.y * eta - (Math.sqrt(Math.max(0, k)) - eta * ci), I.z * eta).normalize();
}

// Caustics modulate the direct (sun / fixture) light on any lit material, including the swimming fish:
// the irradiance multiplier is applied to each directional light before it is shaded, so shadows and
// the BRDF stay correct. Chains with an existing onBeforeCompile (swim shader, tissue light).
const LIGHTS_WITH_CAUSTICS = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= causticAt( vCW ) * rlSunFor( directionalLight.direction );');

export function addCaustics(mat) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    Object.assign(shader.uniforms, causticUniforms, reefLightUniforms);
    shader.vertexShader = 'varying vec3 vCW;\n' + shader.vertexShader.replace('#include <project_vertex>', `#include <project_vertex>
      {
        vec4 cw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cw = instanceMatrix * cw;
        #endif
        vCW = (modelMatrix * cw).xyz;
      }`);
    // ...and the baked reef light (reefLight.js): soft sun shadows of the reef, the share of the water's
    // ambient light a point can see, and the light the reef reflects onto it.
    shader.fragmentShader = 'varying vec3 vCW;\n' + CAUSTIC_LOOKUP_GLSL + REEF_LIGHT_GLSL
      + shader.fragmentShader.replace('#include <lights_fragment_begin>', REEF_LIGHT_EVAL + LIGHTS_WITH_CAUSTICS)
        .replace('#include <aomap_fragment>', REEF_LIGHT_APPLY);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|caustic';
  return mat;
}

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

// ---------- light shafts (volumetric single scattering) ----------
//
// The scene renders to an HDR target with depth; a final pass ray-marches each view ray through the
// water (from the glass to the first surface hit) and adds light that particles scatter towards the
// eye. Only the caustic *fluctuation* (C - 1) is added: the mean single scattering is already in the
// medium's inscatter term, so shafts brighten where the surface focuses light and dim between.
//   dL = b * p_HG(theta) * E_sun * exp(-c * d_light) * (C(x) - 1) * exp(-c * d_eye) * ds
// b: particle scattering (aquarium water with fine particulates), g = 0.75 forward-peaked phase.
const SHAFT_FRAG = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec3 uCamPos;
uniform vec3 uSunColor;
uniform float uScatter;
varying vec2 vUv;
const float PI4 = 12.566371;
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (PI4 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec3 col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  vec4 vp = uProjInv * vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vp /= vp.w;
  vec3 wp = (uViewInv * vp).xyz;
  vec3 rd = normalize(wp - uCamPos);
  float tEnd = d >= 0.99999 ? 30.0 : length(wp - uCamPos);
  float tStart = uCamPos.z > UW_GLASS ? (UW_GLASS - uCamPos.z) / min(rd.z, -1e-4) : 0.0;
  if (rd.y > 0.0) tEnd = min(tEnd, (UW_SURFACE - uCamPos.y) / rd.y);
  vec3 acc = vec3(0.0);
  if (tEnd > tStart && uCauOn > 0.5) {
    const int N = 20;   // jittered per pixel; the scattered pattern is soft, so few samples suffice
    float dt = (tEnd - tStart) / float(N), j = ign(gl_FragCoord.xy);
    float cosL = max(-uCauR0.y, 0.2);
    for (int i = 0; i < N; i++) {
      float t = tStart + (float(i) + j) * dt;
      vec3 p = uCamPos + rd * t;
      float D = UW_SURFACE - p.y;
      if (D < 0.0) continue;
      acc += (causticAt(p, 2.0) - 1.0) * exp(-UW_C * (D / cosL + t - tStart)) * dt;
    }
    float phase = 0.8 * hg(dot(uCauR0, -rd), 0.75) + 0.2 / PI4;
    acc *= uScatter * phase * uSunColor;
  }
  gl_FragColor = vec4(max(col + acc * UW_WB, 0.0), 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export class WaterRenderer {
  constructor(renderer, { scatterPerMetre = 0.35 } = {}) {
    this.renderer = renderer;
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.target.depthTexture = new THREE.DepthTexture(1, 1);
    this.uniforms = {
      ...causticUniforms,
      tColor: { value: this.target.texture }, tDepth: { value: this.target.depthTexture },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
      uScatter: { value: scatterPerMetre * METRES_PER_UNIT },
    };
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: UW_GLSL + CAUSTIC_LOOKUP_GLSL + SHAFT_FRAG,
    }));
    quad.frustumCulled = false;
    this.scene = new THREE.Scene();
    this.scene.add(quad);
    this.camera = new THREE.Camera();
    this._size = new THREE.Vector2();
  }

  // output: render target for the composited frame (e.g. PhotoCamera.begin()), or null for the screen.
  render(scene, camera, sun, output = null) {
    const r = this.renderer;
    r.getDrawingBufferSize(this._size);
    if (this.target.width !== this._size.x || this.target.height !== this._size.y) this.target.setSize(this._size.x, this._size.y);
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    r.setRenderTarget(null);
    const u = this.uniforms;
    u.uProjInv.value.copy(camera.projectionMatrixInverse);
    u.uViewInv.value.copy(camera.matrixWorld);
    u.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    u.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
    r.setRenderTarget(output);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
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

// The underside of the water surface, seen through the water. Exact Fresnel at the water-air
// boundary: beyond the 48.6 degree critical angle it is a perfect mirror of the tank (total internal
// reflection); inside Snell's window it shows the bright fixture above. At the shallow angles a
// viewer looks up through the front glass, the waves' slopes open the window only in flickers,
// which is the silvery, glinting ceiling of a real aquarium. Same waves as the caustics.
export function makeSurface(width) {
  const mat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, fog: false,
    uniforms: {
      ...waveUniforms, uLight: { value: 1 }, uBase: { value: INSCATTER_DAY.clone() },
      uSky: { value: new THREE.Color(2.4, 2.5, 2.6) }, uFloor: { value: new THREE.Color(0.30, 0.27, 0.21) },
    },
    vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position,1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: UW_GLSL + WAVE_GLSL + /* glsl */`
      uniform float uLight; uniform vec3 uBase; uniform vec3 uSky; uniform vec3 uFloor; varying vec3 vW;
      void main(){
        vec2 g = waveGrad(vW.xz);
        vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 v = normalize(vW - cameraPosition);
        float ci = max(dot(v, n), 1e-3), eta = 1.34, st2 = eta * eta * (1.0 - ci * ci);
        float R = 1.0;
        if (st2 < 1.0) {
          float ct = sqrt(1.0 - st2);
          float rs = (eta * ci - ct) / (eta * ci + ct), rp = (eta * ct - ci) / (eta * ct + ci);
          R = 0.5 * (rs * rs + rp * rp);
        }
        vec3 refl = reflect(v, n);
        // Mirror image of the tank: water radiance, plus the sunlit floor when reflected steeply down.
        vec3 below = uwInscatter(uBase, refl, UW_SURFACE)
          + uFloor * uLight * exp(-UW_KD * (UW_SURFACE - 1.0)) * smoothstep(-0.25, -0.9, refl.y) * 0.5;
        vec3 col = mix(uSky * uLight, below, R);
        vec3 T = exp(-UW_C * uwPath(vW, cameraPosition));
        gl_FragColor = vec4((col * T + uwInscatter(uBase, v, UW_SURFACE) * (1.0 - T)) * UW_WB, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
  const depth = GLASS_Z + 10;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(width * 1.8, depth), mat);
  m.rotation.x = Math.PI / 2;
  m.position.set(0, SURFACE_Y, GLASS_Z - depth / 2);
  return m;
}

