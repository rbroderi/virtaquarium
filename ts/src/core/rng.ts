// Seeded pseudo-random numbers. Every random choice in the tank goes through an Rng so a seed
// reproduces the same reef, stock and behaviour.

/** A source of uniform numbers in [0, 1). */
export type Rng = () => number;

const MULBERRY_INCREMENT = 0x6d2b79f5;
const UINT32_RANGE = 4294967296;

/** mulberry32: a small, fast 32-bit generator; the same seed always gives the same sequence. */
export function mulberry32(seed: number): Rng {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + MULBERRY_INCREMENT) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };
}

/** Uniform number in [lo, hi). */
export const range = (rng: Rng, lo: number, hi: number): number => lo + (hi - lo) * rng();

/** A uniformly chosen element; throws on an empty list rather than returning undefined. */
export function pick<T>(rng: Rng, items: readonly T[]): T {
  const item = items[Math.floor(rng() * items.length)];
  if (item === undefined) throw new RangeError('pick: empty list');
  return item;
}
