import { describe, expect, it } from 'vitest';
import { CAVE_SHARE_DAY, CAVE_SHARE_NIGHT, newCaveClock, tickCaveClock } from '../src/brain/caveClock.js';
import { mulberry32 } from '../src/util.js';

function share(dark: number): number {
  const rng = mulberry32(5);
  const c = newCaveClock(rng);
  const dt = 0.5, steps = 2_000_000;
  let inside = 0;
  for (let i = 0; i < steps; i++) {
    tickCaveClock(c, dt, dark, true, rng);
    if (c.inCave) inside++;
  }
  return inside / steps;
}

describe('cave clock', () => {
  it('keeps the eel in its cave about 90% of the day', () => {
    expect(share(0)).toBeCloseTo(CAVE_SHARE_DAY, 1);
  });
  it('and about 60% of the night', () => {
    expect(share(1)).toBeCloseTo(CAVE_SHARE_NIGHT, 1);
  });
});
