// Virtual aquarium (PC / browser): the composition root. It reads the URL, validates the tank
// document, builds the stage, reef and stock, wires the event bus, and starts the loop. Every module
// it wires receives its collaborators here; none reaches for a global.
import * as THREE from 'three';
import { SPECIES } from './species.js';
import { buildReef, loadScenery, EMPTY_SCENERY, type Scenery, type TankScene } from './reef.js';
import { World, type TankBounds } from './world.js';
import { loadCustomModels, loadSkinCache, fishRender } from './fishModel.js';
import { MarineSnow, Bubbles, makeSurface } from './water.js';
import { bakeReefLightCached, pendingReefLightSave, reefLightUniforms, ScreenAO } from './reefLight.js';
import { JELLY_SPECIES, buildJellyTank } from './jelly.js';
import { CRITTER_SPECIES } from './critters.js';
import { UI } from './ui.js';
import { loadTank, type Tank } from './tank.js';
import { LIGHTS } from './rig.js';
import { windowTopY } from './view.js';
import { mulberry32, type Rng } from './core/rng.js';
import { EventBus } from './core/eventBus.js';
import { requireElement } from './core/dom.js';
import { parseAppOptions, type AppOptions } from './app/options.js';
import { StartupTimer } from './app/startupTimer.js';
import { LoadingScreen } from './app/loadingScreen.js';
import { startProfiler, profileReport, type ProfileReport } from './app/profiler.js';
import { StageBuilder, useSoftFishShadows, CAMERA_BASE, type Stage } from './app/stage.js';
import { LightingController, BAKE_SKY } from './app/lighting.js';
import { daylightFor, wallClockDaylight, type DaylightSource } from './app/daylight.js';
import { Feeder, type TankEvents } from './app/feeder.js';
import { stockTank } from './app/stocking.js';
import { trackViewer } from './app/viewer.js';
import { TankLoop } from './app/tankLoop.js';
import { loadReefLightFingerprint } from './app/sourceFingerprint.js';
import type { AquariumHandle, CheckModule } from './app/handle.js';

/** The stock's seed stream: offset from the tank seed so it is independent of the reef's streams. */
const STOCK_SEED = { scale: 101, offset: 3 } as const;
/** The swimmable box, inset from the tank walls and below the top of the zoomed window. */
const SWIM_BOX = { wallInset: 0.9, floor: 0.25, ceiling: 9.2, belowWindow: 0.5, back: -3.0, front: 2.7 } as const;
/** Marine snow spreads a little beyond the tank's width. */
const SNOW_SPREAD = 1.4;
/** The reef light is baked under a soft sun cone (radians). */
const SUN_CONE = 0.1;

const NO_SCENERY: Scenery = EMPTY_SCENERY;

interface DebugHooks {
  aquarium?: AquariumHandle;
  startupStages?: unknown;
  startupTimes?: Readonly<Record<string, number>>;
  firstFramePrograms?: readonly string[];
  startupProfile?: ProfileReport;
}
const debugHooks: DebugHooks = window as Window & DebugHooks;

/** The progress bar over the tank while it starts (index.html #loading). */
const loading = LoadingScreen.fromPage();
/** Let the bar paint before a long synchronous step (the page can't repaint during one). */
const paintLoading = (): Promise<void> => loading?.paint() ?? Promise.resolve();

async function buildScenery(stage: Stage, tank: Tank, options: AppOptions, timer: StartupTimer): Promise<TankScene> {
  if (tank.scenery === 'jelly') {
    // The jelly tank is a backlit blue void with only jellies in it: no reef, sand or surface.
    if (stage.backdrop) stage.backdrop.visible = false;
    return buildJellyTank(stage.scene);
  }
  const scenery = options.generatedScenery ? await loadScenery() : NO_SCENERY;
  timer.stage('load scenery');
  if (scenery.rocks.length || Object.keys(scenery.coral).length) {
    console.info('Using generated scenery:', scenery.rocks.length, 'rocks,', Object.keys(scenery.coral).join(', '));
  }
  await paintLoading();
  const reef = buildReef(stage.scene, stage.tankWidth, tank.seed, scenery, CAMERA_BASE);
  console.info('Planted:', JSON.stringify(reef.planted), 'plants loaded:', Object.keys(scenery.plants).join(', '));
  return reef;
}

