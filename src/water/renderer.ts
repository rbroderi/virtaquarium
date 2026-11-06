// Light shafts (volumetric single scattering) and motion blur.
//
// The scene renders to an HDR target with depth; a final pass ray-marches each view ray through the
// water (from the glass to the first surface hit) and adds light that particles scatter towards the
// eye. Only the caustic *fluctuation* (C - 1) is added: the mean single scattering is already in the
// medium's inscatter term, so shafts brighten where the surface focuses light and dim between.
//   dL = b * p_HG(theta) * E_sun * exp(-c * d_light) * (C(x) - 1) * exp(-c * d_eye) * ds
// b: particle scattering (aquarium water with fine particulates), g = 0.75 forward-peaked phase.
import * as THREE from 'three';
import { METRES_PER_UNIT, UW_GLSL } from './medium.js';
import { CAUSTIC_LOOKUP_GLSL, causticUniforms, type CausticUniforms } from './caustics.js';
import { isMesh } from './objectGuards.js';

const MSAA_SAMPLES = 4;
const DEFAULT_SCATTER_PER_METRE = 0.35;
/** Layer the velocity pass draws (the moving models enable it). */
const VELOCITY_LAYER = 1;

const SHAFT_FRAG = /* glsl */`
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform mat4 uProjInv;
uniform mat4 uViewInv;
uniform vec3 uCamPos;
uniform vec3 uSunColor;
uniform float uScatter;
uniform sampler2D tVel;
uniform float uBlur;
varying vec2 vUv;
const float PI4 = 12.566371;
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / (PI4 * pow(1.0 + g2 - 2.0 * g * c, 1.5)); }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  vec3 col = texture2D(tColor, vUv).rgb;
  float d = texture2D(tDepth, vUv).x;
  // Motion blur: where a moving fish is the visible surface, average the frame along its motion over
  // the shutter time (a video camera's ~1/100 s), centred on the pixel.
  if (uBlur > 0.0) {
    vec4 vel = texture2D(tVel, vUv);
    if (vel.w > 0.5 && abs(vel.z - d) < 0.0006) {
      vec2 v = vel.xy * uBlur;
      if (dot(v, v) > 1e-8) {
        vec3 acc = vec3(0.0);
        for (int i = 0; i < 7; i++) acc += texture2D(tColor, vUv + v * (float(i) / 6.0 - 0.5)).rgb;
        col = acc / 7.0;
      }
    }
  }
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

const VELOCITY_VERT = `uniform mat4 uPrevModel, uPrevVP; varying vec4 vCur, vPrev;
            void main() { vCur = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
              vPrev = uPrevVP * uPrevModel * vec4(position, 1.0); gl_Position = vCur; }`;
// Motion in texture units since the previous step, and this surface's depth (for the composite to
// blur only where the fish is what's seen).
const VELOCITY_FRAG = `varying vec4 vCur, vPrev;
            void main() { gl_FragColor = vec4((vCur.xy / vCur.w - vPrev.xy / vPrev.w) * 0.5, gl_FragCoord.z, 1.0); }`;

interface ShaftUniforms extends CausticUniforms {
  tColor: THREE.IUniform<THREE.Texture>;
  tDepth: THREE.IUniform<THREE.DepthTexture>;
  uProjInv: THREE.IUniform<THREE.Matrix4>;
  uViewInv: THREE.IUniform<THREE.Matrix4>;
  uCamPos: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  uScatter: THREE.IUniform<number>;
  tVel: THREE.IUniform<THREE.Texture | null>;
  uBlur: THREE.IUniform<number>;
}

interface VelocityUniforms {
  uPrevModel: THREE.IUniform<THREE.Matrix4>;
  uPrevVP: THREE.IUniform<THREE.Matrix4>;
}

/** The velocity pass, made on the first markPrev (only when motion blur is used). */
class VelocityPass {
  readonly target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
  readonly prevViewProjection = new THREE.Matrix4();
  readonly uniforms: VelocityUniforms = { uPrevModel: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() } };
  readonly material = new THREE.ShaderMaterial({
    side: THREE.DoubleSide, uniforms: { ...this.uniforms }, vertexShader: VELOCITY_VERT, fragmentShader: VELOCITY_FRAG,
  });
  private readonly scratch = new THREE.Matrix4();
  /** Each model's previous world matrix, and whether its meshes are hooked into the pass. */
  private readonly previousWorld = new WeakMap<THREE.Object3D, THREE.Matrix4>();

  /** Records the model's current pose as the previous one, hooking its meshes in the first time. */
  track(model: THREE.Object3D): void {
    model.updateMatrixWorld();
    const known = this.previousWorld.get(model);
    if (known) {
      known.copy(model.matrixWorld);
      return;
    }
    const prevWorld = model.matrixWorld.clone();
    this.previousWorld.set(model, prevWorld);
    this.hook(model, prevWorld);
  }

  // Velocity pass: these meshes (layer 1) with the velocity material; each draw sets its own previous
  // world matrix (the model's previous pose times the mesh's place in the model).
  private hook(model: THREE.Object3D, prevWorld: THREE.Matrix4): void {
    const inverse = new THREE.Matrix4();
    model.traverse((o) => {
      if (!isMesh(o)) return;
      o.layers.enable(VELOCITY_LAYER);
      const own = o.onBeforeRender;   // e.g. the fish body's level of detail (lod.ts pickLod)
      o.onBeforeRender = (renderer, scene, camera, geometry, material, group) => {
        own.call(o, renderer, scene, camera, geometry, material, group);
        if (material !== this.material) return;
        inverse.copy(model.matrixWorld).invert();
        this.uniforms.uPrevModel.value.multiplyMatrices(prevWorld, this.scratch.multiplyMatrices(inverse, o.matrixWorld));
        this.material.uniformsNeedUpdate = true;
      };
    });
  }
}

/** The sun as the shaft pass sees it: its colour times its intensity. */
export interface ShaftLight { readonly color: THREE.Color; readonly intensity: number }

export interface WaterRendererOptions { readonly scatterPerMetre?: number }

export class WaterRenderer {
  /** The HDR scene target (colour + depth); its depth texture feeds the photo and AO passes. */
  readonly target: THREE.WebGLRenderTarget & { depthTexture: THREE.DepthTexture };
  /** Shutter time / step time; 0 turns the motion blur off (the bake). Set by the caller. */
  blurScale = 0;
  private readonly uniforms: ShaftUniforms;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.Camera();
  private readonly size = new THREE.Vector2();
  private velocity: VelocityPass | null = null;

  constructor(private readonly renderer: THREE.WebGLRenderer, { scatterPerMetre = DEFAULT_SCATTER_PER_METRE }: WaterRendererOptions = {}) {
    const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: MSAA_SAMPLES });
    const depthTexture = new THREE.DepthTexture(1, 1);
    target.depthTexture = depthTexture;
    this.target = Object.assign(target, { depthTexture });
    this.uniforms = {
      ...causticUniforms,
      tColor: { value: target.texture }, tDepth: { value: depthTexture },
      uProjInv: { value: new THREE.Matrix4() }, uViewInv: { value: new THREE.Matrix4() },
      uCamPos: { value: new THREE.Vector3() }, uSunColor: { value: new THREE.Color() },
      uScatter: { value: scatterPerMetre * METRES_PER_UNIT },
      tVel: { value: null }, uBlur: { value: 0 },
    };
    const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: { ...this.uniforms }, depthTest: false, depthWrite: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: UW_GLSL + CAUSTIC_LOOKUP_GLSL + SHAFT_FRAG,
    }));
    quad.frustumCulled = false;
    this.scene.add(quad);
  }

  /**
   * Motion blur for moving models (the fish). Call at the start of each simulation step, before they
   * move, with the models and the camera: their poses now are the "previous" ones for the next render.
   */
  markPrev(models: Iterable<THREE.Object3D>, camera: THREE.Camera): void {
    if (!this.velocity) {
      this.velocity = new VelocityPass();
      this.uniforms.tVel.value = this.velocity.target.texture;
    }
    const pass = this.velocity;
    for (const model of models) pass.track(model);
    camera.updateMatrixWorld();
    pass.prevViewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  }

  /** output: render target for the composited frame (e.g. PhotoCamera.begin()), or null for the screen. */
  render(scene: THREE.Scene, camera: THREE.Camera, sun: ShaftLight, output: THREE.WebGLRenderTarget | null = null): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    if (this.target.width !== this.size.x || this.target.height !== this.size.y) this.target.setSize(this.size.x, this.size.y);
    r.setRenderTarget(this.target);
    r.render(scene, camera);
    const pass = this.velocity;
    const blur = pass !== null && this.blurScale > 0;
    this.uniforms.uBlur.value = blur ? this.blurScale : 0;
    if (pass && blur) this.renderVelocity(pass, scene, camera);
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

  private renderVelocity(pass: VelocityPass, scene: THREE.Scene, camera: THREE.Camera): void {
    const r = this.renderer;
    const w = Math.max(1, this.size.x >> 1), h = Math.max(1, this.size.y >> 1);
    if (pass.target.width !== w || pass.target.height !== h) pass.target.setSize(w, h);
    const mask = camera.layers.mask, background = scene.background;
    const clearColor = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
    pass.uniforms.uPrevVP.value.copy(pass.prevViewProjection);
    camera.layers.set(VELOCITY_LAYER);
    scene.overrideMaterial = pass.material;
    scene.background = null;
    r.setRenderTarget(pass.target);
    r.setClearColor(0x000000, 0);
    r.clear();
    const shadows = r.shadowMap.autoUpdate;
    r.shadowMap.autoUpdate = false;   // the main pass already drew them
    r.render(scene, camera);
    r.shadowMap.autoUpdate = shadows;
    scene.overrideMaterial = null;
    scene.background = background;
    camera.layers.mask = mask;
    r.setClearColor(clearColor, clearAlpha);
  }
}
