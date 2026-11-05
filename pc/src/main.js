// Virtual aquarium (PC / browser). See README for controls and URL options.
import * as THREE from 'three';
import { SPECIES, FISH_NAMES } from './species.js';
import { buildReef, loadScenery } from './reef.js';
import { World } from './world.js';
import { Fish } from './fish.js';
import { loadCustomModels, fishRender } from './fishModel.js';
import { mulberry32, range, clamp, lerp } from './util.js';
import {
  waterUniforms, installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, MarineSnow, Bubbles, makeSurface,
  Caustics, WaterRenderer, updateWaves, setSunDirection,
} from './water.js';
import { UI } from './ui.js';
import { loadTank } from './tank.js';
import { PhotoCamera } from './photo.js';
import { LightRig, toneFor, LIGHTS } from './rig.js';
import { viewOptions, panAt, setView, windowTopY } from './view.js';
import { bakeReefLight, reefLightUniforms, ScreenAO } from './reefLight.js';
import { JELLY_SPECIES, Jelly, buildJellyTank } from './jelly.js';
import { CRITTER_SPECIES, Cuttlefish, Octopus, Turtle } from './critters.js';

const params = new URLSearchParams(location.search);
// The camera model (photo.js) is on by default: a photo of a tank has depth of field, lens fall-off and
// sensor grain, and a render without them reads as CG. ?photo=0 turns it off (and saves ~2 ms a frame).
const PHOTO = params.get('photo') !== '0';
fishRender.finDepth = PHOTO;
const tank = await loadTank(params);
const SEED = tank.seed;
const CLOCK = tank.clock;              // follow local time of day (lights dim at night)
const FEED_MIN = tank.feedMinutes;     // auto-feeder interval in minutes (0 = off)
const DRIFT = tank.drift;              // gentle camera parallax

const rng = mulberry32(SEED * 101 + 3);
const canvas = document.getElementById('tank');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: params.has('capture') || params.get('check') === 'look' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);   // CSS keeps the canvas full-window
const TONE = toneFor(params);
renderer.toneMapping = TONE.mapping;
renderer.toneMappingExposure = 1.05 * TONE.gain;
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
// Zoomed in towards the glass, panning slowly across the tank (view.js).
const view = viewOptions(params);
const frameView = (t) => setView(camera, canvas.clientWidth || window.innerWidth, canvas.clientHeight || window.innerHeight, view, panAt(t, view));
frameView(0);

// Lighting: sun through the surface + sky/sand bounce.
const sun = new THREE.DirectionalLight(0xfff2dc, LIGHTS.sun);
sun.position.set(...LIGHTS.sunPos);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = -TANK_W * 0.75; sc.right = TANK_W * 0.75; sc.top = 9; sc.bottom = -9; sc.near = 5; sc.far = 40;
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.03;
sun.shadow.radius = 4;
scene.add(sun);
// The fixture's light refracts through the moving surface: simulated caustics on every surface,
// and light shafts where the focused light crosses the water.
setSunDirection(sun.position);
const caustics = new Caustics(renderer);
const water = new WaterRenderer(renderer);
const hemi = new THREE.HemisphereLight(0xdcecff, 0x8a7458, 1.0);   // white downwelling (aquarium lights) + sand bounce
scene.add(hemi);
const rig = new LightRig(scene, sun, params.get('rig') || 'sun');
// Render through a camera model (depth of field, lens and sensor effects; see photo.js), unless ?photo=0.
const _ndc = new THREE.Vector3();   // autofocus scratch
// f/5.6 keeps most of the reef sharp with the far rock and near-glass motes softened, as a typical tank
// photo; gentler grain than a high-ISO shot. ?fstop=2.8 for a shallower look.
const photo = PHOTO ? new PhotoCamera(renderer, { fNumber: Number(params.get('fstop')) || 5.6, iso: 0.6 }) : null;

// Optional Tripo3D / GLB models replace procedural fish species by species.
const customModels = await loadCustomModels(SPECIES);
if (customModels.length) console.info('Using GLB models for:', customModels.join(', '));

