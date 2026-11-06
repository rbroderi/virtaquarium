// The shared shapes of the tank's live state: its swimmable box, food flakes, the viewer at the glass,
// the cleaning station and the critters as the fish see them.
import type * as THREE from 'three';
import type { Fish } from '../fish.js';

/** The swimmable box, in world units. */
export interface TankBounds {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
  readonly z0: number;
  readonly z1: number;
}

/** One food flake, sinking or settled. */
export interface Food {
  readonly pos: THREE.Vector3;
  /** Sinking speed (units/s). */
  readonly vy: number;
  /** Seconds left floating on the surface film. */
  float: number;
  /** Flutter phase. */
  readonly ph: number;
  spin: number;
  age: number;
  eaten: boolean;
  resting: boolean;
  readonly color: THREE.Color;
}

/** The pointer at the glass: where it is and how much it has moved lately (0..1, fades). */
export interface Viewer {
  readonly pos: THREE.Vector3;
  activity: number;
}

/** The cleaner wrasse's station: one cleaner holds it, one client at a time poses there. */
export interface Station {
  readonly pos: THREE.Vector3;
  cleaner: Fish | null;
  client: Fish | null;
}

/** A critter (cuttlefish, octopus, turtle) as the fish perceive it. */
export interface WorldCritter {
  readonly pos: THREE.Vector3;
  /** How much room fish give it. */
  readonly radius: number;
  readonly sp: { readonly predator?: boolean };
}

/** Something a fish can be scared of: a fish, a critter, the viewer, or a remembered spot. */
export interface Threat {
  readonly pos: THREE.Vector3;
}
