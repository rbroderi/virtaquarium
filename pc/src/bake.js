// Roku asset baker. Renders what the Roku channel can't (it has no WebGL) into plain images:
//   roku/assets/fish/<id>-a<n>.png    one page per viewing angle n: the swim cycle, facing right, cropped
//   roku/assets/scenery/<key>.jpg     1920x1080 backdrop: water + reef, no fish
//   roku/assets/scenery/<key>-fg.png  reef pieces near the glass, drawn over fish that are behind them
//   roku/assets/manifest.json         frame sizes, anchors, per-species behaviour, reef floor line
// Open /pc/bake.html (optionally ?species=a,b&seeds=7,42&frames=8&yaws=9), or run `node tools/bake.mjs`.
import * as THREE from 'three';
import { SPECIES } from './species.js';
import { buildFishModel, loadCustomModels, posePectoral } from './fishModel.js';
import { buildReef, loadScenery } from './reef.js';
import {
  waterUniforms, installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, makeSurface,
  Caustics, WaterRenderer, causticUniforms, updateWaves, setSunDirection, MarineSnow, Bubbles, SURFACE_Y,
} from './water.js';
import { World } from './world.js';
import { mulberry32 } from './util.js';
import { SCENERY } from './tank.js';
import { bakeReefLight, reefLightUniforms } from './reefLight.js';
import { viewOptions, setStrip, windowTopY, PAN_PERIOD } from './view.js';
import { toneFor, LIGHTS } from './rig.js';

const params = new URLSearchParams(location.search);
const FRAMES = Number(params.get('frames') || 8);   // swim-cycle frames per viewing angle
// Viewing angles (yaw towards the viewer), evenly from tail-on (-90) through side-on (0) to head-on (+90).
// Fish are bilaterally symmetric, so the Roku mirrors these for a fish facing left: 9 angles cover the
// full circle in 22.5 degree steps. 9 x 8 cells for all species is ~60 MB of decoded texture.
const YAWS = Number(params.get('yaws') || 9);
const MAX_SHEET = 2048;             // Roku's recommended largest bitmap side; cells wrap to stay inside it
const SS = 2;                       // supersampling factor
const SCREEN = { w: 1920, h: 1080 };
// Zoomed view (view.js): the screen is a 1/zoom window into the tank; with ?pan=1 it pans along a strip
// zoom times as wide, otherwise the strip is just that window.
const VIEW = viewOptions(params);
const STRIP = { w: VIEW.pan ? Math.round(SCREEN.w * VIEW.zoom) : SCREEN.w, h: SCREEN.h };   // as setStrip
const TILE = 512;   // the strip's backdrop and foreground are cut into columns this wide, loaded as they come into view
const CAUSTIC_T = 3.0;   // wave time (s) the backdrop's caustics are frozen at
const WATER_FRAMES = Number(params.get('waterFrames') || 32);   // moving-water loop: frames ...
const WATER_LOOP = Number(params.get('waterLoop') || 8);        // ... spread over this many seconds
const WATER_SCALE = 2;              // loop frames are baked at 1/2 resolution and scaled up on the Roku
// Sprite resolution: ~1.2x the on-screen size at 1080p (99 px/unit at mid depth, times the zoom),
// headroom for fish swimming nearer the glass.
const PX_PER_UNIT = Math.round(120 * VIEW.zoom);
const CRUISE_YAW = 0.35;            // the player shows cruising fish turned this far towards the viewer (rad)
const OUT = 'roku/assets/';
const only = params.get('species')?.split(',');
const species = SPECIES.filter((sp) => !only || only.includes(sp.id));
const seeds = (params.get('seeds') || '7').split(',').map(Number);

const log = (msg) => { document.getElementById('log').textContent += msg + '\n'; console.log(msg); };

async function save(path, blobOrText) {
  const res = await fetch('/__save?path=' + encodeURIComponent(OUT + path), { method: 'POST', body: blobOrText });
  if (!res.ok) throw new Error(`save ${path}: HTTP ${res.status}`);
}
const toBlob = (canvas, type, q) => new Promise((r) => canvas.toBlob(r, type, q));

