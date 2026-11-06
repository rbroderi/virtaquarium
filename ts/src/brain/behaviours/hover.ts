// Hover: drift slowly about a point near home, fins fanned (lionfish).
import { range } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

export const hover: Behaviour = {
  mode: 'hover',

  score: ({ species: sp, dark }) => (sp.hover ? 0.7 - (sp.nocturnal ? dark * 0.4 : 0) : 0),

  steer({ brain, dir, pos, pace, out }) {
    if (brain.targetTimer <= 0) {
      const home = brain.home;
      brain.target.set(home.x + range(brain.rng, -1.2, 1.2), home.y + range(brain.rng, 0.3, 1.2), home.z + range(brain.rng, -0.6, 0.6));
      brain.targetTimer = range(brain.rng, 6, 12);
    }
    dir.subVectors(brain.target, pos);
    out.speed = Math.min(pace.hover, dir.length() * 0.2);
    dir.normalize();
  },
};
