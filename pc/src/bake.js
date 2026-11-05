// Roku asset baker. Renders what the Roku channel can't (it has no WebGL) into plain images:
//   roku/assets/fish/<id>.png         sprite sheet, row 0 = swim cycle facing right, row 1 = turn right -> left
//   roku/assets/scenery/<key>.jpg     1920x1080 backdrop: water + reef, no fish
//   roku/assets/scenery/<key>-fg.png  reef pieces near the glass, drawn over fish that are behind them
//   roku/assets/manifest.json         frame sizes, anchors, per-species behaviour, reef floor line
// Open /pc/bake.html (optionally ?species=a,b&seeds=7,42&frames=12), or run `node tools/bake.mjs`.
import * as THREE from 'three';
import { SPECIES } from './species.js';
import { buildFishModel, loadCustomModels, posePectoral } from './fishModel.js';
import { buildReef, loadScenery } from './reef.js';
import {
  waterUniforms, installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, makeSurface,
  Caustics, WaterRenderer, causticUniforms, updateWaves, setSunDirection,
} from './water.js';
import { SCENERY } from './tank.js';

const params = new URLSearchParams(location.search);
const FRAMES = Number(params.get('frames') || 12);
const SS = 2;                       // supersampling factor
const SCREEN = { w: 1920, h: 1080 };
const CAUSTIC_T = 3.0;   // wave time (s) the backdrop's caustics are frozen at
const WATER_FRAMES = Number(params.get('waterFrames') || 16);   // moving-water loop: frames ...
const WATER_LOOP = Number(params.get('waterLoop') || 8);        // ... spread over this many seconds
const WATER_SCALE = 2;              // loop frames are baked at 1/2 resolution and scaled up on the Roku
const PX_PER_UNIT = 144;            // sprite resolution: ~1.25x on-screen size at 1080p, headroom for near fish
const YAW = 0.35;                   // swim-row angle towards the viewer (radians)
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

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;

// ---------- fish sprites ----------

function fishScene() {
  const scene = new THREE.Scene();
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = 0.35;
  const sun = new THREE.DirectionalLight(0xfff2dc, 2.65);
  sun.position.set(3, 22, 7);
  scene.add(sun, new THREE.HemisphereLight(new THREE.Color(0.86, 0.92, 1.0), 0x8a7458, 1.0));
  return scene;
}

