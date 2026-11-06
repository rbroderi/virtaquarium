// The reef's non-fish animals: common cuttlefish, day octopus and a juvenile green turtle.
//
// Each is its own model and behaviour (they don't swim like fish), lit by the same materials as the
// reef (addCaustics: caustics and the baked reef light), so they sit in the tank's light. They live in
// World.critters: fish keep their distance from them, and small fish treat the two cephalopods as
// predators. References: pc/ref/cuttlefish, pc/ref/octopus, pc/ref/turtle (CREDITS.md in each).
//
// Frame: like the fish, +x is forward, +y up; yaw turns about y (heading (cos yaw, 0, sin yaw)).
//
// Modules: critters/types (species, the Critter contract and the World ports), critters/shared
// (springs, materials, steering), critters/softBodyMeshes (the blended bodies, loaded before any
// critter is made), one module per animal plus its parts, and critters/factory (createCritter).
import type { CritterSpecies } from './critters/types.js';

export { Cuttlefish, type CuttlefishMode } from './critters/cuttlefish.js';
export { Octopus, type OctopusMode } from './critters/octopus.js';
export { Turtle, type TurtleMode } from './critters/turtle.js';
export { createCritter } from './critters/factory.js';
export { readGLB } from './critters/softBodyMeshes.js';
export type {
  Critter, CritterKind, CritterSpecies, CritterWorld, CritterContext, CritterCave, CritterFood, CritterBounds,
  CritterNeighbour, CritterThreatFish, CaveRoof, OctopusDen, JoinRule,
} from './critters/types.js';

export const CRITTER_SPECIES: readonly CritterSpecies[] = [
  {
    id: 'cuttlefish', name: 'Common Cuttlefish', sci: 'Sepia officinalis', habitat: 'reef', count: 1,
    fact: 'Changes colour in a fraction of a second; hunts by stealth, then shoots out two long tentacles.',
    radius: 0.7, predator: true,
  },
  {
    id: 'octopus', name: 'Day Octopus', sci: 'Octopus cyanea', habitat: 'reef', count: 1,
    fact: 'Hunts by day, crawling over the reef and changing colour and skin texture as it goes.',
    radius: 0.8, predator: true,
  },
  {
    id: 'turtle', name: 'Green Sea Turtle (juvenile)', sci: 'Chelonia mydas', habitat: 'reef', count: 1,
    fact: 'Flies through the water with its long front flippers and comes up every few minutes to breathe.',
    radius: 1.1,
  },
];
