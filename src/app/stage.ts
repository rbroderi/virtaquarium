// Builder for the tank's fixed stage: renderer, scene, water medium, camera framing and lights. Each
// step is a small named method; build() returns the assembled parts for the composition root.
import * as THREE from 'three';
import {
  installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, setSunDirection,
  Caustics, WaterRenderer, type WaterBackdrop,
} from '../water.js';
import { LightRig, LIGHTS, SUN_NOON } from '../rig.js';
import { setView, panAt } from '../view.js';
import { PhotoCamera } from '../photo.js';
import type { AppOptions } from './options.js';

/** Tank width from the window's aspect: wide screens see a wider tank (16..30 units). */
const TANK_WIDTH = { min: 16, max: 30, perAspect: 8.6, extra: 1.5 } as const;
const FALLBACK_ASPECT = 16 / 9;
const MAX_PIXEL_RATIO = 2;
const BASE_EXPOSURE = 1.05;
const ENVIRONMENT_INTENSITY = 0.35;
const FOG_DENSITY = 1.0;

const CAMERA = { fov: 40, near: 0.1, far: 120 } as const;
/** The camera's rest position and where it looks. */
export const CAMERA_BASE = new THREE.Vector3(0, 4.6, 15);
export const CAMERA_LOOK = new THREE.Vector3(0, 3.9, 0);

const SHADOW_MAP_SIZE = 2048;
const SHADOW_BOX = { halfWidthPerTank: 0.75, top: 9, bottom: -9, near: 5, far: 40 } as const;
const SHADOW_BIAS = -0.0004;
const SHADOW_NORMAL_BIAS = 0.03;
const SHADOW_RADIUS = 4;
/** With the baked reef light only the fish cast live shadows: soft, as through moving water. */
const SOFT_SHADOW = { radius: 6, blurSamples: 12 } as const;
/** White downwelling (the aquarium lights) over a sand bounce. */
const HEMI_SKY = 0xdcecff, HEMI_GROUND = 0x8a7458;
const PHOTO_ISO = 0.6;

export interface Stage {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly fog: THREE.FogExp2;
  readonly backdrop: WaterBackdrop;
  readonly camera: THREE.PerspectiveCamera;
  readonly tankWidth: number;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly rig: LightRig;
  readonly caustics: Caustics;
  readonly water: WaterRenderer;
  readonly photo: PhotoCamera | null;
  /** Re-aim the camera's zoomed window for time t (view.ts pan). */
  frameView(t: number): void;
}

export function tankWidthFor(aspect: number): number {
  return Math.min(TANK_WIDTH.max, Math.max(TANK_WIDTH.min, TANK_WIDTH.perAspect * aspect + TANK_WIDTH.extra));
}

export class StageBuilder {
  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: AppOptions) {}

  build(): Stage {
    const renderer = this.renderer();
    installUnderwaterMedium();   // physically based water: per-channel absorption + scattering
    const { scene, fog, backdrop } = this.scene(renderer);
    const aspect = window.innerWidth > 0 && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : FALLBACK_ASPECT;
    const tankWidth = tankWidthFor(aspect);
    const camera = this.camera(aspect);
    const frameView = (t: number): void => setView(
      camera, this.canvas.clientWidth || window.innerWidth, this.canvas.clientHeight || window.innerHeight,
      this.options.view, panAt(t, this.options.view));
    frameView(0);
    const sun = this.sun(tankWidth);
    scene.add(sun);
    // The fixture's light refracts through the moving surface: simulated caustics on every surface,
    // and light shafts where the focused light crosses the water.
    setSunDirection(sun.position);
    const caustics = new Caustics(renderer);
    const water = new WaterRenderer(renderer);
    const hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, 1.0);
    scene.add(hemi);
    const rig = new LightRig(scene, sun, this.options.rig);
    const photo = this.options.photo
      ? new PhotoCamera(renderer, { fNumber: this.options.fNumber, iso: PHOTO_ISO, glass: this.options.glass })
      : null;
    return { canvas: this.canvas, renderer, scene, fog, backdrop, camera, tankWidth, sun, hemi, rig, caustics, water, photo, frameView };
  }

  private renderer(): THREE.WebGLRenderer {
    const renderer = new THREE.WebGLRenderer({
      canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
      preserveDrawingBuffer: this.options.capture || this.options.check === 'look',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
    renderer.setSize(window.innerWidth, window.innerHeight, false);   // CSS keeps the canvas full-window
    renderer.toneMapping = this.options.tone.mapping;
    renderer.toneMappingExposure = BASE_EXPOSURE * this.options.tone.gain;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    return renderer;
  }

  private scene(renderer: THREE.WebGLRenderer): { scene: THREE.Scene; fog: THREE.FogExp2; backdrop: WaterBackdrop } {
    const scene = new THREE.Scene();
    const backdrop = makeWaterBackdrop();
    scene.add(backdrop);
    const fog = new THREE.FogExp2(INSCATTER_DAY.clone(), FOG_DENSITY);   // colour = inscatter radiance, density = turbidity
    scene.fog = fog;
    scene.environment = makeEnvironment(renderer);
    scene.environmentIntensity = ENVIRONMENT_INTENSITY;
    return { scene, fog, backdrop };
  }

  private camera(aspect: number): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(CAMERA.fov, aspect, CAMERA.near, CAMERA.far);
    camera.position.copy(CAMERA_BASE);
    camera.lookAt(CAMERA_LOOK);
    return camera;
  }

  private sun(tankWidth: number): THREE.DirectionalLight {
    const sun = new THREE.DirectionalLight(SUN_NOON, LIGHTS.sun);
    sun.position.set(...LIGHTS.sunPos);
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    const box = sun.shadow.camera;
    box.left = -tankWidth * SHADOW_BOX.halfWidthPerTank;
    box.right = tankWidth * SHADOW_BOX.halfWidthPerTank;
    box.top = SHADOW_BOX.top;
    box.bottom = SHADOW_BOX.bottom;
    box.near = SHADOW_BOX.near;
    box.far = SHADOW_BOX.far;
    sun.shadow.bias = SHADOW_BIAS;
    sun.shadow.normalBias = SHADOW_NORMAL_BIAS;
    sun.shadow.radius = SHADOW_RADIUS;
    return sun;
  }
}

/** With the baked reef light, switch to soft variance shadows (before anything compiles). */
export function useSoftFishShadows(stage: Stage): void {
  stage.renderer.shadowMap.type = THREE.VSMShadowMap;
  stage.sun.shadow.radius = SOFT_SHADOW.radius;
  stage.sun.shadow.blurSamples = SOFT_SHADOW.blurSamples;
}
