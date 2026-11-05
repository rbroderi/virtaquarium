// Light rigs shared by the tank (main.js, ?rig=led) and the fish lab (rig selector), so a fish looks the
// same in both.
//   sun  one key light through the surface (the default; caustics follow it)
//   led  an aquarium LED bar: a softer shadowing key plus two unshadowed fills spread along the bar,
//        which fill the shadow side the way a long fixture does
import * as THREE from 'three';

// Tone mapping shared by the tank and the bake (?tone=aces|neutral, Neutral by default). gain scales
// exposure so the frame's mean brightness matches across curves: three's ACES multiplies by 1/0.6 inside,
// Neutral does not. Neutral (Khronos PBR Neutral) keeps hue and saturation up to the highlights, where
// ACES pulls the saturated oranges and yellows of the fish towards grey. (The per-species colour gains
// in species.js were fitted in the lab under ACES; refit them there with the tone selector on Neutral.)
export const TONES = {
  aces: { mapping: THREE.ACESFilmicToneMapping, gain: 1 },
  neutral: { mapping: THREE.NeutralToneMapping, gain: 1.28 },   // matched by look check mean luminance (0.42)
};
export function toneFor(params) {
  return TONES[params.get('tone')] || TONES.neutral;
}

// Light levels shared by the tank (main.js) and the bake (bake.js), at full daylight. The sun (the tank's
// lamp through the surface) dominates from overhead; the ambient fill (hemisphere light, environment
// map, the reef light's sky term) is kept low, so undersides and overhangs go properly dark and form
// reads, as in reef photos lit by a single overhead source. (Was sun 2.6, ambient 0.75, env 0.35.)
export const LIGHTS = {
  sun: 3.4,                 // directional intensity
  sunPos: [2, 24, 5],       // nearly overhead, a little towards the front
  ambient: 0.4,             // hemisphere / sky fill with the baked reef light on (1 without it)
  env: 0.3,                 // environment map intensity, times ambient
};

export class LightRig {
  constructor(scene, sun, preset = 'sun') {
    this.sun = sun;
    this.preset = preset;
    this.fills = [-1, 1].map((s) => {
      const l = new THREE.DirectionalLight(0xf4f6ff, 0);
      l.position.set(s * 6, 20, 6);
      scene.add(l);
      return l;
    });
  }

  // l: overall light level (0 night .. 1 day).
  apply(l) {
    const led = this.preset === 'led';
    this.sun.intensity = (led ? 1.5 : LIGHTS.sun) * l + 0.05;
    for (const f of this.fills) f.intensity = led ? 0.7 * l : 0;
  }
}
