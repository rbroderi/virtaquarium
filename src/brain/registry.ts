// The behaviour registry. Its order is the order the brain scores and compares modes in, which is
// also the order it draws decision noise in, so it must not change (a seed would grow a different
// tank). It follows the JS build's score assignment order.
import type { Behaviour } from './behaviour.js';
import type { Mode } from './types.js';
import { cruise } from './behaviours/cruise.js';
import { school } from './behaviours/school.js';
import { forage } from './behaviours/forage.js';
import { feed } from './behaviours/feed.js';
import { rest } from './behaviours/rest.js';
import { lurk } from './behaviours/lurk.js';
import { flee } from './behaviours/flee.js';
import { patrol } from './behaviours/patrol.js';
import { inspect } from './behaviours/inspect.js';
import { host } from './behaviours/host.js';
import { hover } from './behaviours/hover.js';
import { stalk } from './behaviours/stalk.js';
import { clean } from './behaviours/clean.js';
import { pose } from './behaviours/pose.js';

export const BEHAVIOURS: readonly Behaviour[] = [
  cruise, school, forage, feed, rest, lurk, flee, patrol, inspect, host, hover, stalk, clean, pose,
];

const BY_MODE: ReadonlyMap<Mode, Behaviour> = new Map(BEHAVIOURS.map((b) => [b.mode, b]));

export function behaviourFor(mode: Mode): Behaviour {
  const behaviour = BY_MODE.get(mode);
  if (!behaviour) throw new Error(`no behaviour for mode "${mode}"`);
  return behaviour;
}
