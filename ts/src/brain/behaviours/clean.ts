// Clean (cleaner wrasse, Labroides): with a client posing, work along its flank head to tail and back,
// swapping sides every other pass, nose to the skin, picking. Without one, advertise with the
// up-and-down rocking "dance" over the station (Potts 1973) that brings clients in.
import * as THREE from 'three';
import { clamp, range } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

/** Cleaners sometimes cheat and bite the client's mucus instead (Bshary & Grutter 2002). */
const CHEAT_CHANCE = 0.03;
const PARASITES_PICKED_PER_SECOND = 0.03;
const AT_SKIN = 0.15;

const _clientSide = new THREE.Vector3();

export const clean: Behaviour = {
  mode: 'clean',

  // Cleaning runs by day: the cleaner holds its station.
  score: ({ world, species: sp, drives: d }) =>
    sp.cleaner && world.station ? 0.55 + 0.35 * world.light - (1 - d.energy) * 0.3 : 0,

  steer({ brain, me, world, dt, dir, pos, out }) {
    const st = world.station;
    if (!st) return;
    const c = st.client;
    out.clearance = me.size * 0.1;
    if (c && c.brain.posing) {
      brain.focus = c;
      brain.orbit += dt * 0.45;
      const along = Math.sin(brain.orbit) * 0.42, side = Math.sin(brain.orbit * 0.5) > 0 ? 1 : -1;
      _clientSide.set(-c.dir.z, 0, c.dir.x).normalize();
      const off = 0.1 * c.size + 0.18 * me.size;
      brain.target.copy(c.pos).addScaledVector(c.dir, along * c.size).addScaledVector(_clientSide, side * off);
      dir.subVectors(brain.target, pos);
      const dist = dir.length();
      if (dist < AT_SKIN) {
        // At the skin: face it and pick, with the odd snap of the jaws.
        dir.copy(_clientSide).multiplyScalar(-side).addScaledVector(c.dir, -Math.cos(brain.orbit) * 0.6);
        out.speed = 0.04;
        c.brain.drives.parasites = clamp(c.brain.drives.parasites - dt * PARASITES_PICKED_PER_SECOND, 0, 1);
        brain.peckT -= dt;
        if (brain.peckT <= 0) {
          me.gulp = 0.12;
          brain.peckT = range(brain.rng, 0.4, 1.2);
          // A cheat: the client jolts and leaves.
          if (brain.rng() < CHEAT_CHANCE) c.brain.startle(me, 0.7);
        }
      } else out.speed = dist > 0.6 ? 0.45 : 0.08 + dist * 0.5;
    } else {
      brain.focus = null;
      brain.orbit += dt;
      brain.target.set(st.pos.x + Math.sin(brain.orbit * 0.6) * 0.35, st.pos.y + 0.3 + Math.sin(brain.orbit * 2.2) * 0.18, st.pos.z + Math.cos(brain.orbit * 0.6) * 0.2);
      dir.subVectors(brain.target, pos);
      out.speed = Math.min(0.3, dir.length() * 0.6);
    }
  },

  narrate: (brain) => (brain.focus ? 'Cleaning ' + brain.focus.name : null),
};
