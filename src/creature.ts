// The root every animal in the tank shares: fish, jellies and the critters (cuttlefish, octopus,
// turtle). The World keeps one list of them (world.ts add/update), the overlay picks and inspects
// through it (ui.ts), and each species fills in a template step:
//   tick(dt)            (optional) its own clocks
//   sense(dt, world)    (optional) take in the world: neighbours, threats, food, drives
//   think(dt, world)    (optional) choose what to do and where to go
//   act(dt, world)      move, pose and colour the model for this step
//   inspect()           the click panel (inspect.ts)
// What differs stays in the species: the fish's force-balance swimming and Brain (fish.ts, brain.ts),
// the jelly's pulse and drift (jelly/jelly.ts), the critters' CritterBrain and bodies (critters/base.ts).
// Each reads the world through its own narrow port (SwimWorld, JellyWorld, CritterWorld); World
// satisfies them all.
import type * as THREE from 'three';
import type { Inspectable, InspectPanel } from './inspect.js';

/** What every species record has: the panel's names and its fact line. */
export interface CreatureSpecies {
  readonly id: string;
  readonly name: string;
  readonly sci: string;
  readonly fact: string;
}

/**
 * When a creature moves in the World's step. 'bodies' (the fish): before the body separation pass,
 * which then pushes overlapping bodies apart, and drawn after it. 'free' (jellies, critters): after
 * the bodies and the fan worms, which react to where the critters were.
 */
export type StepPhase = 'bodies' | 'free';

/** What the tank, the overlay and the checks see of any animal. */
export interface Creature<W = never> extends Inspectable {
  /** 'fish', 'jelly', or the critter's kind. */
  readonly kind: string;
  readonly sp: CreatureSpecies;
  readonly model: THREE.Object3D;
  readonly stepPhase: StepPhase;
  /** Whether a click can select it now (a fish's model is hidden while its look loads). */
  readonly pickable: boolean;
  update(dt: number, world: W): void;
}

/** The step template (see the top of this file); W is the species' own world port. */
export abstract class CreatureBase<W> implements Creature<W> {
  abstract readonly kind: string;
  abstract readonly sp: CreatureSpecies;
  abstract readonly model: THREE.Object3D;
  abstract readonly pos: THREE.Vector3;
  /** Click-proxy radius for the inspection overlay (inspect.ts). */
  abstract readonly pickRadius: number;
  abstract readonly stepPhase: StepPhase;

  get pickable(): boolean {
    return true;
  }

  /** One step: the clocks, then sense, think and act. */
  update(dt: number, world: W): void {
    this.tick(dt);
    this.sense(dt, world);
    this.think(dt, world);
    this.act(dt, world);
  }

  protected tick(_dt: number): void { /* no clocks of its own */ }
  protected sense(_dt: number, _world: W): void { /* nothing to take in */ }
  protected think(_dt: number, _world: W): void { /* nothing to choose */ }
  protected abstract act(dt: number, world: W): void;
  abstract inspect(): InspectPanel;
}
