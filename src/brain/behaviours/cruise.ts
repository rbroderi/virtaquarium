// Cruise: swim to a random point in the species' depth zone, then another. Before a scheduled feed,
// hungry fish gather where the food comes in (feeding-anticipatory activity).
import { clamp, range } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

/** Fish start gathering this many seconds before a feed. */
const ANTICIPATION_SECONDS = 60;
const ANTICIPATION_HUNGER = 0.4;
const ANTICIPATION_LIGHT = 0.3;
/** A new waypoint once within this distance, or after a 6-14 s timer. */
const ARRIVED = 0.8;

export const cruise: Behaviour = {
  mode: 'cruise',

  // An eel roams only on a foray out of its cave (brain/caveClock.ts).
  score: ({ brain, species: sp, personality: t, dark }) =>
    sp.lurker ? (brain.cave?.inCave ? 0 : 0.9) : 0.3 + 0.25 * t.activity + (sp.nocturnal ? dark * 0.5 : 0),

  steer({ brain, world, dir, pos, species: sp, pace, out }) {
    if (brain.targetTimer <= 0 || pos.distanceTo(brain.target) < ARRIVED) {
      brain.pickZonePoint(world, brain.target);
      const lastFeedX = world.lastFeedX;
      if (world.feedIn < ANTICIPATION_SECONDS && lastFeedX !== undefined && brain.drives.hunger > ANTICIPATION_HUNGER && !sp.lurker && world.light > ANTICIPATION_LIGHT) {
        const B = world.bounds;
        brain.target.set(clamp(lastFeedX + range(brain.rng, -1.5, 1.5), B.x0 + 1, B.x1 - 1),
          B.y1 - range(brain.rng, 0.6, 1.8), range(brain.rng, -0.8, 1.5));
      }
      brain.targetTimer = range(brain.rng, 6, 14);
    }
    dir.subVectors(brain.target, pos).normalize();
    out.speed = pace.cruise[0] + pace.cruise[1] * brain.traits.activity;
  },
};
