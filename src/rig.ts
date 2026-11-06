// Light rigs shared by the tank (main, ?rig=led) and the fish lab (rig selector), so a fish looks the
// same in both. Each rig is a Strategy for turning the overall light level into light intensities.
//   sun  one key light through the surface (the default; caustics follow it)
//   led  an aquarium LED bar: a softer shadowing key plus two unshadowed fills spread along the bar,
//        which fill the shadow side the way a long fixture does
import * as THREE from 'three';

export interface ToneCurve {
  readonly mapping: THREE.ToneMapping;
  /** Exposure scale so the frame's mean brightness matches across curves. */
  readonly gain: number;
}

// Tone mapping shared by the tank and the bake (?tone=aces|neutral, Neutral by default). three's ACES
// multiplies by 1/0.6 inside, Neutral does not. Neutral (Khronos PBR Neutral) keeps hue and saturation
// up to the highlights, where ACES pulls the saturated oranges and yellows of the fish towards grey.
export const TONES = {
  aces: { mapping: THREE.ACESFilmicToneMapping, gain: 1 },
  neutral: { mapping: THREE.NeutralToneMapping, gain: 1.28 },   // matched by look check mean luminance (0.42)
} as const satisfies Record<string, ToneCurve>;
export type ToneName = keyof typeof TONES;

const isToneName = (name: string | null): name is ToneName => name !== null && name in TONES;

export function toneFor(params: URLSearchParams): ToneCurve {
  const name = params.get('tone');
  return isToneName(name) ? TONES[name] : TONES.neutral;
}

// Light levels shared by the tank (main) and the bake, at full daylight. The sun (the tank's lamp
// through the surface) dominates from overhead; the ambient fill (hemisphere light, environment map,
// the reef light's sky term) is kept low, so undersides and overhangs go properly dark and form reads.
export const LIGHTS = {
  /** Directional intensity. */
  sun: 3.4,
  /** Nearly overhead, a little towards the front. */
  sunPos: [2, 24, 5] as const,
  /** Hemisphere / sky fill with the baked reef light on (1 without it). */
  ambient: 0.4,
  /** Environment map intensity, times ambient. */
  env: 0.3,
} as const;

/** Night floor on the key light so moonlit scenes are never pitch black. */
const KEY_FLOOR = 0.05;
const LED_KEY = 1.5;
const LED_FILL = 0.7;
const FILL_COLOR = 0xf4f6ff;
const FILL_OFFSET_X = 6, FILL_HEIGHT = 20, FILL_DEPTH = 6;

export type RigName = 'sun' | 'led';

/** Strategy: how a rig turns the light level (0 night .. 1 day) into key and fill intensities. */
interface RigStrategy {
  keyIntensity(level: number): number;
  fillIntensity(level: number): number;
}

const RIGS: Readonly<Record<RigName, RigStrategy>> = {
  sun: { keyIntensity: (l) => LIGHTS.sun * l + KEY_FLOOR, fillIntensity: () => 0 },
  led: { keyIntensity: (l) => LED_KEY * l + KEY_FLOOR, fillIntensity: (l) => LED_FILL * l },
};

export const isRigName = (name: string): name is RigName => name in RIGS;

export class LightRig {
  private presetName: RigName = 'sun';
  private readonly fills: readonly THREE.DirectionalLight[];

  constructor(scene: THREE.Scene, private readonly sun: THREE.DirectionalLight, preset: string = 'sun') {
    this.preset = preset;
    this.fills = [-1, 1].map((side) => {
      const light = new THREE.DirectionalLight(FILL_COLOR, 0);
      light.position.set(side * FILL_OFFSET_X, FILL_HEIGHT, FILL_DEPTH);
      scene.add(light);
      return light;
    });
  }

  get preset(): RigName {
    return this.presetName;
  }

  /** Any name other than a known rig selects the sun, as the JS build did. */
  set preset(name: string) {
    this.presetName = isRigName(name) ? name : 'sun';
  }

  /** level: overall light level (0 night .. 1 day). */
  apply(level: number): void {
    const strategy = RIGS[this.presetName];
    this.sun.intensity = strategy.keyIntensity(level);
    for (const fill of this.fills) fill.intensity = strategy.fillIntensity(level);
  }
}
