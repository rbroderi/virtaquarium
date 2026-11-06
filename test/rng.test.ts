import { describe, expect, it } from 'vitest';
import { mulberry32, pick, range } from '../src/core/rng.js';
import { Noise } from '../src/core/noise.js';
import { clamp, lerp, wrapAngle } from '../src/core/math.js';
import { readGolden, RNG_SEEDS, RNG_DRAWS } from './support/golden.js';
import { mixHex, shade, hexToRgb } from '../src/core/color.js';

const take = (n: number, rng: () => number): number[] => Array.from({ length: n }, () => rng());

describe('mulberry32', () => {
  it('matches the JS build sequence for seed 7', () => {
    // Values the original JS build gave for mulberry32(7); the port must reproduce them exactly.
    expect(take(4, mulberry32(7))).toEqual([
      0.011704753153026104, 0.06195825757458806, 0.97690763277933, 0.6990287057124078,
    ]);
  });

  it('matches the JS build bit for bit across many seeds', () => {
    const golden = readGolden('mulberry32') as number[][];
    RNG_SEEDS.forEach((seed, i) => expect(take(RNG_DRAWS, mulberry32(seed))).toEqual(golden[i]));
  });

  it('is deterministic per seed and differs across seeds', () => {
    expect(take(50, mulberry32(42))).toEqual(take(50, mulberry32(42)));
    expect(take(50, mulberry32(42))).not.toEqual(take(50, mulberry32(43)));
  });

  it('stays in [0, 1)', () => {
    for (const v of take(10_000, mulberry32(123))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('treats seeds modulo 2^32', () => {
    expect(take(5, mulberry32(-1))).toEqual(take(5, mulberry32(0xffffffff)));
  });
});

describe('range and pick', () => {
  it('range stays within its bounds', () => {
    const rng = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = range(rng, -2, 3);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThan(3);
    }
  });

  it('pick returns an element and throws on an empty list', () => {
    const items = ['a', 'b', 'c'] as const;
    expect(items).toContain(pick(mulberry32(5), items));
    expect(() => pick(mulberry32(5), [])).toThrow(RangeError);
  });
});

describe('Noise', () => {
  it('is reproducible for the same seed', () => {
    const a = new Noise(mulberry32(9)), b = new Noise(mulberry32(9));
    for (let i = 0; i < 20; i++) expect(a.fbm(i * 0.37, i * 0.11)).toBe(b.fbm(i * 0.37, i * 0.11));
  });

  it('stays in [0, 1]', () => {
    const n = new Noise(mulberry32(3));
    for (let i = 0; i < 500; i++) {
      const v = n.fbm3(i * 0.13, i * 0.07, i * 0.29);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('math and colour helpers', () => {
  it('clamp, lerp and wrapAngle', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(lerp(2, 4, 0.25)).toBe(2.5);
    expect(wrapAngle(3 * Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-3 * Math.PI)).toBeCloseTo(-Math.PI);
  });

  it('mixes and shades hex colours', () => {
    expect(hexToRgb('#ff8000')).toEqual([255, 128, 0]);
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(shade('#204060', 0)).toBe('#204060');
    expect(shade('#204060', -1)).toBe('#000000');
  });
});