// Bounding box [x, y, w, h] of the non-transparent pixels of `img` (ImageData); [0, 0, 1, 1] if empty.
function alphaBox(img) {
  let x0 = img.width, y0 = img.height, x1 = 0, y1 = 0;
  const d = img.data;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (d[(y * img.width + x) * 4 + 3] < 2) continue;
      if (x < x0) x0 = x; if (x >= x1) x1 = x + 1;
      if (y < y0) y0 = y; if (y >= y1) y1 = y + 1;
    }
  }
  return x1 > x0 ? [x0, y0, x1 - x0, y1 - y0] : [0, 0, 1, 1];
}
function cropCanvas(src, [x, y, w, h]) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(src, x, y, w, h, 0, 0, w, h);
  return c;
}

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
const TONE = toneFor(params);
renderer.toneMapping = TONE.mapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// The live tank's camera at rest (main.js), framed on the strip the Roku shows (view.js).
function liveCamera() {
  const camera = new THREE.PerspectiveCamera(40, SCREEN.w / SCREEN.h, 0.1, 120);
  camera.position.set(0, 4.6, 15);
  camera.lookAt(0, 3.9, 0);
  camera.updateMatrixWorld();
  setStrip(camera, SCREEN.w, SCREEN.h, VIEW);
  return camera;
}
// The live lights at full daylight: main.js's light rig puts the sun at 2.6 x 1 + 0.05, and lowers the
// ambient water light to 0.75 against the reef light.
const SUN = LIGHTS.sun + 0.05, AMBIENT = params.get('reeflight') !== '0' ? LIGHTS.ambient : 1;
const EXPOSURE = 1.25 * TONE.gain;   // main.js applyLight at full daylight

// ---------- fish sprites ----------

// Lit as the live tank lights a fish in open water, and seen through the same water: the medium
// (absorption by depth and path, inscatter, the reef-depth white balance) works from world positions,
// so each fish is rendered where live fish mostly swim, mid-way up the window, from the live camera's
// distance.
function fishScene() {
  installUnderwaterMedium();
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(INSCATTER_DAY.clone(), 1.0);
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = LIGHTS.env * AMBIENT;
  const sun = new THREE.DirectionalLight(0xfff2dc, SUN);
  sun.position.set(...LIGHTS.sunPos);
  scene.add(sun, new THREE.HemisphereLight(new THREE.Color(0.86, 0.92, 1.0), 0x8a7458, AMBIENT));
  const cam = liveCamera();
  scene.userData.fishY = (0.25 + Math.min(9.2, windowTopY(cam) - 0.5)) / 2;
  scene.userData.eyeZ = cam.position.z;
  return scene;
}

// Pose the model for frame i of n. Every phase advances a whole number of cycles so the loop is seamless.
function pose(model, i, n, amp = 0.55) {
  const a = (i / n) * Math.PI * 2, u = model.userData.uniforms;
  u.uPhase.value = a;
  u.uAmp.value = amp;
  u.uBend.value = 0;
  u.uFinPhase.value = a * 2;
  u.uFlutter.value = 0.4;
  u.uVent.value = 0.035 * (0.5 + 0.5 * Math.sin(a));
  for (const p of model.userData.pects) {
    const s = p.userData.side;
    if (model.userData.fan) p.rotation.set(s * 0.25, s * (0.75 + 0.1 * Math.sin(a)), 0.35);
    else posePectoral(p, a * 2, 0.35 + 0.25 * Math.sin(a * 2), 0.2 + 0.25 * Math.cos(a * 2));
  }
}

