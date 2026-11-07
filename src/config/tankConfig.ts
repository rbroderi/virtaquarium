// Tank config: the per-user description of an aquarium (which fish, what scenery, feeder, lights).
// This is the document a dashboard edits and the Roku channel downloads; see schema/tank.schema.json.
//
// normalizeTank() is the anti-corruption layer: it takes `unknown` (parsed JSON, URL params) and
// returns a validated Tank. Anything it returns is safe to build a tank from. It depends only on a
// HabitatCatalogue (dependency inversion), so it has no three.js or species imports and is unit-tested
// in Node.
import { isRecord } from '../core/dom.js';

export const TANK_VERSION = 1;

/** Reef layouts buildReef() knows (bake.ts bakes each). */
export const REEF_SCENERY = ['reef'] as const;
/** Every tank kind: the reef layouts, and the jelly tank (a backlit blue kreisel, no scenery). */
export const TANK_SCENERY = [...REEF_SCENERY, 'jelly'] as const;
export type Scenery = (typeof TANK_SCENERY)[number];
export type Habitat = 'reef' | 'jelly';

export const LIMITS = {
  perSpecies: 12,
  totalFish: 32,   // the default stock is 31 with the critters
  nameLength: 20,
  feedMinutes: 120,
} as const;

const MAX_SEED = 2 ** 31 - 1;

export interface TankStockEntry {
  readonly species: string;
  readonly count: number;
  readonly names: readonly string[];
}

/** A validated tank: every field present, in range, and every species known to its habitat. */
export interface Tank {
  readonly version: typeof TANK_VERSION;
  readonly seed: number;
  readonly scenery: Scenery;
  readonly clock: boolean;
  readonly feedMinutes: number;
  readonly drift: boolean;
  readonly fish: readonly TankStockEntry[];
}

/** What the gate needs to know about a species: its id and default count. */
export interface StockableSpecies {
  readonly id: string;
  readonly count: number;
}

/** Which animals each kind of tank can hold: jellies only in the jelly tank, which holds only jellies. */
export type HabitatCatalogue = Readonly<Record<Habitat, readonly StockableSpecies[]>>;

export interface NormalizeResult {
  readonly tank: Tank;
  readonly warnings: readonly string[];
}

export const DEFAULT_SEED = 7;
export const DEFAULT_FEED_MINUTES = 4;

export const habitatOf = (scenery: Scenery | undefined): Habitat => (scenery === 'jelly' ? 'jelly' : 'reef');

export function defaultStock(catalogue: HabitatCatalogue, scenery: Scenery): TankStockEntry[] {
  return catalogue[habitatOf(scenery)].map((sp) => ({ species: sp.id, count: sp.count, names: [] }));
}

export function defaultTank(catalogue: HabitatCatalogue): Tank {
  return {
    version: TANK_VERSION,
    seed: DEFAULT_SEED,
    scenery: 'reef',
    clock: true,
    feedMinutes: DEFAULT_FEED_MINUTES,
    drift: true,
    fish: defaultStock(catalogue, 'reef'),
  };
}

export const isScenery = (value: unknown): value is Scenery =>
  typeof value === 'string' && (TANK_SCENERY as readonly string[]).includes(value);

/** A number (or numeric string) rounded and clamped to [lo, hi]; anything else gives the fallback. */
function boundedInt(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : fallback;
}

const booleanOr = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

function cleanNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((n): n is string => typeof n === 'string')
    .map((n) => n.trim().slice(0, LIMITS.nameLength))
    .filter((n) => n.length > 0);
}

interface MergedEntry { species: string; count: number; names: string[] }

/** Merges repeated species (first-seen order) and drops unknown ones with a warning. */
function mergeStock(list: readonly unknown[], catalogue: HabitatCatalogue, habitat: Habitat, warnings: string[]): Map<string, MergedEntry> {
  const known = new Map(catalogue[habitat].map((sp) => [sp.id, sp]));
  const anywhere = new Set(Object.values(catalogue).flat().map((sp) => sp.id));
  const merged = new Map<string, MergedEntry>();
  for (const entry of list) {
    const id = isRecord(entry) ? entry['species'] : undefined;
    const sp = typeof id === 'string' ? known.get(id) : undefined;
    if (!sp || !isRecord(entry)) {
      const label = String(id);
      warnings.push(typeof id === 'string' && anywhere.has(id) ? `"${label}" doesn't live in a ${habitat} tank` : `unknown species "${label}"`);
      continue;
    }
    const names = cleanNames(entry['names']);
    const count = boundedInt(entry['count'], 0, LIMITS.perSpecies, names.length || sp.count);
    const m = merged.get(sp.id) ?? { species: sp.id, count: 0, names: [] };
    m.count = Math.min(LIMITS.perSpecies, m.count + count);
    m.names.push(...names);
    merged.set(sp.id, m);
  }
  return merged;
}

