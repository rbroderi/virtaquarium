// A global speed limit on how far any animal can move in one step. Corrections (out of rock, onto the
// floor, into a shelter, along the glass) run after an animal has moved, and each alone is reasonable,
// but together, or after a long frame, they could carry it further than it can swim: it was seen to
// jump. So every animal's displacement per step is capped by the speed it actually has, plus the water's
// drift, a little slack, and a slow crawl allowance (so a stopped animal can still be eased out of rock).
// A capped correction simply finishes over the next frames.
import type * as THREE from 'three';

/** Headroom over the animal's speed. */
export const STEP_SLACK = 1.25;

/** `?steplimit=0` turns the limit off, to compare. */
const ENABLED = typeof location === 'undefined' || new URLSearchParams(location.search).get('steplimit') !== '0';

/** The crawl allowance for fish, in body lengths per second. */
export const STEP_CRAWL_BL = 0.5;

/**
 * Moves `pos` back towards `prev` so the step is at most (STEP_SLACK x speed + crawl) x dt long.
 * speed and crawl in units per second. Returns true when the step was too long (and, unless the limit
 * is turned off, cut short), so the motion check can count jumps either way.
 */
export function limitStep(prev: THREE.Vector3, pos: THREE.Vector3, speed: number, crawl: number, dt: number): boolean {
  const max = (STEP_SLACK * Math.abs(speed) + crawl) * dt;
  const d2 = prev.distanceToSquared(pos);
  if (d2 <= max * max) return false;
  if (ENABLED) pos.sub(prev).multiplyScalar(max / Math.sqrt(d2)).add(prev);
  return true;
}
