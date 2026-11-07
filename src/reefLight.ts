// Baked reef light: soft reef shadows, sky visibility and bounce light, baked once by GPU ray casting
// and applied live by every lit material. A barrel over reefLight/*, so modules import one place as in
// the JS original.
export { reefLightUniforms, type ReefLightUniforms } from './reefLight/uniforms.js';
export { REEF_LIGHT_GLSL, REEF_LIGHT_EVAL, REEF_LIGHT_APPLY } from './reefLight/glsl.js';
export { bakeReefLight } from './reefLight/bake.js';
export { bakeReefLightCached, bakeReefLightCachedGpu, pendingReefLightSave } from './reefLight/cache.js';
export { ScreenAO, type ScreenAOOptions } from './reefLight/screenAO.js';
export type {
  ReefLightTarget, ReefLightSun, ReefLightOptions, ReefLightInfo, ReefLightCacheOptions,
} from './reefLight/types.js';
