// Rest: into its shelter (through the open front of a ledge, or down into the coral) when it knows one,
// else hover by home. In the dark everyone goes in: the reef empties at dusk (Hobson 1972).
import type { Behaviour } from '../behaviour.js';

const SLEEPY = 0.3;

export const rest: Behaviour = {
  mode: 'rest',

  score: ({ species: sp, drives: d, dark }) =>
    sp.lurker ? 0 : (1 - d.energy) * 1.1 + (sp.nocturnal ? 0 : dark * 0.8) + (sp.shy || 0) * 0.15,

  steer({ brain, me, dir, pos, pace, out }) {
    const sh = brain.shelter, goal = sh ? brain.shelterGoal(sh, pos) : brain.home;
    dir.subVectors(goal, pos);
    const dist = dir.length();
    out.clearance = me.size * 0.2;
    if (dist < (sh ? 0.25 : 0.5)) {
      dir.set(Math.sin(brain.modeTime * 0.3 + brain.orbit) * 0.4, 0, Math.cos(brain.modeTime * 0.2) * 0.3).add(me.dir);
      out.speed = pace.rest[1];
    } else out.speed = dist > 1 ? pace.rest[0] : pace.rest[0] * Math.max(0.3, dist);
  },

  narrate: (brain) => (brain.drives.energy < SLEEPY ? 'Sleepy, settling in' : null),
};