async function bakeFish(sp, scene) {
  const model = buildFishModel(sp);
  model.scale.setScalar(sp.size);
  const Y = scene.userData.fishY, Z = scene.userData.eyeZ;
  model.position.set(0, Y, 0);
  scene.add(model);
  renderer.toneMappingExposure = EXPOSURE;

  // Cell big enough for every pose: length for the side view, plus the widest point seen mid-turn.
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
  const ext = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * 1.12;
  const extY = Math.max(Math.abs(box.min.y), Math.abs(box.max.y)) * 1.12;
  const cw = Math.ceil(ext * 2 * PX_PER_UNIT / 2) * 2, ch = Math.ceil(extY * 2 * PX_PER_UNIT / 2) * 2;

  const cam = new THREE.OrthographicCamera(-cw / 2 / PX_PER_UNIT, cw / 2 / PX_PER_UNIT, ch / 2 / PX_PER_UNIT, -ch / 2 / PX_PER_UNIT, 0.1, Z + 10);
  cam.position.set(0, Y, Z);
  cam.lookAt(0, Y, 0);
  renderer.setPixelRatio(1);
  renderer.setSize(cw * SS, ch * SS, false);
  renderer.setClearColor(0x000000, 0);

  // One page (bitmap) per viewing angle, holding that angle's swim cycle (FRAMES cells), so the Roku
  // can load and unload angles independently under its texture budget. Each angle's cells are cropped
  // to what that angle ever covers (a head-on fish is a third the width of a side-on one); `x, y` place
  // the crop within the full frameW x frameH cell, whose centre is the fish's origin. Cells wrap to stay
  // within MAX_SHEET.
  // An eel swims at full amplitude whatever its speed, and its wave is sideways, so it is shown further
  // round towards the camera or the S of the body barely shows from the side.
  const eel = sp.swim?.mode === 'anguilliform', amp = eel ? 0.9 : 0.55;
  const yaws = Array.from({ length: YAWS }, (_, r) => -90 + (180 * r) / (YAWS - 1));
  const shot = document.createElement('canvas');
  shot.width = cw; shot.height = ch;
  const sg = shot.getContext('2d', { willReadFrequently: true });
  sg.imageSmoothingQuality = 'high';
  const angles = [];
  for (let r = 0; r < YAWS; r++) {
    const cells = [];
    let x0 = cw, y0 = ch, x1 = 0, y1 = 0;
    for (let i = 0; i < FRAMES; i++) {
      pose(model, i, FRAMES, amp);
      model.rotation.y = -yaws[r] * Math.PI / 180;   // +90: head-on, -90: tail-on
      renderer.render(scene, cam);
      sg.clearRect(0, 0, cw, ch);
      sg.drawImage(renderer.domElement, 0, 0, cw, ch);
      const img = sg.getImageData(0, 0, cw, ch), [bx, by, bw, bh] = alphaBox(img);
      x0 = Math.min(x0, bx); y0 = Math.min(y0, by); x1 = Math.max(x1, bx + bw); y1 = Math.max(y1, by + bh);
      cells.push(img);
    }
    // One clear pixel of margin so bilinear scaling on the Roku doesn't pick up a neighbour.
    x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(cw, x1 + 1); y1 = Math.min(ch, y1 + 1);
    const w = x1 - x0, h = y1 - y0, cols = Math.max(1, Math.min(FRAMES, Math.floor(MAX_SHEET / w)));
    const sheet = document.createElement('canvas');
    sheet.width = w * cols; sheet.height = h * Math.ceil(FRAMES / cols);
    const g = sheet.getContext('2d');
    cells.forEach((img, i) => g.putImageData(img, (i % cols) * w - x0, Math.floor(i / cols) * h - y0, x0, y0, w, h));
    const path = `fish/${sp.id}-a${r}.png`;
    await save(path, await toBlob(sheet, 'image/png'));
    document.getElementById('sheets').appendChild(sheet);
    angles.push({ yaw: yaws[r], sheet: path, x: x0, y: y0, w, h, cols, mb: +((sheet.width * sheet.height * 4) / 1e6).toFixed(2) });
  }
  scene.remove(model);

  const { maxSpeed, zone, school, grazer, territorial, boldness, curiosity, activity, host, prey, shy, predator, nocturnal, lurker } = sp.brain;
  return {
    name: sp.name, sci: sp.sci, fact: sp.fact, count: sp.count,
    frameW: cw, frameH: ch, frames: FRAMES, angles,
    // Decoded RGBA (4 bytes a pixel), what the Roku holds in texture memory with every angle loaded.
    textureMB: +angles.reduce((s, a) => s + a.mb, 0).toFixed(1),
    cruiseYaw: +((eel ? 0.6 : CRUISE_YAW) * 180 / Math.PI).toFixed(1),
    turnRate: +(sp.swim.hoverTurn * 180 / Math.PI).toFixed(0),   // deg/s, pectoral-sculling turn at low speed
    lengthPx: Math.round(size.x * PX_PER_UNIT),
    ...(eel && { tailHz: sp.brain.tailHz }),   // eels beat far slower than the player's default rate
    brain: { maxSpeed, zone, school, grazer, territorial, boldness, curiosity, activity, host: !!host, prey: !!prey, shy: shy || 0, predator: !!predator && !lurker, nocturnal: !!nocturnal },
  };
}

// ---------- scenery ----------

