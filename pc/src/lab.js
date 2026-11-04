// Fish lab: inspect one species (or all of them) up close under the tank's lighting and water.
// URL: lab.html?sp=clownfish&yaw=30&swim=0   or   lab.html?sp=all
import * as THREE from 'three';
import { SPECIES } from './species.js';
import { buildFishModel, loadCustomModels } from './fishModel.js';
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
const sun = new THREE.DirectionalLight(0xfff2dc, 2.6);
sun.position.set(3, 22, 7);
scene.add(sun, sun.target);
const hemi = new THREE.HemisphereLight(0xdcecff, 0x8a7458, 1.0);
scene.add(hemi);

const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 120);
const CENTRE = new THREE.Vector3(0, 5, 2.2);   // just behind the front glass, mid-water
await loadCustomModels(SPECIES);

// compare=1: procedural fish (left) next to its generated model in pc/models/fish/<id>.glb (right).
const generated = new Map();
async function generatedModel(id) {
  if (!generated.has(id)) generated.set(id, await loadFishModel(`./models/fish/${id}.glb`).catch(() => null));
  return generated.get(id);
}

let fish = [], yaw = Number(params.get('yaw') || 0), spin = params.get('spin') === '1', swim = params.get('swim') !== '0';
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
    scene.add(m);
    return m;
  });
  const span = list.length === 1 ? list[0].size * 1.5 : cols * 1.3;
  camera.position.copy(CENTRE).add(new THREE.Vector3(0, 0, span / (2 * Math.tan(THREE.MathUtils.degToRad(15))) * 0.9));
  camera.lookAt(CENTRE);
}

const sel = $('sp');
for (const s of [{ id: 'all', name: 'All species' }, ...SPECIES]) sel.add(new Option(s.name, s.id));
sel.value = params.get('sp') || 'clownfish';
sel.onchange = () => show(sel.value);
$('swim').checked = swim; $('swim').onchange = (e) => (swim = e.target.checked);
$('spin').checked = spin; $('spin').onchange = (e) => (spin = e.target.checked);
$('yaw').value = yaw; $('yaw').oninput = (e) => (yaw = Number(e.target.value));
const setLight = (l) => {
  sun.intensity = 2.6 * l + 0.05; hemi.intensity = 0.12 + 0.88 * l; waterUniforms.uCaustic.value = l;
  scene.fog.color.copy(INSCATTER_DAY).multiplyScalar(0.06 + 0.94 * l);
  backdrop.material.uniforms.uBase.value.copy(scene.fog.color);
  renderer.toneMappingExposure = 1.25 * (0.45 + 0.55 * l);
};
$('light').oninput = (e) => setLight(e.target.value / 100);
setLight(1);
show(sel.value);

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
  waterUniforms.uTi