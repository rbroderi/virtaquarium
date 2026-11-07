// Builder for the tank's fixed stage: renderer, scene, water medium, camera framing and lights. Each
// step is a small named method; build() returns the assembled parts for the composition root.
import * as THREE from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import {
  installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, setSunDirection,
  Caustics, WaterRenderer, type WaterBackdrop,
} from '../water.js';
import { loadTsl } from '../webgpu/tsl.js';
import { LightRig, LIGHTS, SUN_NOON } from '../rig.js';
import { setView, panAt } from '../view.js';
import { PhotoCamera } from '../photo.js';
import type { AppOptions } from './options.js';

/** Either backend: the WebGL renderer is classic; the WebGPU renderer is the common/TSL renderer. */
export type RendererLike = THREE.WebGLRenderer | WebGPURenderer;

/** Tank width from the window's aspect: wide screens see a wider tank (16..30 units). */
const TANK_WIDTH = { min: 16, max: 30, perAspect: 8.6, extra: 1.5 } as const;
const FALLBACK_ASPECT = 16 / 9;
const MAX_PIXEL_RATIO = 2;
const BASE_EXPOSURE = 1.05;
const ENVIRONMENT_INTENSITY = 0.35;
const FOG_DENSITY = 1.0;
/** Stock FogExp2 on the WebGPU path: the WebGL path replaces the fog equation with per-channel
 *  Beer-Lambert (uwK scales the small beam coefficients), so its nominal density 1.0 is a wash of the
 *  whole scene under stock FogExp2. A small density approximates the medium until the TSL fog lands. */
const GPU_FOG_DENSITY = 0.05;

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
  readonly renderer: RendererLike;
  /** True when the renderer is three's WebGPURenderer (custom GLSL passes are disabled). */
  readonly gpu: boolean;
  readonly scene: THREE.Scene;
  readonly fog: THREE.FogExp2;
  readonly backdrop: WaterBackdrop | null;
  readonly camera: THREE.PerspectiveCamera;
  readonly tankWidth: number;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
  readonly rig: LightRig;
  readonly caustics: Caustics | null;
  readonly water: WaterRenderer | null;
  readonly photo: PhotoCamera | null;
  /** Re-aim the camera's zoomed window for time t (view.ts pan). */
  frameView(t: number): void;
}

export function tankWidthFor(aspect: number): number {
  return Math.min(TANK_WIDTH.max, Math.max(TANK_WIDTH.min, TANK_WIDTH.perAspect * aspect + TANK_WIDTH.extra));
}

export class StageBuilder {
  constructor(private readonly canvas: HTMLCanvasElement, private readonly options: AppOptions) {}

  async build(): Promise<Stage> {
    const { renderer, gpu } = await this.renderer();
    if (!gpu) installUnderwaterMedium();   // physically based water: per-channel absorption + scattering
    const { scene, fog, backdrop } = this.scene(renderer, gpu);
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
    // and light shafts where the focused light crosses the water (WebGL-only; WebGPU renders directly).
    if (!gpu) setSunDirection(sun.position);
    const caustics = gpu ? null : new Caustics(renderer as THREE.WebGLRenderer);
    const water = gpu ? null : new WaterRenderer(renderer as THREE.WebGLRenderer);
    const hemi = new THREE.HemisphereLight(HEMI_SKY, HEMI_GROUND, 1.0);
    scene.add(hemi);
    const rig = new LightRig(scene, sun, this.options.rig);
    const photo = !gpu && this.options.photo
      ? new PhotoCamera(renderer as THREE.WebGLRenderer, { fNumber: this.options.fNumber, iso: PHOTO_ISO, glass: this.options.glass })
      : null;
    return { canvas: this.canvas, renderer, gpu, scene, fog, backdrop, camera, tankWidth, sun, hemi, rig, caustics, water, photo, frameView };
  }

  private async renderer(): Promise<{ renderer: RendererLike; gpu: boolean }> {
    if (this.options.renderer === 'webgpu') {
      const renderer = await this.webgpuRenderer();
      if (renderer) return { renderer, gpu: true };
    }
    return { renderer: this.webglRenderer(), gpu: false };
  }

  private webglRenderer(): THREE.WebGLRenderer {
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

  /** Creates the WebGPU renderer, or null when WebGPU is unavailable or init fails (falls back to WebGL). */
  private async webgpuRenderer(): Promise<WebGPURenderer | null> {
    if (typeof navigator === 'undefined' || !('gpu' in navigator) || !navigator.gpu) return null;
    try {
      const wg = await loadTsl();
      const renderer = new wg.WebGPURenderer({
        canvas: this.canvas, antialias: true, powerPreference: 'high-performance',
      });
      await renderer.init();
      // three/webgpu is a self-contained build, so its node library is keyed by that build's light
      // classes; register the core-three light classes (the scene graph's) so the lights actually
      // light the auto-converted node materials instead of being skipped as "not found".
      renderer.library.addLight(wg.DirectionalLightNode, THREE.DirectionalLight);
      renderer.library.addLight(wg.HemisphereLightNode, THREE.HemisphereLight);
      renderer.library.addLight(wg.PointLightNode, THREE.PointLight);
      renderer.library.addLight(wg.SpotLightNode, THREE.SpotLight);
      renderer.library.addLight(wg.AmbientLightNode, THREE.AmbientLight);
      renderer.library.addLight(wg.RectAreaLightNode, THREE.RectAreaLight);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, MAX_PIXEL_RATIO));
      renderer.setSize(window.innerWidth, window.innerHeight, false);
      renderer.toneMapping = this.options.tone.mapping;
      renderer.toneMappingExposure = BASE_EXPOSURE * this.options.tone.gain;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.shadowMap.enabled = true;
      return renderer;
    } catch (e) {
      console.warn('WebGPU renderer unavailable, falling back to WebGL2', e instanceof Error ? e.message : e);
      return null;
    }
  }

  private scene(renderer: RendererLike, gpu: boolean): { scene: THREE.Scene; fog: THREE.FogExp2; backdrop: WaterBackdrop | null } {
    const scene = new THREE.Scene();
    const fog = new THREE.FogExp2(INSCATTER_DAY.clone(), gpu ? GPU_FOG_DENSITY : FOG_DENSITY);   // colour = inscatter radiance, density = turbidity
    scene.fog = fog;
    if (gpu) {
      // The backdrop and PMREM environment are ShaderMaterial GLSL; the WebGPU path uses a flat
      // open-water clear colour and stock exponential fog instead (see notes/webgpu-plan.md).
      scene.background = INSCATTER_DAY.clone();
      return { scene, fog, backdrop: null };
    }
    const backdrop = makeWaterBackdrop();
    scene.add(backdrop);
    scene.environment = makeEnvironment(renderer as THREE.WebGLRenderer);
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