/** Caps the whole tank at LIMITS.totalFish, filling species in order. */
function capStock(merged: Map<string, MergedEntry>, warnings: string[]): TankStockEntry[] {
  let room: number = LIMITS.totalFish;
  const fish: TankStockEntry[] = [];
  for (const m of merged.values()) {
    const count = Math.min(m.count, room);
    if (count < m.count) warnings.push(`tank capped at ${LIMITS.totalFish} fish`);
    room -= count;
    if (count > 0) fish.push({ species: m.species, count, names: m.names.slice(0, count) });
  }
  return fish;
}

/**
 * Unknown or out-of-range values fall back to defaults rather than failing, so an old Roku build can
 * still show a tank written by a newer dashboard.
 */
export function normalizeTank(raw: unknown, catalogue: HabitatCatalogue): NormalizeResult {
  const warnings: string[] = [];
  const defaults = defaultTank(catalogue);
  const src: Record<string, unknown> = isRecord(raw) ? raw : {};
  if (raw !== undefined && !isRecord(raw)) warnings.push('tank config is not an object; using defaults');
  if (src['version'] !== undefined && src['version'] !== TANK_VERSION) warnings.push(`tank version ${String(src['version'])} != ${TANK_VERSION}`);

  const scenery = isScenery(src['scenery']) ? src['scenery'] : defaults.scenery;
  if (src['scenery'] !== undefined && scenery !== src['scenery']) warnings.push(`unknown scenery "${String(src['scenery'])}"`);

  const habitat = habitatOf(scenery);
  const list = Array.isArray(src['fish']) ? (src['fish'] as unknown[]) : defaultStock(catalogue, scenery);
  const fish = capStock(mergeStock(list, catalogue, habitat, warnings), warnings);

  return {
    tank: {
      version: TANK_VERSION,
      seed: boundedInt(src['seed'], 0, MAX_SEED, defaults.seed),
      scenery,
      clock: booleanOr(src['clock'], defaults.clock),
      feedMinutes: boundedInt(src['feedMinutes'], 0, LIMITS.feedMinutes, defaults.feedMinutes),
      drift: booleanOr(src['drift'], defaults.drift),
      fish,
    },
    warnings,
  };
}

/** The legacy URL overrides (?seed= ?clock= ?feed= ?drift= ?scenery=) layered over a loaded config. */
export function applyUrlOverrides(loaded: unknown, params: URLSearchParams, catalogue: HabitatCatalogue): Record<string, unknown> {
  const file = isRecord(loaded) ? loaded : {};
  const scenery = params.get('scenery') ?? file['scenery'];
  // A jelly tank without its own fish list gets the jellies, not the reef fish.
  const jellyStock = scenery === 'jelly' && file['fish'] === undefined ? { fish: defaultStock(catalogue, 'jelly') } : {};
  const merged: Record<string, unknown> = { ...defaultTank(catalogue), ...jellyStock, ...file };
  if (scenery !== undefined) merged['scenery'] = scenery;
  const seed = params.get('seed');
  if (seed) merged['seed'] = seed;
  if (params.has('clock')) merged['clock'] = params.get('clock') === '1';
  const feed = params.get('feed');
  if (feed) merged['feedMinutes'] = feed;
  if (params.has('drift')) merged['drift'] = params.get('drift') !== '0';
  return merged;
}

/** Fetches parsed JSON; injected so loadTank can be tested without a network. */
export type JsonFetcher = (url: string) => Promise<unknown>;
export type WarningSink = (message: string) => void;

export const fetchJson: JsonFetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as unknown;
};

/** ?tank=<url> loads a config file; the older ?seed= ?clock= ?feed= ?drift= params still override it. */
export async function loadTank(
  params: URLSearchParams,
  catalogue: HabitatCatalogue,
  fetcher: JsonFetcher = fetchJson,
  warn: WarningSink = (m) => console.warn('tank:', m),
): Promise<Tank> {
  let loaded: unknown;
  const url = params.get('tank');
  if (url) {
    try {
      loaded = await fetcher(url);
    } catch (err) {
      warn(`could not load ${url} (${err instanceof Error ? err.message : String(err)}); using defaults`);
    }
  }
  const { tank, warnings } = normalizeTank(applyUrlOverrides(loaded, params, catalogue), catalogue);
  for (const w of warnings) warn(w);
  return tank;
}
