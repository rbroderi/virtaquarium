// Water atmosphere: backdrop gradient, fog, caustic light on surfaces, god rays, drifting particles
// ("marine snow"), bubble column and the shimmering surface. A barrel over water/*, so modules import
// one place as in the JS original.
export { METRES_PER_UNIT, SURFACE_Y, GLASS_Z, INSCATTER_DAY, UW_GLSL, waterUniforms, installUnderwaterMedium } from './water/medium.js';
export { WAVE_TILE, WAVE_COUNT, WAVE_GLSL, waveUniforms, updateWaves, setSunDirection } from './water/waves.js';
export { Caustics, causticUniforms, CAUSTIC_LOOKUP_GLSL, type CausticUniforms, type CausticsOptions } from './water/caustics.js';
export { addCaustics } from './water/materials.js';
export { makeWaterBackdrop, makeEnvironment, type WaterBackdrop, type BackdropUniforms } from './water/backdrop.js';
export { WaterRenderer, type ShaftLight, type WaterRendererOptions } from './water/renderer.js';
export { NO_FLOW, type FlowField } from './water/flow.js';
export { MarineSnow } from './water/snow.js';
export { Bubbles } from './water/bubbles.js';
export { makeSurface, type WaterSurface, type SurfaceUniforms } from './water/surface.js';