// The jelly tank (jelly.js) is a backlit blue void with only jellies in it: no reef, sand or surface.
const JELLY_TANK = tank.scenery === 'jelly';
let reef;
if (JELLY_TANK) {
  reef = buildJellyTank(scene);
  backdrop.visible = false;
} else {
  // Optional generated rocks/corals (tools/tripo.mjs) replace the procedural ones.
  const scenery = await loadScenery();
  if (scenery.rocks.length || Object.keys(scenery.coral).length) console.info('Using generated scenery:', scenery.rocks.length, 'rocks,', Object.keys(scenery.coral).join(', '));
  reef = buildReef(scene, TANK_W, SEED, scenery, CAM_BASE);
  console.info('Planted:', JSON.stringify(reef.planted), 'plants loaded:', Object.keys(scenery.plants).join(', '));
}
// Light the static reef once by ray casting (reefLight.js): soft sun shadows, ambient occlusion and
// coloured bounce light, per pixel from the camera's rest view and in a grid for the fish.
// ?reeflight=0 to compare; L toggles it.
const ao = new ScreenAO(renderer);
if (!JELLY_TANK && params.get('reeflight') !== '0') {
  rig.apply(1);   // baked at full daylight; the live light level scales it
  bakeReefLight(renderer, reef, {
    sun: { dir: sun.position.clone(), irr: sun.color.clone().multiplyScalar(sun.intensity), cone: 0.1 },
    sky: new THREE.Color(0.86, 0.92, 1.0).multiplyScalar(LIGHTS.ambient), ground: hemi.groundColor.clone().multiplyScalar(LIGHTS.ambient),
    camera,
  });
  // Only the fish cast live shadows now; soft ones, as from a broad light through moving water.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  sun.shadow.radius = 6; sun.shadow.blurSamples = 12;
}
const snow = new MarineSnow(scene, TANK_W * 1.4, rng);
const bubbles = reef.bubbler ? new Bubbles(scene, reef.bubbler, rng) : null;
const surface = makeSurface(TANK_W);
if (!JELLY_TANK) scene.add(surface);

// Fish stay below the top of the zoomed window, so they swim in frame rather than above it.
const bounds = { x0: -TANK_W / 2 + 0.9, x1: TANK_W / 2 - 0.9, y0: 0.25, y1: Math.min(9.2, windowTopY(camera) - 0.5), z0: -3.0, z1: 2.7 };
const world = new World(scene, reef, bounds, rng);

// Populate the tank. Names the owner chose come first; the rest are drawn from the pool.
const speciesById = new Map(SPECIES.map((sp) => [sp.id, sp]));
const chosen = new Set(tank.fish.flatMap((e) => e.names));
const names = FISH_NAMES.filter((n) => !chosen.has(n));
const homes = reef.homes.slice();
// The cleaning station: a prominent rock top in the front half at mid height, where clients can be seen
// queuing (Labroides stations are on conspicuous outcrops). Held by the first cleaner wrasse.
if (!JELLY_TANK && tank.fish.some((e) => speciesById.get(e.species)?.brain.cleaner && e.count > 0)) {
  const spots = reef.homes.filter((h) => h.z > -1.2 && h.y > 1.0 && h.y < 4.0);
  const pick = (spots.length ? spots : reef.homes).slice().sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[Math.floor(rng() * Math.min(3, spots.length || 1))];
  world.station = { pos: pick.clone(), cleaner: null, client: null };
}
const jellies = [];
const jellyById = new Map(JELLY_SPECIES.map((sp) => [sp.id, sp]));
const critterById = new Map(CRITTER_SPECIES.map((sp) => [sp.id, sp]));
for (const entry of tank.fish) {
  if (jellyById.has(entry.species)) {
    for (let i = 0; i < entry.count; i++) {
      const j = new Jelly(jellyById.get(entry.species), rng, bounds);
      jellies.push(j);
      scene.add(j.model);
    }
    continue;
  }
  if (critterById.has(entry.species)) {
    const sp = critterById.get(entry.species);
    for (let i = 0; i < entry.count; i++) {
      let c;
      if (sp.id === 'cuttlefish') c = new Cuttlefish(sp, rng, world);
      else if (sp.id === 'turtle') c = new Turtle(sp, rng, world);
      else {
        // The octopus dens in a cave the moray doesn't hold (the eels take the first ones), else in a
        // low crevice among the rock.
        const eels = tank.fish.filter((e) => speciesById.get(e.species)?.brain.lurker).reduce((n, e) => n + e.count, 0);
        const cave = reef.caves[eels + world.critters.filter((o) => o instanceof Octopus).length];
        const den = cave ? cave.mouth.clone().addScaledVector(cave.dir, -0.2) : reef.homes.slice().sort((a, b) => a.y - b.y)[0].clone();
        c = new Octopus(sp, rng, world, den);
        c.cave = cave || null;
        if (cave) c.yaw = Math.atan2(cave.dir.z, cave.dir.x);
      }
      world.critters.push(c);
      scene.add(c.model);
    }
    continue;
  }
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
    } else if (sp.brain.lurker && reef.caves.length) {
      // Eels take a cave (extra eels share): body inside, the front quarter out of the mouth.
      const cave = reef.caves[world.fish.filter((o) => o.sp.brain.lurker).length % reef.caves.length];
      f.brain.home.copy(cave.mouth).addScaledVector(cave.dir, -0.25 * f.size);
      f.brain.lurkDir = cave.dir.clone();
      f.pos.copy(f.brain.home);
      f.dir.copy(cave.dir); f.yaw = Math.atan2(cave.dir.z, cave.dir.x);
      f.brain.mode = 'lurk';
    } else if (sp.brain.cleaner && world.station && !world.station.cleaner) {
      world.station.cleaner = f;
      f.brain.home.copy(world.station.pos);
      f.pos.copy(world.station.pos).add(new THREE.Vector3(0, 0.4, 0));
    } else {
      // Shy fish choose low homes; everyone else takes a random spot on the reef.
      homes.sort((a, b) => (sp.brain.shy ? a.y - b.y : 0) || 0);
      const h = homes.splice(sp.brain.shy ? Math.floor(rng() * 6) : Math.floor(rng() * homes.length), 1)[0] || reef.homes[0];
      f.brain.home.copy(h);
    }
    world.addFish(f);
  }
}
// Each fish knows a shelter near its home (reef.shelters): shoaling chromis share their staghorn, the
// rest take the nearest ledge whose gap fits their body, at most three to a ledge. Clownfish have the
// anemone and eels their cave.
if (!JELLY_TANK && reef.shelters) {
  const used = new Map(), coral = reef.shelters.find((s) => s.kind === 'coral');
  for (const f of world.fish) {
    const b = f.sp.brain;
    if (b.host || b.lurker) continue;
    if (b.school >= 0.8 && coral) { f.brain.shelter = coral; f.brain.home.copy(reef.shoalCoral.pos); continue; }
    const depth = f.size * f.sp.body.depth;
    let best = null, bd = Infinity;
    for (const s of reef.shelters) {
      if (s.kind !== 'ledge' || s.top - s.floor < depth + 0.12 || (used.get(s) || 0) >= 3) continue;
      const d = s.pos.distanceTo(f.brain.home);
      if (d < bd) { bd = d; best = s; }
    }
    if (best) { f.brain.shelter = best; used.set(best, (used.get(best) || 0) + 1); }
  }
  console.info('Shelters:', reef.shelters.length, 'assigned:', world.fish.filter((f) => f.brain.shelter).length);
}

