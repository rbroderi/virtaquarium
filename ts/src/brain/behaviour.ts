// Strategy: each behaviour mode is a Behaviour that scores how much the fish wants it right now and,
// while it is the active mode, steers the fish. The Brain owns perception, drives and the choice.
import type * as THREE from 'three';
import type { Brain } from '../brain.js';
import type { Fish } from '../fish.js';
import type { BrainTraits, Pace } from '../species/types.js';
import type { SwimWorld } from '../world/ports.js';
import type { Drives, Mode, Personality } from './types.js';

/** What a behaviour's utility is computed from. Scoring is pure: it draws no random numbers. */
export interface DecisionContext {
  readonly brain: Brain;
  readonly world: SwimWorld;
  readonly drives: Drives;
  readonly personality: Personality;
  /** The species' temperament (sp.brain). */
  readonly species: BrainTraits;
  /** 1 - light. */
  readonly dark: number;
}

/** The steering a behaviour asks for: speed as a fraction of max sustained speed, and rock clearance. */
export interface Steering {
  speed: number;
  clearance: number;
}

export interface SteerContext {
  readonly brain: Brain;
  readonly me: Fish;
  readonly world: SwimWorld;
  readonly dt: number;
  /** Desired heading, written by the behaviour (not normalised). */
  readonly dir: THREE.Vector3;
  readonly pos: THREE.Vector3;
  readonly species: BrainTraits;
  readonly pace: Pace;
  /** The eel's backing speed from the previous step (it is reset to 0 before steering). */
  readonly wasBacking: number;
  readonly out: Steering;
}

export interface Behaviour {
  readonly mode: Mode;
  score(ctx: DecisionContext): number;
  steer(ctx: SteerContext): void;
  /** A more specific thought than the mode's label, or null for the label. */
  narrate?(brain: Brain): string | null;
  /** Called when the fish switches into this mode. */
  enter?(brain: Brain): void;
  /** Called when the fish switches out of this mode. */
  exit?(brain: Brain): void;
}