// Mirrors main.js at full daylight with the camera at rest, so the Roku backdrop matches the PC view.
async function bakeScenery(scenery, seed) {
  installUnderwaterMedium();
  const aspect = SCREEN.w / SCREEN.h;
  const TANK_W = Math.min(30, Math.max(16, 8.6 * aspect + 1.5));
  const scene = new THREE.Scene();
  const backdrop = makeWaterBackdrop();
  scene.add(backdrop);
  scene.fog = new THREE.FogExp2(INSCATTER_DAY.clone(), 1.0);
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = 0.35;
  backdrop.material.uniforms.uBase.value.copy(scene.fog.color);
  const camera = liveCamera();   // framed on the whole strip the zoomed window shows

  const sun = new THREE.DirectionalLight(0xfff2dc, SUN);
  sun.position.set(...LIGHTS.sunPos);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -TANK_W * 0.75; sc.right = TANK_W * 0.75; sc.top = 9; sc.bottom = -9; sc.near = 5; sc.far = 40;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 4;
  const hemi = new THREE.HemisphereLight(new THREE.Color(0.86, 0.92, 1.0), 0x8a7458, 1.0);
  scene.add(sun, hemi);
  // Generated rocks and corals (pc/models/scenery.json), as in main.js; missing ones stay procedural.
  const reef = buildReef(scene, TANK_W, seed, await loadScenery(), camera.position);
  // The PC tank's reef light (reefLight.js), with the same inputs as main.js at full daylight: soft sun
  // shadows, ambient occlusion and coloured bounce light ray cast once, with the ambient water light
  // lowered against it as main.js does. (main.js's live screen-space AO shades fish against the reef;
  // the Roku's fish are sprites drawn over this, so it has nothing to add here.)
  if (params.get('reeflight') !== '0') {
    bakeReefLight(renderer, reef, {
      sun: { dir: sun.position.clone(), irr: sun.color.clone().multiplyScalar(sun.intensity), cone: 0.1 },
      sky: new THREE.Color(0.86, 0.92, 1.0).multiplyScalar(LIGHTS.ambient), ground: hemi.groundColor.clone().multiplyScalar(LIGHTS.ambient),
      camera,
    });
  }
  hemi.intensity = AMBIENT;
  scene.environmentIntensity = LIGHTS.env * AMBIENT;
  const surface = makeSurface(TANK_W);
  scene.add(surface);
  waterUniforms.uCaustic.value = 1;
  waterUniforms.uTime.value = 0;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMappingExposure = EXPOSURE;
  // Supersampled like the fish: the headless GPU's MSAA leaves about a quarter of the reef's outline
  // pixels hard-stepped, so the strip is rendered at SS x and filtered down when it is read back.
  renderer.setPixelRatio(1);
  renderer.setSize(STRIP.w * SS, STRIP.h * SS, false);

  // Marine snow as in main.js, carried by the pump current (world.js). It moves, so it lives only in
  // the water loop, never the static layers; two copies (the same particles) are simulated forward to
  // the two moments each loop frame blends, t and t + loop length.
  const swim = { x0: -TANK_W / 2 + 0.9, x1: TANK_W / 2 - 0.9, y0: 0.25, y1: Math.min(9.2, windowTopY(camera) - 0.5), z0: -3.0, z1: 2.7 };
  const world = new World(scene, reef, swim, mulberry32(seed));
  const flow = (p, o) => world.flow(p, o);
  const snowSims = [0, 1].map(() => ({ s: new MarineSnow(scene, TANK_W * 1.4, mulberry32(seed * 101 + 3)), t: 0 }));
  const snow = {
    at(k, t) {
      const sim = snowSims[k];
      for (; sim.t < t - 1e-6; sim.t += 1 / 30) { world.time = sim.t; sim.s.update(Math.min(1 / 30, t - sim.t), sim.t, flow); }
      snowSims.forEach((o, i) => { o.s.points.visible = i === k; });
    },
    off() { for (const o of snowSims) o.s.points.visible = false; },
  };
  snow.off();
  renderer.setClearColor(0x000000, 1);

  // The same simulated caustics and light shafts as the PC tank, frozen at one moment of the waves.
  setSunDirection(sun.position);
  updateWaves(CAUSTIC_T);
  const caustics = new Caustics(renderer);
  caustics.update();
  const waterRenderer = new WaterRenderer(renderer);

  const key = `${scenery}-${seed}`;
  const out = document.createElement('canvas');
  out.width = STRIP.w; out.height = STRIP.h;
  const g = out.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingQuality = 'high';
  waterRenderer.render(scene, camera, sun);
  g.drawImage(renderer.domElement, 0, 0, STRIP.w, STRIP.h);
  // The strip is cut into TILE-wide columns, so the Roku holds only those in view as the window pans.
  const backTiles = [];
  for (let x = 0, n = 0; x < STRIP.w; x += TILE, n++) {
    const rect = [x, 0, Math.min(TILE, STRIP.w - x), STRIP.h], file = `scenery/${key}-${n}.jpg`;
    await save(file, await toBlob(cropCanvas(out, rect), 'image/jpeg', 0.9));
    backTiles.push({ file, rect });
  }

  // Foreground: only reef meshes near the glass, on a transparent background. Rendered without the
  // shaft pass (which is opaque); the reef keeps its caustic lighting so it matches the backdrop.
  const FG_Z = 1.0, hidden = [];
  scene.traverse((o) => {
    if (!o.isMesh && !o.isInstancedMesh) return;
    const inReef = !!reef.group.getObjectById(o.id);
    const sand = o.userData.noHeight && o.geometry.type === 'PlaneGeometry';
    if (!inReef || sand || o.getWorldPosition(new THREE.Vector3()).z < FG_Z) hidden.push(o);
  });
  const showFgOnly = (on) => { for (const o of hidden) o.visible = !on; };
  showFgOnly(true);
  renderer.setClearColor(0x000000, 0);
  renderer.render(scene, camera);
  g.clearRect(0, 0, STRIP.w, STRIP.h);
  g.drawImage(renderer.domElement, 0, 0, STRIP.w, STRIP.h);
  // Columns like the backdrop's, each cropped to the pixels that hold reef: texture memory goes by
  // bitmap size (4 bytes a pixel), so empty layer costs as much as reef.
  const fgTiles = [];
  for (let x = 0, n = 0; x < STRIP.w; x += TILE, n++) {
    const w = Math.min(TILE, STRIP.w - x), [bx, by, bw, bh] = alphaBox(g.getImageData(x, 0, w, STRIP.h));
    if (bw <= 1) continue;
    const rect = [x + bx, by, bw, bh], file = `scenery/${key}-fg-${n}.png`;
    await save(file, await toBlob(cropCanvas(out, rect), 'image/png'));
    fgTiles.push({ file, rect });
  }
  showFgOnly(false);
  const water = await bakeWater(key, scene, camera, sun, waterRenderer, caustics, showFgOnly, snow);
  renderer.shadowMap.enabled = false;
  // Sprites must not carry a frozen caustic pattern (fish move through it on the Roku).
  causticUniforms.uCauOn.value = 0;
  reefLightUniforms.uRLOn.value = 0;   // nor this reef's light

  // Screen-space helpers for the Roku's 2D brains: reef top line at mid depth, anemone, swim box.
  const project = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [Math.round((v.x + 1) / 2 * STRIP.w), Math.round((1 - v.y) / 2 * STRIP.h)];
  };
  const floor = [];
  for (let i = 0; i <= 64; i++) {
    const sx = i / 64, ndc = new THREE.Vector3(sx * 2 - 1, 0, 0.5).unproject(camera);
    // March along the view ray to z = 0 to find the world x under this screen column.
    const dir = ndc.sub(camera.position).normalize(), t = -camera.position.z / dir.z;
    const x = camera.position.x + dir.x * t;
    floor.push(project(x, reef.heightAt(x, 0), 0)[1]);
  }
  const an = reef.anemones[0].pos;
  // As main.js: fish stay below the top of the zoomed window.
  const bounds = swim;
  const tl = project(bounds.x0, bounds.y1, 0), br = project(bounds.x1, bounds.y0, 0);
  // The airstone, for the player's bubble column: where it is, how far up the bubbles go (the surface,
  // usually above the strip) and the scale at its depth.
  const bo = reef.bubbler, bp = bo && project(bo.x, bo.y, bo.z);
  const bubbler = bo ? { pos: bp, top: project(bo.x, SURFACE_Y, bo.z)[1], pxPerUnit: Math.abs(project(bo.x + 1, bo.y, bo.z)[0] - bp[0]) } : null;
  return {
    key,
    entry: {
      scenery, seed, backdrop: backTiles, foreground: fgTiles, water,
      floor, anemone: project(an.x, an.y, an.z), swimBox: [tl[0], tl[1], br[0], br[1]], bubbler,
      // Where fish hide (reef.js shelters): screen position, and kind ('ledge' or the shoal's 'coral').
      shelters: (reef.shelters || []).map((s) => ({ pos: project(s.pos.x, s.pos.y, s.pos.z), kind: s.kind })),
    },
  };
}

