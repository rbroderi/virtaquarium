// The reef light's ports: what it needs from the reef and the caller (consumer-side interfaces, so it
// does not depend on reef.ts).
import type * as THREE from 'three';

/** What the bake reads from the reef: the static scene group (with an optional mesh named 'sand'). */
export interface ReefLightTarget {
  readonly group: THREE.Object3D;
}

export interface ReefLightSun {
  /** Direction towards the light. */
  readonly dir: THREE.Vector3;
  /** Colour x intensity at full daylight. */
  readonly irr: THREE.Color;
  /** Half-angle of the fixture (rad). */
  readonly cone?: number;
}

export interface ReefLightOptions {
  readonly sun: ReefLightSun;
  /** Hemisphere sky colour x intensity at full daylight. */
  readonly sky: THREE.Color;
  /** Hemisphere ground colour x intensity at full daylight. */
  readonly ground: THREE.Color;
  /** The rest view to bake per pixel (omit or null to bake the grid only). */
  readonly camera?: THREE.PerspectiveCamera | null;
  readonly cell?: number;
  readonly skyDirs?: number;
  readonly bounceDirs?: number;
  readonly sunDirs?: number;
  readonly bounces?: number;
  readonly res?: number;
}

export interface ReefLightInfo {
  readonly cells: number[];
  readonly cell: number;
  readonly screen: [number, number] | null;
  readonly ms: number;
  readonly cached?: true;
}

export interface ReefLightCacheOptions {
  /** Fingerprint of the sources that make the reef and the bake (computed by the build). */
  readonly sourceFingerprint: string;
  /** Where cached bakes live (default './models/cache/'). */
  readonly base?: string;
  /** Skip the cache and always bake (default: ?rlcache=0). */
  readonly alwaysBake?: boolean;
  /** Save a fresh bake for next time (default: on the local dev server). */
  readonly save?: boolean;
  /** Told what is happening: loading the cached light, or baking it (with the share done, 0..1). */
  readonly onProgress?: (phase: ReefLightPhase, done: number) => void;
}

export type ReefLightPhase = 'cache' | 'bake';
