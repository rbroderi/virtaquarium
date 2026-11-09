// The crystal's glass shader on the WebGPU path, in TSL (the WebGL path is crystal.ts's
// onBeforeCompile patch, which WebGPURenderer never runs). The same sub-frustum transmission
// background, the frosted etched letters by planar projection (project the fragment's local position
// onto the text plane, fade by how near the flat normal is to the face normal), plus native
// iridescence.
import * as THREE from 'three';
import {
  tsl, webgpu,
  type NodeBuilder, type NodeObject, type Tsl, type Webgpu,
} from '../webgpu/tsl.js';
import { installReefLight } from '../reefLight/webgpu.js';
import { crystalBgUniforms } from './crystalBg.js';

/** A texture node re-sampleable at an explicit uv (the `.sample()` keeps the node's link). */
type UvSamplerNode = NodeObject & { sample(uv: NodeObject): NodeObject };

const CRYSTAL_IOR = 1.54;
/** The frame's etched letters mix toward this roughness (frosted), while the clear frame keeps its own. */
const FROST_ROUGH = 0.85;

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

/** Per-vertex glass thickness (0..1 of the rock's thickest), baked once at load in crystal.ts. */
export const CRYSTAL_THICK_ATTR = 'crystalThick';

export interface GpuCrystalOptions {
  readonly transmission: number;
  /** Refraction offset through the thickest glass, world units (scaled by the baked thickness). */
  readonly thickness: number;
  /** Beer's-law absorption per channel through the thickest glass (-ln of its transmission). */
  readonly sigma: THREE.Vector3;
  /** IOR spread between green and red/blue, for the rainbow fringes. */
  readonly dispersion: number;
  /** Haze scale at zero thickness and at the thickest glass. */
  readonly thinHaze: number;
  readonly thickHaze: number;
  readonly tint: THREE.Color;
  /** Share of the background replaced by the glass's own lit milky colour, and that colour. */
  readonly haze: number;
  readonly hazeColor: THREE.Color;
  /** Fresnel F0 (normal-incidence reflectance); grazing edges turn mirror-like. */
  readonly f0: number;
  /** Frosted letters keep this fraction of the refracted background (translucent, not opaque). */
  readonly etchTrans: number;
  /** The frosted letters' soft ice-white scatter. */
  readonly frost: THREE.Color;
  /** Inner-edge darkening strength on the frosted letters. */
  readonly dark: number;
  /** How the etched letters read against the clear glass: the plaque polishes its clear area, while
   *  the frame keeps its clear glass and only frosts the letters. */
  readonly frostMode: 'plaque' | 'frame';
  /** The etched mask (red clarity / green frost / blue inner edge). */
  readonly mask: THREE.Texture;
  /** The text plane, in the crystal's local space. */
  readonly textN: THREE.Vector3;
  readonly textU: THREE.Vector3;
  readonly textV: THREE.Vector3;
  readonly textCenter: THREE.Vector3;
  readonly silU0: number;
  readonly silV0: number;
  readonly silExtentU: number;
  readonly silExtentV: number;
  /** Recessed groove depth (local units) and the blur radius of the letter mask (text UVs). */
  readonly groove: number;
  readonly grooveBlur: number;
  readonly grooveBright: number;
}