// ---------- moving water ----------
//
// The Roku can't simulate the surface, so the moving water (caustics on sand and reef, light shafts,
// surface ripples, swaying soft corals) is baked as a short loop. Each frame is an overlay that, drawn
// over the static backdrop with plain alpha blending, turns it into that moment of the water:
// per pixel the smallest alpha a and colour C with B(1 - a) + C a = F. Only pixels that change carry
// alpha, so the frames crop and compress well. The waves never repeat, so the loop is a crossfade:
// frame s shows (s/T) F(s) + (1 - s/T) F(s + T), which starts and ends on F(T) (blended about the
// loop's mean, so the contrast holds through the fade).
// A second overlay set covers the foreground reef layer and is drawn over it.

// Overlay that takes base B to target F (both RGBA bytes); mask (0-255 per pixel) limits it. Grows box.
function encodeOverlay(F, B, mask, box, w) {
  const out = new Uint8ClampedArray(F.length);
  for (let p = 0, i = 0; i < F.length; p++, i += 4) {
    const m = mask ? mask[p] : 255;
    if (m < 8) continue;
    let a = 0, big = 0;
    for (let c = 0; c < 3; c++) {
      const d = F[i + c] - B[i + c];
      big = Math.max(big, Math.abs(d));
      a = Math.max(a, d > 0 ? d / Math.max(1, 255 - B[i + c]) : -d / Math.max(1, B[i + c]));
    }
    if (big <= 2) continue;   // below 8-bit noise: leave the backdrop alone
    const a8 = Math.min(255, Math.ceil(a * 255)), aa = a8 / 255;
    for (let c = 0; c < 3; c++) out[i + c] = Math.round(B[i + c] + (F[i + c] - B[i + c]) / aa);
    out[i + 3] = Math.round(a8 * m / 255);
    const x = p % w, y = (p / w) | 0;
    box.x0 = Math.min(box.x0, x); box.y0 = Math.min(box.y0, y); box.x1 = Math.max(box.x1, x + 1); box.y1 = Math.max(box.y1, y + 1);
  }
  return out;
}