/** Light the static reef once by ray casting: soft sun shadows, ambient occlusion and bounce light. */
async function bakeReefLight(stage: Stage, reef: TankScene): Promise<void> {
  stage.rig.apply(1);   // baked at full daylight; the live light level scales it
  await bakeReefLightCached(stage.renderer as THREE.WebGLRenderer, reef, {
    sun: { dir: stage.sun.position.clone(), irr: stage.sun.color.clone().multiplyScalar(stage.sun.intensity), cone: SUN_CONE },
    sky: BAKE_SKY.clone().multiplyScalar(LIGHTS.ambient),
    ground: stage.hemi.groundColor.clone().multiplyScalar(LIGHTS.ambient),
    camera: stage.camera,
  }, {
    sourceFingerprint: await loadReefLightFingerprint(),
    onProgress: (phase, done) => loading?.progress(done, phase === 'cache'
      ? 'Lighting the reef (from the cache)'
      : `Lighting the reef ${Math.round(done * 100)}% · first start for this layout`),
  });
}

function swimBox(stage: Stage): TankBounds {
  const half = stage.tankWidth / 2;
  return {
    x0: -half + SWIM_BOX.wallInset, x1: half - SWIM_BOX.wallInset,
    y0: SWIM_BOX.floor, y1: Math.min(SWIM_BOX.ceiling, windowTopY(stage.camera) - SWIM_BOX.belowWindow),
    z0: SWIM_BOX.back, z1: SWIM_BOX.front,
  };
}

function bindKeys(loop: TankLoop, daylight: DaylightSource, ui: UI, toggleReefLight: () => void): void {
  window.addEventListener('keydown', (e) => {
    if (e.key === ' ') loop.togglePause();
    if (e.key === 'n' || e.key === 'N') { loop.toggleDayNight(); ui.showClock(daylight); }
    if (e.key === 'l' || e.key === 'L') toggleReefLight();
    if (e.key === '<') { daylight.slowDown(); ui.showClock(daylight); }
    if (e.key === '>') { daylight.speedUp(); ui.showClock(daylight); }
    if (e.key === 'r' || e.key === 'R') { daylight.reset(); ui.showClock(daylight); }
  });
}

async function runCheck(check: AppOptions['check'], aquarium: AquariumHandle, gpu: boolean): Promise<void> {
  if (check === 'perf' && gpu) {
    console.warn('The perf check is WebGL-only; skipping under WebGPU');
    return;
  }
  const loaders: Record<string, () => Promise<CheckModule>> = {
    critters: () => import('./critterCheck.js'),
    motion: () => import('./motionCheck.js'),
    look: () => import('./lookCheck.js'),
    perf: () => import('./perfCheck.js'),
  };
  const load = check ? loaders[check] : undefined;
  if (load) await (await load()).main(aquarium);
}

