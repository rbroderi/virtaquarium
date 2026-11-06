// Factory / registry: one constructor per critter kind, so the tank builds any critter species without
// knowing which class it is.
import { Cuttlefish } from './cuttlefish.js';
import { Octopus } from './octopus.js';
import { Turtle } from './turtle.js';
import type { Critter, CritterContext, CritterKind, CritterSpecies } from './types.js';

type CritterConstructor = (sp: CritterSpecies, ctx: CritterContext) => Critter;

const REGISTRY: Readonly<Record<CritterKind, CritterConstructor>> = {
  cuttlefish: (sp, { rng, world }) => new Cuttlefish(sp, rng, world),
  // The octopus dens in a cave (or a low crevice): asked for only here.
  octopus: (sp, { rng, findDen }) => new Octopus(sp, rng, findDen()),
  turtle: (sp, { rng, world }) => new Turtle(sp, rng, world),
};

export function createCritter(sp: CritterSpecies, ctx: CritterContext): Critter {
  return REGISTRY[sp.id](sp, ctx);
}
