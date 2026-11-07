// Rest: into its shelter (through the open front of a ledge, or down into the coral) when it knows one,
// else hover by home. In the dark everyone goes in: the reef empties at dusk (Hobson 1972).
import type { Behaviour } from '../behaviour.js';
import { SHELTER_ROCK_ROOM } from '../reflexes.js';

const SLEEPY = 0.3;
/** In its shelter a resting fish drifts at this share of its resting pace (it nudged into the rock). */
const SHELTERED_DRIFT = 0.5;
/** A perched fish sways this much (heading units) so it doesn't stand stock-still. */
const PERCH_SWAY = 0.05;

export const rest: Behaviour = {
  mode: 'rest',

  score: ({ species: sp, drives: d, dark }) =>
    sp.lurker ? 0 : (1 - d.energy) * 1.1 + (sp.nocturnal ? 0 : dark * 0.8) + (sp.shy || 0) * 0.15,

  steer({ brain, me, world, dir, pos, pace, out }) {
    const sh = brain.shelter, goal = sh ? brain.shelterGoal(sh, pos, world) : brain.home;
    dir.subVectors(goal, pos);
    const dist = dir.length();
    out.clearance = me.size * 0.2;
    // Perching species settle on the rock for the night once they are against it, instead of chasing
    // the spot's height: the height correction and the rock's push-back then fought each other, so the
    // fish bobbed up and down in the gap all night (the longnose ~5.8 wobbles/min).
    if (me.sp.brain.perch && sh && brain.sheltered && world.rockDist(pos) < me.body.halfDepth + SHELTER_ROCK_ROOM) {
      dir.set(Math.sin(brain.modeTime * 0.1 + brain.orbit) * PERCH_SWAY, 0, Math.cos(brain.modeTime * 0.08) * PERCH_SWAY).add(me.dir);
      out.speed = 0;
      brain.perched = true;
      return;
    }
    brain.perched = false;
    if (dist < (sh ? 0.25 : 0.5)) {
      dir.set(Math.sin(brain.modeTime * 0.3 + brain.orbit) * 0.4, 0, Math.cos(brain.modeTime * 0.2) * 0.3).add(me.dir);
      out.speed = pace.rest[1] * (brain.sheltered ? SHELTERED_DRIFT : 1);
    } else out.speed = dist > 1 ? pace.rest[0] : pace.rest[0] * Math.max(0.3, dist);
  },

  narrate: (brain) => (brain.drives.energy < SLEEPY ? 'Sleepy, settling in' : null),
};
