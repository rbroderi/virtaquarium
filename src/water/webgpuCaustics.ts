// Caustics on the WebGPU path, in TSL. The WebGL path simulates the caustic irradiance field with a
// ShaderMaterial over a grid (src/water/caustics.ts) and reads it back in every lit material via an
// onBeforeCompile patch (src/water/materials.ts). WebGPURenderer never runs onBeforeCompile, so here:
//   - the simulation keeps the same forward-mapping construction: a fine grid's vertex stage projects
//     each surface point to where its refracted ray lands on the plane (per-channel IOR), and the
//     fragment stage divides the source/plane triangle areas from the interpolated dFdx/dFdy, so the
//     texture is indexed by plane position and its mean stays 1 (energy conservation). Three additive
//     channel passes per depth layer, exactly like the WebGL grid.
//   - the lookup becomes a custom DirectionalLightNode (registered for THREE.DirectionalLight in
//     app/stage.ts) that multiplies the sun's irradiance by the caustic factor at the surface point,
//     exactly where materials.ts patches directLight.color on the WebGL path.
import * as THREE from 'three';
import type { Node, ShaderNodeObject, UniformNode } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { tsl, type Tsl } from '../webgpu/tsl.js';
import { causticUniforms, CAUSTIC_RES, CAUSTIC_GAIN, CAUSTIC_LOW_LOD, GREEN_IOR, refractDir, SEAWATER_IOR } from './caustics.js';
import { SURFACE_Y } from './medium.js';
import { waveUniforms, WAVE_COUNT, WAVE_TILE } from './waves.js';

type NodeObject = ShaderNodeObject<Node>;
type Vec3UniformNode = ShaderNodeObject<UniformNode<THREE.Vector3>>;

const DEPTH_LAYERS = 3;
/** Sim grid: WAVE_TILE plus a margin so neighbours' refracted light lands inside (caustics.ts). */
const GRID = 288;
const GRID_MARGIN = 1.5;

/** What the caustic lookup (the light node) reads; set when a WebGpuCaustics is built. */
export interface GpuCausticState {
  readonly textures: readonly [THREE.Texture, THREE.Texture, THREE.Texture];
  readonly uCauR0: Vec3UniformNode;
  readonly uCauDepth: Vec3UniformNode;
  readonly uCauTile: ShaderNodeObject<UniformNode<number>>;
  readonly uCauBlur: ShaderNodeObject<UniformNode<number>>;
  readonly uCauOn: ShaderNodeObject<UniformNode<number>>;
}

let gpuCausticState: GpuCausticState | null = null;

/** The live caustic lookup state (set when a WebGpuCaustics is built), shared with the shaft pass. */
export function getGpuCausticState(): GpuCausticState | null {
  return gpuCausticState;
}

/** Twice the signed area of the triangle (0, a, b). */
function area2(a: NodeObject, b: NodeObject): NodeObject {
  return a.x.mul(b.y).sub(a.y.mul(b.x)).abs();
}

/** Fresnel transmittance through the flat interface (caustics.ts fresnelT). */
function fresnelT(I: NodeObject, n: NodeObject, r: NodeObject, eta: NodeObject): NodeObject {
  const ci = I.dot(n).negate();
  const ct = r.dot(n).negate();
  const rs = ci.sub(eta.mul(ct)).div(ci.add(eta.mul(ct)));
  const rp = ct.sub(eta.mul(ci)).div(ct.add(eta.mul(ci)));
  return rs.mul(rs).add(rp.mul(rp)).mul(0.5).oneMinus();
}

/** The wave surface gradient (waves.ts WAVE_GLSL), shared with the water surface. */
export function waveGradNode(t: Tsl): (p: NodeObject) => NodeObject {
  const waves = t.uniformArray(waveUniforms.uWaves.value as unknown as unknown[], 'vec4');
  return t.Fn(([p]: [NodeObject]) => {
    const g = t.vec2(0).toVar();
    t.Loop(WAVE_COUNT, ({ i }: { i: NodeObject }) => {
      const w = waves.element(i);
      g.addAssign(w.z.mul(w.xy).mul(t.cos(w.xy.dot(p).sub(w.w))));
    });
    return g;
  });
}