async function bakeWater(key, scene, camera, sun, waterRenderer, caustics, showFgOnly, snow) {
  const W = STRIP.w / WATER_SCALE, H = STRIP.h / WATER_SCALE;
  renderer.setSize(W * SS, H * SS, false);   // supersampled as the static layers
  const grab = document.createElement('canvas');
  grab.width = W; grab.height = H;
  const gg = grab.getContext('2d', { willReadFrequently: true });
  gg.imageSmoothingQuality = 'high';
  const read = () => { gg.clearRect(0, 0, W, H); gg.drawImage(renderer.domElement, 0, 0, W, H); return gg.getImageData(0, 0, W, H).data; };
  const setTime = (t, waves = t) => { waterUniforms.uTime.value = t; updateWaves(waves); caustics.update(); };
  const back = () => { renderer.setClearColor(0x000000, 1); waterRenderer.render(scene, camera, sun); return read(); };
  const front = () => { showFgOnly(true); renderer.setClearColor(0x000000, 0); renderer.render(scene, camera); const d = read(); showFgOnly(false); return d; };
  // A plain crossfade of two unrelated caustic patterns halves their contrast mid-loop (the light
  // pulses dim and bright once a loop): blend the offsets from each pixel's mean over the loop instead,
  // scaled to the contrast of one pattern. The two patterns aren't quite unrelated, so the scale is
  // measured per frame (rms offset from the mean, matched to the average of the single shots, `rms`).
  const rmsOff = (d, M) => { let s = 0; for (let i = 0; i < d.length; i++) s += (d[i] - M[i]) ** 2; return Math.sqrt(s / d.length); };
  const mix = (a, b, w, M, rms) => {
    const o = new Float32Array(a.length);
    for (let i = 0; i < a.length; i++) o[i] = (a[i] - M[i]) * w + (b[i] - M[i]) * (1 - w);
    let s = 0;
    for (let i = 0; i < o.length; i++) s += o[i] * o[i];
    const k = rms / Math.max(1e-6, Math.sqrt(s / o.length)), out = new Uint8ClampedArray(a.length);
    for (let i = 0; i < a.length; i++) out[i] = M[i] + o[i] * k;
    return out;
  };
  // What the screen shows after drawing overlay O over base B (RGBA bytes; the result is opaque).
  const composite = (B, O) => {
    const out = new Uint8ClampedArray(B.length);
    for (let i = 0; i < B.length; i += 4) {
      const a = O[i + 3] / 255;
      for (let c = 0; c < 3; c++) out[i + c] = B[i + c] * (1 - a) + O[i + c] * a;
      out[i + 3] = 255;
    }
    return out;
  };
  const meanOf = (list) => {
    const M = new Float32Array(list[0].length);
    for (const d of list) for (let i = 0; i < M.length; i++) M[i] += d[i];
    for (let i = 0; i < M.length; i++) M[i] /= list.length;
    return M;
  };

  // Bases: the backdrop and foreground exactly as baked above, at loop resolution.
  setTime(0, CAUSTIC_T);
  snow.off();   // the bases match the static layers, which have no snow
  const B = back(), G = front();
  const fgA = new Uint8ClampedArray(W * H), backMask = new Uint8ClampedArray(W * H);
  for (let p = 0; p < W * H; p++) { fgA[p] = G[p * 4 + 3]; backMask[p] = 255 - fgA[p]; }

  const boxes = [{ x0: W, y0: H, x1: 0, y1: 0 }, { x0: W, y0: H, x1: 0, y1: 0 }], frames = [], shots = [];
  for (let i = 0; i < WATER_FRAMES; i++) {
    const t0 = CAUSTIC_T + (i / WATER_FRAMES) * WATER_LOOP, t1 = t0 + WATER_LOOP;
    // Snow shows in the backdrop layer's frames (the foreground layer covers only the near reef).
    setTime(t0); snow.at(0, t0); const b0 = back(); snow.off(); const f0 = front();
    setTime(t1); snow.at(1, t1); const b1 = back(); snow.off(); const f1 = front();
    shots.push({ b0, f0, b1, f1 });
    log(`water ${key}: frame ${i + 1}/${WATER_FRAMES}`);
  }
  const MB = meanOf(shots.flatMap((s) => [s.b0, s.b1])), MF = meanOf(shots.flatMap((s) => [s.f0, s.f1]));
  const avg = (list, M) => list.reduce((s, d) => s + rmsOff(d, M), 0) / list.length;
  const rmsB = avg(shots.flatMap((s) => [s.b0, s.b1]), MB), rmsF = avg(shots.flatMap((s) => [s.f0, s.f1]), MF);
  const targets = shots.map(({ b0, f0, b1, f1 }, i) => {
    const w = i / WATER_FRAMES;
    return [mix(b0, b1, w, MB, rmsB), mix(f0, f1, w, MF, rmsF)];
  });
  shots.length = 0;   // ~8 MB a frame; the overlays below need as much again
  // Each step has two overlays: the frame itself (over the static base), and a step overlay that takes
  // what is then on screen to the next frame. The Roku draws the frame, then the step at opacity t;
  // because the step was encoded against exactly that screen, the result is the linear blend
  // (1 - t) frame + t next for every t. Fading one partly transparent frame over another instead shows
  // both caustic networks at once and brightens through each step (a pulse at the loop's frame rate).
  const bases = [[B, backMask], [G, fgA]];
  for (let i = 0; i < WATER_FRAMES; i++) {
    frames.push([0, 1].map((l) => {
      const [base, mask] = bases[l], O = encodeOverlay(targets[i][l], base, mask, boxes[l], W);
      const D = encodeOverlay(targets[(i + 1) % WATER_FRAMES][l], composite(base, O), mask, boxes[l], W);
      return [O, D];
    }));
  }
  setTime(0, CAUSTIC_T);

  // Crop every frame of a layer to the area that ever changes, and save.
  const layers = ['', '-fg'].map((suffix, l) => {
    const b = boxes[l];
    if (b.x1 <= b.x0) return null;
    const cw = b.x1 - b.x0, ch = b.y1 - b.y0, c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    return { suffix, b, c, files: [], steps: [], rect: [b.x0, b.y0, cw, ch].map((v) => v * WATER_SCALE) };
  });
  for (let i = 0; i < frames.length; i++) {
    for (let l = 0; l < 2; l++) {
      const L = layers[l];
      if (!L) continue;
      for (const [d, kind, list] of [[0, '', L.files], [1, 'step-', L.steps]]) {
        const full = new ImageData(frames[i][l][d], W, H), cg = L.c.getContext('2d');
        cg.clearRect(0, 0, L.c.width, L.c.height);
        cg.putImageData(full, -L.b.x0, -L.b.y0, L.b.x0, L.b.y0, L.c.width, L.c.height);
        const file = `scenery/${key}-water${L.suffix}-${kind}${String(i).padStart(2, '0')}.png`;
        await save(file, await toBlob(L.c, 'image/png'));
        list.push(file);
      }
    }
  }
  renderer.setSize(STRIP.w * SS, STRIP.h * SS, false);
  const layer =(L) => L && { rect: L.rect, frames: L.files, steps: L.steps };
  return { fps: WATER_FRAMES / WATER_LOOP, scale: WATER_SCALE, back: layer(layers[0]), front: layer(layers[1]) };
}

