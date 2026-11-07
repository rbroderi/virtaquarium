// The running tank: one step advances light, feeder, fish, critters, jellies and water; present()
// draws a frame through the water renderer (and the camera model, when on). The checks drive step()
// and present() themselves; the page drives them from requestAnimationFrame.
import * as THREE from 'three';
import { clamp, lerp } from '../core/math.js';
import { waterUniforms, updateWaves, MarineSnow, Bubbles, type SurfaceUniforms } from '../water.js';
import { reefLightUniforms, type ScreenAO } from '../reefLight.js';
import type { WebGpuScreenAO } from '../webgpu/screenAO.js';
import type { World } from '../world.js';
import type { Jelly } from '../jelly.js';
import type { Critter } from '../critters.js';
import type { TankScene } from '../reef/types.js';
import { updateFishPush } from '../reef/fishPush.js';
import { renderCrystalBgScene, type CrystalBgRenderer } from '../reef/crystalBg.js';
import type { Stage } from './stage.js';
import { CAMERA_BASE, CAMERA_LOOK } from './stage.js';
import type { LightingController } from './lighting.js';
import type { DaylightSource } from './daylight.js';
import type { Feeder } from './feeder.js';

/** Longest step simulated in one frame (a stalled tab must not teleport the fish). */
const MAX_STEP = 0.05;
/** Motion blur: shutter 1/100 s, as video. */
const SHUTTER = 1 / 100;
const MIN_DT = 1e-3;
/** How fast the light level follows the clock, and the live level follows the target (1/s). */
const CLOCK_FOLLOW_RATE = 0.2;
const LIGHT_FOLLOW_RATE = 0.8;
/** Gentle camera drift: amplitudes and angular rates. */
const DRIFT = { x: 0.6, xRate: 0.05, y: 0.15, yRate: 0.037 } as const;
/** Autofocus: the centre AF point weighs height a little less than width; focus pull rate (1/s). */
const AF_VERTICAL_WEIGHT = 0.8;
const FOCUS_RATE = 3;
const MAX_PIXEL_RATIO = 2;
const NIGHT_THRESHOLD = 0.5;
/** N jumps the running clock to these hours (a plain light toggle when the clock is off). */
const NOON_HOUR = 12;
const MIDNIGHT_HOUR = 0;

export interface TankParts {
  readonly stage: Stage;
  readonly world: World;
  readonly reef: TankScene;
  readonly jellies: readonly Jelly[];
  readonly critters: readonly Critter[];
  readonly snow: MarineSnow;
  readonly bubbles: Bubbles | null;
  readonly surface: { readonly surfaceUniforms: SurfaceUniforms } | null;
  readonly lighting: LightingController;
  readonly daylight: DaylightSource;
  readonly feeder: Feeder;
  readonly ao: ScreenAO | WebGpuScreenAO | null;
  readonly isJellyTank: boolean;
  readonly drift: boolean;
  readonly motionBlur: boolean;
  /** Called at the end of each step (the UI's tags and panel). */
  readonly afterStep: (dt: number) => void;
}

