// The organic-imperfection helpers must draw the same random numbers and give the same curves as the
// JS build's pc/src/organic.js, so painted skins match.
import { describe, expect, it } from 'vitest';
import { valueNoise, wobble, roundCorners } from '../src/core/organic.js';
import { mulberry32 } from '../src/core/rng.js';

type Fn = (...args: unknown[]) => unknown;

async function jsOrganic(name: string): Promise<Fn> {
  const mod: unknown = await import(new URL('../../pc/src/organic.js', import.meta.url).href);
  const fn = typeof mod === 'object' && mod !== null ? (mod as Record<string, unknown>)[name] : undefined;
  if (typeof fn !== 'function') throw new Error(`organic.js has no ${name}`);
  return fn as Fn;
}

const asField = (f: unknown): ((...a: number[]) => number) => {
  if (typeof f !== 'function') throw new Error('not a field');
  return (...a) => Number((f as Fn)(...a));
};

const SAMPLES = Array.from({ length: 40 }, (_, i) => [((i * 37) % 101) / 100, ((i * 53) % 97) / 96] as const);

describe('organic helpers match the JS build', () => {
  it.each([[false, false], [true, false], [true, true]])('valueNoise (wrapX %s, wrapY %s)', async (wrapX, wrapY) => {
    const js = asField((await jsOrganic('valueNoise'))(mulberry32(5), 7.4, 3, wrapX, wrapY));
    const ts = valueNoise(mulberry32(5), 7.4, 3, wrapX, wrapY);
    for (const [x, y] of SAMPLES) expect(ts(x * 1.3 - 0.1, y)).toBe(js(x * 1.3 - 0.1, y));
  });

  it('wobble', async () => {
    const js = asField((await jsOrganic('wobble'))(mulberry32(9), 4));
    const ts = wobble(mulberry32(9), 4);
    for (const [s] of SAMPLES) expect(ts(s)).toBe(js(s));
  });

  it('roundCorners', async () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 4], [0, 4]];
    expect(roundCorners(square, 1.5)).toEqual((await jsOrganic('roundCorners'))(square, 1.5));
  });

  it('draws the same number of random values', async () => {
    const a = mulberry32(3), b = mulberry32(3);
    valueNoise(a, 6, 6, true);
    (await jsOrganic('valueNoise'))(b, 6, 6, true);
    expect(a()).toBe(b());
  });
});
