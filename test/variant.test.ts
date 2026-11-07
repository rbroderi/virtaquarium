// Individual variation between fish of a species: assignment is deterministic per seed, the Roku bake
// always uses variant 0, and a variant never removes or retypes a species-defining pattern op or fin.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng.js';
import { SPECIES } from '../src/species.js';
import { BAKE_VARIANT, VARIANT_COUNT, bakeVariant, pickVariant, variantSpecies } from '../src/fishModel/variant.js';

const HEX = /^#[0-9a-f]{6}$/i;

describe('variant assignment', () => {
  it('is deterministic for a seed', () => {
    const draw = (): number[] => Array.from({ length: 40 }, () => pickVariant(mulberry32(7)));
    expect(draw()).toEqual(draw());
  });

  it('stays within the capped variant set', () => {
    for (const v of Array.from({ length: 200 }, () => pickVariant(mulberry32(42)))) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(VARIANT_COUNT);
    }
  });
});

describe('Roku bake variants', () => {
  it('uses variant 0 for every fish of a species', () => {
    expect(BAKE_VARIANT).toBe(0);
    for (let i = 0; i < 40; i++) expect(bakeVariant(i)).toBe(0);
  });
});

describe('variantSpecies', () => {
  it('keeps variant 0 as the catalogued species', () => {
    for (const sp of SPECIES) expect(variantSpecies(sp, 0)).toBe(sp);
  });

  it('keeps species-defining pattern and fin structure while shifting colours', () => {
    for (const sp of SPECIES) {
      for (let v = 1; v < VARIANT_COUNT; v++) {
        const vsp = variantSpecies(sp, v);
        expect(vsp.variant).toBe(v);
        expect(vsp.pattern.length).toBe(sp.pattern.length);
        expect(vsp.fins.length).toBe(sp.fins.length);
        vsp.pattern.forEach((p, i) => expect(p.op).toBe(sp.pattern[i]?.op));
        for (const p of vsp.pattern) {
          if ('color' in p) expect(p.color).toMatch(HEX);
          if ('stops' in p) for (const [, c] of p.stops) expect(c).toMatch(HEX);
        }
      }
    }
  });
});
