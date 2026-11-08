// The crystal's glass shader on the WebGPU path, in TSL (the WebGL path is crystal.ts's
// onBeforeCompile patch, which WebGPURenderer never runs). The same sub-frustum transmission
// background, the face's etched/frosted mask and its faint inner edge, plus native iridescence.
import * as THREE from 'three';
import type {
  LightingModelIndirectInput, Node, NodeBuilder, ShaderNodeObject, StackNode,
} from 'three/webgpu';
import { tsl, type Tsl } from '../webgpu/tsl.js';
import { installReefLight } from '../reefLight/webgpu.js';
import { crystalBgUniforms } from './crystalBg.js';

type NodeObject = ShaderNodeObject<Node>;
/** A texture node re-sampleable at an explicit uv (the `.uv()` keeps the node's link). */
type UvSamplerNode = NodeObject & { uv(uv: NodeObject): NodeObject };

const CRYSTAL_IOR = 1.54;

interface GpuCrystalBg {
  readonly tex: UvSamplerNode;
  readonly proj: NodeObject;
}

let bg: GpuCrystalBg | null = null;

/** The shared sub-frustum background texture and projection matrix, bridged to TSL once. */
function crystalBgNodes(t: Tsl): GpuCrystalBg {
  if (bg) return bg;
  const placeholder = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
  placeholder.needsUpdate = true;
  const tex = t.texture(placeholder) as unknown as UvSamplerNode;
  // The background texture is replaced every frame (crystalBg.ts); bridge it so the node follows.
  Object.defineProperty(crystalBgUniforms.uCrystalBg, 'value', {
    get: (): THREE.Texture | null => (tex as unknown as { value: THREE.Texture | null }).value,
    set: (v: THREE.Texture | null): void => { (tex as unknown as { value: THREE.Texture | null }).value = v; },
    configurable: true,
    enumerable: true,
  });
  // The projection is a Matrix4 mutated in place; a uniform node reads it by reference each frame.
  const proj = t.uniform(crystalBgUniforms.uCrystalBgProj.value) as unknown as NodeObject;
  bg = { tex, proj };
  return bg;
}

export interface GpuCrystalOptions {
  readonly face: boolean;
  readonly transmission: number;
  readonly thickness: number;
  readonly tint: THREE.Color;
  /** Fresnel F0 (normal-incidence reflectance); grazing edges turn mirror-like. */
  readonly f0: number;
  /** Frosted letters keep this fraction of the refracted background (translucent, not opaque). */
  readonly etchTrans: number;
  /** The frosted letters' soft ice-white scatter. */
  readonly frost: THREE.Color;
  /** Inner-edge darkening strength on the frosted letters. */
  readonly dark: number;
  /** The face's etched mask (red clarity / green frost / blue inner edge), and its fade uniform. */
  readonly mask?: THREE.Texture;
  readonly fade?: { value: number };
}

