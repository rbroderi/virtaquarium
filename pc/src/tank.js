// Tank config: the per-user description of an aquarium (which fish, what scenery, feeder, lights).
// This is the document a dashboard edits and the Roku channel downloads; see schema/tank.schema.json.
// normalizeTank() is the single gate: anything it returns is safe to build a tank from.

import { SPECIES } from './species.js';
import { JELLY_SPECIES } from './jelly.js';
import { CRITTER_SPECIES } from './critters.js';

export const TANK_VERSION = 1;
export const SCENERY = ['reef'];       // layouts buildReef() knows (bake.js bakes each); more to come
// Every tank kind: the reef layouts, and the jelly tank (jelly.js: a backlit blue kreisel, no scenery).
export const TANK_SCENERY = [...SCENERY, 'jelly'];
export const LIMITS = { perSpecies: 12, totalFish: 32, nameLength: 20, feedMinutes: 120 };   // default stock is 31 with the critters
// Which animals each kind of tank can hold: jellies live only in the jelly tank, and it holds only jellies.
const HABITAT = { reef: [...SPECIES, ...CRITTER_SPECIES], jelly: JELLY_SPECIES };
const defaultFish = (scenery) => HABITAT[scenery === 'jelly' ? 'jelly' : 'reef'].map((sp) => ({ species: sp.id, count: sp.count }));

export const DEFAULT_TANK = {
  version: TANK_VERSION,
  seed: 7,
  scenery: 'reef',
  clock: false,
  feedMinutes: 4,
  drift: true,
  fish: defaultFish('reef'),
};

const int = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback);
const bool = (v, fallback) => (typeof v === 'boolean' ? v : fallback);

// Returns { tank, warnings }. Unknown or out-of-range values fall back to defaults rather than failing,
// so an old Roku build can still show a tank written by a newer dashboard.
export function normalizeTank(raw) {
  const warnings = [];
  const src = raw && typeof raw === 'object' ? raw : {};
  if (raw !== undefined && src !== raw) warnings.push('tank config is not an object; using defaults');
  if (src.version !== undefined && src.version !== TANK_VERSION) warnings.push(`tank version ${src.version} != ${TANK_VERSION}`);

  const scenery = TANK_SCENERY.includes(src.scenery) ? src.scenery : DEFAULT_TANK.scenery;
  if (src.scenery !== undefined && scenery !== src.scenery) warnings.push(`unknown scenery "${src.scenery}"`);

  const habitat = scenery === 'jelly' ? 'jelly' : 'reef';
  const known = new Map(HABITAT[habitat].map((sp) => [sp.id, sp]));
  const elsewhere = new Set(Object.values(HABITAT).flat().map((sp) => sp.id));
  const merged = new Map();   // species id -> { count, names }, keeps first-seen order
  const list = Array.isArray(src.fish) ? src.fish : defaultFish(scenery);
  for (const entry of list) {
    const id = entry && entry.species;
    if (!known.has(id)) { warnings.push(elsewhere.has(id) ? `"${id}" doesn't live in a ${habitat} tank` : `unknown species "${id}"`); continue; }
    const names = (Array.isArray(entry.names) ? entry.names : [])
      .filter((n) => typeof n === 'string')
      .map((n) => n.trim().slice(0, LIMITS.nameLength))
      .filter(Boolean);
    const count = int(entry.count, 0, LIMITS.perSpecies, names.length || known.get(id).count);
    const m = merged.get(id) || { species: id, count: 0, names: [] };
    m.count = Math.min(LIMITS.perSpecies, m.count + count);
    m.names.push(...names);
    merged.set(id, m);
  }

  let room = LIMITS.totalFish;
  const fish = [];
  for (const m of merged.values()) {
    const count = Math.min(m.count, room);
    if (count < m.count) warnings.push(`tank capped at ${LIMITS.totalFish} fish`);
    room -= count;
    if (count > 0) fish.push({ species: m.species, count, names: m.names.slice(0, count) });
  }

  return {
    tank: {
      version: TANK_VERSION,
      seed: int(src.seed, 0, 2 ** 31 - 1, DEFAULT_TANK.seed),
      scenery,
      clock: bool(src.clock, DEFAULT_TANK.clock),
      feedMinutes: int(src.feedMinutes, 0, LIMITS.feedMinutes, DEFAULT_TANK.feedMinutes),
      drift: bool(src.drift, DEFAULT_TANK.drift),
      fish,
    },
    warnings,
  };
}

// ?tank=<url> loads a config file; the older ?seed= ?clock= ?feed= ?drift= params still override it.
export async function loadTank(params) {
  let raw;
  const url = params.get('tank');
  if (url) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      raw = await res.json();
    } catch (e) {
      console.warn(`tank: could not load ${url} (${e.message}); using defaults`);
    }
  }
  const scenery = params.get('scenery') || raw?.scenery;
  // A jelly tank without its own fish list gets the jellies, not the reef fish.
  raw = { ...DEFAULT_TANK, ...(scenery === 'jelly' && !raw?.fish ? { fish: defaultFish('jelly') } : {}), ...raw };
  if (scenery) raw.scenery = scenery;
  if (params.get('seed')) raw.seed = params.get('seed');
  if (params.has('clock')) raw.clock = params.get('clock') === '1';
  if (params.get('feed')) raw.feedMinutes = params.get('feed');
  if (params.has('drift')) raw.drift = params.get('drift') !== '0';

  const { tank, warnings } = normalizeTank(raw);
  for (const w of warnings) console.warn('tank:', w);
  return tank;
}