/** The caustic factor (vec3, mean ~1) at a world point, sampled from the three simulated depth layers. */
function causticAtNode(t: Tsl, s: GpuCausticState, lodBias = 0): (p: NodeObject) => NodeObject {
  const [texA, texB, texC] = s.textures;
  const depth = s.uCauDepth;
  const r0 = s.uCauR0;
  const tile = s.uCauTile;
  const blur = s.uCauBlur;
  const f = t.Fn(([p]: [NodeObject]) => {
    // Same lookup as caustics.ts CAUSTIC_LOOKUP_GLSL: walk the flat-water refracted ray back to the
    // surface, blur by the light source's angular size in proportion to depth (via the mip chain), then
    // divide by the pattern's own 1-unit blur (high-pass) and re-apply the fixed gain.
    const D = t.max(t.float(0), t.float(SURFACE_Y).sub(p.y));
    const uv = p.xz.sub(r0.xz.mul(D.div(r0.y.negate()))).div(tile);
    const lod = t.log2(t.max(t.float(1), D.mul(blur).div(tile).mul(t.float(CAUSTIC_RES)))).add(t.float(lodBias));
    const detail = (tex: THREE.Texture): NodeObject =>
      t.texture(tex, uv, lod).xyz.div(t.texture(tex, uv, t.float(CAUSTIC_LOW_LOD)).xyz.max(t.vec3(0.06)));
    const a = detail(texA);
    const b = detail(texB);
    const c = detail(texC);
    const k = t.select(
      D.lessThan(depth.y),
      t.mix(a, b, t.clamp(D.sub(depth.x).div(depth.y.sub(depth.x)), t.float(0), t.float(1))),
      t.mix(b, c, t.clamp(D.sub(depth.y).div(depth.z.sub(depth.y)), t.float(0), t.float(1))),
    );
    return t.mix(t.vec3(1), k, t.clamp(D.div(depth.x), t.float(0), t.float(1))).mul(t.float(CAUSTIC_GAIN));
  });
  return (p) => f(p);
}

/** The caustic lookup the shaft pass uses (lodBias 2, as causticAt(p, 2.0) in the WebGL shaft shader). */
export function shaftCausticNode(t: Tsl): (p: NodeObject) => NodeObject {
  const s = gpuCausticState;
  if (!s) return (p) => t.vec3(1);
  return causticAtNode(t, s, 2);
}

/** The caustic irradiance factor (vec3, mean ~1) at a world point, as the WebGL materials.ts patch
 *  applies it in lights_fragment_begin. Returns 1 when the simulation state is not built. */
export function causticFactorNode(t: Tsl): (p: NodeObject) => NodeObject {
  const s = gpuCausticState;
  if (!s) return (p) => t.vec3(1);
  return causticAtNode(t, s);
}

/** The sun light node registered for THREE.DirectionalLight in app/stage.ts. The caustic factor moved
 *  into the reef-light lighting model (reefLight/webgpu.ts direct), exactly where the WebGL patch
 *  multiplies directLight.color, so it reaches every wrapped material whether or not it receives a
 *  shadow. This node stays a plain DirectionalLightNode. */
export function causticDirectionalLightNode(t: Tsl): typeof t.DirectionalLightNode {
  return t.DirectionalLightNode;
}

export class WebGpuCaustics {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly targets: THREE.RenderTarget[];
  private readonly depth: ShaderNodeObject<UniformNode<number>>;
  private readonly r0 = new THREE.Vector3(0, -1, 0);

  constructor(private readonly renderer: WebGPURenderer) {
    const t = tsl();
    this.depth = t.uniform(0);
    // One target per simulated depth layer (caustics.ts causticUniforms.uCauDepth), each with the same
    // properties the WebGL path's caustic field is now really sampled with (caustics.ts re-applies them
    // after three r170's WebGLArrayRenderTarget dropped them): half-float, linear, repeat-wrapped and
    // mipped. The high-pass + gain in causticAtNode below divide the pattern by its own 1-unit blur, so
    // the HDR field and its mip chain must match the WebGL reference exactly.
    this.targets = Array.from({ length: DEPTH_LAYERS }, () => new THREE.RenderTarget(CAUSTIC_RES, CAUSTIC_RES, {
      type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: true,
      wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping,
      minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
    }));

    this.buildSim(t);

    gpuCausticState = {
      textures: this.targets.map((target) => target.texture) as [THREE.Texture, THREE.Texture, THREE.Texture],
      uCauR0: t.uniform(this.r0),
      uCauDepth: t.uniform(causticUniforms.uCauDepth.value),
      uCauTile: t.uniform(causticUniforms.uCauTile.value),
      uCauBlur: t.uniform(causticUniforms.uCauBlur.value),
      uCauOn: t.uniform(1),
    };
  }

