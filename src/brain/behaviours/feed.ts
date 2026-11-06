// Feed: chase the flake the fish has its eye on and eat it.
import { clamp } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

/** Within this distance the fish slows for the final snap. */
const NEAR = 1.2;
/** It eats the flake within this fraction of its body length. */
const BITE_REACH = 0.4;
const HUNGER_PER_FLAKE = 0.15;
const ENERGY_PER_FLAKE = 0.04;
const STARVING = 0.7;

export const feed: Behaviour = {
  mode: 'feed',

  score: ({ brain, drives: d, personality: t }) => (brain.focusFood ? 0.5 + d.hunger * 1.2 + t.boldness * 0.3 : 0),

  steer({ brain, me, dir, pos, pace, out }) {
    const f = brain.focusFood;
    if (!f || f.eaten) {
      brain.thinkClock = 0;
      out.speed = pace.forage[0];
      dir.copy(me.dir);
      return;
    }
    dir.subVectors(f.pos, pos);
    const dist = dir.length();
    dir.normalize();
    out.clearance = me.size * 0.1;
    out.speed = pace.feed[dist > NEAR ? 0 : 1];
    if (dist < me.size * BITE_REACH) {
      f.eaten = true;
      brain.drives.hunger = clamp(brain.drives.hunger - HUNGER_PER_FLAKE, 0, 1);
      brain.drives.energy = clamp(brain.drives.energy + ENERGY_PER_FLAKE, 0, 1);
      me.gulp = 0.3;
    }
  },

  narrate: (brain) => (brain.drives.hunger > STARVING ? 'Starving: food!' : null),
};
