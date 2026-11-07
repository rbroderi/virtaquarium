// Caustics.
//
// Caustics are simulated, not painted: every point of a fine grid on the wave surface refracts the
// light (Snell, per-channel IOR so the bright lines fringe slightly), the grid is projected onto a
// horizontal plane at depth D, and irradiance there is the ratio of a triangle's area on the surface
// to its area on the plane (energy conservation), times the Fresnel transmittance relative to flat
// water. Three depth layers are simulated because the pattern sharpens towards a focal depth and
// then breaks up. Surfaces look the pattern up along the flat-water refracted ray; the light
// source's angular size blurs it in proportion to depth (a soft sun / LED fixture).
import * as THREE from 'three';
import { SURFACE_Y } from './medium.js';
import { WAVE_GLSL, WAVE_TILE, waveUniforms } from './waves.js';

export const CAUSTIC_RES = 512;
/** Seawater refractive index at ~650, 550, 450 nm. */
export const SEAWATER_IOR = [1.3370, 1.3405, 1.3445] as const;
export const GREEN_IOR = SEAWATER_IOR[1];
const DEPTH_LAYERS = 3;
const RGBA_BYTES = 4;
const DEFAULT_GRID = 288;
/** The simulated grid covers the tile plus a margin (see Caustics). */
const GRID_MARGIN = 1.5;
const LIGHT_SOURCE_RADIUS_DEG = 0.35;

// The three depth layers live in one texture array (layer = depth), so every lit material spends one
// texture unit on them, not three (fish shaders are at the GPU's 16 with the reef light and their maps).
function whiteLayers(): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(new Uint8Array(RGBA_BYTES * DEPTH_LAYERS).fill(255), 1, 1, DEPTH_LAYERS);
  texture.needsUpdate = true;
  return texture;
}

export interface CausticUniforms {
  uCau: THREE.IUniform<THREE.Texture>;
  uCauDepth: THREE.IUniform<THREE.Vector3>;
  uCauR0: THREE.IUniform<THREE.Vector3>;
  uCauTile: THREE.IUniform<number>;
  uCauBlur: THREE.IUniform<number>;
  uCauOn: THREE.IUniform<number>;
}

export const causticUniforms: CausticUniforms = {
  uCau: { value: whiteLayers() },
  uCauDepth: { value: new THREE.Vector3(2.8, 6.0, 9.2) },   // simulated depths below the surface (units)
  uCauR0: { value: new THREE.Vector3(0, -1, 0) },          // flat-water refracted light direction
  uCauTile: { value: WAVE_TILE },
  uCauBlur: { value: Math.tan(THREE.MathUtils.degToRad(LIGHT_SOURCE_RADIUS_DEG)) },   // light source angular radius (LED / halide)
  uCauOn: { value: 0 },                                    // 0 until a simulation runs (lab, bake)
};

/** Irradiance multiplier for the direct light at world point p (mean 1 over the tile). */
export const CAUSTIC_LOOKUP_GLSL = /* glsl */`
uniform highp sampler2DArray uCau;
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
  float lod = log2(max(1.0, D * uCauBlur / uCauTile * ${CAUSTIC_RES.toFixed(1)})) + lodBias;
  vec3 a = textureLod(uCau, vec3(uv, 0.0), lod).rgb, b = textureLod(uCau, vec3(uv, 1.0), lod).rgb, c = textureLod(uCau, vec3(uv, 2.0), lod).rgb;
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

export interface CausticsOptions {
  readonly grid?: number;
}

/** Snell refraction through a flat (y-up) surface, for a downward direction. */
export function refractDir(incident: THREE.Vector3, eta: number): THREE.Vector3 {
  const ci = -incident.y, k = 1 - eta * eta * (1 - ci * ci);
  return new THREE.Vector3(incident.x * eta, incident.y * eta - (Math.sqrt(Math.max(0, k)) - eta * ci), incident.z * eta).normalize();
}

const channelMask = (channel: number): THREE.Vector3 =>
  new THREE.Vector3(channel === 0 ? 1 : 0, channel === 1 ? 1 : 0, channel === 2 ? 1 : 0);

export class Caustics {
  private readonly target: THREE.WebGLArrayRenderTarget;
  private readonly depth: THREE.IUniform<number> = { value: 0 };
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();

  constructor(private readonly renderer: THREE.WebGLRenderer, { grid = DEFAULT_GRID }: CausticsOptions = {}) {
    // One layer per simulated depth (see causticUniforms).
    this.target = new THREE.WebGLArrayRenderTarget(CAUSTIC_RES, CAUSTIC_RES, DEPTH_LAYERS, {
      type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    });
    // The grid covers the tile plus a margin: light refracted in from the neighbouring (periodic)
    // tiles lands inside, and what leaves is counted by its periodic copy entering on the far side.
    const geo = new THREE.PlaneGeometry(WAVE_TILE * GRID_MARGIN, WAVE_TILE * GRID_MARGIN, grid, grid);
    geo.rotateX(-Math.PI / 2);
    geo.translate(WAVE_TILE / 2, 0, WAVE_TILE / 2);
    SEAWATER_IOR.forEach((ior, channel) => {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          ...waveUniforms, uIor: { value: ior }, uDepth: this.depth, uTile: { value: WAVE_TILE },
          uChannel: { value: channelMask(channel) },
        },
        vertexShader: CAUSTIC_SIM_VERT, fragmentShader: CAUSTIC_SIM_FRAG,
        blending: THREE.AdditiveBlending, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    });
    causticUniforms.uCau.value = this.target.texture;
    causticUniforms.uCauOn.value = 1;
  }

  /** Re-simulates the three depth layers for the current waves and light direction. */
  update(): void {
    const r = this.renderer, prev = r.getRenderTarget(), clear = r.getClearColor(new THREE.Color()), alpha = r.getClearAlpha();
    causticUniforms.uCauR0.value.copy(refractDir(waveUniforms.uSunAir.value, 1 / GREEN_IOR));
    r.setClearColor(0x000000, 0);
    const D = causticUniforms.uCauDepth.value;
    [D.x, D.y, D.z].forEach((d, layer) => {
      this.depth.value = d;
      r.setRenderTarget(this.target, layer);   // three re-derives the mipmaps after each render
      r.clear(true, false, false);
      r.render(this.scene, this.camera);
    });
    r.setRenderTarget(prev);
    r.setClearColor(clear, alpha);
  }
}