// ---------- bubbles ----------

// Bubble sprites: the live bubble shader (water.js Bubbles) on single bubbles of a few sizes, flattened
// as they are live (aspect 1 + 0.16 d[mm]), for the Roku player to send up the airstone's column with
// the same rise speed.
const BUBBLE_MM = [1.5, 2.5, 3.5, 5];
async function bakeBubbles(scene) {
  const b = new Bubbles(scene, new THREE.Vector3(), mulberry32(5));
  b.mesh.count = 1;
  const px = PX_PER_UNIT * 1.15;   // a little over mid-depth scale, for bubbles nearer the glass
  const cell = Math.ceil((BUBBLE_MM[BUBBLE_MM.length - 1] / 1000 / 0.125) * px * 1.3) + 4;
  const cam = new THREE.OrthographicCamera(-cell / 2 / px, cell / 2 / px, cell / 2 / px, -cell / 2 / px, 0.1, 20);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  renderer.setPixelRatio(1);
  renderer.setSize(cell * SS, cell * SS, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMappingExposure = EXPOSURE;
  const sheet = document.createElement('canvas');
  sheet.width = cell * BUBBLE_MM.length; sheet.height = cell;
  const g = sheet.getContext('2d');
  BUBBLE_MM.forEach((mm, i) => {
    const r = mm / 2000 / 0.125, aspect = 1 + 0.16 * Math.max(0, mm - 1);
    b.mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(r * Math.cbrt(aspect), r / Math.pow(aspect, 2 / 3), r * Math.cbrt(aspect)));
    b.mesh.instanceMatrix.needsUpdate = true;
    renderer.render(scene, cam);
    g.drawImage(renderer.domElement, i * cell, 0, cell, cell);
  });
  scene.remove(b.mesh);
  await save('fish/bubbles.png', await toBlob(sheet, 'image/png'));
  return { sheet: 'fish/bubbles.png', cell, mm: BUBBLE_MM, pxPerUnit: +px.toFixed(1) };
}

