// The organic-imperfection helpers must draw the same random numbers and give the same curves as the
// original JS build (recorded in test/goldens/organic.json), so painted skins match.
import { describe, expect, it } from 'vitest';
import { valueNoise, wobble, roundCorners } from '../src/core/organic.js';
import { mulberry32 } from '../src/core/rng.js';
import { readGolden, ORGANIC_SAMPLES } from './support/golden.js';

interface OrganicGolden {
  valueNoise: number[][];
  wobble: number[];
  roundCorners: unknown;
  nextAfterValueNoise: number;
}
const golden = readGolden('organic') as OrganicGolden;

describe('organic helpers match the JS build', () => {
  it.each([[0, false, false], [1, true, false], [2, true, true]] as const)('valueNoise #%i (wrapX %s, wrapY %s)', (i, wrapX, wrapY) => {
    const ts = valueNoise(mulberry32(5), 7.4, 3, wrapX, wrapY);
    expect(ORGANIC_SAMPLES.map(([x, y]) => ts(x * 1.3 - 0.1, y))).toEqual(golden.valueNoise[i]);
  });

  it('wobble', () => {
    const ts = wobble(mulberry32(9), 4);
    expect(ORGANIC_SAMPLES.map(([s]) => ts(s))).toEqual(golden.wobble);
  });

  it('roundCorners', () => {
    expect(roundCorners([[0, 0], [10, 0], [10, 4], [0, 4]], 1.5)).toEqual(golden.roundCorners);
  });

  it('draws the same number of random values', () => {
    const a = mulberry32(3);
    valueNoise(a, 6, 6, true);
    expect(a()).toBe(golden.nextAfterValueNoise);
  });
});
