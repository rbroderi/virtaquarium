// Roku bake settings: the URL switches (?species=a,b&seeds=7,42&frames=8&yaws=9&zoom&pan&waterFrames&
// waterLoop&reeflight) resolved once into a read-only record, plus the fixed output geometry.
import { viewOptions, type PixelSize, type ViewOptions } from '../view.js';
import { toneFor, LIGHTS, type ToneCurve } from '../rig.js';

/** Roku's recommended largest bitmap side; cells wrap to stay inside it. */
export const MAX_SHEET = 2048;
/** Supersampling factor for every render. */
export const SUPERSAMPLE = 2;
export const SCREEN: PixelSize = { w: 1920, h: 1080 };
/** The strip's backdrop and foreground are cut into columns this wide, loaded as they come into view. */
export const TILE = 512;
/** Wave time (s) the backdrop's caustics are frozen at. */
export const CAUSTIC_T = 3.0;
/** Loop frames are baked at 1/2 resolution and scaled up on the Roku. */
export const WATER_SCALE = 2;
/** The player shows cruising fish turned this far towards the viewer (rad). */
export const CRUISE_YAW = 0.35;
/** Eels are shown further round towards the camera (rad). */
export const EEL_CRUISE_YAW = 0.6;
export const OUT_DIR = 'roku/assets/';
/** Sprites at ~1.2x the on-screen size at 1080p (99 px/unit at mid depth), times the zoom. */
const PX_PER_UNIT_AT_ZOOM_1 = 120;
const DEFAULT_FRAMES = 8;
const DEFAULT_YAWS = 9;
const DEFAULT_WATER_FRAMES = 32;
const DEFAULT_WATER_LOOP_SECONDS = 8;
const DEFAULT_SEED = 7;
/** main's applyLight exposure at full daylight. */
const DAYLIGHT_EXPOSURE = 1.25;
/** The live rig's night floor on the key light (rig.ts). */
const KEY_FLOOR = 0.05;

export interface BakeConfig {
  /** Swim-cycle frames per viewing angle. */
  readonly frames: number;
  /**
   * Viewing angles (yaw towards the viewer), evenly from tail-on (-90) through side-on (0) to head-on
   * (+90). Fish are bilaterally symmetric, so the Roku mirrors these for a fish facing left.
   */
  readonly yaws: number;
  readonly view: ViewOptions;
  /** The strip the zoomed window pans along (as setStrip). */
  readonly strip: PixelSize;
  readonly waterFrames: number;
  readonly waterLoopSeconds: number;
  readonly pxPerUnit: number;
  readonly speciesFilter: readonly string[] | null;
  readonly seeds: readonly number[];
  readonly reefLight: boolean;
  readonly tone: ToneCurve;
  /** The live sun at full daylight. */
  readonly sun: number;
  /** Ambient water light: lowered against the reef light, as main does. */
  readonly ambient: number;
  readonly exposure: number;
}

export function parseBakeConfig(params: URLSearchParams): BakeConfig {
  const view = viewOptions(params);
  const tone = toneFor(params);
  const reefLight = params.get('reeflight') !== '0';
  return {
    frames: Number(params.get('frames') || DEFAULT_FRAMES),
    yaws: Number(params.get('yaws') || DEFAULT_YAWS),
    view,
    strip: { w: view.pan ? Math.round(SCREEN.w * view.zoom) : SCREEN.w, h: SCREEN.h },
    waterFrames: Number(params.get('waterFrames') || DEFAULT_WATER_FRAMES),
    waterLoopSeconds: Number(params.get('waterLoop') || DEFAULT_WATER_LOOP_SECONDS),
    pxPerUnit: Math.round(PX_PER_UNIT_AT_ZOOM_1 * view.zoom),
    speciesFilter: params.get('species')?.split(',') ?? null,
    seeds: (params.get('seeds') || String(DEFAULT_SEED)).split(',').map(Number),
    reefLight,
    tone,
    sun: LIGHTS.sun + KEY_FLOOR,
    ambient: reefLight ? LIGHTS.ambient : 1,
    exposure: DAYLIGHT_EXPOSURE * tone.gain,
  };
}