/** The lighting model's finish: mix the refracted sub-frustum background into the shaded radiance. */
function crystalLightingModel(
  t: Tsl,
  wg: Webgpu,
  inner: InstanceType<Webgpu['PhysicalLightingModel']>,
  opts: {
    readonly transmission: NodeObject;
    readonly dispersion: number;
    readonly thickness: NodeObject;
    readonly thick01: NodeObject;
    readonly sigma: NodeObject;
    readonly thinHaze: NodeObject;
    readonly thickHaze: NodeObject;
    readonly tint: NodeObject;
    readonly haze: NodeObject;
    readonly hazeColor: NodeObject;
    readonly f0: NodeObject;
    readonly etchTrans: NodeObject;
    readonly frost: NodeObject;
    readonly darkStrength: NodeObject;
    readonly tex: UvSamplerNode;
    readonly proj: NodeObject;
    readonly etch: NodeObject;
    readonly dark: NodeObject;
    readonly engravedN: NodeObject;
    readonly letter: NodeObject;
    readonly groove: NodeObject;
    readonly grooveBright: NodeObject;
  },
): InstanceType<Webgpu['PhysicalLightingModel']> {
  const { dispersion, transmission, thickness, thick01, sigma, thinHaze, thickHaze, tint, haze, hazeColor, f0, etchTrans, frost, darkStrength, tex, proj, etch, dark, engravedN, letter, groove, grooveBright } = opts;
  class CrystalLightingModel extends wg.PhysicalLightingModel {
    override finish(builder: NodeBuilder): void {
      inner.finish(builder);
      const outgoing = (builder.context as unknown as { outgoingLight: NodeObject }).outgoingLight;
      const pw = t.positionWorld as unknown as NodeObject;
      const v = t.cameraPosition.sub(pw).normalize();
      // The etched groove's wall normal (already perturbed in world space): the cut walls catch light
      // and refract differently from the flat facet around them.
      const r = t.refract(v.negate(), engravedN, t.float(1 / CRYSTAL_IOR));
      // Dispersion: red bends a little less than green, blue a little more, so edges and letter walls
      // split into faint rainbow fringes.
      const rr = t.refract(v.negate(), engravedN, t.float(1 / (CRYSTAL_IOR - dispersion)));
      const rb = t.refract(v.negate(), engravedN, t.float(1 / (CRYSTAL_IOR + dispersion)));
      // Cheap parallax: the letter floor is recessed, so it looks through a little less glass.
      // The refraction offset follows the baked thickness: thin edges barely bend the view.
      const thick = thickness.mul(thick01).sub(letter.mul(groove)).max(t.float(0));
      const bgUv = (dir: NodeObject): NodeObject => {
        const ndc = proj.mul(t.vec4(pw.add(dir.mul(thick)), 1));
        return ndc.xy.div(t.max(t.float(1e-5), ndc.w)).mul(t.float(0.5)).add(t.float(0.5)).clamp(t.vec2(0), t.vec2(1));
      };
      const bgSample = t.vec3(tex.sample(bgUv(rr)).r, tex.sample(bgUv(r)).g, tex.sample(bgUv(rb)).b);
      // Beer's law: the path through the glass is the baked thickness over the refracted ray's cosine,
      // so thick parts and oblique views absorb more (red first), and thin edges stay clear.
      const cosR = r.dot(engravedN).abs().max(t.float(0.3));
      const absorb = t.exp(sigma.mul(thick01.div(cosR)).negate());
      // Milky haze: part of the background gives way to the glass's own lit white-blue, so it follows
      // the reef light (no glow at night); more glass scatters more.
      const hazeAmt = haze.mul(t.mix(thinHaze, thickHaze, thick01)).min(t.float(0.95));
      const transmitted = t.mix(bgSample.mul(tint).mul(absorb).mul(transmission), outgoing.mul(hazeColor), hazeAmt);
      // Frosted floors: partly transparent (the reef still shows through) plus a soft ice-white scatter,
      // and a touch brighter than the clear glass around them.
      const transmittedTerm = t.mix(transmitted, transmitted.mul(etchTrans).add(frost), etch)
        .mul(t.mix(t.float(1), grooveBright, etch));
      // Fresnel with the engraved normal: one wall grazes (bright reflection), the other stays clear.
      const cosT = engravedN.dot(v).max(t.float(0));
      const fresnel = f0.add(t.float(1).sub(f0).mul(t.pow(t.float(1).sub(cosT), t.float(5))));
      outgoing.assign(t.mix(transmittedTerm, outgoing, fresnel));
      outgoing.mulAssign(t.float(1).sub(dark.mul(darkStrength)));
    }
  }
  return new CrystalLightingModel();
}

/**
 * The crystal glass as a MeshPhysicalNodeMaterial: caustic-lit like the reef, with the transmission
 * background mixed in after shading and the frosted letters etched by planar projection.
 */
