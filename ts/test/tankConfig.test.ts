import { describe, expect, it } from 'vitest';
import {
  normalizeTank, loadTank, applyUrlOverrides, defaultTank, LIMITS, TANK_VERSION, type HabitatCatalogue,
} from '../src/config/tankConfig.js';

const CATALOGUE: HabitatCatalogue = {
  reef: [
    { id: 'clownfish', count: 3 },
    { id: 'bluetang', count: 2 },
    { id: 'octopus', count: 1 },
  ],
  jelly: [{ id: 'moon', count: 6 }],
};

const normalize = (raw: unknown) => normalizeTank(raw, CATALOGUE);

describe('normalizeTank', () => {
  it('fills every field with defaults for an empty object', () => {
    const { tank, warnings } = normalize({});
    expect(warnings).toEqual([]);
    expect(tank).toEqual(defaultTank(CATALOGUE));
    expect(tank.fish.map((f) => [f.species, f.count])).toEqual([['clownfish', 3], ['bluetang', 2], ['octopus', 1]]);
  });

  it('rejects non-objects with a warning', () => {
    for (const raw of [null, 42, 'tank', [1, 2]]) {
      const { tank, warnings } = normalize(raw);
      expect(warnings).toContain('tank config is not an object; using defaults');
      expect(tank.seed).toBe(defaultTank(CATALOGUE).seed);
    }
  });

  it('warns about a different version but still loads', () => {
    const { tank, warnings } = normalize({ version: 99, seed: 5 });
    expect(warnings).toEqual([`tank version 99 != ${TANK_VERSION}`]);
    expect(tank.version).toBe(TANK_VERSION);
    expect(tank.seed).toBe(5);
  });

  it('clamps and rounds numbers, accepting numeric strings', () => {
    const { tank } = normalize({ seed: '42.6', feedMinutes: 10_000 });
    expect(tank.seed).toBe(43);
    expect(tank.feedMinutes).toBe(LIMITS.feedMinutes);
    expect(normalize({ seed: -5 }).tank.seed).toBe(0);
    expect(normalize({ seed: 'abc' }).tank.seed).toBe(defaultTank(CATALOGUE).seed);
  });

  it('only accepts booleans for flags', () => {
    expect(normalize({ clock: 'yes', drift: 0 }).tank).toMatchObject({ clock: false, drift: true });
    expect(normalize({ clock: true, drift: false }).tank).toMatchObject({ clock: true, drift: false });
  });

  it('falls back to reef for unknown scenery', () => {
    const { tank, warnings } = normalize({ scenery: 'lagoon' });
    expect(tank.scenery).toBe('reef');
    expect(warnings).toEqual(['unknown scenery "lagoon"']);
  });

  it('drops unknown species and species from another habitat', () => {
    const { tank, warnings } = normalize({ fish: [{ species: 'shark', count: 1 }, { species: 'moon', count: 2 }, { species: 'clownfish', count: 1 }] });
    expect(tank.fish).toEqual([{ species: 'clownfish', count: 1, names: [] }]);
    expect(warnings).toEqual(['unknown species "shark"', `"moon" doesn't live in a reef tank`]);
  });

  it('merges repeated species, trims names and caps per species', () => {
    const { tank } = normalize({
      fish: [
        { species: 'clownfish', names: ['  Nemo  ', '', 7, 'A very long name that goes on and on'] },
        { species: 'clownfish', count: 11 },
      ],
    });
    expect(tank.fish).toHaveLength(1);
    const [clown] = tank.fish;
    expect(clown?.count).toBe(LIMITS.perSpecies);
    expect(clown?.names).toEqual(['Nemo', 'A very long name tha']);
  });

  it('uses the species default count when none is given and no names', () => {
    expect(normalize({ fish: [{ species: 'bluetang' }] }).tank.fish).toEqual([{ species: 'bluetang', count: 2, names: [] }]);
  });

  it('caps the whole tank', () => {
    const fish = ['clownfish', 'bluetang', 'octopus'].map((species) => ({ species, count: 12 }));
    const { tank, warnings } = normalize({ fish });
    expect(tank.fish.reduce((n, f) => n + f.count, 0)).toBe(LIMITS.totalFish);
    expect(tank.fish.map((f) => f.count)).toEqual([12, 12, 8]);
    expect(warnings).toContain(`tank capped at ${LIMITS.totalFish} fish`);
  });

  it('keeps the jelly tank to jellies', () => {
    const { tank, warnings } = normalize({ scenery: 'jelly', fish: [{ species: 'clownfish', count: 1 }, { species: 'moon', count: 3 }] });
    expect(tank.fish).toEqual([{ species: 'moon', count: 3, names: [] }]);
    expect(warnings).toEqual([`"clownfish" doesn't live in a jelly tank`]);
  });

  it('is idempotent', () => {
    const once = normalize({ seed: 9, fish: [{ species: 'bluetang', count: 4, names: ['Dory'] }] }).tank;
    expect(normalize(once)).toEqual({ tank: once, warnings: [] });
  });
});

describe('URL overrides and loadTank', () => {
  it('applies the legacy params over a file', () => {
    const params = new URLSearchParams('seed=12&clock=1&feed=9&drift=0');
    const { tank } = normalize(applyUrlOverrides({ seed: 3, clock: false }, params, CATALOGUE));
    expect(tank).toMatchObject({ seed: 12, clock: true, feedMinutes: 9, drift: false });
  });

  it('gives a jelly tank the jellies when it has no fish list', () => {
    const { tank } = normalize(applyUrlOverrides(undefined, new URLSearchParams('scenery=jelly'), CATALOGUE));
    expect(tank.scenery).toBe('jelly');
    expect(tank.fish).toEqual([{ species: 'moon', count: 6, names: [] }]);
  });

  it('loads ?tank= through the injected fetcher', async () => {
    const urls: string[] = [];
    const tank = await loadTank(new URLSearchParams('tank=tanks/a.json'), CATALOGUE, async (url) => {
      urls.push(url);
      return { seed: 77, fish: [{ species: 'octopus', count: 2 }] };
    }, () => {});
    expect(urls).toEqual(['tanks/a.json']);
    expect(tank.seed).toBe(77);
    expect(tank.fish).toEqual([{ species: 'octopus', count: 2, names: [] }]);
  });

  it('falls back to defaults when the fetch fails, with a warning', async () => {
    const warnings: string[] = [];
    const tank = await loadTank(new URLSearchParams('tank=missing.json'), CATALOGUE, () => Promise.reject(new Error('HTTP 404')), (m) => warnings.push(m));
    expect(tank).toEqual(defaultTank(CATALOGUE));
    expect(warnings).toEqual(['could not load missing.json (HTTP 404); using defaults']);
  });
});
