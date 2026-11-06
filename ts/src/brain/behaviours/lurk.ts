// Lurk: a moray settles in the cave at home (main), facing out of its mouth, head up, swaying slowly.
// Morays reverse their body wave to swim backwards, so an eel that is outside the mouth backs in tail
// first (fish.ts); at home it braces against the rock.
import * as THREE from 'three';
import type { Behaviour } from '../behaviour.js';

/** The water just outside the mouth, this far out along lurkDir. */
const MOUTH_OUT = 1.2;
const MAX_BACKING = 0.3;

const _mouth = new THREE.Vector3();

export const lurk: Behaviour = {
  mode: 'lurk',

  score: ({ species: sp, drives: d, dark }) => (sp.lurker ? 0.85 + (1 - d.energy) * 0.4 - d.hunger * 0.35 - dark * 0.45 : 0),

  steer({ brain, me, dir, pos, pace, wasBacking, out }) {
    dir.subVectors(brain.home, pos);
    const dist = dir.length();
    out.clearance = me.size * 0.04;
    const lurkDir = brain.lurkDir;
    _mouth.copy(brain.home).addScaledVector(lurkDir || me.dir, MOUTH_OUT);
    if (dist < 0.3 || (lurkDir && pos.distanceTo(_mouth) < 0.5) || (lurkDir && dist < 1.3 && wasBacking)) {
      // Face out with a slow sway.
      dir.copy(lurkDir || me.dir).multiplyScalar(2);
      dir.x += Math.sin(brain.modeTime * 0.25 + brain.orbit) * 0.3; dir.z += Math.cos(brain.modeTime * 0.17) * 0.2;
      out.speed = pace.lurk[1];
      brain.backing = lurkDir && dist > 0.05 ? Math.min(MAX_BACKING, 0.1 + dist * 0.4) : 0;
    } else {
      // Coming home: head for the water just outside the mouth (the roof is not in the height field).
      if (lurkDir) dir.subVectors(_mouth, pos);
      const d = dir.length();
      dir.normalize();
      out.speed = Math.max(0.12, d < 1 ? pace.lurk[0] * d : pace.lurk[0]);
    }
  },
};
