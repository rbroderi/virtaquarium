// The typed species catalogue must hold exactly the data the JS build computes (pc/src/species.js after
// its post-processing: swim, pace, night colours, fitted anatomy and colour gains), and the tank gate
// must accept the same stock with the real catalogue.
import { describe, expect, it } from 'vitest';
import { SPECIES, FISH_NAMES } from '../src/species.js';

async function jsExport(file: string, name: string): Promise<unknown> {
  const mod: unknown = await import(new URL(`../../pc/src/${file}`, import.meta.url).href);
  if (typeof mod !== 'object' || mod === null || !(name in mod)) throw new Error(`${file} has no ${name}`);
  return (mod as Record<string, unknown>)[name];
}

/** Plain-data copy (drops undefined members, which JSON would too). */
const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

describe('species catalogue', () => {
  it('matches the JS species data field for field', async () => {
    expect(plain(SPECIES)).toEqual(plain(await jsExport('species.js', 'SPECIES')));
  });

  it('keeps the name pool', async () => {
    expect(FISH_NAMES).toEqual(await jsExport('species.js', 'FISH_NAMES'));
  });

  it('has unique ids', () => {
    expect(new Set(SPECIES.map((s) => s.id)).size).toBe(SPECIES.length);
  });
});
