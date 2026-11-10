// The running tank as seen by the headless checks (motionCheck, lookCheck, critterCheck) and the
// debugging console (window.aquarium). The composition root (main.ts) builds it; checks receive it
// as a parameter instead of reaching for a global.
import type * as THREE from 'three';
import type { World } from '../world.js';
import type { Fish } from '../fish.js';
import type { TankScene } from '../reef/types.js';
import type { Jelly } from '../jelly.js';
import type { Critter } from '../critters.js';
import type { Species } from '../species.js';
import type { Caustics, WaterRenderer, MarineSnow, Bubbles, WaterSurface } from '../water.js';
import type { DaylightSource } from './daylight.js';

export interface AquariumHandle {
  readonly THREE: typeof THREE;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  readonly world: World;
  readonly reef: TankScene;
  readonly jellies: readonly Jelly[];
  /** The critters (the same objects as world.critters, with their full interface). */
  readonly critters: readonly Critter[];
  readonly SPECIES: readonly Species[];
  readonly caustics: Caustics;
  readonly water: WaterRenderer;
  readonly snow: MarineSnow;
  readonly bubbles: Bubbles | null;
  readonly surface: WaterSurface;
  /** The day/night clock (the look check jumps it to a fixed hour). */
  readonly daylight: DaylightSource;
  /** Jump the light level (0 night .. 1 day). */
  setLight(level: number): void;
  /** Advance the tank by dt seconds (no drawing). */
  step(dt: number): void;
  /** Draw the current state (WebGPU returns the async render promise). */
  present(): void | Promise<void>;
  /** Match the canvas to its CSS size. */
  fitCanvas(): void;
  /** The open reef's fish's-eye view (null in the other tanks). */
  readonly ride: { readonly rider: Fish | null; enter(fish: Fish): void; exit(): void } | null;
  /** The open reef's scenery beyond the tank (the perf check hides it to measure its cost). */
  readonly openReef: THREE.Object3D | null;
}

/** Each check module exports `main(aq)`; the page loads the one ?check= names on demand. */
export interface CheckModule {
  main(aq: AquariumHandle): Promise<void>;
}
