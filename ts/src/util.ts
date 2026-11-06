// Barrel for the shared helpers (core/*), so modules import one place as in the JS original.
export { mulberry32, range, pick, type Rng } from './core/rng.js';
export { clamp, lerp, smooth, wrapAngle, TAU, DEG_TO_RAD } from './core/math.js';
export { Noise } from './core/noise.js';
export { hexToRgb, rgba, mixHex, shade, type Rgb } from './core/color.js';
export { makeCanvas, context2d } from './core/canvas.js';
export { requireElement, errorMessage, isRecord } from './core/dom.js';
