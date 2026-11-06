// Pose (a cleaner's client): swim to the station and hold still head-up with fins spread while the
// cleaner works. Only one at a time; the next waits its turn a little way off. Clients come when their
// parasites itch.
import * as THREE from 'three';
import type { Behaviour } from '../behaviour.js';

/** Parasite load that starts to itch. */
const ITCH = 0.3;

const _spot = new THREE.Vector3(), _back = new THREE.Vector3();

export const pose: Behaviour = {
  mode: 'pose',

  score({ world, species: sp, drives: d }) {
    const st = world.station;
    return sp.client && st && st.cleaner && st.cleaner.brain.mode === 'clean' ? (d.parasites - ITCH) * 2.5 * world.light - d.fear : 0;
  },

  steer({ brain, me, world, dir, pos, pace, out }) {
    const st = world.station;
    if (!st) return;
    const free = !st.client || st.client === me;
    out.clearance = me.size * 0.25;
    _spot.set(st.pos.x, st.pos.y + 0.35 + me.size * 0.3, st.pos.z + 0.4);
    if (!free) _spot.x += (pos.x > st.pos.x ? 1 : -1) * (1.2 + me.size);
    dir.subVectors(_spot, pos);
    const dist = dir.length();
    // Once in place, stay posing while within a looser radius (the cleaner nudges, the current drifts).
    brain.posing = free && dist < (brain.posing ? 1.0 : 0.5);
    if (brain.posing) {
      st.client = me;
      // Hold still head-up, drifting back to the spot if pushed off it.
      dir.set(me.dir.x * 0.3, 1, me.dir.z * 0.3).addScaledVector(_back.subVectors(_spot, pos), 0.8);
      out.speed = 0.02 + dist * 0.1;
    } else {
      dir.normalize();
      out.speed = dist > 1 ? pace.cruise[0] + 0.1 : 0.06 + dist * 0.15;
    }
  },

  narrate: (brain) => (brain.posing ? 'Posing, being cleaned' : null),
};
