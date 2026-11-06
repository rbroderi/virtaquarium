// What the jelly module needs from the outside world (consumer-side ports) and its species shape.
import type * as THREE from 'three';

export interface JellySpecies {
  readonly id: string;
  readonly name: string;
  readonly sci: string;
  readonly habitat: 'jelly';
  readonly count: number;
  readonly fact: string;
  /** Bell radius range, world units. */
  readonly size: readonly [number, number];
}

/** The swimmable box. */
export interface JellyBounds {
  readonly x0: number; readonly x1: number;
  readonly y0: number; readonly y1: number;
  readonly z0: number; readonly z1: number;
}

/** The parts of the World a jelly reads. */
export interface JellyWorld {
  readonly bounds: JellyBounds;
  /** Overall light level, 0 night .. 1 day. */
  readonly light: number;
  /** The water's current at p, written into out. */
  flow(p: THREE.Vector3, out: THREE.Vector3): unknown;
}
