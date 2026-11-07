// The underwater medium on the WebGPU path, in TSL (the WebGL path patches three's fog chunks, which
// WebGPURenderer never runs). scene.backgroundNode is the open-water backdrop (graded by view direction,
// as makeWaterBackdrop's ShaderMaterial) and scene.fogNode is the Beer-Lambert per-channel absorption
// (red dies first), matching medium.ts's coefficients.
import * as THREE from 'three';
import type { Node } from 'three/webgpu';
import { tsl } from '../webgpu/tsl.js';
import { INSCATTER_DAY, GLASS_Z } from './medium.js';

type NodeObject = import('three/webgpu').ShaderNodeObject<Node>;

/** Per-unit beam attenuation c (red/green/blue), from BEAM_ATTENUATION_PER_M * METRES_PER_UNIT. */
const BEAM_PER_UNIT = [0.60 * 0.125, 0.17 * 0.125, 0.12 * 0.125] as const;
/** Camera white balance: exp(UW_KD * 7), so the reef zone reads as the eye adapts (medium.ts UW_WB). */
const WHITE_BALANCE = [Math.exp(0.45 * 0.125 * 7), Math.exp(0.07 * 0.125 * 7), Math.exp(0.05 * 0.125 * 7)] as const;
/** The camera sits outside the glass at z = 15; the medium starts at the glass plane. */
const CAMERA_Z = 15;
const GLASS_DISTANCE = CAMERA_Z - GLASS_Z;

/** The white-balanced inscatter base radiance: the fog colour (INSCATTER_DAY * UW_WB). */
function inscatterBase(): THREE.Color {
  return new THREE.Color(
    INSCATTER_DAY.r * WHITE_BALANCE[0],
    INSCATTER_DAY.g * WHITE_BALANCE[1],
    INSCATTER_DAY.b * WHITE_BALANCE[2],
  );
}

/**
 * A FogNode whose factor is the per-channel Beer-Lambert transmittance over the in-water path. The
 * renderer mixes each fragment as color*T + inscatter*(1-T), so red fades out nearest and blue survives.
 */
export function underwaterFogNode(): NodeObject {
  const t = tsl();
  const base = inscatterBase();
  // Distance from the camera, minus the part of the ray outside the glass (the water starts at z=3.3).
  const viewZ = t.positionView.z.negate();
  const path = t.max(0, viewZ.sub(GLASS_DISTANCE));
  const transmittance = t.exp(t.negate(t.vec3(BEAM_PER_UNIT[0], BEAM_PER_UNIT[1], BEAM_PER_UNIT[2]).mul(path)));
  const factor = t.vec3(1).sub(transmittance);
  return t.fog(t.color(base), factor);
}

/** The open-water background: inscatter radiance graded brighter up, darker down, white-balanced. */
export function underwaterBackgroundNode(): NodeObject {
  const t = tsl();
  const base = inscatterBase();
  const dir = t.normalWorld.normalize();
  const up = t.smoothstep(-0.7, 0.95, dir.y);
  const grade = t.mix(0.55, 1.3, t.smoothstep(-0.3, 0.35, dir.y));
  const c = t.vec3(base.r, base.g, base.b)
    .mul(t.float(0.45).add(t.float(1.1).mul(up).mul(up)))
    .mul(grade);
  return t.vec4(c, 1);
}
