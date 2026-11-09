// Stocking the tank from the validated Tank document: fish (placed by a chain of placement
// strategies), critters (through the critter factory) and jellies, each into the World's one creature
// list. Random draws happen in the same order as the JS build, so a seed stocks the same tank.
import * as THREE from 'three';
import { range, type Rng } from '../core/rng.js';
import { FISH_NAMES, type Species } from '../species.js';
import { Fish } from '../fish.js';
import type { World, TankBounds } from '../world.js';
import type { TankScene } from '../reef/types.js';
import type { Tank, TankStockEntry } from '../tank.js';
import { createCritter, type Critter, type CritterSpecies, type OctopusDen } from '../critters.js';
import { Jelly, type JellySpecies } from '../jelly.js';

/** Fish start at least this far in from the side walls and front/back glass. */
const SPAWN_MARGIN = { x: 1, z: 0.5, top: 0.5, aboveReef: 0.6 } as const;
/** Clownfish start in a small cloud above their anemone. */
const HOST_SPREAD = { x: 0.4, y: 0.3, z: 0.3 } as const;
/** An eel's body is inside its cave, the front quarter out of the mouth. */
const LURK_DEPTH = 0.25;
/** The cleaner starts just above its station. */
const CLEANER_LIFT = 0.4;
/** Shy fish choose among the lowest homes. */
const SHY_HOME_CHOICES = 6;
/** The octopus den sits a little inside the cave mouth. */
const DEN_DEPTH = 0.2;
/** The cleaning station: a prominent rock top in the front half at mid height. */
const STATION_ZONE = { zMin: -1.2, yMin: 1.0, yMax: 4.0, nearestCentre: 3 } as const;
/** Ledge shelters: the gap must fit the fish's body plus this, at most this many fish per ledge. */
const LEDGE_CLEARANCE = 0.12;
const FISH_PER_LEDGE = 3;
/** Fish that shoal at least this strongly share the shoal's staghorn. */
const SHOALING = 0.8;

/** The catalogues stocking draws from (injected, so the composition root decides). */
export interface StockCatalogue {
  readonly fish: readonly Species[];
  readonly critters: readonly CritterSpecies[];
  readonly jellies: readonly JellySpecies[];
}

export interface StockingContext {
  readonly world: World;
  readonly reef: TankScene;
  readonly bounds: TankBounds;
  readonly rng: Rng;
  readonly tank: Tank;
  readonly catalogue: StockCatalogue;
}

// ---------- fish placement (Strategy chain: the first that applies places the fish) ----------

interface PlacementContext {
  readonly world: World;
  readonly reef: TankScene;
  readonly rng: Rng;
  /** Homes not yet taken (shuffled as fish choose). */
  readonly homes: THREE.Vector3[];
}

interface Placement {
  applies(fish: Fish, ctx: PlacementContext): boolean;
  place(fish: Fish, ctx: PlacementContext): void;
}

const hostPlacement: Placement = {
  applies: (f, { reef }) => f.sp.brain.host === true && reef.anemones.length > 0,
  place: (f, { reef, rng }) => {
    const anemone = reef.anemones[0];
    if (!anemone) return;
    f.brain.home.copy(anemone.pos);
    f.pos.copy(anemone.pos).add(new THREE.Vector3(range(rng, -HOST_SPREAD.x, HOST_SPREAD.x), HOST_SPREAD.y, range(rng, -HOST_SPREAD.z, HOST_SPREAD.z)));
  },
};

/** Eels take a cave (extra eels share). */
const lurkerPlacement: Placement = {
  applies: (f, { reef }) => f.sp.brain.lurker === true && reef.caves.length > 0,
  place: (f, { world, reef }) => {
    const cave = reef.caves[world.fish.filter((o) => o.sp.brain.lurker).length % reef.caves.length];
    if (!cave) return;
    f.brain.home.copy(cave.mouth).addScaledVector(cave.dir, -LURK_DEPTH * f.size);
    f.brain.lurkDir = cave.dir.clone();
    f.pos.copy(f.brain.home);
    f.dir.copy(cave.dir);
    f.yaw = Math.atan2(cave.dir.z, cave.dir.x);
    f.brain.mode = 'lurk';
  },
};

/** The first cleaner wrasse holds the station. */
const cleanerPlacement: Placement = {
  applies: (f, { world }) => f.sp.brain.cleaner === true && world.station !== null && world.station.cleaner === null,
  place: (f, { world }) => {
    const station = world.station;
    if (!station) return;
    station.cleaner = f;
    f.brain.home.copy(station.pos);
    f.pos.copy(station.pos).add(new THREE.Vector3(0, CLEANER_LIFT, 0));
  },
};

/** Shy fish choose low homes; everyone else takes a random spot on the reef. */
const homePlacement: Placement = {
  applies: () => true,
  place: (f, { reef, rng, homes }) => {
    const shy = (f.sp.brain.shy ?? 0) > 0;
    homes.sort((a, b) => (shy ? a.y - b.y : 0) || 0);
    const at = shy ? Math.floor(rng() * SHY_HOME_CHOICES) : Math.floor(rng() * homes.length);
    const home = homes.splice(at, 1)[0] ?? reef.homes[0];
    if (home) f.brain.home.copy(home);
  },
};

const PLACEMENTS: readonly Placement[] = [hostPlacement, lurkerPlacement, cleanerPlacement, homePlacement];

// ---------- the stocking steps ----------

