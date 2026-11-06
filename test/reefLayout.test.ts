// Reef layout determinism: the same seed builds the same reef, different seeds differ, and the builder
// reproduces the original JS build's layout exactly (recorded in test/goldens/reefLayout-<seed>.json).
// Built headlessly behind a fake canvas (the layout never reads texture pixels) with procedural scenery.
import { describe, expect, it } from 'vitest';
import { buildSnapshot } from './support/reefSnapshot.js';
import { readGolden, REEF_SEEDS } from './support/golden.js';
import { buildReef } from '../src/reef.js';

const TIMEOUT_MS = 120_000;
const build = (seed: number) => buildSnapshot(buildReef, seed);

describe('reef layout', () => {
  it('is deterministic for a seed', () => {
    const a = build(7), b = build(7);
    expect(a).toEqual(b);
    expect(a.homes.length).toBeGreaterThan(0);
    expect(a.caves.length).toBeGreaterThan(0);
  }, TIMEOUT_MS);

  it('differs across seeds', () => {
    expect(build(7).homes).not.toEqual(build(42).homes);
  }, TIMEOUT_MS);

  it.each(REEF_SEEDS)('matches the JS build for seed %i', (seed) => {
    expect(build(seed)).toEqual(readGolden(`reefLayout-${seed}`));
  }, TIMEOUT_MS);
});
