// Light rigs shared by the tank (main.js, ?rig=led) and the fish lab (rig selector), so a fish looks the
// same in both.
//   sun  one key light through the surface (the default; caustics follow it)
//   led  an aquarium LED bar: a softer shadowing key plus two unshadowed fills spread along the bar,
//        which fill the shadow side the way a long fixture does
import * as THREE from 'three';

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
    this.sun.intensity = (led ? 1.5 : 2.6) * l + 0.05;
    for (const f of this.fills) f.intensity = led ? 0.7 * l : 0;
  }
}
