// The shapes a built tank exposes to the rest of the aquarium (world, brains, critters, main, bake).
//
// TankScene is what every kind of tank provides (the reef, and jelly.ts's buildJellyTank stub: a
// backlit void with no rock). Reef extends it with the rock-specific parts, all present.
import type * as THREE from 'three';
import type { RockField } from '../rockField.js';
import type { FanWorms } from '../fanWorms.js';
import type { HeightField } from './heightField.js';

/** A host anemone: centre of its tentacle crown and how far it reaches. */
export interface Anemone {
  readonly pos: THREE.Vector3;
  readonly radius: number;
}

/** A moray cave's roof, which is not in the height field (it overhangs the floor). */
export interface CaveRoof {
  /** Underside height, over cave-local x within +-hx and z from z0 (back) to z1 (front). */
  readonly y: number;
  /** Upper surface, for animals that pass over it. */
  readonly top: number;
  readonly hx: number;
  readonly z0: number;
  readonly z1: number;
}

/** A rock arch with its mouth to the front, for an eel (or the octopus) to den in. */
export interface Cave {
  /** Where the head rests, just inside the mouth. */
  readonly mouth: THREE.Vector3;
  /** Unit vector facing out of the cave. */
  readonly dir: THREE.Vector3;
  readonly yaw: number;
  /** Sand height under the cave. */
  readonly ground: number;
  readonly x: number;
  readonly z: number;
  /** Share of the camera's sight lines into it that are clear. */
  readonly seen: number;
  readonly roof: CaveRoof;
}

export type ShelterKind = 'ledge' | 'coral';

/** Where a fish can tuck in for the night or dive when scared. */
export interface Shelter {
  /** Middle of the gap. */
  readonly pos: THREE.Vector3;
  readonly floor: number;
  /** Rock (or coral) above. */
  readonly top: number;
  /** How near counts as in it. */
  readonly r: number;
  readonly kind: ShelterKind;
}

/** The chromis shoal's home staghorn. */
export interface ShoalCoral {
  /** Upper middle of the colony. */
  readonly pos: THREE.Vector3;
  readonly top: number;
  readonly r: number;
}

/** How much sea grass, algae and rubble found clear sand (logged at startup). */
export interface PlantedCounts {
  grass: number;
  clumps: number;
  rubble: number;
}

/** What every kind of tank provides. */
export interface TankScene {
  readonly group: THREE.Group;
  /** Top of the scenery at (x, z), for keeping animals above it. */
  heightAt(x: number, z: number): number;
  readonly anemones: readonly Anemone[];
  readonly homes: readonly THREE.Vector3[];
  readonly caves: readonly Cave[];
  readonly bubbler: THREE.Vector3 | null;
  readonly rockField?: RockField;
  readonly fanWorms?: FanWorms;
  readonly shelters?: readonly Shelter[];
  readonly shoalCoral?: ShoalCoral | null;
  readonly planted?: PlantedCounts;
  /** The jelly tank's light panel (its uLight uniform follows the day). */
  readonly backdrop?: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
}

/** The procedural reef (buildReef). */
export interface Reef extends TankScene {
  readonly heightField: HeightField;
  readonly rockField: RockField;
  readonly fanWorms: FanWorms;
  readonly shelters: readonly Shelter[];
  readonly shoalCoral: ShoalCoral | null;
  readonly planted: PlantedCounts;
  readonly bubbler: THREE.Vector3;
}

/** Generated models by manifest id, centred on x/z with the base at y = 0 and a unit bounding box. */
export type SceneryModels = Readonly<Record<string, THREE.Group>>;

/** loadScenery()'s result: generated rocks and corals that replace the procedural ones. */
export interface Scenery {
  /** Sorted by id, so seeded layouts repeat. */
  readonly rocks: readonly THREE.Group[];
  readonly coral: SceneryModels;
  readonly props: SceneryModels;
  readonly plants: SceneryModels;
}

export const EMPTY_SCENERY: Scenery = { rocks: [], coral: {}, props: {}, plants: {} };
