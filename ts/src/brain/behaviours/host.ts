// Host: a clownfish weaving through its anemone's tentacles, closer in when scared.
import type { Behaviour } from '../behaviour.js';

export const host: Behaviour = {
  mode: 'host',

  score: ({ species: sp, drives: d }) => (sp.host ? 0.75 + d.fear * 0.8 - d.boredom * 0.3 : 0),

  steer({ brain, me, world, dt, dir, pos, pace, out }) {
    const an = world.anemoneFor(me);
    if (!an) {   // no anemone in this tank: drift on
      dir.copy(me.dir);
      return;
    }
    brain.orbit += dt * (0.4 + brain.drives.fear);
    const r = an.radius * (0.35 + 0.25 * Math.sin(brain.orbit * 0.7));
    brain.target.set(an.pos.x + Math.cos(brain.orbit) * r, an.pos.y + an.radius * 0.45 + Math.sin(brain.orbit * 1.3) * 0.15, an.pos.z + Math.sin(brain.orbit) * r * 0.6);
    dir.subVectors(brain.target, pos);
    const dist = dir.length();
    dir.normalize();
    out.speed = dist > 1.5 ? pace.host[0] : pace.host[1] + dist * 0.1;
    out.clearance = 0.05;
  },
};
