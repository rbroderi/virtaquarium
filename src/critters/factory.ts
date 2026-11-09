// Factory / registry: one constructor per critter kind, so the tank builds any critter species without
// knowing which class it is. Every species extends CritterBase (base.ts) and builds itself from the
// context in its static create(); the octopus alone asks for a den.
import { Cuttlefish } from './cuttlefish.js';
import { Octopus } from './octopus.js';
import { Turtle } from './turtle.js';
import type { Critter, CritterContext, CritterKind, CritterSpecies } from './types.js';

type CritterConstructor = (sp: CritterSpecies, ctx: CritterContext) => Critter;

const REGISTRY: Readonly<Record<CritterKind, CritterConstructor>> = {
  cuttlefish: Cuttlefish.create,
  octopus: Octopus.create,
  turtle: Turtle.create,
};

export function createCritter(sp: CritterSpecies, ctx: CritterContext): Critter {
  return REGISTRY[sp.id](sp, ctx);
}
