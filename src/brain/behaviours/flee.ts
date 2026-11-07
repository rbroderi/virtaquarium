// Flee: away from the threat and dash for cover, a known shelter close by, else home.
import * as THREE from 'three';
import type { Behaviour } from '../behaviour.js';

/** A shelter further than this is no use in a hurry. */
const SHELTER_REACH = 5;

const _toCover = new THREE.Vector3();

export const flee: Behaviour = {
  mode: 'flee',

  score: ({ species: sp, drives: d }) => (sp.host ? 0 : d.fear * 1.8),

  steer({ brain, me, world, dir, pos, pace, out }) {
    if (brain.threat) dir.subVectors(pos, brain.threat.pos).normalize().multiplyScalar(1.5);
    const sh = brain.shelter && brain.shelter.pos.distanceTo(pos) < SHELTER_REACH ? brain.shelter : null;
    dir.add(_toCover.subVectors(sh ? brain.shelterGoal(sh, pos, world) : brain.home, pos).normalize().multiplyScalar(sh ? 1.4 : 1));
    out.speed = pace.flee;
    out.clearance = me.size * 0.2;
  },
};
