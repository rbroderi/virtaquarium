// Screen-space geometry of a baked scene: the strip the screen pans along, the swim box, the reef
// floor line and the world-to-pixel scale, all derived from the manifest.
import type { Manifest, SceneEntry } from './manifest.js';

// Same tank width formula as main.ts (TANK_W) and bake.ts, so pixels per unit match the bake.
const TANK_WIDTH_MIN = 16, TANK_WIDTH_MAX = 30, TANK_WIDTH_PER_ASPECT = 8.6, TANK_WIDTH_PAD = 1.5;
const SWIM_BOX_MARGIN_UNITS = 1.8;      // the swim bounds are inset 0.9 units each side
const HALF_DEPTH_UNITS = 2.85;          // depth runs -1..1 over the tank's 5.7 units front to back
const CENTRED_PAN = 0.5;

export const wrapAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

export class SceneGeometry {
  readonly screenW: number;
  readonly stripW: number;
  readonly bx0: number;
  readonly by0: number;
  readonly bx1: number;
  readonly by1: number;
  /** Screen pixels per world unit on the mid-depth plane. */
  readonly pxPerUnit: number;
  /** Sprite scale at mid depth: screen px per baked px. */
  readonly baseScale: number;
  /** Pixels per unit of normalised depth (-1 back .. 1 front). */
  readonly depthPx: number;

  constructor(private readonly manifest: Manifest, private readonly scene: SceneEntry) {
    const { screen, view } = manifest;
    this.screenW = screen.w;
    this.stripW = view.strip.w;
    const aspect = screen.w / screen.h;
    const tankW = Math.min(TANK_WIDTH_MAX, Math.max(TANK_WIDTH_MIN, TANK_WIDTH_PER_ASPECT * aspect + TANK_WIDTH_PAD));
    [this.bx0, this.by0, this.bx1, this.by1] = scene.swimBox;
    this.pxPerUnit = (this.bx1 - this.bx0) / (tankW - SWIM_BOX_MARGIN_UNITS);
    this.baseScale = this.pxPerUnit / manifest.pxPerUnit;
    this.depthPx = HALF_DEPTH_UNITS * this.pxPerUnit;
  }

  /** Left edge of the screen window on the strip at time t (s). */
  panAt(t: number): number {
    const { pan, period } = this.manifest.view;
    const p = pan ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / period) : CENTRED_PAN;
    return (this.stripW - this.screenW) * p;
  }

  /** Reef floor line (screen y) under strip x, interpolated from the baked samples. */
  floorAt(x: number): number {
    const f = this.scene.floor;
    const t = Math.min(Math.max(x / this.stripW, 0), 1) * (f.length - 1);
    const i = Math.min(Math.floor(t), f.length - 2);
    const a = f[i] ?? 0, b = f[i + 1] ?? a;
    return a + (b - a) * (t - i);
  }
}
