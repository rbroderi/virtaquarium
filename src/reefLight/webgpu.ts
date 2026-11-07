// The baked reef light on the WebGPU path, in TSL. The WebGL path (reefLight/glsl.ts + water/materials.ts
// addCaustics) reads the baked terms through an onBeforeCompile patch; WebGPURenderer never runs that,
// so the same evaluation lives in a wrapping PhysicalLightingModel installed by installReefLight:
//   - start() evaluates the screen bake (project + depth test) or the 3D grid (SH sky/bounce/sun terms)
//     into rlSky / rlBounce / rlSun, exactly like rlEval().
//   - direct() multiplies the sun's direct light by rlSunFor() (the baked soft sun shadow), alongside the
//     caustic factor the caustics light node already applied.
//   - indirect() applies REEF_LIGHT_APPLY after the wrapped model's ambient accumulation. Reef materials
//     carry no aoMap, so the multiplication matches WebGL exactly; fish (whose cavity AO lives in their
//     lighting model) differ only in that the small bounce term is not cavity-occluded.
// Screen AO (uRLAOOn) stays off under WebGPU (ScreenAO is WebGL-only), but the term is kept for parity.
import * as THREE from 'three';
import type {
  LightingModelDirectInput, LightingModelIndirectInput, Node, NodeBuilder,
  ShaderNodeObject, StackNode, TextureNode,
} from 'three/webgpu';
import { tsl, type Tsl } from '../webgpu/tsl.js';
import { reefLightUniforms } from './uniforms.js';

type NodeObject = ShaderNodeObject<Node>;
type TextureNodeObject = ShaderNodeObject<TextureNode>;

const RL_Y = [0.2126, 0.7152, 0.0722] as const;

/** A lighting model the reef light wraps (the material's own: stock, translucency or the fish's). */
type InnerLightingModel = InstanceType<Tsl['PhysicalLightingModel']>;

/** The live uniform nodes; the bake/cache replaces the map textures and mutates the rest in place. */
interface GpuReefLightState {
  readonly grid: NodeObject;
  readonly scr: NodeObject;
  readonly ao: NodeObject;
  readonly uRLMin: NodeObject;
  readonly uRLSize: NodeObject;
  readonly uRLRes: NodeObject;
  readonly uRLSunDir: NodeObject;
  readonly uRLScrVP: NodeObject;
  readonly uRLScrEye: NodeObject;
  readonly uRLTiles: NodeObject;
  readonly uRLCell: NodeObject;
  readonly uRLOn: NodeObject;
  readonly uRLLight: NodeObject;
  readonly uRLScrOn: NodeObject;
  readonly uRLAOOn: NodeObject;
}

let state: GpuReefLightState | null = null;

/** Keeps a texture node in sync with the uniform the bake/cache replaces (see uniforms.ts replaceMap). */
function bridgeTexture(name: 'uRLGrid' | 'uRLScr' | 'uRLAO', node: NodeObject): void {
  const uniform = reefLightUniforms[name];
  const tex = node as unknown as { value: THREE.Texture };
  Object.defineProperty(uniform, 'value', {
    get: (): THREE.Texture => tex.value,
    set: (v: THREE.Texture): void => { tex.value = v; },
    configurable: true, enumerable: true,
  });
}

/** The live reef-light uniform nodes, created once before the bake runs so replaceMap feeds them. */
function getGpuReefLight(t: Tsl): GpuReefLightState {
  if (state) return state;
  const grid = t.texture(reefLightUniforms.uRLGrid.value) as unknown as NodeObject;
  const scr = t.texture(reefLightUniforms.uRLScr.value) as unknown as NodeObject;
  const ao = t.texture(reefLightUniforms.uRLAO.value) as unknown as NodeObject;
  bridgeTexture('uRLGrid', grid);
  bridgeTexture('uRLScr', scr);
  bridgeTexture('uRLAO', ao);
  // Vectors/matrices are mutated in place, so a uniform node over the same object stays live; scalars
  // are replaced, so they read the uniform's value back by reference each render.
  state = {
    grid, scr, ao,
    uRLMin: t.uniform(reefLightUniforms.uRLMin.value) as unknown as NodeObject,
    uRLSize: t.uniform(reefLightUniforms.uRLSize.value) as unknown as NodeObject,
    uRLRes: t.uniform(reefLightUniforms.uRLRes.value) as unknown as NodeObject,
    uRLSunDir: t.uniform(reefLightUniforms.uRLSunDir.value) as unknown as NodeObject,
    uRLScrVP: t.uniform(reefLightUniforms.uRLScrVP.value) as unknown as NodeObject,
    uRLScrEye: t.uniform(reefLightUniforms.uRLScrEye.value) as unknown as NodeObject,
    uRLTiles: t.reference('uRLTiles.value', 'float', reefLightUniforms) as unknown as NodeObject,
    uRLCell: t.reference('uRLCell.value', 'float', reefLightUniforms) as unknown as NodeObject,
    uRLOn: t.reference('uRLOn.value', 'float', reefLightUniforms) as unknown as NodeObject,
    uRLLight: t.reference('uRLLight.value', 'float', reefLightUniforms) as unknown as NodeObject,
    uRLScrOn: t.reference('uRLScrOn.value', 'float', reefLightUniforms) as unknown as NodeObject,
    uRLAOOn: t.reference('uRLAOOn.value', 'float', reefLightUniforms) as unknown as NodeObject,
  };
  return state;
}

