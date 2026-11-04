// Fish lab: inspect one species (or all of them) up close under the tank's lighting and water.
// URL: lab.html?sp=clownfish&yaw=30&swim=0   or   lab.html?sp=all   or   lab.html?sp=clownfish&compare=1
import * as THREE from 'three';
import { SPECIES } from './species.js';
import { buildFishModel, loadCustomModels, loadFishModel } from './fishModel.js';
import { installReference } from './labRef.js';
import { installUnderwaterMedium, INSCATTER_DAY, makeWaterBackdrop, makeEnvironment, waterUniforms } from './water.js';

const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);
const canvas = $('lab');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;

installUnderwaterMedium();
const scene = new THREE.Scene();
const backdrop = makeWaterBackdrop();
scene.add(backdrop);
scene.fog = new THREE.FogExp2(INSCATTER_DAY.clone(), 1.0);
scene.environment = makeEnvironment(renderer);
scene.environmentIntensity = 0.35;
const CENTRE = new THREE.Vector3(0, 5, 2.2);   // just behind the front glass, mid-water
const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
sun.position.set(3, 22, 7);
sun.target.position.copy(CENTRE);
// Shadows as in the tank (main.js), on a tight box around the fish so fins shade the flank crisply.
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2, near: 1, far: 60 });
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.01; sun.shadow.radius = 3;
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xdcecff, 0x8a7458, 1.0);
scene.add(hemi);

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 120);
await loadCustomModels(SPECIES);

// compare=1: procedural fish (left) next to its generated model in pc/models/fish/<id>.glb (right).
const generated = new Map();
async function generatedModel(id) {
  if (!generated.has(id)) generated.set(id, await loadFishModel(`./models/fish/${id}.glb`).catch(() => null));
  return generated.get(id);
}

let fish = [], yaw = Number(params.get('yaw') || 0), spin = params.get('spin') === '1', swim = params.get('swim') !== '0';
let pitch = Number(params.get('pitch') || 0);   // camera elevation, degrees (positive looks down on the fish)
let compare = params.get('compare') === '1', showing = 0;
async function show(id) {
  const n = ++showing;
  const sp1 = SPECIES.find((s) => s.id === id);
  const model = compare && sp1 ? await generatedModel(id) : null;
  if (n !== showing) return;   // a newer selection won the race
  if (compare && sp1 && !model) console.warn(`No pc/models/fish/${id}.glb to compare against`);
  for (const f of fish) scene.remove(f);
  const list = id === 'all' ? SPECIES : model ? [sp1, sp1] : [sp1];
  const cols = Math.ceil(Math.sqrt(list.length * 1.4));
  fish = list.map((sp, i) => {
    const m = model ? buildFishModel(sp, i ? { model } : { procedural: true }) : buildFishModel(sp);
    // Single fish: true size. Grid: every species at the same length so they can be compared.
    const L = list.length === 1 ? sp.size : 1;
    m.scale.setScalar(L);
    const r = Math.floor(i / cols), c = i % cols, rows = Math.ceil(list.length / cols);
    m.position.copy(CENTRE).add(list.length === 1 ? new THREE.Vector3() : new THREE.Vector3((c - (cols - 1) / 2) * 1.25, ((rows - 1) / 2 - r) * 0.9, 0));
    m.userData.len = L;
    m.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });   // as in the tank (fish.js)
    scene.add(m);
    return m;
  });
  span = list.length === 1 ? list[0].size * 1.5 : cols * 1.3;
  frameCamera();
}
let span = 1;
function frameCamera() {
  camera.updateProjectionMatrix();
  camera.position.copy(CENTRE).add(new THREE.Vector3(0, 0, span / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) * 0.9));
  camera.lookAt(CENTRE);
}