const ui = new UI({ world, camera, renderer, onFeed: (x) => world.dropFood(x) });

// The viewer: pointer movement over the tank, as a point just behind the glass with an activity level
// that fades in a few seconds (brain.js: bold fish come to look, shy ones back off, both get used to it).
{
  const ndc = new THREE.Vector2(), ray = new THREE.Raycaster(), glass = new THREE.Plane(new THREE.Vector3(0, 0, 1), -(bounds.z1 - 0.4)), hit = new THREE.Vector3();
  let last = null;
  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    if (!ray.ray.intersectPlane(glass, hit)) return;
    hit.x = clamp(hit.x, bounds.x0, bounds.x1); hit.y = clamp(hit.y, bounds.y0 + 0.5, bounds.y1);
    const moved = last ? Math.min(1, hit.distanceTo(last) * 0.5) : 0.3;
    last = hit.clone();
    world.viewer = world.viewer || { pos: new THREE.Vector3(), activity: 0 };
    world.viewer.pos.copy(hit);
    world.viewer.activity = Math.min(1, world.viewer.activity + moved);
  });
}

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
  rig.apply(l);
  // Ambient water light is occluded by the baked reef light, so it can sit lower against the sun
  // and let the shadows read (without the bake, the old balance).
  const amb = reefLightUniforms.uRLOn.value ? LIGHTS.ambient : 1.0;
  hemi.intensity = amb * k;
  reefLightUniforms.uRLLight.value = k;
  hemi.color.setRGB(lerp(0.30, 0.86, l), lerp(0.45, 0.92, l), 1.0);   // moonlight is bluer
  scene.environmentIntensity = LIGHTS.env * amb * k;
  waterUniforms.uCaustic.value = l;
  scene.fog.color.copy(INSCATTER_DAY).multiplyScalar(0.06 + 0.94 * l);
  backdrop.material.uniforms.uBase.value.copy(scene.fog.color);
  renderer.toneMappingExposure = 1.25 * TONE.gain * (0.45 + 0.55 * l);
  surface.material.uniforms.uLight.value = l;
  surface.material.uniforms.uBase.value.copy(scene.fog.color);
  if (reef.backdrop) reef.backdrop.material.uniforms.uLight.value = 0.08 + 0.92 * l;   // the jelly tank's light panel
}
applyLight(light);

// ---------- loop ----------

