// Cave clock: how a moray splits its time between the cave and forays out. It spends about 90% of
// the day in the cave and about 60% of the night, in bouts: a foray out, then a long spell in. The
// lurk and cruise scores (behaviours/lurk.ts, cruise.ts) follow the clock; feeding and fleeing can
// still override it.
import { lerp, range, type Rng } from '../util.js';

/** Share of time spent in the cave, by day and by night. */
export const CAVE_SHARE_DAY = 0.9;
export const CAVE_SHARE_NIGHT = 0.6;
/** An eel this close to home (its middle, fish.pos) is in its cave. */
export const CAVE_RANGE = 1;
/** Mean length of a foray out, in seconds, by day and by night. */
const FORAY_DAY = 30;
const FORAY_NIGHT = 80;
/** Each bout lasts its mean times a factor in this range. */
const BOUT_SPREAD: [number, number] = [0.5, 1.5];

export interface CaveClock {
  /** True while the eel should be in its cave. */
  inCave: boolean;
  /** Seconds left in the current bout. */
  left: number;
}

/** Mean bout lengths for a darkness level (0 day, 1 night). */
export function caveBouts(dark: number): { inside: number; out: number } {
  const share = lerp(CAVE_SHARE_DAY, CAVE_SHARE_NIGHT, dark);
  const out = lerp(FORAY_DAY, FORAY_NIGHT, dark);
  return { inside: (out * share) / (1 - share), out };
}

/** A clock that starts in the cave, part way through a spell in. */
export function newCaveClock(rng: Rng): CaveClock {
  return { inCave: true, left: caveBouts(0).inside * rng() };
}

/** A spell in never grows past this many times its mean (an eel kept from home doesn't owe forever). */
const MAX_OWED = 3;

/**
 * Advances the clock; at the end of a bout it flips and draws the next bout's length. Time due in
 * the cave but spent away from it (swimming home, or drawn out to food) counts as time out, so the
 * spell in grows to keep the share: it holds, and adds share / (1 - share) of the time away.
 */
export function tickCaveClock(c: CaveClock, dt: number, dark: number, atHome: boolean, rng: Rng): void {
  if (c.inCave && !atHome) {
    const share = lerp(CAVE_SHARE_DAY, CAVE_SHARE_NIGHT, dark);
    c.left = Math.min(c.left + (dt * share) / (1 - share), caveBouts(dark).inside * MAX_OWED);
    return;
  }
  c.left -= dt;
  if (c.left > 0) return;
  c.inCave = !c.inCave;
  const mean = c.inCave ? caveBouts(dark).inside : caveBouts(dark).out;
  c.left = mean * range(rng, BOUT_SPREAD[0], BOUT_SPREAD[1]);
}