// Pose the model for frame i of n. Every phase advances a whole number of cycles so the loop is seamless.
function pose(model, i, n) {
  const a = (i / n) * Math.PI * 2, u = model.userData.uniforms;
  u.uPhase.value = a;
  u.uAmp.value = 0.55;
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
  scene.add(model);

  // Cell big enough for every pose: length for the side view, plus the widest point seen mid-turn.
  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
  const ext = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * 1.12;
  const extY = Math.max(Math.abs(box.min.y), Math.abs(box.max.y)) * 1.12;
  const cw = Math.ceil(ext * 2 * PX_PER_UNIT / 2) * 2, ch = Math.ceil(extY * 2 * PX_PER_UNIT / 2) * 2;

  const cam = new THREE.OrthographicCamera(-cw / 2 / PX_PER_UNIT, cw / 2 / PX_PER_UNIT, ch / 2 / PX_PER_UNIT, -ch / 2 / PX_PER_UNIT, 0.1, 20);
  cam.position.set(0, 0, 10);
  cam.lookAt(0, 0, 0);
  renderer.setPixelRatio(1);
  renderer.setSize(cw * SS, ch * SS, false);
  renderer.setClearColor(0x000000, 0);

  const sheet = document.createElement('canvas');
  sheet.width = cw * FRAMES; sheet.height = ch * 2;
  const g = sheet.getContext('2d');
  g.imageSmoothingQuality = 'high';
  for (let row = 0; row < 2; row++) {
    for (let i = 0; i < FRAMES; i++) {
      pose(model, i, FRAMES);
      // Swim row is angled slightly towards the camera so the side-to-side tail beat reads; the turn row
      // swings through the viewer to the mirror of that pose, which the Roku gets by flipping the swim row.
      model.rotation.y = row === 0 ? -YAW : -(YAW + (i / (FRAMES - 1)) * (Math.PI - 2 * YAW));
      renderer.render(scene, cam);
      g.drawImage(renderer.domElement, i * cw, row * ch, cw, ch);
    }
  }
  scene.remove(model);
  await save(`fish/${sp.id}.png`, await toBlob(sheet, 'image/png'));
  document.getElementById('sheets').appendChild(sheet);

  const { maxSpeed, zone, school, grazer, territorial, boldness, curiosity, activity, host, prey, shy } = sp.brain;
  return {
    name: sp.name, sci: sp.sci, fact: sp.fact, count: sp.count,
    sheet: `fish/${sp.id}.png`, frameW: cw, frameH: ch, frames: FRAMES, rows: { swim: 0, turn: 1 },
    lengthPx: Math.round(size.x * PX_PER_UNIT),
    brain: { maxSpeed, zone, school, grazer, territorial, boldness, curiosity, activity, host: !!host, prey: !!prey, shy: shy || 0 },
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
  const camera = new THREE.PerspectiveCamera(40, aspect, 0.1, 120);
  camera.position.set(0, 4.6, 15);
  camera.lookAt(0, 3.9, 0);
  camera.updateMatrixWorld();

  const sun = new THREE.DirectionalLight(0xfff2dc, 2.65);
  sun.position.set(3, 22, 7);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  const sc = sun.shadow.camera;
  sc.left = -TANK_W * 0.75; sc.right = TANK_W * 0.75; sc.top = 9; sc.bottom = -9; sc.near = 5; sc.far = 40;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 4;
  scene.add(sun, new THREE.HemisphereLight(new THREE.Color(0.86, 0.92, 1.0), 0x8a7458, 1.0));
  // Generated rocks and corals (pc/models/scenery.json), as in main.js; missing ones stay procedural.
  const reef = buildReef(scene, TANK_W, seed, await loadScenery());
  const surface = makeSurface(TANK_W);
  scene.add(surface);
  waterUniforms.uCaustic.value = 1;
  waterUniforms.uTime.value = 0;

  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMappingExposure = 1.25;
  renderer.setPixelRatio(1);
  renderer.setSize(SCREEN.w, SCREEN.h, false);
  renderer.setClearColor(0x000000, 1);

  // The same simulated caustics and light shafts as the PC tank, frozen at one moment of the waves.
  setSunDirection(sun.position);
  updateWaves(CAUSTIC_T);
  const caustics = new Caustics(renderer);
  caustics.update();
  const waterRenderer = new WaterRenderer(renderer);

  const key = `${scenery}-${seed}`;
  const out = document.createElement('canvas');
  out.width = SCREEN.w; out.height = SCREEN.h;
  const g = out.getContext('2d');
  waterRenderer.render(scene, camera, sun);
  g.drawImage(renderer.domElement, 0, 0);
  await save(`scenery/${key}.jpg`, await toBlob(out, 'image/jpeg', 0.9));

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
  g.clearRect(0, 0, SCREEN.w, SCREEN.h);
  g.drawImage(renderer.domElement, 0, 0);
  await save(`scenery/${key}-fg.png`, await toBlob(out, 'image/png'));
  showFgOnly(false);
  const water = await bakeWater(key, scene, camera, sun, waterRenderer, caustics, showFgOnly);
  renderer.shadowMap.enabled = false;
  // Sprites must not carry a frozen caustic pattern (fish move through it on the Roku).
  causticUniforms.uCauOn.value = 0;

  // Screen-space helpers for the Roku's 2D brains: reef top line at mid depth, anemone, swim box.
  const project = (x, y, z) => {
    const v = new THREE.Vector3(x, y, z).project(camera);
    return [Math.round((v.x + 1) / 2 * SCREEN.w), Math.round((1 - v.y) / 2 * SCREEN.h)];
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
  const bounds = { x0: -TANK_W / 2 + 0.9, x1: TANK_W / 2 - 0.9, y0: 0.25, y1: 9.2 };
  const tl = project(bounds.x0, bounds.y1, 0), br = project(bounds.x1, bounds.y0, 0);
  return {
    key,
    entry: {
      scenery, seed, backdrop: `scenery/${key}.jpg`, foreground: `scenery/${key}-fg.png`, water,
      floor, anemone: project(an.x, an.y, an.z), swimBox: [tl[0], tl[1], br[0], br[1]],
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
// frame s shows (s/T) F(s) + (1 - s/T) F(s + T), which starts and ends on F(T).
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

async function bakeWater(key, scene, camera, sun, waterRenderer, caustics, showFgOnly) {
  const W = SCREEN.w / WATER_SCALE, H = SCREEN.h / WATER_SCALE;
  renderer.setSize(W, H, false);
  const grab = document.createElement('canvas');
  grab.width = W; grab.height = H;
  const gg = grab.getContext('2d', { willReadFrequently: true });
  const read = () => { gg.clearRect(0, 0, W, H); gg.drawImage(renderer.domElement, 0, 0); return gg.getImageData(0, 0, W, H).data; };
  const setTime = (t, waves = t) => { waterUniforms.uTime.value = t; updateWaves(waves); caustics.update(); };
  const back = () => { renderer.setClearColor(0x000000, 1); waterRenderer.render(scene, camera, sun); return read(); };
  const front = () => { showFgOnly(true); renderer.setClearColor(0x000000, 0); renderer.render(scene, camera); const d = read(); showFgOnly(false); return d; };
  const mix = (a, b, w) => { const o = new Uint8ClampedArray(a.length); for (let i = 0; i < a.length; i++) o[i] = a[i] * w + b[i] * (1 - w); return o; };

  // Bases: the backdrop and foreground exactly as baked above, at loop resolution.
  setTime(0, CAUSTIC_T);
  const B = back(), G = front();
  const fgA = new Uint8ClampedArray(W * H), backMask = new Uint8ClampedArray(W * H);
  for (let p = 0; p < W * H; p++) { fgA[p] = G[p * 4 + 3]; backMask[p] = 255 - fgA[p]; }

  const boxes = [{ x0: W, y0: H, x1: 0, y1: 0 }, { x0: W, y0: H, x1: 0, y1: 0 }], frames = [];
  for (let i = 0; i < WATER_FRAMES; i++) {
    const s = (i / WATER_FRAMES) * WATER_LOOP, w = i / WATER_FRAMES;
    const t0 = CAUSTIC_T + s, t1 = t0 + WATER_LOOP;
    setTime(t0); const b0 = back(), f0 = front();
    setTime(t1); const b1 = back(), f1 = front();
    frames.push([
      encodeOverlay(mix(b0, b1, w), B, backMask, boxes[0], W),
      encodeOverlay(mix(f0, f1, w), G, fgA, boxes[1], W),
    ]);
    log(`water ${key}: frame ${i + 1}/${WATER_FRAMES}`);
  }
  setTime(0, CAUSTIC_T);

  // Crop every frame of a layer to the area that ever changes, and save.
  const layers = ['', '-fg'].map((suffix, l) => {
    const b = boxes[l];
    if (b.x1 <= b.x0) return null;
    const cw = b.x1 - b.x0, ch = b.y1 - b.y0, c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    return { suffix, b, c, files: [], rect: [b.x0, b.y0, cw, ch].map((v) => v * WATER_SCALE) };
  });
  for (let i = 0; i < frames.length; i++) {
    for (let l = 0; l < 2; l++) {
      const L = layers[l];
      if (!L) continue;
      const full = new ImageData(frames[i][l], W, H), cg = L.c.getContext('2d');
      cg.clearRect(0, 0, L.c.width, L.c.height);
      cg.putImageData(full, -L.b.x0, -L.b.y0, L.b.x0, L.b.y0, L.c.width, L.c.height);
      const file = `scenery/${key}-water${L.suffix}-${String(i).padStart(2, '0')}.png`;
      await save(file, await toBlob(L.c, 'image/png'));
      L.files.push(file);
    }
  }
  renderer.setSize(SCREEN.w, SCREEN.h, false);
  const layer = (L) => L && { rect: L.rect, frames: L.files };
  return { fps: WATER_FRAMES / WATER_LOOP, scale: WATER_SCALE, back: layer(layers[0]), front: layer(layers[1]) };
}

// ---------- run ----------

async function run() {
  const t0 = performance.now();
  const manifest = { version: 1, generated: new Date().toISOString(), screen: SCREEN, pxPerUnit: PX_PER_UNIT, species: {}, scenery: {} };
  const custom = await loadCustomModels(species);
  if (custom.length) log(`custom models: ${custom.join(', ')}`);

  const fs = fishScene();
  for (const sp of species) {
    manifest.species[sp.id] = await bakeFish(sp, fs);
    log(`fish ${sp.id}: ${manifest.species[sp.id].frameW}x${manifest.species[sp.id].frameH} x ${FRAMES * 2}`);
  }
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