async function main(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const options = parseAppOptions(params);
  const timer = new StartupTimer();
  loading?.follow(timer);
  debugHooks.startupStages = timer;
  const profiler = options.profile ? startProfiler() : null;

  const tank = await loadTank(params);
  const rng: Rng = mulberry32(tank.seed * STOCK_SEED.scale + STOCK_SEED.offset);
  await paintLoading();
  const stage = await new StageBuilder(requireElement('tank', HTMLCanvasElement), options).build();
  // Fish materials are built during stocking, so the backend flag must be set before the world is built.
  fishRender.finDepth = options.photo && !stage.gpu;
  fishRender.gpu = stage.gpu;
  if (stage.gpu) console.info('WebGPU renderer active (?renderer=webgpu; post effects disabled, see notes/webgpu-plan.md)');
  timer.stage('renderer, environment, caustics');

  // Optional Tripo3D / GLB models replace procedural fish species by species.
  const [customModels] = await Promise.all([loadCustomModels(SPECIES), loadSkinCache(SPECIES)]);
  if (customModels.length) console.info('Using GLB models for:', customModels.join(', '));
  timer.stage('fish models + skin cache');

  const isJellyTank = tank.scenery === 'jelly';
  if (isJellyTank && stage.gpu) console.warn('Jelly tank shaders are not ported to WebGPU yet; the tank will not render correctly');
  const reef = await buildScenery(stage, tank, options, timer);
  timer.stage('build reef');

  const ao = stage.gpu ? null : new ScreenAO(stage.renderer as THREE.WebGLRenderer);
  const useReefLight = !isJellyTank && options.reefLight && !stage.gpu;
  if (useReefLight) useSoftFishShadows(stage);
  // Shaders compile in parallel while the rest of startup runs, instead of blocking on first draw. Bound
  // to the target the tank draws into (the water renderer's): a program is specific to its target (an
  // HDR target has no tone mapping or sRGB output), and the screen's would go unused. WebGPU has no
  // water target, so it precompiles straight against the default framebuffer.
  const precompile = (): Promise<void> => {
    if (stage.water) stage.renderer.setRenderTarget(stage.water.target);
    const compiling = stage.renderer.compileAsync(stage.scene, stage.camera);   // issues every compile now, then waits
    if (stage.water) stage.renderer.setRenderTarget(null);
    return compiling.then(() => undefined, (e: unknown) => console.warn('compileAsync:', e instanceof Error ? e.message : e));
  };
  if (options.precompile && !stage.gpu) void precompile();   // WebGPU pipelines compile lazily; compileAsync corrupts its draw path (see below)
  if (useReefLight) await bakeReefLight(stage, reef);
  timer.stage('reef light bake');

  const snow = new MarineSnow(stage.scene, stage.tankWidth * SNOW_SPREAD, rng);
  const bubbles = reef.bubbler && !stage.gpu ? new Bubbles(stage.scene, reef.bubbler, rng) : null;
  const surface = stage.gpu ? null : makeSurface(stage.tankWidth);
  if (!isJellyTank && surface) stage.scene.add(surface);

  const bounds = swimBox(stage);
  await paintLoading();   // stocking paints any fish skins the cache didn't have (about a second each)
  const world = new World(stage.scene, reef, bounds, rng);
  const { critters, jellies } = stockTank({
    scene: stage.scene, world, reef, bounds, rng, tank,
    catalogue: { fish: SPECIES, critters: CRITTER_SPECIES, jellies: JELLY_SPECIES },
  });
  timer.stage('fish and critters');
  if (options.precompile && !stage.gpu) await precompile();
  timer.stage('compile shaders');

  // Feeding is an event: the auto-feeder, a click and the F key all publish it; the world drops food.
  const bus = new EventBus<TankEvents>();
  bus.on('feed', ({ x }) => world.dropFood(x));
  const ui = new UI({ world, camera: stage.camera, renderer: stage.renderer, onFeed: (x) => bus.emit('feed', { x, automatic: false }) });
  trackViewer(stage.canvas, stage.camera, world, bounds);

  const lighting = new LightingController({ stage, surface, reef, toneGain: options.tone.gain });
  const feeder = new Feeder(bus, tank.feedMinutes, bounds, rng, !isJellyTank);   // jellies aren't fed flakes
  // Checks keep a fixed light (they call setLight); the live page follows the clock by default. The look
  // check can also be pinned to a specific hour of day (--hour=18) to preview dawn/dusk/night.
  const followClock = tank.clock && options.check === null;
  const lookHour = options.check === 'look' && params.has('hour') ? Number(params.get('hour')) : NaN;
  const daylight = Number.isFinite(lookHour) ? wallClockDaylight() : daylightFor(followClock);
  const loop = new TankLoop({
    stage, world, reef, jellies, critters, snow, bubbles, surface, lighting,
    daylight, feeder, ao, isJellyTank, drift: tank.drift, motionBlur: options.motionBlur && !stage.gpu,
    afterStep: () => ui.update(),
  });
  bindKeys(loop, daylight, ui, () => toggleReefLight(reef));

  // The handle is the WebGL renderer's shape; under WebGPU its GLSL-only members are null but the
  // checks that run there (look, motion, critters) only touch the common surface and the world.
  const aquarium: AquariumHandle = {
    THREE, scene: stage.scene, camera: stage.camera, renderer: stage.renderer as THREE.WebGLRenderer, world, reef, jellies, critters, SPECIES,
    caustics: stage.caustics as NonNullable<Stage['caustics']>, water: stage.water as NonNullable<Stage['water']>, snow, bubbles, surface: surface as NonNullable<typeof surface>, daylight,
    setLight: (l) => loop.setLight(l), step: (dt) => loop.step(dt), present: () => loop.present(), fitCanvas: () => loop.fitCanvas(),
  };
  debugHooks.aquarium = aquarium;   // exposed for the Roku exporter and debugging

  if (!options.checkDrivesLoop) startAnimation(loop, stage, timer, options, profiler);
  else loading?.finish();   // a check steps the tank itself and draws no first frame
  if (options.check) await runCheck(options.check, aquarium, stage.gpu);
}