/** The lighting model's finish: mix the refracted sub-frustum background into the shaded radiance. */
function crystalLightingModel(
  t: Tsl,
  inner: InstanceType<Tsl['PhysicalLightingModel']>,
  opts: {
    readonly face: boolean;
    readonly transmission: NodeObject;
    readonly thickness: NodeObject;
    readonly tint: NodeObject;
    readonly f0: NodeObject;
    readonly etchTrans: NodeObject;
    readonly frost: NodeObject;
    readonly darkStrength: NodeObject;
    readonly tex: UvSamplerNode;
    readonly proj: NodeObject;
    readonly etch: NodeObject | null;
    readonly dark: NodeObject | null;
  },
): InstanceType<Tsl['PhysicalLightingModel']> {
  const { face, transmission, thickness, tint, f0, etchTrans, frost, darkStrength, tex, proj, etch, dark } = opts;
  class CrystalLightingModel extends t.PhysicalLightingModel {
    override finish(input: LightingModelIndirectInput, stack: StackNode, builder: NodeBuilder): void {
      inner.finish(input, stack, builder);
      const outgoing = input.outgoingLight as unknown as NodeObject;
      const pw = t.positionWorld as unknown as NodeObject;
      // The flat-shaded world normal (normalWorld is a vertex varying and loses the flat facets).
      const n = (t.transformedNormalWorld as unknown as NodeObject).normalize();
      const v = t.cameraPosition.sub(pw).normalize();
      const r = t.refract(v.negate(), n, t.float(1 / CRYSTAL_IOR));
      const exit = pw.add(r.mul(thickness));
      const ndc = proj.mul(t.vec4(exit, 1));
      const uv = ndc.xy.div(t.max(t.float(1e-5), ndc.w)).mul(t.float(0.5)).add(t.float(0.5)).clamp(t.vec2(0), t.vec2(1));
      const transmitted = tex.uv(uv).rgb.mul(tint).mul(transmission);
      // Frosted letters: partly transparent (the reef still shows through) plus a soft ice-white scatter.
      const transmittedTerm = face && etch
        ? t.mix(transmitted, transmitted.mul(etchTrans).add(frost), etch)
        : transmitted;
      // Fresnel: near-normal facets stay clear, grazing facets reflect their PBR lighting (edge glints).
      const cosT = n.dot(v).max(t.float(0));
      const fresnel = f0.add(t.float(1).sub(f0).mul(t.pow(t.float(1).sub(cosT), t.float(5))));
      outgoing.assign(t.mix(transmittedTerm, outgoing, fresnel));
      if (face && dark) {
        outgoing.mulAssign(t.float(1).sub(dark.mul(darkStrength)));
      }
    }
  }
  return new CrystalLightingModel();
}

/**
 * The crystal glass as a MeshPhysicalNodeMaterial: caustic-lit like the reef, with the transmission
 * background mixed in after shading, and (for the face) the etched frost and its faint inner edge.
 */
export function gpuCrystalMaterial(params: THREE.MeshPhysicalMaterialParameters, options: GpuCrystalOptions): THREE.MeshPhysicalMaterial {
  const t = tsl();
  const mat = new t.MeshPhysicalNodeMaterial(params);
  installReefLight(mat);

  const { tex, proj } = crystalBgNodes(t);
  const transmission = t.float(options.transmission);
  const thickness = t.float(options.thickness);
  const tint = t.vec3(options.tint.r, options.tint.g, options.tint.b);
  const f0 = t.float(options.f0);
  const etchTrans = t.float(options.etchTrans);
  const frost = t.vec3(options.frost.r, options.frost.g, options.frost.b);
  const darkStrength = t.float(options.dark);

  let etch: NodeObject | null = null;
  let dark: NodeObject | null = null;
  if (options.face && options.mask && options.fade) {
    const fade = t.uniform(options.fade.value);
    Object.defineProperty(options.fade, 'value', {
      get: (): number => fade.value,
      set: (v: number): void => { fade.value = v; },
      configurable: true,
      enumerable: true,
    });
    const mask = t.texture(options.mask, t.uv());
    etch = t.float(1).sub(mask.r).mul(fade);
    dark = mask.b.mul(fade);
    // Frost: the etched letters read rough against the smooth clear face (roughnessmap_fragment patch).
    mat.roughnessNode = t.float(params.roughness as number).mul(t.mix(t.float(1), mask.g, fade));
  }

  const nodeMat = mat as unknown as {
    setupLightingModel?: () => InstanceType<Tsl['PhysicalLightingModel']>;
    customProgramCacheKey: () => string;
  };
  const prev = nodeMat.setupLightingModel?.bind(mat);
  nodeMat.setupLightingModel = () => {
    const inner = prev ? prev() : new t.PhysicalLightingModel();
    return crystalLightingModel(t, inner, { face: options.face, transmission, thickness, tint, f0, etchTrans, frost, darkStrength, tex, proj, etch, dark });
  };
  const prevKey = nodeMat.customProgramCacheKey.bind(mat);
  nodeMat.customProgramCacheKey = () => prevKey() + (options.face ? '|crystalface' : '|crystalbody');
  return mat as unknown as THREE.MeshPhysicalMaterial;
}
