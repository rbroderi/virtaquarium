// Scenery layers: the backdrop (water and reef, no fish) cut into strip columns, the foreground reef
// near the glass, the moving-water loop, and the screen-space helpers the Roku's 2D brains need. Mirrors
// main at full daylight with the camera at rest, so the Roku backdrop matches the PC view.
import * as THREE from 'three';
import { buildReef, loadScenery, type Reef } from '../reef.js';
import {
  waterUniforms, installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, makeSurface,
  Caustics, WaterRenderer, causticUniforms, updateWaves, setSunDirection, MarineSnow, SURFACE_Y,
} from '../water.js';
import { World, type TankBounds } from '../world.js';
import { mulberry32 } from '../util.js';
import { isNoHeight, inBackdropOnlySubtree } from '../reef/flags.js';
import { bakeReefLight, reefLightUniforms } from '../reefLight.js';
import { windowTopY } from '../view.js';
import { LIGHTS } from '../rig.js';
import { CAUSTIC_T, SCREEN, SUPERSAMPLE, TILE, type BakeConfig } from './config.js';
import { alphaBox, blankCanvas, cropCanvas, readbackContext, saveAsset, toBlob, type Log, type Rect } from './io.js';
import { GROUND_COLOR, SKY_COLOR, SUN_COLOR, liveCamera } from './camera.js';
import { bakeWater, type SnowLoop } from './waterLoop.js';
import type { BubblerEntry, SceneryEntry, ScreenPoint, Tile } from './manifest.js';

// As main: the tank's width follows the screen aspect.
const TANK_WIDTH_PER_ASPECT = 8.6, TANK_WIDTH_OFFSET = 1.5, TANK_MIN_W = 16, TANK_MAX_W = 30;
const ENVIRONMENT_INTENSITY = 0.35;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_SPAN = 0.75, SHADOW_TOP = 9, SHADOW_NEAR = 5, SHADOW_FAR = 40;
const SHADOW_BIAS = -0.0004, SHADOW_NORMAL_BIAS = 0.03, SHADOW_RADIUS = 4;
const SUN_CONE = 0.1;
/** Marine snow spans the tank's width times this (as main). */
const SNOW_SPAN = 1.4;
const SNOW_SEED_MULTIPLIER = 101, SNOW_SEED_OFFSET = 3;
const SIM_STEP = 1 / 30;
const JPEG_QUALITY = 0.9;
/** Reef meshes whose world z is in front of this make the foreground layer. */
const FOREGROUND_Z = 1.0;
/** Samples of the reef's top line across the strip. */
const FLOOR_SAMPLES = 64;
// main's swim bounds.
const SWIM_MARGIN_X = 0.9, SWIM_Y0 = 0.25, SWIM_CEILING = 9.2, WINDOW_TOP_MARGIN = 0.5, SWIM_Z0 = -3.0, SWIM_Z1 = 2.7;

const tankWidth = (aspect: number): number => Math.min(TANK_MAX_W, Math.max(TANK_MIN_W, TANK_WIDTH_PER_ASPECT * aspect + TANK_WIDTH_OFFSET));

interface SceneryRig {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly sun: THREE.DirectionalLight;
  readonly hemi: THREE.HemisphereLight;
}

