// Moon jellies (Aurelia aurita) and the jelly tank they live in.
//
// Public aquariums show moon jellies in a kreisel: a round tank with a slow circular current that keeps
// them suspended, nothing else in the water, and a backlit deep-blue background. The jellies glow
// because light passes through them and scatters in the jelly: the rim and the folds catch the most,
// so a bell reads as a bright outline with fine radial canals, four horseshoe-shaped gonads (pale
// lavender, the brightest part) and a fringe of short marginal tentacles, with four frilly oral arms
// trailing below. (References: aquarium photos of Aurelia aurita, e.g. National Aquarium, Baltimore.)
//
// Modules: jelly/shaders (GLSL), jelly/geometry (shared unit-bell geometry), jelly/jelly (the
// animal), jelly/tank (the backlit void), jelly/types (species and the World port).
import type { JellySpecies } from './jelly/types.js';

export { Jelly } from './jelly/jelly.js';
export { buildJellyTank, type JellyTank, type JellyBackdropUniforms } from './jelly/tank.js';
export type { JellySpecies, JellyWorld, JellyBounds } from './jelly/types.js';

export const JELLY_SPECIES: readonly JellySpecies[] = [
  {
    id: 'moonjelly', name: 'Moon Jelly', sci: 'Aurelia aurita', habitat: 'jelly', count: 10,
    fact: 'Ninety-five per cent water; drifts on the current, pulsing about once a second to stay up.',
    size: [0.6, 1.2],   // bell radius, units (15-30 cm across, as in public-aquarium exhibits)
  },
];