/** Trilinear lookup in the grid's 2D atlas, in layer `layer` of the texture array (reefLight/glsl.ts). */
function rlAtlas(t: Tsl, tex: NodeObject, layer: number): (p01: NodeObject, res: NodeObject, tiles: NodeObject) => NodeObject {
  const layerI = t.int(layer);
  const sampler = tex as unknown as TextureNodeObject;
  const sample = (uv: NodeObject): NodeObject => (sampler.uv(uv) as unknown as TextureNodeObject).depth(layerI);
  return t.Fn(([p01, res, tiles]: [NodeObject, NodeObject, NodeObject]) => {
    const c = p01.mul(res).sub(t.float(0.5));
    const z0 = t.floor(c.z).clamp(t.float(0), res.z.sub(t.float(1)));
    const z1 = t.min(z0.add(t.float(1)), res.z.sub(t.float(1)));
    const atlas = res.xy.mul(t.vec2(tiles, t.ceil(res.z.div(tiles))));
    const cxy = c.xy.clamp(t.vec2(0), res.xy.sub(t.float(1))).add(t.float(0.5));
    const t0 = t.vec2(t.mod(z0, tiles), t.floor(z0.div(tiles)));
    const t1 = t.vec2(t.mod(z1, tiles), t.floor(z1.div(tiles)));
    const uv0 = t0.mul(res.xy).add(cxy).div(atlas);
    const uv1 = t1.mul(res.xy).add(cxy).div(atlas);
    return t.mix(sample(uv0), sample(uv1), t.clamp(c.z.sub(z0), t.float(0), t.float(1)));
  });
}