export class TankLoop {
  private time = 0;
  private targetLight: number;
  private paused = false;
  private readonly clock = new THREE.Clock();
  private readonly ndc = new THREE.Vector3();
  private readonly flow = (p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 => this.parts.world.flow(p, out);

  constructor(private readonly parts: TankParts) {
    this.targetLight = parts.daylight.level();
    this.applyLight(this.targetLight);
  }

  get seconds(): number {
    return this.time;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  /** N: jump the running day/night clock to noon or midnight (a plain toggle when the clock is off). */
  toggleDayNight(): void {
    const { daylight } = this.parts;
    if (daylight.followsClock) daylight.jumpTo(daylight.level() > NIGHT_THRESHOLD ? MIDNIGHT_HOUR : NOON_HOUR);
    else this.targetLight = this.targetLight > NIGHT_THRESHOLD ? 0 : 1;
  }

  /** Jump straight to a light level (checks, console). */
  setLight(level: number): void {
    this.targetLight = level;
    this.applyLight(level);
  }

  /** One animation frame: fit the canvas, step (unless paused) and draw. */
  frame(): void {
    this.fitCanvas();
    const dt = Math.min(this.clock.getDelta(), MAX_STEP);
    if (!this.paused) this.step(dt);
    this.present();
  }

  step(dt: number): void {
    const { stage, world, jellies, critters, snow, bubbles } = this.parts;
    // Motion blur (water.ts): poses before this step are the previous ones.
    if (this.parts.motionBlur) {
      if (stage.water) {
        stage.water.markPrev(world.fish.map((f) => f.model), stage.camera);
        stage.water.blurScale = Math.min(1, SHUTTER / Math.max(dt, MIN_DT));
      }
      if (stage.post) {
        stage.post.track(world.fish.map((f) => f.model), stage.camera);
        stage.post.blurScale = Math.min(1, SHUTTER / Math.max(dt, MIN_DT));
      }
    }
    this.time += dt;
    waterUniforms.uTime.value = this.time;
    this.updateLight(dt);
    world.feedIn = this.parts.feeder.update(dt);   // fish learn the schedule (feeding anticipation)
    world.update(dt);
    updateFishPush(world, stage.camera, dt);   // grass/anemone part from the fish that just moved
    for (const j of jellies) j.update(dt, world, jellies);
    for (const c of critters) c.update(dt, world);
    updateWaves(this.time);
    if (!this.parts.isJellyTank && stage.caustics) stage.caustics.update();   // no surface in view in the jelly tank
    snow.update(dt, this.time, this.flow);
    bubbles?.update(dt, this.time, this.flow, world.light);
    if (this.parts.drift) this.driftCamera();
    stage.frameView(this.time);
    this.parts.afterStep(dt);
    if (stage.photo ?? stage.post?.photo) this.autofocus(dt);
  }

  present(): void | Promise<void> {
    const { stage, ao } = this.parts;
    if (stage.gpu) {
      // The crystal's sub-frustum transmission background, rendered before the main pass samples it.
      renderCrystalBgScene(stage.renderer as unknown as CrystalBgRenderer, stage.scene, stage.camera, this.parts.world.fish.map((f) => f.model));
      if (stage.post) {
        stage.post.setSun(stage.sun);
        stage.post.render(stage.camera, this.time);
        // Screen AO publishes to reefLightUniforms for the next frame (inert until the bake is on).
        if (reefLightUniforms.uRLOn.value && ao) (ao as WebGpuScreenAO).update(stage.camera);
        return;
      }
      // No post yet: draw the scene straight to the screen (async on the backend).
      return stage.renderer.render(stage.scene, stage.camera);
    }
    const water = stage.water;
    if (!water) return;
    // The crystal's sub-frustum transmission background, rendered before the main pass samples it.
    renderCrystalBgScene(stage.renderer as THREE.WebGLRenderer, stage.scene, stage.camera, this.parts.world.fish.map((f) => f.model));
    if (!stage.photo) water.render(stage.scene, stage.camera, stage.sun);
    else {
      water.render(stage.scene, stage.camera, stage.sun, stage.photo.begin());
      stage.photo.finish(water.target.depthTexture, stage.camera, this.time);
    }
    if (reefLightUniforms.uRLOn.value && ao) (ao as ScreenAO).update(water.target.depthTexture, stage.camera);   // read by the next frame
  }

  /** Track the canvas size every frame (window moves between monitors, panes resize without events). */
  fitCanvas(): void {
    const { canvas, renderer, camera } = this.parts.stage;
    const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO);
    if (!w || !h) return;
    // three's setSize floors w * dpr; comparing against a rounded size resized every frame at
    // fractional display scaling (125%, 150%).
    if (canvas.width === Math.floor(w * dpr) && canvas.height === Math.floor(h * dpr)) return;
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    this.parts.stage.frameView(this.time);
  }

  private updateLight(dt: number): void {
    const { daylight, world } = this.parts;
    daylight.advance(dt);
    if (daylight.followsClock) this.targetLight = lerp(this.targetLight, daylight.level(), Math.min(1, dt * CLOCK_FOLLOW_RATE));
    this.applyLight(clamp(lerp(world.light, this.targetLight, Math.min(1, dt * LIGHT_FOLLOW_RATE)), 0, 1));
  }

  /** The look (lighting.ts) and what the fish see: brains read world.light (night colours, sleep, sight). */
  private applyLight(level: number): void {
    this.parts.world.light = level;
    this.parts.lighting.apply(level, this.parts.daylight.sun());
  }

  private driftCamera(): void {
    const camera = this.parts.stage.camera, t = this.time;
    camera.position.set(CAMERA_BASE.x + Math.sin(t * DRIFT.xRate) * DRIFT.x, CAMERA_BASE.y + Math.sin(t * DRIFT.yRate) * DRIFT.y, CAMERA_BASE.z);
    camera.lookAt(CAMERA_LOOK);
  }

  /** Autofocus on the fish nearest the middle of the frame, as a camera's centre AF point would. */
  private autofocus(dt: number): void {
    const { stage, world } = this.parts;
    const photo = stage.photo ?? stage.post?.photo;
    if (!photo) return;
    let best = null, bestDist = Infinity;
    for (const f of world.fish) {
      this.ndc.copy(f.pos).project(stage.camera);
      const d = Math.hypot(this.ndc.x, this.ndc.y * AF_VERTICAL_WEIGHT);
      if (this.ndc.z < 1 && d < bestDist) { bestDist = d; best = f; }
    }
    const s = best ? stage.camera.position.distanceTo(best.pos) : stage.camera.position.distanceTo(CAMERA_LOOK);
    photo.focus = lerp(photo.focus, s, Math.min(1, dt * FOCUS_RATE));
  }
}
