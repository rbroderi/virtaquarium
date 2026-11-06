// The tank config gate (config/tankConfig.ts) bound to the real species catalogue. Modules that build
// a tank import from here; tests import config/tankConfig.ts with a stub catalogue.
import { SPECIES } from './species.js';
import { JELLY_SPECIES } from './jelly.js';
import { CRITTER_SPECIES } from './critters.js';
import {
  loadTank as loadTankWith, normalizeTank as normalizeTankWith, defaultTank,
  type HabitatCatalogue, type NormalizeResult, type Tank,
} from './config/tankConfig.js';

export {
  TANK_VERSION, REEF_SCENERY as SCENERY, TANK_SCENERY, LIMITS,
  type Tank, type TankStockEntry, type Scenery, type HabitatCatalogue,
} from './config/tankConfig.js';

export const HABITATS: HabitatCatalogue = {
  reef: [...SPECIES, ...CRITTER_SPECIES],
  jelly: JELLY_SPECIES,
};

export const DEFAULT_TANK: Tank = defaultTank(HABITATS);

export const normalizeTank = (raw: unknown): NormalizeResult => normalizeTankWith(raw, HABITATS);

export const loadTank = (params: URLSearchParams): Promise<Tank> => loadTankWith(params, HABITATS);