function makeSceneryRig(renderer: THREE.WebGLRenderer, config: BakeConfig, tankW: number): SceneryRig {
  installUnderwaterMedium();
  const scene = new THREE.Scene();
  const backdrop = makeWaterBackdrop();
  scene.add(backdrop);
  const fog = new THREE.FogExp2(INSCATTER_DAY.clone(), 1.0);
  scene.fog = fog;
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = ENVIRONMENT_INTENSITY;
  backdrop.backdropUniforms.uBase.value.copy(fog.color);
  const camera = liveCamera(config);   // framed on the whole strip the zoomed window shows

  const sun = new THREE.DirectionalLight(SUN_COLOR, config.sun);
  sun.position.set(...LIGHTS.sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
  const sc = sun.shadow.camera;
  sc.left = -tankW * SHADOW_SPAN; sc.right = tankW * SHADOW_SPAN; sc.top = SHADOW_TOP; sc.bottom = -SHADOW_TOP; sc.near = SHADOW_NEAR; sc.far = SHADOW_FAR;
  sun.shadow.bias = SHADOW_BIAS; sun.shadow.normalBias = SHADOW_NORMAL_BIAS; sun.shadow.radius = SHADOW_RADIUS;
  const hemi = new THREE.HemisphereLight(SKY_COLOR.clone(), GROUND_COLOR, 1.0);
  scene.add(sun, hemi);
  return { scene, camera, sun, hemi };
}

/**
 * Marine snow as in main, carried by the pump current. It moves, so it lives only in the water loop;
 * two copies (the same particles) are simulated forward to the two moments each loop frame blends.
 */
function makeSnowLoop(scene: THREE.Scene, tankW: number, seed: number, world: World): SnowLoop {
  const flow = (p: THREE.Vector3, o: THREE.Vector3): void => { world.flow(p, o); };
  const sims = [0, 1].map(() => ({ snow: new MarineSnow(scene, tankW * SNOW_SPAN, mulberry32(seed * SNOW_SEED_MULTIPLIER + SNOW_SEED_OFFSET)), t: 0 }));
  return {
    at(k, t) {
      const sim = sims[k];
      if (!sim) return;
      for (; sim.t < t - 1e-6; sim.t += SIM_STEP) {
        world.time = sim.t;
        sim.snow.update(Math.min(SIM_STEP, t - sim.t), sim.t, flow);
      }
      sims.forEach((o, i) => { o.snow.points.visible = i === k; });
    },
    off() {
      for (const o of sims) o.snow.points.visible = false;
    },
  };
}

/** The strip cut into TILE-wide columns, so the Roku holds only those in view as the window pans. */
async function saveBackdropTiles(out: HTMLCanvasElement, strip: { w: number; h: number }, key: string): Promise<Tile[]> {
  const tiles: Tile[] = [];
  for (let x = 0, n = 0; x < strip.w; x += TILE, n++) {
    const rect: Rect = [x, 0, Math.min(TILE, strip.w - x), strip.h], file = `scenery/${key}-${n}.jpg`;
    await saveAsset(file, await toBlob(cropCanvas(out, rect), 'image/jpeg', JPEG_QUALITY));
    tiles.push({ file, rect });
  }
  return tiles;
}

/** Columns like the backdrop's, each cropped to the pixels that hold reef (empty layer costs memory too). */
async function saveForegroundTiles(out: HTMLCanvasElement, g: CanvasRenderingContext2D, strip: { w: number; h: number }, key: string): Promise<Tile[]> {
  const tiles: Tile[] = [];
  for (let x = 0, n = 0; x < strip.w; x += TILE, n++) {
    const w = Math.min(TILE, strip.w - x), [bx, by, bw, bh] = alphaBox(g.getImageData(x, 0, w, strip.h));
    if (bw <= 1) continue;
    const rect: Rect = [x + bx, by, bw, bh], file = `scenery/${key}-fg-${n}.png`;
    await saveAsset(file, await toBlob(cropCanvas(out, rect), 'image/png'));
    tiles.push({ file, rect });
  }
  return tiles;
}

/** Hides everything but the reef near the glass (no sand plane) while `on`. */
function foregroundToggle(scene: THREE.Scene, reef: Reef): (on: boolean) => void {
  const hidden: THREE.Object3D[] = [];
  scene.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const inReef = !!reef.group.getObjectById(o.id);
    const geometry: unknown = o.geometry;
    const sand = isNoHeight(o) && geometry instanceof THREE.BufferGeometry && geometry.type === 'PlaneGeometry';
    if (!inReef || sand || inBackdropOnlySubtree(o) || o.getWorldPosition(new THREE.Vector3()).z < FOREGROUND_Z) hidden.push(o);
  });
  return (on) => { for (const o of hidden) o.visible = !on; };
}

/** Screen-space helpers for the Roku's 2D brains: reef top line, anemone, swim box, bubbler, shelters. */
function screenHelpers(camera: THREE.PerspectiveCamera, reef: Reef, swim: TankBounds, strip: { w: number; h: number }): Omit<SceneryEntry, 'scenery' | 'seed' | 'backdrop' | 'foreground' | 'water'> {
  const project = (x: number, y: number, z: number): ScreenPoint => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [Math.round(((v.x + 1) / 2) * strip.w), Math.round(((1 - v.y) / 2) * strip.h)];
  };
  const floor: number[] = [];
  for (let i = 0; i <= FLOOR_SAMPLES; i++) {
    const sx = i / FLOOR_SAMPLES, ndc = new THREE.Vector3(sx * 2 - 1, 0, 0.5).unproject(camera);
    // March along the view ray to z = 0 to find the world x under this screen column.
    const dir = ndc.sub(camera.position).normalize(), t = -camera.position.z / dir.z;
    const x = camera.position.x + dir.x * t;
    floor.push(project(x, reef.heightAt(x, 0), 0)[1]);
  }
  const an = reef.anemones[0]?.pos;
  const tl = project(swim.x0, swim.y1, 0), br = project(swim.x1, swim.y0, 0);
  // The airstone, for the player's bubble column: where it is, how far up the bubbles go (the surface,
  // usually above the strip) and the scale at its depth.
  const bo = reef.bubbler, bp = project(bo.x, bo.y, bo.z);
  const bubbler: BubblerEntry = { pos: bp, top: project(bo.x, SURFACE_Y, bo.z)[1], pxPerUnit: Math.abs(project(bo.x + 1, bo.y, bo.z)[0] - bp[0]) };
  return {
    floor,
    anemone: an ? project(an.x, an.y, an.z) : null,
    swimBox: [tl[0], tl[1], br[0], br[1]],
    bubbler,
    // Where fish hide (reef shelters): screen position, and kind ('ledge' or the shoal's 'coral').
    shelters: reef.shelters.map((s) => ({ pos: project(s.pos.x, s.pos.y, s.pos.z), kind: s.kind })),
  };
}