const sel = $('sp');
for (const s of [{ id: 'all', name: 'All species' }, ...SPECIES]) sel.add(new Option(s.name, s.id));
sel.value = params.get('sp') || 'clownfish';
sel.onchange = () => show(sel.value);
$('swim').checked = swim; $('swim').onchange = (e) => (swim = e.target.checked);
$('spin').checked = spin; $('spin').onchange = (e) => (spin = e.target.checked);
$('compare').checked = compare; $('compare').onchange = (e) => { compare = e.target.checked; show(sel.value); };
$('yaw').value = yaw; $('yaw').oninput = (e) => (yaw = Number(e.target.value));
// Light presets: 'sun' is the tank's single key light; 'led' previews an aquarium LED bar
// (soft key from above-front plus two unshadowed fills along the bar).
const fills = [-1, 1].map((s) => { const l = new THREE.DirectionalLight(0xf4f6ff, 0); l.position.set(s * 6, 20, 6); scene.add(l); return l; });
let level = 1, preset = params.get('rig') || 'sun';
const setLight = (l = level) => {
  level = l;
  const led = preset === 'led';
  sun.intensity = (led ? 1.5 : 2.6) * l + 0.05;
  for (const f of fills) f.intensity = led ? 0.7 * l : 0;
  hemi.intensity = 0.12 + 0.88 * l; waterUniforms.uCaustic.value = l;
  scene.fog.color.copy(INSCATTER_DAY).multiplyScalar(0.06 + 0.94 * l);
  backdrop.material.uniforms.uBase.value.copy(scene.fog.color);
  renderer.toneMappingExposure = 1.25 * (0.45 + 0.55 * l);
};
// Sun direction in degrees relative to the view: az 0 = from the camera side, el 90 = straight down.
const setLightDir = (az = 23, el = 70) => {
  const a = THREE.MathUtils.degToRad(az), e = THREE.MathUtils.degToRad(el);
  sun.position.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(23).add(CENTRE);
};
setLightDir();
$('light').oninput = (e) => setLight(e.target.value / 100);
$('rig').value = preset; $('rig').onchange = (e) => { preset = e.target.value; setLight(); };
const TONE = { aces: THREE.ACESFilmicToneMapping, neutral: THREE.NeutralToneMapping, agx: THREE.AgXToneMapping, none: THREE.NoToneMapping };
const setTone = (k) => { renderer.toneMapping = TONE[k] ?? TONE.aces; for (const m of fish) m.traverse((o) => { if (o.material) [].concat(o.material).forEach((x) => (x.needsUpdate = true)); }); };
$('tone').value = params.get('tone') || 'aces'; $('tone').onchange = (e) => setTone(e.target.value);
setTone($('tone').value);
setLight(1);
await show(sel.value);

const clock = new THREE.Clock();
let t = 0;
function frame() {
  requestAnimationFrame(frame);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) {
    renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
  }
  const dt = Math.min(clock.getDelta(), 0.05);
  t += dt;
  waterUniforms.uTime.value = t;
  if (spin) yaw = ((yaw + dt * 20 + 180) % 360) - 180;
  for (const m of fish) {
    m.rotation.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0);
    const u = m.userData.uniforms;
    u.uPhase.value = swim ? t * Math.PI * 2 * 2.2 : 0;
    u.uFinPhase.value = swim ? t * Math.PI * 2 * 3 : 0;
    u.uAmp.value = swim ? 0.6 : 0;
    u.uFlutter.value = swim ? 0.6 : 0;
    for (const p of m.userData.pects) {
      const s = p.userData.side;
      p.rotation.set(0, s * (m.userData.fan ? 0.9 : 0.5 + (swim ? 0.3 * Math.sin(t * 9) : 0)), 0);
    }
  }
  renderer.render(scene, camera);
}
frame();
window.lab = {
  THREE, scene, camera, renderer, canvas, backdrop, show, fish: () => fish, species: () => sel.value,
  setYaw: (v) => { yaw = v; $('yaw').value = v; }, setPitch: (v) => (pitch = v),
  setSwim: (v) => { swim = v; $('swim').checked = v; }, setSpin: (v) => { spin = v; $('spin').checked = v; },
  setFov: (v) => { camera.fov = v; frameCamera(); }, setLight, setLightDir, setTone,
  // Render one frame now (e.g. right before reading pixels), with the pose applied.
  render: () => { for (const m of fish) m.rotation.set(THREE.MathUtils.degToRad(pitch), THREE.MathUtils.degToRad(yaw), 0); renderer.render(scene, camera); },
};
installReference(window.lab);
