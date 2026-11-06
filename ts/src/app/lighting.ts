// Turns the tank's light level (0 night .. 1 day) into every light, fog, exposure and shader uniform
// that depends on it. One place owns the day/night look.
import * as THREE from 'three';
import { lerp } from '../core/math.js';
import { INSCATTER_DAY, waterUniforms, type WaterSurface } from '../water.js';
import { reefLightUniforms } from '../reefLight.js';
import { LIGHTS } from '../rig.js';
import type { TankScene } from '../reef/types.js';
import type { Stage } from './stage.js';

/** Fraction of the light left at night (moonlight) for the fill terms. */
const NIGHT_FILL = 0.12;
/** Fog (inscatter) brightness at night. */
const NIGHT_FOG = 0.06;
/** Exposure: the curve's gain times this at full day, falling to NIGHT_EXPOSURE of it at night. */
const DAY_EXPOSURE = 1.25;
const NIGHT_EXPOSURE = 0.45;
/** The jelly tank's light panel: dim at night, full by day. */
const PANEL_NIGHT = 0.08;
/** Hemisphere colour: moonlight is bluer than the day's white. */
const HEMI_NIGHT = { r: 0.3, g: 0.45 } as const;
const HEMI_DAY = { r: 0.86, g: 0.92 } as const;
/** Without the reef-light bake, ambient water light stays at the old balance. */
const AMBIENT_WITHOUT_BAKE = 1.0;
/** The reef light was baked under this sky colour (scaled by LIGHTS.ambient). */
export const BAKE_SKY = new THREE.Color(0.86, 0.92, 1.0);

export interface LightingTargets {
  readonly stage: Stage;
  readonly surface: WaterSurface;
  readonly reef: TankScene;
  /** Exposure gain of the tone curve in use. */
  readonly toneGain: number;
}

export class LightingController {
  constructor(private readonly targets: LightingTargets) {}

  apply(level: number): void {
    const { stage, surface, reef, toneGain } = this.targets;
    const fill = NIGHT_FILL + (1 - NIGHT_FILL) * level;
    stage.rig.apply(level);
    // Ambient water light is occluded by the baked reef light, so it can sit lower against the sun and
    // let the shadows read.
    const ambient = reefLightUniforms.uRLOn.value ? LIGHTS.ambient : AMBIENT_WITHOUT_BAKE;
    stage.hemi.intensity = ambient * fill;
    reefLightUniforms.uRLLight.value = fill;
    stage.hemi.color.setRGB(lerp(HEMI_NIGHT.r, HEMI_DAY.r, level), lerp(HEMI_NIGHT.g, HEMI_DAY.g, level), 1.0);
    stage.scene.environmentIntensity = LIGHTS.env * ambient * fill;
    waterUniforms.uCaustic.value = level;
    stage.fog.color.copy(INSCATTER_DAY).multiplyScalar(NIGHT_FOG + (1 - NIGHT_FOG) * level);
    stage.backdrop.backdropUniforms.uBase.value.copy(stage.fog.color);
    stage.renderer.toneMappingExposure = DAY_EXPOSURE * toneGain * (NIGHT_EXPOSURE + (1 - NIGHT_EXPOSURE) * level);
    surface.surfaceUniforms.uLight.value = level;
    surface.surfaceUniforms.uBase.value.copy(stage.fog.color);
    const panel = reef.backdrop?.material.uniforms['uLight'];
    if (panel) panel.value = PANEL_NIGHT + (1 - PANEL_NIGHT) * level;
  }
}