export async function bakeScenery(renderer: THREE.WebGLRenderer, config: BakeConfig, log: Log, scenery: string, seed: number): Promise<{ key: string; entry: SceneryEntry }> {
  const tankW = tankWidth(SCREEN.w / SCREEN.h);
  const { scene, camera, sun, hemi } = makeSceneryRig(renderer, config, tankW);
  // Generated rocks and corals (models/scenery.json), as in main; missing ones stay procedural.
  const reef = buildReef(scene, tankW, seed, await loadScenery(), camera.position);
  // The PC tank's reef light, with the same inputs as main at full daylight. (main's live screen-space
  // AO shades fish against the reef; the Roku's fish are sprites drawn over this, so it adds nothing.)
  if (config.reefLight) {
    bakeReefLight(renderer, reef, {
      sun: { dir: sun.position.clone(), irr: sun.color.clone().multiplyScalar(sun.intensity), cone: SUN_CONE },
      sky: SKY_COLOR.clone().multiplyScalar(LIGHTS.ambient), ground: hemi.groundColor.clone().multiplyScalar(LIGHTS.ambient),
      camera,
    });
  }
  hemi.intensity = config.ambient;
  scene.environmentIntensity = LIGHTS.env * config.ambient;
  scene.add(makeSurface(tankW));
  waterUniforms.uCaustic.value = 1;
  waterUniforms.uTime.value = 0;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMappingExposure = config.exposure;
  // Supersampled like the fish: the headless GPU's MSAA leaves about a quarter of the reef's outline
  // pixels hard-stepped, so the strip is rendered at SS x and filtered down when it is read back.
  const strip = config.strip;
  renderer.setPixelRatio(1);
  renderer.setSize(strip.w * SUPERSAMPLE, strip.h * SUPERSAMPLE, false);

  const swim: TankBounds = {
    x0: -tankW / 2 + SWIM_MARGIN_X, x1: tankW / 2 - SWIM_MARGIN_X,
    y0: SWIM_Y0, y1: Math.min(SWIM_CEILING, windowTopY(camera) - WINDOW_TOP_MARGIN), z0: SWIM_Z0, z1: SWIM_Z1,
  };
  const world = new World(scene, reef, swim, mulberry32(seed));
  const snow = makeSnowLoop(scene, tankW, seed, world);
  snow.off();
  renderer.setClearColor(0x000000, 1);

  // The same simulated caustics and light shafts as the PC tank, frozen at one moment of the waves.
  setSunDirection(sun.position);
  updateWaves(CAUSTIC_T);
  const caustics = new Caustics(renderer);
  caustics.update();
  const waterRenderer = new WaterRenderer(renderer);

  const key = `${scenery}-${seed}`;
  const out = blankCanvas(strip.w, strip.h);
  const g = readbackContext(out);
  waterRenderer.render(scene, camera, sun);
  g.drawImage(renderer.domElement, 0, 0, strip.w, strip.h);
  const backdrop = await saveBackdropTiles(out, strip, key);

  // Foreground: only reef meshes near the glass, on a transparent background. Rendered without the
  // shaft pass (which is opaque); the reef keeps its caustic lighting so it matches the backdrop.
  const showForegroundOnly = foregroundToggle(scene, reef);
  showForegroundOnly(true);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  g.clearRect(0, 0, strip.w, strip.h);
  g.drawImage(renderer.domElement, 0, 0, strip.w, strip.h);
  const foreground = await saveForegroundTiles(out, g, strip, key);
  showForegroundOnly(false);

  const water = await bakeWater({ renderer, config, log, key, scene, camera, sun, waterRenderer, caustics, showForegroundOnly, snow });
  renderer.shadowMap.enabled = false;
  // Sprites must not carry a frozen caustic pattern (fish move through it on the Roku), nor this reef's light.
  causticUniforms.uCauOn.value = 0;
  reefLightUniforms.uRLOn.value = 0;

  return { key, entry: { scenery, seed, backdrop, foreground, water, ...screenHelpers(camera, reef, swim, strip) } };
}
