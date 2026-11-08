// Camera framing shared by the PC view and the Roku bake. The whole tank is the full frustum, as
// framed by main's camera; the screen shows a 1/zoom window into it, held near the bottom (sand and
// reef in view, the surface above the frame) and panning slowly from side to side, as a camera pushed
// up to the glass would. On the Roku the backdrop is baked as the strip that window slides along.
//   ?zoom=1.6 (1 shows the whole tank)   ?pan=0/1: the PC view pans across the tank by default; the
//   Roku bake only with ?pan=1 (the strip it pans along measured 53-66 MB of texture memory against a
//   50 MB target)
import * as THREE from 'three';

/** Where the window sits in the frame's height: 0 top, 1 bottom. */
export const VIEW_ANCHOR = 0.85;
/** Seconds for one sweep across and back. */
export const PAN_PERIOD = 120;
const DEFAULT_ZOOM = 1.6;
/** Nominal height (px) to frame by while the page has no size yet. */
const UNSIZED_HEIGHT = 1000;
const PAN_CENTRE = 0.5;

export interface ViewOptions {
  readonly zoom: number;
  readonly pan: boolean;
}

export interface PixelSize {
  readonly w: number;
  readonly h: number;
}

/** `panByDefault`: pan unless ?pan=0 (the PC view); otherwise only with ?pan=1 (the Roku bake). */
export function viewOptions(params: URLSearchParams, panByDefault = false): ViewOptions {
  const zoom = Math.max(1, Number(params.get('zoom') ?? DEFAULT_ZOOM));
  const pan = params.get('pan') ?? (panByDefault ? '1' : '0');
  return { zoom, pan: zoom > 1 && pan === '1' };
}

/** Pan position 0 (left end) .. 1 (right end) at time t: eases in and out at the ends. */
export function panAt(t: number, view: ViewOptions): number {
  return view.pan ? PAN_CENTRE - PAN_CENTRE * Math.cos((2 * Math.PI * t) / PAN_PERIOD) : PAN_CENTRE;
}

/** After a drag, the slow sweep waits this long (s) before it picks up again from where it was left. */
const SWEEP_RESUME_SECONDS = 30;

/**
 * The live view's pan position. It sweeps slowly by itself (as panAt), and a drag takes it over:
 * the window follows the pointer, and after a pause the sweep carries on from there in the direction
 * it was going. Dragging needs a zoomed view; the sweep also needs view.pan.
 */
export class PanControl {
  private phase = 0;
  private p = PAN_CENTRE;
  private idle = Infinity;

  constructor(private readonly view: ViewOptions, private readonly draggable: boolean) {
    this.p = panAt(0, view);
  }

  get position(): number {
    return this.p;
  }

  get canDrag(): boolean {
    return this.draggable && this.view.zoom > 1;
  }

  advance(dt: number): void {
    this.idle += dt;
    if (!this.view.pan || this.idle < SWEEP_RESUME_SECONDS) return;
    this.phase = (this.phase + (2 * Math.PI * dt) / PAN_PERIOD) % (2 * Math.PI);
    this.p = PAN_CENTRE - PAN_CENTRE * Math.cos(this.phase);
  }

  /** Drag by dx screen pixels on a screen w pixels wide: the tank moves with the pointer. */
  drag(dx: number, w: number): void {
    if (!this.canDrag || w <= 0) return;
    this.p = Math.min(1, Math.max(0, this.p - dx / (w * (this.view.zoom - 1))));
    this.idle = 0;
    // The sweep's phase for this position, on the half of the cycle it was on (keeps its direction).
    const a = Math.acos(1 - 2 * this.p);
    this.phase = this.phase <= Math.PI ? a : 2 * Math.PI - a;
  }
}

/** Point `camera` (whose aspect is w / h) at the window for pan position p, for a w x h screen. */
export function setView(camera: THREE.PerspectiveCamera, wIn: number, hIn: number, view: ViewOptions, p: number): void {
  if (view.zoom <= 1) {
    camera.clearViewOffset();
    return;
  }
  // A page started in a hidden tab has no size yet: frame by the camera's aspect instead (the offset is
  // relative, so any size of that shape gives the same window). A 0 x 0 offset made the projection NaN,
  // and with it the swim box's top, which every fish and jelly then inherited.
  const sized = wIn > 0 && hIn > 0;
  const h = sized ? hIn : UNSIZED_HEIGHT, w = sized ? wIn : UNSIZED_HEIGHT * camera.aspect;
  const fw = w * view.zoom, fh = h * view.zoom;
  camera.setViewOffset(fw, fh, (fw - w) * p, (fh - h) * VIEW_ANCHOR, w, h);
}

/**
 * The strip the window pans along (full width, window height), for baking; without the pan, just the
 * window at the centre. Returns its pixel size.
 */
export function setStrip(camera: THREE.PerspectiveCamera, w: number, h: number, view: ViewOptions): PixelSize {
  if (view.zoom <= 1) {
    camera.clearViewOffset();
    return { w, h };
  }
  const fw = Math.round(w * view.zoom), fh = h * view.zoom, sw = view.pan ? fw : w;
  camera.setViewOffset(fw, fh, (fw - sw) / 2, (fh - h) * VIEW_ANCHOR, sw, h);
  return { w: sw, h };
}

const WINDOW_TOP_NDC = new THREE.Vector3(0, 1, 0.5);

/** World height where the top of the window meets the plane z (fish above it would be out of frame). */
export function windowTopY(camera: THREE.PerspectiveCamera, z = 0): number {
  camera.updateMatrixWorld();
  const origin = camera.position.clone();
  const dir = WINDOW_TOP_NDC.clone().unproject(camera).sub(origin).normalize();
  return origin.y + (dir.y * (z - origin.z)) / dir.z;
}
