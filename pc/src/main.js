// Virtual aquarium (PC / browser). See README for controls and URL options.
import * as THREE from 'three';
import { SPECIES, FISH_NAMES } from './species.js';
import { buildReef, loadScenery } from './reef.js';
import { World } from './world.js';
import { Fish } from './fish.js';
import { loadCustomModels } from './fishModel.js';
import { mulberry32, range, clamp, lerp } from './util.js';
import { waterUniforms, installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, GodRays, MarineSnow, Bubbles, makeSurface } from './water.js';
import { UI } from './ui.js';
import { loadTank } from './tank.js';

const params = new URLSearchParams(location.search);
const tank = await loadTank(params);
const SEED = tank.seed;
const CLOCK = tank.clock;              // follow local time of day (lights dim at night)
const FEED_MIN = tank.feedMinutes;     // auto-feeder interval in minutes (0 = off)
const DRIFT = tank.drift;              // gentle camera parallax

const rng = mulberry32(SEED * 101 + 3);
const canvas = document.getElementById('tank');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('capture') });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);   // CSS keeps the canvas full-window
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

installUnderwaterMedium();   // physically based water: per-channel absorption + scattering
const scene = new THREE.Scene();
const backdrop = makeWaterBackdrop();
scene.add(backdrop);
scene.fog = new THREE.FogExp2(INSCATTER_DAY.clone(), 1.0);   // colour = inscatter radiance, density = turbidity
scene.environment = makeEnvironment(renderer);
scene.environmentIntensity = 0.35;

const aspect = window.innerWidth > 0 && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 16 / 9;
const TANK_W = Math.min(30, Math.max(16, 8.6 * aspect + 1.5));
const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 120);
const CAM_BASE = new THREE.Vector3(0, 4.6, 15);
const LOOK = new THREE.Vector3(0, 3.9, 0);
camera.position.copy(CAM_BASE);
camera.lookAt(LOOK);

// Lighting: sun through the surface + sky/sand bounce.
const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
sun.position.set(3, 22, 7);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -TANK_W * 0.75; sc.right = TANK_W * 0.75; sc.top = 9; sc.bottom = -9; sc.near = 5; sc.far = 40;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 4;
scene.add(sun);
const hemi = new THREE.HemisphereLight(0xdcecff, 0x8a7458, 1.0);   // white downwelling (aquarium lights) + sand bounce
scene.add(hemi);

// Optional Tripo3D / GLB models replace procedural fish species by species.
const customModels = await loadCustomModels(SPECIES);
if (customModels.length) console.info('Using GLB models for:', customModels.join(', '));

// Optional generated rocks/corals (tools/tripo.mjs) replace the procedural ones.
const scenery = await loadScenery();
if (scenery.rocks.length || Object.keys(scenery.coral).length) console.info('Using generated scenery:', scenery.rocks.length, 'rocks,', Object.keys(scenery.coral).join(', '));
const reef = buildReef(scene, TANK_W, SEED, scenery);
const rays = new GodRays(scene, TANK_W, rng);
const snow = new MarineSnow(scene, TANK_W * 1.4, rng);
const bubbles = new Bubbles(scene, reef.bubbler, rng);
const surface = makeSurface(TANK_W);
scene.add(surface);

const bounds = { x0: -TANK_W / 2 + 0.9, x1: TANK_W / 2 - 0.9, y0: 0.25, y1: 9.2, z0: -3.0, z1: 2.7 };
const world = new World(scene, reef, bounds, rng);

