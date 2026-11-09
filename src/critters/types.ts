// The critters' species shape, the Critter contract, and the consumer-side ports (dependency
// inversion): the narrow parts of the World, reef and fish that the critters read. world.ts, reef.ts
// and fish.ts satisfy these structurally; nothing here imports them.
import type * as THREE from 'three';
import type { Rng } from '../util.js';
import type { Inspectable } from '../inspect.js';

export type CritterKind = 'cuttlefish' | 'octopus' | 'turtle';

export interface CritterSpecies {
  readonly id: CritterKind;
  readonly name: string;
  readonly sci: string;
  readonly habitat: 'reef';
  readonly count: number;
  readonly fact: string;
  /** How much room fish give it (units). */
  readonly radius: number;
  /** Small fish flee it (brain.ts). */
  readonly predator?: boolean;
}

/** The swimmable box. */
export interface CritterBounds {
  readonly x0: number; readonly x1: number;
  readonly y0: number; readonly y1: number;
  readonly z0: number; readonly z1: number;
}

/** A cave roof's underside and extent in cave-local x/z (reef.ts caves[].roof). */
export interface CaveRoof {
  readonly y: number;
  readonly hx: number;
  readonly z0: number;
  readonly z1: number;
}

/** The parts of a reef cave the critters use. */
export interface CritterCave {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  /** The cave's own floor height. */
  readonly ground: number;
  readonly mouth: THREE.Vector3;
  /** Facing out of the cave. */
  readonly dir: THREE.Vector3;
  readonly roof?: CaveRoof | null;
}

/** A flake of food: critters eat it by setting eaten. */
export interface CritterFood {
  readonly pos: THREE.Vector3;
  eaten: boolean;
  /** Settled on the bottom. */
  readonly resting: boolean;
}

/** A fish as a startle threat. */
export interface CritterThreatFish {
  readonly pos: THREE.Vector3;
  readonly size: number;
  readonly speed: number;
}

/** Another critter as a startle threat (any of the tank's critters). */
export interface CritterNeighbour {
  readonly pos: THREE.Vector3;
  readonly radius: number;
  readonly sp: { readonly predator?: boolean };
}

/** The parts of the World a critter reads. */
export interface CritterWorld {
  readonly bounds: CritterBounds;
  readonly reef: {
    readonly caves?: readonly CritterCave[];
    /** Turtle-grass patches: centre and radius. */
    readonly grassBeds?: readonly { readonly x: number; readonly z: number; readonly r: number }[];
    /** Sponges to settle on: top centre, radius and a name for the panel. */
    readonly perches?: readonly { readonly pos: THREE.Vector3; readonly r: number; readonly name: string }[];
  };
  readonly critters: readonly CritterNeighbour[];
  readonly fish: readonly CritterThreatFish[];
  readonly food: readonly CritterFood[];
  /** The reef's height-field top at (x, z). */
  reefHeight(x: number, z: number): number;
  /** The cave roof over (x, z), or null in the open. */
  roofAt(x: number, z: number): { readonly y: number } | null;
}

/** Two parts allowed to touch, by mesh name ('arm*' matches any 'arm...'): critterCheck.ts. */
export type JoinRule = readonly [string, string];

/**
 * A behaviour the shape check holds a critter in (critterCheck.ts), and where it goes meanwhile: an
 * offset from where it is, or null to stay put.
 */
export type CheckVisit = readonly [mode: string, go: readonly [number, number, number] | null];

/** What every critter offers the tank and the shape check (critters/base.ts implements it). */
export interface Critter extends Inspectable {
  readonly kind: CritterKind;
  /** The name the shape check reports it under. */
  readonly displayName: string;
  /** The behaviours the shape check holds it in, in turn. */
  readonly checkVisits: readonly CheckVisit[];
  readonly sp: CritterSpecies;
  readonly radius: number;
  readonly pos: THREE.Vector3;
  readonly model: THREE.Group;
  /** Attachments the shape check allows to touch. */
  readonly joins: readonly JoinRule[];
  /** Time spent building the animated parts (ms). */
  readonly buildMs: number;
  /** Current behaviour (the shape check forces each in turn), its time left and goal. */
  mode: string;
  modeT: number;
  target: THREE.Vector3;
  update(dt: number, world: CritterWorld): void;
  /** Startle it as by something at `from`: an escape jet (cephalopods only). */
  startle?(world: CritterWorld, from: THREE.Vector3): void;
  /** Shoot the tentacles out for `seconds` of a strike (cuttlefish only). */
  forceStrike?(seconds: number): void;
}

/** Where the octopus dens: a cave the moray doesn't hold, else a low crevice. */
export interface OctopusDen {
  readonly pos: THREE.Vector3;
  readonly cave: CritterCave | null;
}

/** Everything a critter is built from. findDen is asked only by critters that keep a den. */
export interface CritterContext {
  readonly rng: Rng;
  readonly world: CritterWorld;
  readonly findDen: () => OctopusDen;
}