const clock = new THREE.Clock();
let t = 0, nextFeed = FEED_MIN > 0 && !JELLY_TANK ? 45 : Infinity, paused = false;   // jellies aren't fed flakes
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') paused = !paused;
  if (e.key === 'n' || e.key === 'N') light = light > 0.5 ? 0 : 1;
  if ((e.key === 'l' || e.key === 'L') && reefLightUniforms.uRLRes.value.x > 1) {
    const on = (reefLightUniforms.uRLOn.value ^= 1);
    reef.group.traverse((o) => { if (o.isMesh) o.castShadow = !on; });   // off: live reef shadows again
  }
});

function frame() {
  requestAnimationFrame(frame);
  fitCanvas();
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!paused) step(dt);
  present();
}

// One step of the tank: light, feeder, fish, critters, water. The checks (lookCheck.js) drive it too.
function step(dt) {
  // Motion blur (water.js): poses before this step are the previous ones; shutter 1/100 s, as video.
  if (params.get('blur') !== '0') {
    water.markPrev(world.fish.map((f) => f.model), camera);
    water.blurScale = Math.min(1, (1 / 100) / Math.max(dt, 1e-3));
  }
  t += dt;
  waterUniforms.uTime.value = t;

  if (CLOCK) light = lerp(light, daylight(), Math.min(1, dt * 0.2));
  applyLight(clamp(lerp(world.light, light, Math.min(1, dt * 0.8)), 0, 1));

  nextFeed -= dt;
  world.feedIn = nextFeed;   // fish learn the schedule (brain.js feeding anticipation)
  if (nextFeed <= 0) {
    world.dropFood(range(rng, bounds.x0 + 2, bounds.x1 - 2));
    nextFeed = FEED_MIN * 60;
  }

  world.update(dt);
  for (const j of jellies) j.update(dt, world, jellies);
  for (const c of world.critters) c.update(dt, world);
  updateWaves(t);
  if (!JELLY_TANK) caustics.update();   // no surface in view: the light panel is behind the tank
  const flow = (p, out) => world.flow(p, out);
  snow.update(dt, t, flow);
  if (bubbles) bubbles.update(dt, t, flow, world.light);

  if (DRIFT) {
    camera.position.set(CAM_BASE.x + Math.sin(t * 0.05) * 0.6, CAM_BASE.y + Math.sin(t * 0.037) * 0.15, CAM_BASE.z);
    camera.lookAt(LOOK);
  }
  frameView(t);
  ui.update(dt);
  if (photo) autofocus(dt);
}
// The checks step the tank themselves (the motion check draws nothing).
if (!params.has('check') || params.get('check') === 'critters') frame();

function present() {
  if (!photo) water.render(scene, camera, sun);
  else {
    water.render(scene, camera, sun, photo.begin());
    photo.finish(water.target.depthTexture, camera, t);
  }
  if (reefLightUniforms.uRLOn.value) ao.update(water.target.depthTexture, camera);   // read by the next frame
}

// Autofocus on the fish nearest the middle of the frame, as a camera's centre AF point would.
function autofocus(dt) {
  let best = null, bd = Infinity;
  for (const f of world.fish) {
    _ndc.copy(f.pos).project(camera);
    const d = Math.hypot(_ndc.x, _ndc.y * 0.8);
    if (_ndc.z < 1 && d < bd) { bd = d; best = f; }
  }
  const s = best ? camera.position.distanceTo(best.pos) : camera.position.distanceTo(LOOK);
  photo.focus = lerp(photo.focus, s, Math.min(1, dt * 3));
}

// Track the canvas size every frame (window moves between monitors, panes resize without events).
function fitCanvas() {
  const w = canvas.clientWidth, h = canvas.clientHeight, dpr = Math.min(window.devicePixelRatio, 2);
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    renderer.setPixelRatio(dpr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    frameView(t);
  }
}

// Exposed for the Roku exporter and debugging.
window.aquarium = { THREE, scene, camera, renderer, world, reef, jellies, SPECIES, caustics, water, snow, bubbles, surface, setLight: (l) => { light = l; applyLight(l); }, step, present, fitCanvas };

// ?check=critters: the critters' shape checks (critterCheck.js).
if (params.get('check') === 'critters') import('./critterCheck.js').then((m) => m.main(window.aquarium));
// ?check=motion: fish climb, bobbing and eel-in-roof checks (motionCheck.js).
if (params.get('check') === 'motion') import('./motionCheck.js').then((m) => m.main(window.aquarium));
// ?check=look: render fixed moments to out/look-*.png, with close-ups (lookCheck.js).
if (params.get('check') === 'look') import('./lookCheck.js').then((m) => m.main(window.aquarium));