/** Held by the first cleaner wrasse; clients can be seen queuing there. */
function setUpCleaningStation(ctx: StockingContext, speciesById: ReadonlyMap<string, Species>): void {
  const { tank, reef, rng, world } = ctx;
  if (tank.scenery === 'jelly') return;
  if (!tank.fish.some((e) => speciesById.get(e.species)?.brain.cleaner && e.count > 0)) return;
  const spots = reef.homes.filter((h) => h.z > STATION_ZONE.zMin && h.y > STATION_ZONE.yMin && h.y < STATION_ZONE.yMax);
  const choices = (spots.length ? spots : reef.homes).slice().sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
  const chosen = choices[Math.floor(rng() * Math.min(STATION_ZONE.nearestCentre, spots.length || 1))];
  if (chosen) world.station = { pos: chosen.clone(), cleaner: null, client: null };
}

/** Names the owner chose come first; the rest are drawn from the pool. */
class NamePool {
  private readonly free: string[];
  constructor(tank: Tank, private readonly rng: Rng) {
    const chosen = new Set(tank.fish.flatMap((e) => e.names));
    this.free = FISH_NAMES.filter((n) => !chosen.has(n));
  }
  nameFor(entry: TankStockEntry, index: number, fallback: string): string {
    const own = entry.names[index];
    if (own) return own;
    if (!this.free.length) return fallback;
    return this.free.splice(Math.floor(this.rng() * this.free.length), 1)[0] ?? fallback;
  }
}

function addFish(ctx: StockingContext, sp: Species, entry: TankStockEntry, names: NamePool, placement: PlacementContext): void {
  const { rng, bounds, reef, world } = ctx;
  for (let i = 0; i < entry.count; i++) {
    const f = new Fish(sp, names.nameFor(entry, i, sp.name), rng);
    const x = range(rng, bounds.x0 + SPAWN_MARGIN.x, bounds.x1 - SPAWN_MARGIN.x);
    const z = range(rng, bounds.z0 + SPAWN_MARGIN.z, bounds.z1 - SPAWN_MARGIN.z);
    const floor = reef.heightAt(x, z) + SPAWN_MARGIN.aboveReef;
    f.pos.set(x, range(rng, floor, bounds.y1 - SPAWN_MARGIN.top), z);
    PLACEMENTS.find((p) => p.applies(f, placement))?.place(f, placement);
    world.add(f);
  }
}

/** The octopus dens in a cave the moray doesn't hold (the eels take the first ones), else in a low crevice. */
function denFinder(ctx: StockingContext, speciesById: ReadonlyMap<string, Species>, critters: readonly Critter[]): () => OctopusDen {
  return () => {
    const eels = ctx.tank.fish.filter((e) => speciesById.get(e.species)?.brain.lurker).reduce((n, e) => n + e.count, 0);
    const cave = ctx.reef.caves[eels + critters.filter((c) => c.kind === 'octopus').length];
    if (cave) return { pos: cave.mouth.clone().addScaledVector(cave.dir, -DEN_DEPTH), cave };
    const lowest = ctx.reef.homes.slice().sort((a, b) => a.y - b.y)[0];
    return { pos: lowest ? lowest.clone() : new THREE.Vector3(), cave: null };
  };
}

/**
 * Each fish knows a shelter near its home: shoaling chromis share their staghorn, the rest take the
 * nearest ledge whose gap fits their body. Clownfish have the anemone and eels their cave.
 */
function assignShelters(world: World, reef: TankScene): void {
  const shelters = reef.shelters;
  if (!shelters) return;
  const used = new Map<object, number>();
  const coral = shelters.find((s) => s.kind === 'coral');
  for (const f of world.fish) {
    const b = f.sp.brain;
    if (b.host || b.lurker) continue;
    if (b.school >= SHOALING && coral && reef.shoalCoral) {
      f.brain.shelter = coral;
      f.brain.home.copy(reef.shoalCoral.pos);
      continue;
    }
    const depth = f.size * f.sp.body.depth;
    let best = null, bestDist = Infinity;
    for (const s of shelters) {
      if (s.kind !== 'ledge' || s.top - s.floor < depth + LEDGE_CLEARANCE || (used.get(s) ?? 0) >= FISH_PER_LEDGE) continue;
      const d = s.pos.distanceTo(f.brain.home);
      if (d < bestDist) { bestDist = d; best = s; }
    }
    if (best) {
      f.brain.shelter = best;
      used.set(best, (used.get(best) ?? 0) + 1);
    }
  }
  console.info('Shelters:', shelters.length, 'assigned:', world.fish.filter((f) => f.brain.shelter).length);
}

/** Stocks the tank: every animal goes into the World's creature list (world.add), in the tank's order. */
export function stockTank(ctx: StockingContext): void {
  const { catalogue, tank, rng, world, reef, bounds } = ctx;
  const speciesById = new Map(catalogue.fish.map((sp) => [sp.id, sp]));
  const jellyById = new Map(catalogue.jellies.map((sp) => [sp.id, sp]));
  const critterById = new Map<string, CritterSpecies>(catalogue.critters.map((sp) => [sp.id, sp]));
  const names = new NamePool(tank, rng);
  const placement: PlacementContext = { world, reef, rng, homes: reef.homes.slice() };
  setUpCleaningStation(ctx, speciesById);

  const findDen = denFinder(ctx, speciesById, world.critters);
  for (const entry of tank.fish) {
    const jellySp = jellyById.get(entry.species);
    const critterSp = critterById.get(entry.species);
    const fishSp = speciesById.get(entry.species);
    for (let i = 0; jellySp && i < entry.count; i++) world.add(new Jelly(jellySp, rng, bounds));
    for (let i = 0; !jellySp && critterSp && i < entry.count; i++) world.add(createCritter(critterSp, { rng, world, findDen }));
    if (!jellySp && !critterSp && fishSp) addFish(ctx, fishSp, entry, names, placement);
  }
  if (tank.scenery !== 'jelly') assignShelters(world, reef);
}
