// What a fish's brain and body read from the tank (dependency inversion: world.ts implements it, and a
// test or check can supply its own).
import type * as THREE from 'three';
import type { Fish } from '../fish.js';
import type { Anemone, CaveRoof, ShoalCoral } from '../reef/types.js';
import type { Food, Station, TankBounds, Viewer, WorldCritter } from './types.js';

export interface SwimWorld {
  /** Overall light level, 0 night .. 1 day. */
  readonly light: number;
  /** Seconds since the tank started. */
  readonly time: number;
  /** Seconds to the next scheduled feed. */
  readonly feedIn: number;
  /** Where the last food went in, if any has. */
  readonly lastFeedX: number | undefined;
  readonly bounds: TankBounds;
  readonly viewer: Viewer | null;
  readonly station: Station | null;
  readonly fish: readonly Fish[];
  readonly critters: readonly WorldCritter[];
  readonly food: readonly Food[];
  readonly reef: { readonly shoalCoral?: ShoalCoral | null };
  /** Top of the reef's height field at (x, z). */
  reefHeight(x: number, z: number): number;
  /** Signed distance to the solid scenery, negative inside it. */
  rockDist(p: THREE.Vector3): number;
  /** Outward normal of the scenery near p, written into out. */
  rockNormal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  /** The cave roof over (x, z), or null in the open. */
  roofAt(x: number, z: number): CaveRoof | null;
  /** Water velocity at p, written into out. */
  flow(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3;
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean;
  /** The anemone a host fish lives in, if the tank has one. */
  anemoneFor(fish: Fish): Anemone | null;
}