// Populate the tank. Names the owner chose come first; the rest are drawn from the pool.
const speciesById = new Map(SPECIES.map((sp) => [sp.id, sp]));
const chosen = new Set(tank.fish.flatMap((e) => e.names));
const names = FISH_NAMES.filter((n) => !chosen.has(n));
const homes = reef.homes.slice();
for (const entry of tank.fish) {
  const sp = speciesById.get(entry.species);
  for (let i = 0; i < entry.count; i++) {
    const name = entry.names[i] || (names.length ? names.splice(Math.floor(rng() * names.length), 1)[0] : sp.name);
    const f = new Fish(sp, name, rng);
    const x = range(rng, bounds.x0 + 1, bounds.x1 - 1), z = range(rng, bounds.z0 + 0.5, bounds.z1 - 0.5);
    const floor = reef.heightAt(x, z) + 0.6;
    f.pos.set(x, range(rng, floor, bounds.y1 - 0.5), z);
    if (sp.brain.host) {
      f.brain.home.copy(reef.anemones[0].pos);
      f.pos.copy(reef.anemones[0].pos).add(new THREE.Vector3(range(rng, -0.4, 0.4), 0.3, range(rng, -0.3, 0.3)));
    } else {
      // Shy fish choose low homes; everyone else takes a random spot on the reef.
      homes.sort((a, b) => (sp.brain.shy ? a.y - b.y : 0) || 0);
      const h = homes.splice(sp.brain.shy ? Math.floor(rng() * 6) : Math.floor(rng() * homes.length), 1)[0] || reef.homes[0];
      f.brain.home.copy(h);
    }
    world.addFish(f);
  }
}

const ui = new UI({ world, camera, renderer, onFeed: (x) => world.dropFood(x) });

// ---------- day / night ----------

function daylight() {
  if (!CLOCK) return 1;
  const d = new Date(), h = d.getHours() + d.getMinutes() / 60;
  // Lights ramp 7:00-8:30 and 20:00-21:30; moonlight at night.
  if (h < 7 || h >= 21.5) return 0;
  if (h < 8.5) return (h - 7) / 1.5;
  if (h >= 20) return 1 - (h - 20) / 1.5;
  return 1;
}
let light = daylight();
function applyLight(l) {
  world.light = l;
  const k = 0.12 + 0.88 * l;
  sun.intensity = 2.6 * l + 0.05;
  hemi.intensity = 1.0 * k;
  hemi.color.setRGB(lerp(0.30, 0.86, l), lerp(0.45, 0.92, l), 1.0);   // moonlight is bluer
  scene.environmentIntensity = 0.35 * k;
  waterUniforms.uCaustic.value = l;
  scene.fog.color.copy(INSCATTER_DAY).multiplyScalar(0.06 + 0.94 * l);
  backdrop.material.uniforms.uBase.value.copy(scene.fog.color);
  renderer.toneMappingExposure = 1.25 * (0.45 + 0.55 * l);
  surface.material.uniforms.uLight.value = l;
}
applyLight(light);

// ---------- loop ----------

const clock = new THREE.Clock();
let t = 0, nextFeed = FEED_MIN > 0 ? 45 : Infinity, paused = false;
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') paused = !paused;
  if (e.key === 'n' || e.key === 'N') light = light > 0.5 ? 0 : 1;
});

function frame() {
  requestAnimationFrame(frame);
  fitCanvas();
  const dt = Math.min(clock.getDelta(), 0.05);
  if (paused) { renderer.render(scene, camera); return; }
  t += dt;
  waterUniforms.uTime.value = t;

  if (CLOCK) light = lerp(light, daylight(), Math.min(1, dt * 0.2));
  applyLight(clamp(lerp(world.light, light, Math.min(1, dt * 0.8)), 0, 1));

  nextFeed -= dt;
  if (nextFeed <= 0) {
    world.dropFood(range(rng, bounds.x0 + 2, bounds.x1 - 2));
    nextFeed = FEED_MIN * 60;
  }

  world.update(dt);
  rays.update(t, world.light);
  const flow = (p, out) => world.flow(p, out);
  snow.update(dt, t, flow);
  bubbles.update(dt, t, flow, world.light);

  if (DRIFT) {
    camera.position.set(CAM_BASE.x + Math.sin(t * 0.05) * 0.6, CAM_BASE.y + Math.sin(t * 0.037) * 0.15, CAM_BASE.z);
    camera.lookAt(LOOK);
  }
  ui.update(dt);
  renderer.render(scene, camera);
}
frame();

// Track the canvas size every frame (window moves between monitors, panes resize without events).
function fitCanvas() {
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio, 2);
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
}

// Exposed for the Roku exporter and debugging.
window.aquarium = { THREE, scene, camera, renderer, world, reef, SPECIES, rays, snow, bubbles, surface, setLight: (l) => { light = l; applyLight(l); } };
