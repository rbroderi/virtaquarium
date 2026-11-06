// Stalk (lionfish, Albins & Lyons 2012): a slow approach with the pectoral fans spread, herding prey
// against the rock, then a lunge from about a body length. The prey always gets away here (the tank
// keeps its fish), but the lunge scares it and the shoal around it.
import { clamp } from '../../util.js';
import type * as THREE from 'three';
import type { Brain } from '../../brain.js';
import type { Fish } from '../../fish.js';
import type { Behaviour, Steering } from '../behaviour.js';

/** Hunting peaks at this light level (dusk and dawn: crepuscular), fading over DUSK_WIDTH. */
const DUSK_LIGHT = 0.35;
const DUSK_WIDTH = 0.3;
/** Prey is lost beyond this distance, or after GIVE_UP seconds. */
const LOSE_PREY = 5;
const SEARCH_RADIUS = 4;
const GIVE_UP = 45;
const STRIKE_SECONDS = 0.35;
const LUNGE_SPEED = 1.6;
/** How wide the jaws open on the strike. */
const LUNGE_GAPE = 0.35;
/** Rest between hunts (s), after giving up / after a strike. */
const COOL_AFTER_GIVING_UP = 30;
const COOL_AFTER_STRIKE = 25;

export const stalk: Behaviour = {
  mode: 'stalk',

  // Lionfish hunt mostly at dusk and dawn, and by day only when hungry.
  score({ brain, world, species: sp, drives: d }) {
    const dusk = clamp(1 - Math.abs(world.light - DUSK_LIGHT) / DUSK_WIDTH, 0, 1);
    return sp.predator && !sp.lurker && !(brain.strikeCool > 0) ? dusk * 0.9 + d.hunger * 0.55 : 0;
  },

  steer({ brain, me, world, dt, dir, pos, pace, out }) {
    let prey = brain.focus;
    if (!prey || prey.pos.distanceTo(pos) > LOSE_PREY || brain.modeTime > GIVE_UP) {
      prey = null;
      let bd = SEARCH_RADIUS;
      for (const o of world.fish) {
        if (!o.sp.brain.prey || o.sp === me.sp || o.brain.sheltered) continue;
        const d = o.pos.distanceTo(pos);
        if (d < bd && brain.senses(o, d, world)) { bd = d; prey = o; }
      }
      brain.focus = prey;
      if (brain.modeTime > GIVE_UP) { brain.strikeCool = COOL_AFTER_GIVING_UP; brain.thinkClock = 0; }
    }
    if (!prey) { dir.copy(me.dir); dir.y = 0; out.speed = pace.hover; return; }
    lunge(brain, me, prey, dt, dir, pos, out);
  },

  narrate: (brain) => (brain.focus ? (brain.striking > 0 ? 'Lunging at ' : 'Stalking ') + brain.focus.name : null),
};

/** Close in on the prey and, within a body length, strike. */
function lunge(brain: Brain, me: Fish, prey: Fish, dt: number, dir: THREE.Vector3, pos: THREE.Vector3, out: Steering): void {
  dir.subVectors(prey.pos, pos);
  const d = dir.length();
  dir.normalize();
  out.clearance = me.size * 0.2;
  if (brain.striking > 0) {
    brain.striking -= dt;
    out.speed = LUNGE_SPEED;
    if (brain.striking <= 0) { brain.strikeCool = COOL_AFTER_STRIKE; brain.focus = null; brain.thinkClock = 0; }
  } else if (d < me.size * 0.9) {
    brain.striking = STRIKE_SECONDS;
    me.gulp = LUNGE_GAPE;
    prey.brain.startle(me, 0.95);
    brain.strikes += 1;
  } else out.speed = 0.22 * clamp(d, 0.3, 1);
}