// ---------- run ----------

async function run() {
  const t0 = performance.now();
  const manifest = { version: 1, generated: new Date().toISOString(), screen: SCREEN, view: { zoom: VIEW.zoom, pan: VIEW.pan, period: PAN_PERIOD, strip: STRIP }, pxPerUnit: PX_PER_UNIT, species: {}, scenery: {} };
  const custom = await loadCustomModels(species);
  if (custom.length) log(`custom models: ${custom.join(', ')}`);

  const fs = fishScene();
  for (const sp of species) {
    manifest.species[sp.id] = await bakeFish(sp, fs);
    log(`fish ${sp.id}: ${manifest.species[sp.id].frameW}x${manifest.species[sp.id].frameH} x ${YAWS} angles x ${FRAMES}, ${manifest.species[sp.id].textureMB} MB`);
  }
  manifest.bubbles = await bakeBubbles(fs);
  for (const scenery of SCENERY) {
    for (const seed of seeds) {
      const { key, entry } = await bakeScenery(scenery, seed);
      manifest.scenery[key] = entry;
      log(`scenery ${key}`);
    }
  }
  await save('manifest.json', JSON.stringify(manifest, null, 2));
  const summary = `baked ${species.length} fish, ${Object.keys(manifest.scenery).length} scenery in ${((performance.now() - t0) / 1000).toFixed(1)}s`;
  log(summary);
  await fetch('/__done', { method: 'POST', body: summary });
}

run().catch(async (e) => {
  log('FAILED: ' + (e.stack || e));
  await fetch('/__done', { method: 'POST', body: 'FAILED: ' + e.message });
});
