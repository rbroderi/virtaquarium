// The typed species catalogue must hold exactly the data the original JS build computed (its species
// table after post-processing: swim, pace, night colours, fitted anatomy and colour gains), recorded in
// test/goldens/species.json.
import { describe, expect, it } from 'vitest';
import { SPECIES, FISH_NAMES } from '../src/species.js';
import { readGolden, plain } from './support/golden.js';

describe('species catalogue', () => {
  it('matches the JS species data field for field', () => {
    expect(plain(SPECIES)).toEqual(readGolden('species'));
  });

  it('keeps the name pool', () => {
    expect(FISH_NAMES).toEqual(readGolden('fishNames'));
  });

  it('has unique ids', () => {
    expect(new Set(SPECIES.map((s) => s.id)).size).toBe(SPECIES.length);
  });
});
