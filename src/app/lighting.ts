// Turns the tank's light level (0 night .. 1 day) into every light, fog, exposure and shader uniform
// that depends on it. One place owns the day/night look. The sun's colour and arc also follow the time
// of day: warm and low at the golden hours, white-blue overhead at noon, cool moonlight at night.
import * as THREE from 'three';
import { lerp } from '../core/math.js';
import { INSCATTER_DAY, setSunDirection, waterUniforms, type WaterSurface } from '../water.js';
import { reefLightUniforms } from '../reefLight.js';
import { LIGHTS, SUN_NOON } from '../rig.js';
import type { TankScene } from '../reef/types.js';
import type { Stage } from './stage.js';
import { NOON_SUN, type SunState } from './daylight.js';

/** Fraction of the light left at night (moonlight) for the fill terms. */
const NIGHT_FILL = 0.5;
/** Fog (inscatter) brightness at night. */
const NIGHT_FOG = 0.08;
/** Exposure: the curve's gain times this at full day, falling to NIGHT_EXPOSURE of it at night. */
const DAY_EXPOSURE = 1.35;
const NIGHT_EXPOSURE = 1.5;
/** The jelly tank's light panel: dim at night, full by day. */
const PANEL_NIGHT = 0.12;
/** Hemisphere colour: moonlight is bluer than the day's white. */
const HEMI_NIGHT = { r: 0.34, g: 0.48 } as const;
const HEMI_DAY = { r: 0.92, g: 0.97 } as const;
/** Without the reef-light bake, ambient water light stays at the old balance. */
const AMBIENT_WITHOUT_BAKE = 1.0;
/** The reef light was baked under this sky colour (scaled by LIGHTS.ambient). */
export const BAKE_SKY = new THREE.Color(0.86, 0.92, 1.0);
/** Golden low sun at dawn and dusk. */
const SUN_HORIZON = new THREE.Color(0xffa64d);
/** Cool moonlight key light at night. */
const SUN_MOON = new THREE.Color(0x9fb4d8);
/** How much of the low sun's warmth the water column picks up at the horizon. */
const FOG_WARMTH = 0.35;
/** The ends of the sun's arc: low over the tank at dawn/dusk. */
const SUN_LOW = { x: 14, y: 11, z: 5 } as const;

export interface LightingTargets {
  readonly stage: Stage;
  readonly surface: WaterSurface;
  readonly reef: TankScene;
  /** Exposure gain of the tone curve in use. */
  readonly toneGain: number;
}

/** The sun's direction towards the light: overhead at noon, low over the tank at dawn/dusk. */
function sunDirectionInto(out: THREE.Vector3, phase: number): void {
  const zenith = Math.sin(Math.PI * phase);
  const east = Math.cos(Math.PI * phase);
  out.set(
    SUN_LOW.x * east * (1 - zenith) + LIGHTS.sunPos[0] * zenith,
    SUN_LOW.y * (1 - zenith) + LIGHTS.sunPos[1] * zenith,
    SUN_LOW.z * (1 - zenith) + LIGHTS.sunPos[2] * zenith,
  );
}

/** The key light's colour: golden at the horizon, white-blue overhead, moon-cool at night. */
function sunColourInto(out: THREE.Color, level: number, warmth: number): void {
  if (level <= 0) { out.copy(SUN_MOON); return; }
  out.copy(SUN_HORIZON).lerp(SUN_NOON, warmth);
}

export class LightingController {
  private readonly sunDir = new THREE.Vector3();
  private readonly sunTint = new THREE.Color();
  private readonly fogTint = new THREE.Color();

  constructor(private readonly targets: LightingTargets) {}

  apply(level: number, sun: SunState = NOON_SUN): void {
    const { stage, surface, reef, toneGain } = this.targets;
    const fill = NIGHT_FILL + (1 - NIGHT_FILL) * level;
    stage.rig.apply(level);
    // The sun's colour and arc follow the time of day; the live caustics read its direction. At night
    // the moon stands overhead instead of hugging the horizon.
    sunColourInto(this.sunTint, level, sun.warmth);
    stage.sun.color.copy(this.sunTint);
    sunDirectionInto(this.sunDir, level > 0 ? sun.phase : NOON_SUN.phase);
    stage.sun.position.copy(this.sunDir);
    setSunDirection(stage.sun.position);
    // Ambient water light is occluded by the baked reef light, so it can sit lower against the sun and
    // let the shadows read.
    const ambient = reefLightUniforms.uRLOn.value ? LIGHTS.ambient : AMBIENT_WITHOUT_BAKE;
    stage.hemi.intensity = ambient * fill;
    reefLightUniforms.uRLLight.value = fill;
    stage.hemi.color.setRGB(lerp(HEMI_NIGHT.r, HEMI_DAY.r, level), lerp(HEMI_NIGHT.g, HEMI_DAY.g, level), 1.0);
    stage.scene.environmentIntensity = LIGHTS.env * ambient * fill;
    waterUniforms.uCaustic.value = level;
    // The water column picks up a little of the low sun's warmth at the golden hours.
    this.fogTint.copy(INSCATTER_DAY);
    if (level > 0) this.fogTint.lerp(SUN_HORIZON, (1 - sun.warmth) * FOG_WARMTH);
    stage.fog.color.copy(this.fogTint).multiplyScalar(NIGHT_FOG + (1 - NIGHT_FOG) * level);
    stage.backdrop.backdropUniforms.uBase.value.copy(stage.fog.color);
    stage.renderer.toneMappingExposure = DAY_EXPOSURE * toneGain * (NIGHT_EXPOSURE + (1 - NIGHT_EXPOSURE) * level);
    surface.surfaceUniforms.uLight.value = level;
    surface.surfaceUniforms.uBase.value.copy(stage.fog.color);
    const panel = reef.backdrop?.material.uniforms['uLight'];
    if (panel) panel.value = PANEL_NIGHT + (1 - PANEL_NIGHT) * level;
  }
}
