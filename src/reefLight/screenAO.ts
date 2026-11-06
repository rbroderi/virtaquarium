// Live screen-space ambient occlusion.
//
// Hemisphere AO from the last frame's depth (WaterRenderer's HDR target), at half resolution with a
// depth-aware blur. Materials read it for their ambient light only, so sunlit tops stay bright.
import * as THREE from 'three';
import { reefLightUniforms } from './uniforms.js';

const DEFAULT_RADIUS = 0.3;
const DEFAULT_STRENGTH = 0.65;
const RESOLUTION_DIVISOR = 2;

const AO_FRAG = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProj, uProjInv;
uniform vec2 uTexel;
uniform float uRadius, uStrength;
varying vec2 vUv;
vec3 vpos(vec2 uv) { float d = texture2D(tDepth, uv).x; vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  if (texture2D(tDepth, vUv).x >= 0.9999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = vpos(vUv);
  vec3 dx1 = vpos(vUv + vec2(uTexel.x, 0.0)) - P, dx0 = P - vpos(vUv - vec2(uTexel.x, 0.0));
  vec3 dy1 = vpos(vUv + vec2(0.0, uTexel.y)) - P, dy0 = P - vpos(vUv - vec2(0.0, uTexel.y));
  vec3 N = normalize(cross(abs(dx1.z) < abs(dx0.z) ? dx1 : dx0, abs(dy1.z) < abs(dy0.z) ? dy1 : dy0));
  if (dot(N, P) > 0.0) N = -N;   // towards the eye (view space)
  vec3 T = normalize(abs(N.x) < 0.9 ? cross(N, vec3(1.0, 0.0, 0.0)) : cross(N, vec3(0.0, 1.0, 0.0))), Bt = cross(N, T);
  float a0 = ign(gl_FragCoord.xy) * 6.2831853, j = ign(gl_FragCoord.yx + 17.0), occ = 0.0;
  const int K = 12;
  for (int i = 0; i < K; i++) {
    float f = (float(i) + 0.5) / float(K), r = sqrt(f), th = a0 + float(i) * 2.399963;
    vec3 dir = T * cos(th) * r + Bt * sin(th) * r + N * sqrt(1.0 - f);   // cosine-weighted
    vec3 S = P + dir * uRadius * mix(0.15, 1.0, fract(f * 7.13 + j));
    vec4 c = uProj * vec4(S, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
    float sz = vpos(uv).z;
    occ += (sz >= S.z + 0.01 ? 1.0 : 0.0) * smoothstep(0.0, 1.0, uRadius / max(1e-3, abs(P.z - sz)));
  }
  gl_FragColor = vec4(vec3(1.0 - uStrength * occ / float(K)), 1.0);
}`;
const BLUR_FRAG = /* glsl */`
uniform sampler2D tAO, tDepth;
uniform mat4 uProjInv;
uniform vec2 uStep;
varying vec2 vUv;
float lz(vec2 uv) { vec4 p = uProjInv * vec4(0.0, 0.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0); return p.z / p.w; }
void main() {
  float z0 = lz(vUv), s = 0.0, w = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + uStep * float(i);
    float g = exp(-float(i * i) / 8.0) * exp(-abs(lz(uv) - z0) * 6.0);
    s += texture2D(tAO, uv).r * g; w += g;
  }
  gl_FragColor = vec4(vec3(s / w), 1.0);
}`;
const FULLSCREEN_UV_VERT = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';

interface AOUniforms {
  tDepth: THREE.IUniform<THREE.Texture | null>;
  uProj: THREE.IUniform<THREE.Matrix4>;
  uProjInv: THREE.IUniform<THREE.Matrix4>;
  uTexel: THREE.IUniform<THREE.Vector2>;
  uRadius: THREE.IUniform<number>;
  uStrength: THREE.IUniform<number>;
}

interface BlurUniforms {
  tAO: THREE.IUniform<THREE.Texture | null>;
  tDepth: THREE.IUniform<THREE.Texture | null>;
  uProjInv: THREE.IUniform<THREE.Matrix4>;
  uStep: THREE.IUniform<THREE.Vector2>;
}

export interface ScreenAOOptions { readonly radius?: number; readonly strength?: number }

export class ScreenAO {
  private readonly targets: readonly [THREE.WebGLRenderTarget, THREE.WebGLRenderTarget];
  private readonly aoUniforms: AOUniforms;
  private readonly blurUniforms: BlurUniforms;
  private readonly ao: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh<THREE.PlaneGeometry, THREE.Material>;
  private readonly scene: THREE.Scene;
  private readonly camera = new THREE.Camera();
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer, { radius = DEFAULT_RADIUS, strength = DEFAULT_STRENGTH }: ScreenAOOptions = {}) {
    const halfFloatTarget = (): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false });
    this.targets = [halfFloatTarget(), halfFloatTarget()];
    this.aoUniforms = {
      tDepth: { value: null }, uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() },
      uTexel: { value: new THREE.Vector2() }, uRadius: { value: radius }, uStrength: { value: strength },
    };
    this.ao = new THREE.ShaderMaterial({
      uniforms: { ...this.aoUniforms }, vertexShader: FULLSCREEN_UV_VERT, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
    });
    this.blurUniforms = { tAO: { value: null }, tDepth: { value: null }, uProjInv: this.aoUniforms.uProjInv, uStep: { value: new THREE.Vector2() } };
    this.blur = new THREE.ShaderMaterial({
      uniforms: { ...this.blurUniforms }, vertexShader: FULLSCREEN_UV_VERT, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(new THREE.PlaneGeometry(2, 2), this.ao);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene().add(this.quad);
  }

  /** Computes AO from the frame's depth and publishes it to the reef light uniforms (read next frame). */
  update(depthTexture: THREE.Texture, camera: THREE.Camera): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.ceil(this.size.x / RESOLUTION_DIVISOR)), h = Math.max(1, Math.ceil(this.size.y / RESOLUTION_DIVISOR));
    for (const t of this.targets) if (t.width !== w || t.height !== h) t.setSize(w, h);
    const prev = r.getRenderTarget();
    const a = this.aoUniforms;
    a.tDepth.value = depthTexture;
    a.uProj.value.copy(camera.projectionMatrix); a.uProjInv.value.copy(camera.projectionMatrixInverse);
    a.uTexel.value.set(1 / w, 1 / h);
    const draw = (mat: THREE.Material, target: THREE.WebGLRenderTarget): void => {
      this.quad.material = mat; r.setRenderTarget(target); r.render(this.scene, this.camera);
    };
    const [first, second] = this.targets;
    draw(this.ao, first);
    const b = this.blurUniforms;
    b.tDepth.value = depthTexture;
    b.tAO.value = first.texture; b.uStep.value.set(1 / w, 0); draw(this.blur, second);
    b.tAO.value = second.texture; b.uStep.value.set(0, 1 / h); draw(this.blur, first);
    r.setRenderTarget(prev);
    const L = reefLightUniforms;
    L.uRLAO.value = first.texture;
    L.uRLAOInv.value.set(1 / this.size.x, 1 / this.size.y);
    L.uRLAOOn.value = 1;
  }
}
