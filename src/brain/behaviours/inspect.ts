// Inspect: come up to the glass and look out. A pointer at the glass draws bold, curious fish to it;
// they get used to it (habituation), so it isn't a lure that works for ever.
import { range } from '../../util.js';
import type { Behaviour } from '../behaviour.js';

/** The viewer counts as there above this activity. */
const VIEWER_ACTIVE = 0.2;
/** Too shy to come to the glass above this. */
const SHY_LIMIT = 0.6;
const HOLD_SECONDS = 9;

export const inspect: Behaviour = {
  mode: 'inspect',

  score({ brain, world, species: sp, personality: t, drives: d }) {
    let s = brain.inspectDone || (sp.shy || 0) > SHY_LIMIT ? 0 : t.curiosity * d.boredom * (sp.lurker ? 0.4 : 0.9);
    const vw = world.viewer;
    if (vw && vw.activity > VIEWER_ACTIVE && !sp.lurker) s = Math.max(s, t.curiosity * t.boldness * 1.2 * vw.activity * (1 - (brain.habit || 0)));
    return s;
  },

  // (As in the original: leaving the glass makes the fish willing to come back to it.)
  exit(brain) {
    brain.inspectDone = false;
  },

  steer({ brain, me, world, dir, pos, pace, out }) {
    const vw = world.viewer, B = world.bounds;
    if (vw && vw.activity > VIEWER_ACTIVE) {
      // Come up to the pointer and hold just behind the glass, facing it.
      brain.target.copy(vw.pos).setZ(B.z1 - 0.5 - me.size * 0.5);
      brain.targetTimer = 5;
    } else if (brain.targetTimer <= 0 && brain.target.z < B.z1 - 1) {
      brain.target.set(range(brain.rng, B.x0 * 0.6, B.x1 * 0.6), range(brain.rng, B.y1 * 0.4, B.y1 * 0.75), B.z1 - 0.7);
      brain.targetTimer = 20;
    }
    dir.subVectors(brain.target, pos);
    if (dir.length() < 0.5) {
      // Face the viewer and hang there for a bit.
      dir.set(Math.sin(brain.modeTime * 0.7) * 0.25, 0, 1);
      out.speed = pace.inspect[1];
      if (brain.modeTime > HOLD_SECONDS) { brain.inspectDone = true; brain.drives.boredom = 0; brain.thinkClock = 0; }
    } else { dir.normalize(); out.speed = pace.inspect[0]; }
  },

  narrate: (brain) => (brain.habit > 0 && brain.habit < 1 ? 'Watching you' : null),
};