/** A PhysicalLightingModel wrapper that applies the baked reef light around `inner`. */
function reefLightLightingModel(t: Tsl, inner: InnerLightingModel): InnerLightingModel {
  const s = getGpuReefLight(t);
  const [atlasA, atlasB, atlasC] = [rlAtlas(t, s.grid, 0), rlAtlas(t, s.grid, 1), rlAtlas(t, s.grid, 2)];
  const scrTex = s.scr as unknown as TextureNodeObject;
  const aoTex = s.ao as unknown as TextureNodeObject;
  const scrSample = (uv: NodeObject, layer: number): NodeObject =>
    (scrTex.uv(uv) as unknown as TextureNodeObject).depth(t.int(layer));
  class ReefLightLightingModel extends t.PhysicalLightingModel {
    private rlSky: NodeObject = t.float(1).toVar('rlSky');
    private rlBounce: NodeObject = t.vec3(0).toVar('rlBounce');
    private rlSun: NodeObject = t.float(1).toVar('rlSun');

    override start(input: LightingModelIndirectInput, stack: StackNode, builder: NodeBuilder): void {
      inner.start(input, stack, builder);
      const pw = t.positionWorld as unknown as NodeObject;
      // Read the world normal HERE, in the function's own flow. transformedNormalWorld is a lazy TSL
      // var: its declaration lands at the function top but its assignment is emitted at the first
      // read, and every read below sits inside the uniform gate. With the gate closed (reef light off)
      // nothing ever initialised it, so the environment IBL's getFace(), the shadow bias term and the
      // grid lookups all saw (0,0,0): the whole reef went dark under the sun and rendered the env's
      // seam colour. Reading it before the branch emits the assignment outside it.
      const nw = (t.transformedNormalWorld as unknown as NodeObject).toVar('rlWorldNormal');
      // The on/off gate is uniform (uRLOn), so this branch is fine; inside it WGSL still forbids
      // textureSample in divergent (per-pixel) control flow, so every sample is taken unconditionally
      // at clamped coordinates and the branch results are selected afterwards. Sampling outside the
      // gate with the bake off also wedged the D3D12 device, so keep all of it inside the uniform If.
      const on = s.uRLOn.greaterThan(t.float(0.5));
      t.If(on, () => {
      const p = pw.add(nw.mul(s.uRLCell.mul(t.float(1.5)))).sub(s.uRLMin).div(s.uRLSize) as unknown as NodeObject;
      const insideBox = p.x.greaterThanEqual(t.float(0)).and(p.y.greaterThanEqual(t.float(0))).and(p.z.greaterThanEqual(t.float(0)))
        .and(p.x.lessThanEqual(t.float(1))).and(p.y.lessThanEqual(t.float(1))).and(p.z.lessThanEqual(t.float(1)));
      const pc = p.clamp(t.float(0), t.float(1)) as unknown as NodeObject;
      const A = atlasA(pc, s.uRLRes, s.uRLTiles) as unknown as NodeObject;
      const B = atlasB(pc, s.uRLRes, s.uRLTiles) as unknown as NodeObject;
      const C = atlasC(pc, s.uRLRes, s.uRLTiles) as unknown as NodeObject;
      // L1 projection of max(0, n.d) over the sphere: 1/4 + n.d/2 (open water gives 1).
      const skyGrid = A.x.add(t.float(2).mul(A.yzw.dot(nw))).clamp(t.float(0), t.float(1)) as unknown as NodeObject;
      const cl = C.rgb.dot(t.vec3(RL_Y[0], RL_Y[1], RL_Y[2])) as unknown as NodeObject;
      const bounceGrid = t.select(cl.greaterThan(t.float(1e-6)),
        C.rgb.div(cl).mul(t.max(t.float(0), B.x.add(t.float(2).mul(B.yzw.dot(nw))))),
        t.vec3(0)) as unknown as NodeObject;
      const sunGrid = C.a as unknown as NodeObject;

      // The screen bake: its pixel by projecting into the rest view, checked against the baked depth.
      const clip = s.uRLScrVP.mul(t.vec4(pw, t.float(1))) as unknown as NodeObject;
      const ndcUV = clip.xy.div(clip.w).mul(t.float(0.5)).add(t.float(0.5)) as unknown as NodeObject;
      const scrUV = ndcUV.clamp(t.float(0), t.float(1)) as unknown as NodeObject;
      const b = scrSample(scrUV, 1) as unknown as NodeObject;
      const a = scrSample(scrUV, 0) as unknown as NodeObject;
      const dist = t.length(pw.sub(s.uRLScrEye)) as unknown as NodeObject;
      const inScreen = s.uRLScrOn.greaterThan(t.float(0.5)).and(clip.w.greaterThan(t.float(0)))
        .and(ndcUV.x.greaterThan(t.float(0))).and(ndcUV.x.lessThan(t.float(1)))
        .and(ndcUV.y.greaterThan(t.float(0))).and(ndcUV.y.lessThan(t.float(1)))
        .and(t.abs(b.g.sub(dist)).lessThan(t.float(0.03).add(t.float(0.004).mul(dist))));
      const useGrid = insideBox.and(inScreen.not());
      this.rlSky.assign(t.select(inScreen, a.a, t.select(useGrid, skyGrid, t.float(1))));
      this.rlBounce.assign(t.select(inScreen, a.rgb, t.select(useGrid, bounceGrid, t.vec3(0))));
      this.rlSun.assign(t.select(inScreen, b.r, t.select(useGrid, sunGrid, t.float(1))));
      });
      // Screen AO: off under WebGPU (ScreenAO is WebGL-only), kept for parity.
      t.If(s.uRLAOOn.greaterThan(t.float(0.5)), () => {
        const ao = aoTex.uv(t.screenUV).r;
        this.rlSky.assign(this.rlSky.mul(ao));
        this.rlBounce.assign(this.rlBounce.mul(ao));
      });
    }

    override direct(input: LightingModelDirectInput, stack: StackNode, builder: NodeBuilder): void {
      // Baked soft shadow on the key light only (rlSunFor): the LED fills stay unshadowed.
      const dirWorld = t.cameraWorldMatrix.mul(t.vec4(input.lightDirection, t.float(0))).xyz.normalize() as unknown as NodeObject;
      const isSun = dirWorld.dot(s.uRLSunDir).greaterThan(t.float(0.999));
      input.lightColor = (input.lightColor as unknown as NodeObject).mul(t.select(isSun, this.rlSun, t.float(1)));
      inner.direct(input, stack, builder);
    }

    override indirect(input: LightingModelIndirectInput, stack: StackNode, builder: NodeBuilder): void {
      inner.indirect(input, stack, builder);
      // REEF_LIGHT_APPLY (reefLight/glsl.ts): the ambient is occluded by rlSky and the bounce added; the
      // specular occlusion commutes with the material AO, so the ordering is exact.
      const id = input.reflectedLight.indirectDiffuse as unknown as NodeObject;
      id.assign(id.mul(this.rlSky).add(t.diffuseColor.rgb.mul(this.rlBounce).mul(s.uRLLight)));
      const is = input.reflectedLight.indirectSpecular as unknown as NodeObject;
      is.assign(is.mul(t.mix(t.float(1), this.rlSky, t.float(0.8))));
    }

    override finish(input: LightingModelIndirectInput, stack: StackNode, builder: NodeBuilder): void {
      inner.finish(input, stack, builder);
    }
  }
  return new ReefLightLightingModel();
}

/** Installs the baked reef light on a lit material's node lighting model (WebGL path: addCaustics). */
export function installReefLight<M extends THREE.Material>(mat: M): M {
  const t = tsl();
  const nodeMat = mat as unknown as {
    setupLightingModel?: () => InnerLightingModel;
    customProgramCacheKey: () => string;
  };
  const prev = nodeMat.setupLightingModel?.bind(mat);
  nodeMat.setupLightingModel = () => {
    const inner = prev ? prev() : new t.PhysicalLightingModel();
    return reefLightLightingModel(t, inner);
  };
  const prevKey = nodeMat.customProgramCacheKey.bind(mat);
  nodeMat.customProgramCacheKey = () => prevKey() + '|reeflight';
  return mat;
}
