// Procedural reef: sand bed, live-rock piles, corals, a host anemone, plants, moray caves, and the
// height field, collision field and shelters the animals use. Barrel over reef/*:
//   reef/buildReef.ts  entry point (BVH-accelerated build)
//   reef/builder.ts    ReefBuilder, the layout in named steps
//   reef/scenery.ts    generated models (scenery.json) and coral swapping
//   reef/types.ts      Reef, TankScene, Scenery, Cave, Shelter, ...
export { buildReef, type ReefBuildOptions } from './reef/buildReef.js';
export { loadScenery, parseSceneryManifest, type SceneryEntry } from './reef/scenery.js';
export { HeightField } from './reef/heightField.js';
export { addSway } from './reef/materials.js';
export { EMPTY_SCENERY } from './reef/types.js';
export type {
  Reef, TankScene, Scenery, SceneryModels, Cave, CaveRoof, Shelter, ShelterKind, ShoalCoral, Anemone, PlantedCounts,
} from './reef/types.js';
export { waterUniforms } from './water.js';