  /** The grid simulation (caustics.ts): one additive mesh per colour channel, projecting surface
   *  points to their refracted plane positions and dividing source/plane triangle areas. The vertex
   *  stage places each grid vertex at its refracted plane position (clip space), so the fragment's
   *  screenUV is the plane coordinate; the fragment reads the interpolated surface coordinate from
   *  positionLocal and divides the two screen-space derivative areas (the same construction as the
   *  WebGL grid, without custom varyings). */
  private buildSim(t: Tsl): void {
    const uSunAir = t.uniform(waveUniforms.uSunAir.value) as unknown as NodeObject;
    const uDepth = this.depth;
    const uTile = t.uniform(WAVE_TILE);

    const waveGrad = waveGradNode(t);

    const geo = new THREE.PlaneGeometry(WAVE_TILE * GRID_MARGIN, WAVE_TILE * GRID_MARGIN, GRID, GRID);
    geo.rotateX(-Math.PI / 2);
    geo.translate(WAVE_TILE / 2, 0, WAVE_TILE / 2);

    const up = t.vec3(0, 1, 0);
    for (let c = 0; c < 3; c++) {
      const eta = t.float(1 / (SEAWATER_IOR[c] as number)) as unknown as NodeObject;
      const mask = new THREE.Vector3(c === 0 ? 1 : 0, c === 1 ? 1 : 0, c === 2 ? 1 : 0);

      const material = new t.NodeMaterial();
      material.vertexNode = t.Fn(() => {
        const p = t.positionGeometry.xz as unknown as NodeObject;
        const g = waveGrad(p) as unknown as NodeObject;
        const n = t.vec3(g.x.negate(), t.float(1), g.y.negate()).normalize() as unknown as NodeObject;
        const r = t.refract(uSunAir, n, eta) as unknown as NodeObject;
        const r0 = t.refract(uSunAir, up, eta) as unknown as NodeObject;
        const q = p.add(r.xz.mul(uDepth.div(r.y.negate()))).sub(r0.xz.mul(uDepth.div(r0.y.negate()))) as unknown as NodeObject;
        return t.vec4(q.div(uTile).mul(t.float(2)).sub(t.float(1)), t.float(0), t.float(1));
      })();
      material.fragmentNode = t.Fn(() => {
        // positionLocal is the interpolated surface point; screenUV * uTile is the plane point the
        // vertex was placed at (clip = q/uTile*2-1), so their derivatives give the area ratio.
        const p = t.positionLocal.xz as unknown as NodeObject;
        const q = t.screenUV.mul(uTile) as unknown as NodeObject;
        const g = waveGrad(p) as unknown as NodeObject;
        const n = t.vec3(g.x.negate(), t.float(1), g.y.negate()).normalize() as unknown as NodeObject;
        const r = t.refract(uSunAir, n, eta) as unknown as NodeObject;
        const r0 = t.refract(uSunAir, up, eta) as unknown as NodeObject;
        const vT = fresnelT(uSunAir, n, r, eta).div(fresnelT(uSunAir, up, r0, eta));
        const ratio = area2(p.dFdx(), p.dFdy()).div(area2(q.dFdx(), q.dFdy()).max(t.float(1e-12)));
        return t.vec3(mask.x, mask.y, mask.z).mul(ratio.min(t.float(40))).mul(vT);
      })();
      material.transparent = true;
      material.blending = THREE.AdditiveBlending;
      material.depthWrite = false;
      material.depthTest = false;
      material.fog = false;
      material.side = THREE.DoubleSide;

      const mesh = new THREE.Mesh(geo, material);
      mesh.frustumCulled = false;
      this.scene.add(mesh);
    }
  }

  /** Re-simulates the three depth layers for the current waves and light direction. */
  update(): void {
    this.r0.copy(refractDir(waveUniforms.uSunAir.value, 1 / GREEN_IOR));
    const prevTarget = this.renderer.getRenderTarget();
    const prevMRT = this.renderer.getMRT();
    // The common renderer's clear-colour accessors are typed against the internal Color4; the runtime
    // accepts the same Color/number shapes the WebGL renderer does.
    const r = this.renderer as unknown as {
      getClearColor(t: THREE.Color): THREE.Color;
      setClearColor(c: THREE.Color | number, a?: number): void;
      getClearAlpha(): number;
    };
    const clearColor = r.getClearColor(new THREE.Color());
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    // Clear through render()'s own pass (autoClear), not renderer.clear(): three r170's clear() binds a
    // view over every mip level of the target, which WebGPU rejects for these mipped targets, so the
    // whole command buffer (the simulation draw included) was dropped. render() binds mip 0 only.
    const { autoClear, autoClearColor, autoClearDepth, autoClearStencil } = this.renderer;
    Object.assign(this.renderer, { autoClear: true, autoClearColor: true, autoClearDepth: false, autoClearStencil: false });
    this.targets.forEach((target, layer) => {
      this.depth.value = causticUniforms.uCauDepth.value.getComponent(layer);
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.camera);
    });
    Object.assign(this.renderer, { autoClear, autoClearColor, autoClearDepth, autoClearStencil });
    r.setClearColor(clearColor, clearAlpha);
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setMRT(prevMRT);
  }
}