export function gpuCrystalMaterial(
  params: THREE.MeshPhysicalMaterialParameters,
  options: GpuCrystalOptions,
  fadeNode: { value: number } | null,
): THREE.MeshPhysicalMaterial {
  const t = tsl();
  const wg = webgpu();
  const mat = new wg.MeshPhysicalNodeMaterial(params);
  installReefLight(mat);

  const { tex, proj } = crystalBgNodes(t);
  const transmission = t.float(options.transmission);
  const thickness = t.float(options.thickness);
  const thick01 = t.attribute(CRYSTAL_THICK_ATTR, 'float') as unknown as NodeObject;
  const sigma = t.vec3(options.sigma.x, options.sigma.y, options.sigma.z) as unknown as NodeObject;
  const thinHaze = t.float(options.thinHaze);
  const thickHaze = t.float(options.thickHaze);
  const tint = t.vec3(options.tint.r, options.tint.g, options.tint.b);
  const haze = t.float(options.haze);
  const hazeColor = t.vec3(options.hazeColor.r, options.hazeColor.g, options.hazeColor.b);
  const f0 = t.float(options.f0);
  const etchTrans = t.float(options.etchTrans);
  const frost = t.vec3(options.frost.r, options.frost.g, options.frost.b);
  const darkStrength = t.float(options.dark);
  // The shared fade uniform (created once per crystal and mutated by crystalText.ts); a fallback 1
  // keeps the degenerate (no face) body compiling without the sign controller.
  const fade = (fadeNode ?? t.float(1)) as unknown as NodeObject;

  // The etch mask sampled at the fragment's projection onto the text plane (local space).
  const maskTex = t.texture(options.mask, t.uv()) as unknown as UvSamplerNode;
  const localPos = t.positionLocal as unknown as NodeObject;
  const textN = t.vec3(options.textN.x, options.textN.y, options.textN.z) as unknown as NodeObject;
  const textU = t.vec3(options.textU.x, options.textU.y, options.textU.z) as unknown as NodeObject;
  const textV = t.vec3(options.textV.x, options.textV.y, options.textV.z) as unknown as NodeObject;
  const textCenter = t.vec3(options.textCenter.x, options.textCenter.y, options.textCenter.z) as unknown as NodeObject;
  const invExtU = t.float(1 / Math.max(1e-6, options.silExtentU));
  const invExtV = t.float(1 / Math.max(1e-6, options.silExtentV));
  const u0 = t.float(options.silU0);
  const v0 = t.float(options.silV0);

  // The flat local normal (same derivative method three uses for FLAT_SHADED), for the facing falloff.
  const localN = localPos.dFdx().cross(localPos.dFdy()).normalize();
  const facing = t.smoothstep(t.float(0.3), t.float(0.5), localN.dot(textN));
  const du = localPos.sub(textCenter).dot(textU);
  const dv = localPos.sub(textCenter).dot(textV);
  const textUv = t.vec2(du.sub(u0).mul(invExtU), dv.sub(v0).mul(invExtV)) as unknown as NodeObject;
  const sampled = maskTex.sample(textUv);
  // Blur the clarity channel (3x3 box, a fraction of a stroke wide) into a groove height (0 outside,
  // 1 inside) for the wall normal and the parallax only; the frost itself uses the sharp glyph, so
  // the blur's taps never show as shifted copies of the letters.
  let blurR: NodeObject = sampled.r;
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    if (i === 0 && j === 0) continue;
    blurR = blurR.add(maskTex.sample(textUv.add(t.vec2(i * options.grooveBlur, j * options.grooveBlur))).r);
  }
  const letter = t.float(1).sub(blurR.div(t.float(9)));
  const etch = t.float(1).sub(sampled.r).mul(facing).mul(fade);
  const dark = sampled.b.mul(facing).mul(fade);

  // The groove height's gradient in the text plane, then the engraved wall normal in world space.
  const groove = t.float(options.groove);
  const ldx = letter.dFdx(), ldy = letter.dFdy();
  const dudx = du.dFdx(), dudy = du.dFdy();
  const dvdx = dv.dFdx(), dvdy = dv.dFdy();
  const det = dudx.mul(dvdy).sub(dvdx.mul(dudy));
  const dletterdu = ldx.mul(dvdy).sub(ldy.mul(dvdx)).div(det);
  const dletterdv = dudx.mul(ldy).sub(dudy.mul(ldx)).div(det);
  const perturbWorld = (t.modelWorldMatrix.mul(t.vec4(textU.mul(dletterdu).add(textV.mul(dletterdv)), t.float(0)))).xyz as unknown as NodeObject;
  const worldN = (t.normalWorld as unknown as NodeObject).normalize();
  const engravedN = worldN.add(perturbWorld.mul(groove)).normalize();

  // Frost: the plaque polishes its clear area and keeps the rough letters; the frame keeps its clear
  // glass and frosts only the letters.
  mat.roughnessNode = options.frostMode === 'plaque'
    ? t.float(params.roughness as number).mul(t.mix(t.float(1), sampled.g, fade))
    : t.mix(t.float(params.roughness as number), t.float(FROST_ROUGH), etch);

  const nodeMat = mat as unknown as {
    setupLightingModel?: () => InstanceType<Webgpu['PhysicalLightingModel']>;
    customProgramCacheKey: () => string;
  };
  const prev = nodeMat.setupLightingModel?.bind(mat);
  nodeMat.setupLightingModel = () => {
    const inner = prev ? prev() : new wg.PhysicalLightingModel();
    return crystalLightingModel(t, wg, inner, {
      dispersion: options.dispersion, transmission, thickness, thick01, sigma, thinHaze, thickHaze, tint, haze, hazeColor, f0, etchTrans, frost, darkStrength, tex, proj, etch, dark,
      engravedN, letter, groove, grooveBright: t.float(options.grooveBright),
    });
  };
  const prevKey = nodeMat.customProgramCacheKey.bind(mat);
  nodeMat.customProgramCacheKey = () => prevKey() + (options.frostMode === 'plaque' ? '|crystalplaque' : '|crystalframe');
  return mat as unknown as THREE.MeshPhysicalMaterial;
}
