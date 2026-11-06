// The viewer: pointer movement over the tank becomes a point just behind the glass with an activity
// level that fades in a few seconds (bold fish come to look, shy ones back off, both get used to it).
import * as THREE from 'three';
import { clamp } from '../core/math.js';
import type { World, TankBounds } from '../world.js';

/** The glass plane sits this far in front of the swimmable box's front. */
const GLASS_INSET = 0.4;
/** Keep the point this far above the floor of the swimmable box. */
const FLOOR_MARGIN = 0.5;
/** Activity added per unit of pointer travel, and for the first move. */
const ACTIVITY_PER_UNIT = 0.5;
const FIRST_MOVE_ACTIVITY = 0.3;

export function trackViewer(canvas: HTMLCanvasElement, camera: THREE.Camera, world: World, bounds: TankBounds): void {
  const ndc = new THREE.Vector2();
  const ray = new THREE.Raycaster();
  const glass = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(bounds.z1 - GLASS_INSET));
  const hit = new THREE.Vector3();
  let last: THREE.Vector3 | null = null;
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(glass, hit)) return;
    hit.x = clamp(hit.x, bounds.x0, bounds.x1);
    hit.y = clamp(hit.y, bounds.y0 + FLOOR_MARGIN, bounds.y1);
    const moved = last ? Math.min(1, hit.distanceTo(last) * ACTIVITY_PER_UNIT) : FIRST_MOVE_ACTIVITY;
    last = hit.clone();
    const viewer = (world.viewer ??= { pos: new THREE.Vector3(), activity: 0 });
    viewer.pos.copy(hit);
    viewer.activity = Math.min(1, viewer.activity + moved);
  });
}
