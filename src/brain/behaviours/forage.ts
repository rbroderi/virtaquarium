// Forage: pick a patch of reef near home, swim to it and peck at the algae, nose down.
import { clamp, range } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

/** Within this distance of the patch the fish starts pecking. */
const PECK_REACH = 0.35;
/** Beyond this the fish travels at the far pace. */
const FAR = 2;

export const forage: Behaviour = {
  mode: 'forage',

  score: ({ species: sp, drives: d }) => (sp.grazer || 0) * (0.25 + d.hunger * 0.9),

  steer({ brain, me, world, dt, dir, pos, species: sp, pace, out }) {
    const B = world.bounds;
    if (brain.targetTimer <= 0) {
      const x = clamp(brain.home.x + range(brain.rng, -3, 3), B.x0 + 0.8, B.x1 - 0.8);
      const z = range(brain.rng, B.z0 + 0.8, B.z1 - 1.0);
      brain.target.set(x, world.reefHeight(x, z) + me.size * 0.3, z);
      brain.targetTimer = range(brain.rng, 8, 16);
      brain.pecking = 0;
    }
    const dist = pos.distanceTo(brain.target);
    out.clearance = me.size * 0.15;
    if (dist < PECK_REACH || brain.pecking > 0) {
      // Peck: hold position nose-down, nibbling.
      brain.pecking += dt;
      brain.drives.hunger = clamp(brain.drives.hunger - dt * 0.012 * sp.grazer, 0, 1);
      dir.subVectors(brain.target, pos);
      dir.y -= 0.6;
      dir.x += Math.sin(brain.modeTime * 2 + brain.orbit) * 0.3;
      out.speed = pace.peck;
      if (brain.pecking > range(brain.rng, 2.5, 5)) brain.targetTimer = 0;
    } else {
      dir.subVectors(brain.target, pos).normalize();
      out.speed = pace.forage[dist > FAR ? 0 : 1];
    }
  },

  narrate: (brain) => (brain.pecking > 0 ? 'Nibbling algae' : null),
};
