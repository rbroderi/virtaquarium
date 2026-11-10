// The underwater medium on the WebGPU path, in TSL (the WebGL path patches three's fog chunks, which
// WebGPURenderer never runs). scene.backgroundNode is the open-water backdrop (graded by view direction,
// as makeWaterBackdrop's ShaderMaterial) and scene.fogNode is the Beer-Lambert per-channel absorption
// (red dies first), matching medium.ts's coefficients. Both read the live water colour (scene.fog.color,
// written by app/lighting.ts) through a uniform, so day/dusk/night stays identical to the WebGL path.
import * as THREE from 'three';
import { tsl, type NodeObject, type Tsl } from '../webgpu/tsl.js';
import { FAR_WATER, FAR_WATER_RAMP, GLASS_Z } from './medium.js';

/** Per-unit beam attenuation c (red/green/blue), from BEAM_ATTENUATION_PER_M * METRES_PER_UNIT. */
const BEAM_PER_UNIT = [0.60 * 0.125, 0.17 * 0.125, 0.12 * 0.125] as const;
/** Camera white balance: exp(UW_KD * 7), so the reef zone reads as the eye adapts (medium.ts UW_WB). */
const WHITE_BALANCE = [Math.exp(0.45 * 0.125 * 7), Math.exp(0.07 * 0.125 * 7), Math.exp(0.05 * 0.125 * 7)] as const;
/** The camera sits outside the glass at z = 15; the medium starts at the glass plane. */
const CAMERA_Z = 15;
/** The part of each eye ray outside the water from the tank's camera (GpuOpenWater.glassDistance). */
export const GLASS_DISTANCE = CAMERA_Z - GLASS_Z;

/**
 * The open reef's water (openReef.ts), which has no glass and no room behind the window:
 *   glassDistance  the part of each eye ray that is outside the water (0 when the camera is in it)
 *   density        turbidity beyond FAR_WATER: a multiplier on the beam attenuation there (the WebGL
 *                  path's fog.density)
 *   open           1: the inscatter follows the view direction as the background does and the background
 *                  drops its darker-below grade, so a fully fogged object is exactly the background
 *                  colour and the far edge of the seabed has no seam
 * The defaults are the reef tank's look.
 */
export interface GpuOpenWater { glassDistance: number; density: number; open: number }
const openWater: GpuOpenWater = { glassDistance: GLASS_DISTANCE, density: 1, open: 0 };
type FloatUniform = NodeObject & { value: number };
let openWaterNodes: Record<keyof GpuOpenWater, FloatUniform> | null = null;

function openWaterUniforms(t: Tsl): Record<keyof GpuOpenWater, FloatUniform> {
  openWaterNodes ??= {
    glassDistance: t.uniform(openWater.glassDistance) as FloatUniform,
    density: t.uniform(openWater.density) as FloatUniform,
    open: t.uniform(openWater.open) as FloatUniform,
  };
  return openWaterNodes;
}

/** Sets the WebGPU medium's open-water terms (see GpuOpenWater); fields left out keep their value. */
export function setGpuOpenWater(values: Partial<GpuOpenWater>): void {
  Object.assign(openWater, values);
  if (!openWaterNodes) return;
  for (const k of Object.keys(values) as (keyof GpuOpenWater)[]) openWaterNodes[k].value = openWater[k];
}

/** The live water colour, white-balanced (scene.fog.color * UW_WB). */
function whiteBalancedBase(t: Tsl, base: THREE.Color): NodeObject {
  return (t.uniform(base) as unknown as NodeObject).mul(t.vec3(WHITE_BALANCE[0], WHITE_BALANCE[1], WHITE_BALANCE[2]));
}

/** medium.ts uwInscatter's direction term: brighter looking up towards the light, darker down. */
function inscatterGrade(t: Tsl, dir: NodeObject): NodeObject {
  const up = t.smoothstep(-0.7, 0.95, dir.y);
  return t.float(0.45).add(t.float(1.1).mul(up).mul(up));
}

/**
 * A FogNode whose factor is the per-channel Beer-Lambert transmittance over the in-water path. The
 * renderer mixes each fragment as color*T + inscatter*(1-T), so red fades out nearest and blue survives.
 */
export function underwaterFogNode(base: THREE.Color): NodeObject {
  const t = tsl();
  const u = openWaterUniforms(t);
  const viewDir = t.positionWorld.sub(t.cameraPosition).normalize() as NodeObject;
  const inscatter = whiteBalancedBase(t, base).mul(t.mix(t.float(1), inscatterGrade(t, viewDir), u.open));
  // Distance from the camera, minus the part of the ray outside the glass (the water starts at z=3.3).
  const viewZ = t.positionView.z.negate();
  // Past FAR_WATER, `density` adds turbidity (medium.ts FOG_FRAGMENT's uwK), so the far reef fades out.
  const inWater = t.max(0, viewZ.sub(u.glassDistance));
  // Eased in over FAR_WATER_RAMP (x^2 / (x + ramp)), so the change of rate leaves no crease on the seabed.
  const far = t.max(0, inWater.sub(FAR_WATER));
  const path = inWater.add(far.mul(far).div(far.add(FAR_WATER_RAMP)).mul(u.density.sub(1)));
  const transmittance = t.exp(t.negate(t.vec3(BEAM_PER_UNIT[0], BEAM_PER_UNIT[1], BEAM_PER_UNIT[2]).mul(path)));
  const factor = t.vec3(1).sub(transmittance);
  // Not t.fog(): since r17x it reduces the factor to a float (its .x, red's), which fogs every channel
  // at red's rate. NodeMaterial.setupFog assigns the lit colour to `output` before reading this node.
  return t.Fn(() => t.vec4(t.mix(t.output.rgb, inscatter, factor), t.output.a))();
}

/** The open-water background: inscatter radiance graded brighter up, darker down, white-balanced. */
export function underwaterBackgroundNode(base: THREE.Color): NodeObject {
  const t = tsl();
  const dir = t.normalWorld.normalize();
  const grade = t.mix(t.mix(0.55, 1.3, t.smoothstep(-0.3, 0.35, dir.y)), t.float(1), openWaterUniforms(t).open);
  const c = whiteBalancedBase(t, base)
    .mul(inscatterGrade(t, dir))
    .mul(grade);
  return t.vec4(c, 1);
}
