// Patrol: circle the territory; chase an intruder off it. The loser remembers: after two defeats it
// keeps out of this fish's territory (a truce line, see the brain's reflexes).
import type { Behaviour } from '../behaviour.js';

/** The chase is given up beyond this distance from home. */
const TERRITORY = 4;
const ORBIT_RATE = 0.35;

export const patrol: Behaviour = {
  mode: 'patrol',

  score: ({ brain, personality: t }) => (brain.intruder ? t.aggression * 1.1 : t.aggression * 0.2) * (1 - brain.chaseFatigue),

  enter(brain) {
    brain.focus = brain.intruder;
  },

  steer({ brain, me, dir, pos, pace, out }) {
    const foe = brain.focus;
    if (foe && foe.pos.distanceTo(brain.home) < TERRITORY) {
      dir.subVectors(foe.pos, pos);
      const dist = dir.length();
      dir.normalize();
      out.speed = pace.chase;
      if (dist < (me.size + foe.size) * 0.6 && foe.brain.mode !== 'flee') {
        foe.brain.startle(me, 0.8);
        const lost = foe.brain.lostTo ?? (foe.brain.lostTo = new Map());
        lost.set(me, (lost.get(me) || 0) + 1);
      }
    } else {
      brain.focus = null;
      const a = brain.modeTime * ORBIT_RATE + brain.orbit;
      brain.target.set(brain.home.x + Math.cos(a) * 1.6, brain.home.y + 0.4, brain.home.z + Math.sin(a) * 0.8);
      dir.subVectors(brain.target, pos).normalize();
      out.speed = pace.patrol;
    }
  },

  narrate: (brain) => (brain.focus ? 'Chasing off ' + brain.focus.name : null),
};
