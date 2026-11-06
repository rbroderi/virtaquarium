// A damped spring (semi-implicit Euler, substepped so a frame hitch can't blow it up). Real reef-fish
// bodies are stiff (an overshoot of a few percent), fins much softer.
import { clamp } from '../util.js';

export interface SpringState {
  x: number;
  v: number;
}

/** Substeps per natural period: enough that a long frame stays stable. */
const SUBSTEPS_PER_PERIOD = 8;

export const springState = (x = 0): SpringState => ({ x, v: 0 });

/** Pulls s towards target at natural frequency hz with damping ratio zeta; returns the new position. */
export function spring(s: SpringState, target: number, hz: number, zeta: number, dt: number): number {
  const w = 2 * Math.PI * hz, n = Math.ceil(dt * hz * SUBSTEPS_PER_PERIOD), h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (w * w * (target - s.x) - 2 * zeta * w * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}

/** Hermite step from a to b. */
export function smoothstep(a: number, b: number, x: number): number {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
