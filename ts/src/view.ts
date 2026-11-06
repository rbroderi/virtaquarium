// Camera framing shared by the PC view and the Roku bake. The whole tank is the full frustum, as
// framed by main's camera; the screen shows a 1/zoom window into it, held near the bottom (sand and
// reef in view, the surface above the frame) and panning slowly from side to side, as a camera pushed
// up to the glass would. On the Roku the backdrop is baked as the strip that window slides along.
//   ?zoom=1.6 (1 shows the whole tank)   ?pan=1 pans the window across the tank (off by default: on
//   the Roku the strip it pans along measured 53-66 MB of texture memory against a 50 MB target)
import * as THREE from 'three';

/** Where the window sits in the frame's height: 0 top, 1 bottom. */
export const VIEW_ANCHOR = 0.85;
/** Seconds for one sweep across and back. */
export const PAN_PERIOD = 120;
const DEFAULT_ZOOM = 1.6;
const PAN_CENTRE = 0.5;

export interface ViewOptions {
  readonly zoom: number;
  readonly pan: boolean;
}

export interface PixelSize {
  readonly w: number;
  readonly h: number;
}

export function viewOptions(params: URLSearchParams): ViewOptions {
  const zoom = Math.max(1, Number(params.get('zoom') ?? DEFAULT_ZOOM));
  return { zoom, pan: zoom > 1 && params.get('pan') === '1' };
}

/** Pan position 0 (left end) .. 1 (right end) at time t: eases in and out at the ends. */
export function panAt(t: number, view: ViewOptions): number {
  return view.pan ? PAN_CENTRE - PAN_CENTRE * Math.cos((2 * Math.PI * t) / PAN_PERIOD) : PAN_CENTRE;
}

/** Point `camera` (whose aspect is w / h) at the window for pan position p, for a w x h screen. */
export function setView(camera: THREE.PerspectiveCamera, w: number, h: number, view: ViewOptions, p: number): void {
  if (view.zoom <= 1) {
    camera.clearViewOffset();
    return;
  }
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