/** L toggles the baked reef light (off: live reef shadows again). */
function toggleReefLight(reef: TankScene): void {
  if (reefLightUniforms.uRLRes.value.x <= 1) return;   // never baked
  const on = (reefLightUniforms.uRLOn.value ^= 1);
  reef.group.traverse((o) => { if (o instanceof THREE.Mesh) o.castShadow = !on; });
}

function startAnimation(loop: TankLoop, stage: Stage, timer: StartupTimer, options: AppOptions, profiler: ReturnType<typeof startProfiler>): void {
  let first = true;
  const programsBefore = stage.gpu ? 0 : (stage.renderer as THREE.WebGLRenderer).info.programs?.length ?? 0;
  const tick = (): void => {
    requestAnimationFrame(tick);
    loop.frame();
    if (!first) return;
    first = false;
    reportFirstFrame(stage, timer, options, profiler, programsBefore);
  };
  tick();
}

/** Logs startup timing once the first frame (and its shader compiles) is done; ?check=startup reports it. */
function reportFirstFrame(stage: Stage, timer: StartupTimer, options: AppOptions, profiler: ReturnType<typeof startProfiler>, programsBefore: number): void {
  if (stage.gpu) {
    timer.stage('first frame');
    loading?.finish();
    const times = timer.times();
    console.info(`Startup ${timer.totalMs()} ms (WebGPU):`, JSON.stringify(times));
    return;
  }
  const gl = stage.renderer as THREE.WebGLRenderer;
  const programs = gl.info.programs ?? [];
  debugHooks.firstFramePrograms = programs.slice(programsBefore).map((p) => p.name);
  gl.getContext().finish();   // the first draw compiles every shader; count it here
  timer.stage('first frame (shader compile)');
  loading?.finish();
  const times = timer.times();
  debugHooks.startupTimes = times;
  const total = timer.totalMs();
  console.info(`Startup ${total} ms:`, JSON.stringify(times));
  void Promise.all([profiler ? profileReport(profiler) : null, pendingReefLightSave()]).then(([profile]) => {
    if (profile) debugHooks.startupProfile = profile;
    if (options.check !== 'startup') return;
    const body = JSON.stringify({
      total, programs: gl.info.programs?.length, firstFramePrograms: debugHooks.firstFramePrograms, stages: times, profile,
    }, null, 1);
    void fetch('/__done', { method: 'POST', body });
  });
}

await main().catch((e: unknown) => {
  loading?.fail(e);
  throw e;
});
