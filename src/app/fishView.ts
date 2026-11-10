// The open reef's fish's-eye view: the camera rides a fish, at its head, looking where it swims.
//
// The look direction follows the fish's heading through a low-pass filter and the horizon stays level,
// so its turns read as a smooth pan rather than a lurch (the swim wiggle is in the body's shader, not in
// the heading, so the view never sees it). The ridden fish's own body is hidden so the camera isn't
// inside it. Leaving restores the tank camera exactly as it was.
import * as THREE from 'three';
import { clamp } from '../core/math.js';
import { GLASS_DISTANCE, setGpuOpenWater } from '../water/webgpuMedium.js';

/** A wide eye: fish see far more around them than a camera. */
const RIDE_FOV = 68;
const RIDE_NEAR = 0.03;
/** How fast the view turns after the fish's heading (1/s). */
const LOOK_RATE = 2.5;
/** The view pitches at most this far up or down (sin of the angle, about 40 degrees). */
const MAX_PITCH_SIN = 0.64;
/** The eye: this share of the nose's distance ahead of the body's centre, and a little up. */
const EYE_FORWARD = 0.85;
const EYE_UP = 0.25;

/** What the view needs of a fish. */
export interface Rideable {
  readonly pos: THREE.Vector3;
  readonly dir: THREE.Vector3;
  readonly model: THREE.Object3D;
  readonly body: { readonly nose: number; readonly halfDepth: number };
}

interface SavedCamera { fov: number; near: number; position: THREE.Vector3; quaternion: THREE.Quaternion; up: THREE.Vector3; modelVisible: boolean }

export class FishView<F extends Rideable = Rideable> {
  private fish: F | null = null;
  private saved: SavedCamera | null = null;
  private readonly look = new THREE.Vector3(0, 0, -1);
  private readonly eye = new THREE.Vector3();
  private readonly target = new THREE.Vector3();
  private readonly level = new THREE.Vector3();
  private readonly listeners: ((fish: F | null) => void)[] = [];

  /**
   * restoreView re-frames the tank camera after leaving (stage.frameView); gpu: the WebGPU medium,
   * whose fog subtracts the camera's distance to the glass, is told the eye is in the water.
   */
  constructor(private readonly camera: THREE.PerspectiveCamera, private readonly restoreView: () => void, private readonly gpu: boolean) {}

  /** The fish being ridden, or null when the tank camera is in use. */
  get rider(): F | null {
    return this.fish;
  }

  /** Called whenever the rider changes (the UI's ride bar). */
  onChange(listener: (fish: F | null) => void): void {
    this.listeners.push(listener);
  }

  enter(fish: F): void {
    if (fish === this.fish) return;
    const camera = this.camera;
    if (this.fish) this.fish.model.visible = this.saved?.modelVisible ?? true;
    else {
      this.saved = { fov: camera.fov, near: camera.near, position: camera.position.clone(), quaternion: camera.quaternion.clone(), up: camera.up.clone(), modelVisible: true };
      camera.fov = RIDE_FOV;
      camera.near = RIDE_NEAR;
      camera.clearViewOffset();   // the tank view's zoomed window (view.ts) doesn't apply to an eye
      camera.updateProjectionMatrix();
      if (this.gpu) setGpuOpenWater({ glassDistance: 0 });
    }
    if (this.saved) this.saved.modelVisible = fish.model.visible;
    this.fish = fish;
    fish.model.visible = false;
    this.look.copy(fish.dir).normalize();
    this.update(0);
    for (const l of this.listeners) l(fish);
  }

  exit(): void {
    const fish = this.fish, saved = this.saved;
    if (!fish || !saved) return;
    fish.model.visible = saved.modelVisible;
    const camera = this.camera;
    camera.fov = saved.fov;
    camera.near = saved.near;
    camera.position.copy(saved.position);
    camera.quaternion.copy(saved.quaternion);
    camera.up.copy(saved.up);
    camera.updateProjectionMatrix();
    if (this.gpu) setGpuOpenWater({ glassDistance: GLASS_DISTANCE });
    this.fish = null;
    this.saved = null;
    this.restoreView();
    for (const l of this.listeners) l(null);
  }

  /** Follow the rider one step (after the world has moved it). */
  update(dt: number): void {
    const fish = this.fish;
    if (!fish) return;
    const k = dt > 0 ? 1 - Math.exp(-dt * LOOK_RATE) : 0;
    this.look.lerp(this.target.copy(fish.dir).normalize(), k);
    if (this.look.lengthSq() < 1e-6) this.look.copy(fish.dir);
    this.look.normalize();
    // Level horizon: limit the pitch, keeping the heading.
    const pitch = clamp(this.look.y, -MAX_PITCH_SIN, MAX_PITCH_SIN);
    this.level.set(this.look.x, 0, this.look.z);
    const flat = this.level.length();
    if (flat > 1e-4) this.level.multiplyScalar(Math.sqrt(1 - pitch * pitch) / flat);
    else this.level.set(0, 0, Math.sqrt(1 - pitch * pitch));
    this.level.y = pitch;
    this.eye.copy(fish.pos).addScaledVector(fish.dir, fish.body.nose * EYE_FORWARD);
    this.eye.y += fish.body.halfDepth * EYE_UP;
    const camera = this.camera;
    camera.up.set(0, 1, 0);
    camera.position.copy(this.eye);
    camera.lookAt(this.target.copy(this.eye).add(this.level));
    camera.updateMatrixWorld();
  }
}
