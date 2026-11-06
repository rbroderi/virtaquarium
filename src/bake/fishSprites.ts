// Fish sprite sheets: each species rendered through the live tank's water and light, one page per
// viewing angle holding that angle's swim cycle, so the Roku can load and unload angles independently
// under its texture budget.
import * as THREE from 'three';
import { buildFishModel, posePectoral, posePectoralFan, mountPectoral, type FishModel } from '../fishModel.js';
import { installUnderwaterMedium, INSCATTER_DAY, makeEnvironment } from '../water.js';
import { windowTopY } from '../view.js';
import { LIGHTS } from '../rig.js';
import { context2d, requireElement, TAU } from '../util.js';
import type { Species } from '../species.js';
import { CRUISE_YAW, EEL_CRUISE_YAW, MAX_SHEET, SUPERSAMPLE, type BakeConfig } from './config.js';
import { alphaBox, blankCanvas, readbackContext, saveAsset, toBlob } from './io.js';
import { liveCamera, SKY_COLOR, GROUND_COLOR, SUN_COLOR } from './camera.js';
import type { AngleSheet, FishEntry } from './manifest.js';

/** Where live fish mostly swim: mid-way up the window (as main's bounds). */
const SWIM_FLOOR = 0.25;
const SWIM_CEILING = 9.2;
const WINDOW_TOP_MARGIN = 0.5;
/** Cell padding around the model's box so the widest mid-turn pose fits. */
const CELL_PADDING = 1.12;
const ORTHO_NEAR = 0.1;
const ORTHO_DEPTH_MARGIN = 10;
const DEG = Math.PI / 180;
const SIDE_ON_YAW_RANGE = 180;
const TAIL_ON_YAW = -90;
const AMP_FISH = 0.55;
/** An eel swims at full amplitude whatever its speed, and its wave is sideways. */
const AMP_EEL = 0.9;
const FIN_FLUTTER = 0.4;
const VENT_AMP = 0.035;
const BYTES_PER_PIXEL = 4;
const BYTES_PER_MB = 1e6;

export interface FishScene {
  readonly scene: THREE.Scene;
  readonly fishY: number;
  readonly eyeZ: number;
}

/**
 * Lit as the live tank lights a fish in open water, and seen through the same water: the medium
 * works from world positions, so each fish is rendered where live fish mostly swim, from the live
 * camera's distance.
 */
export function makeFishScene(renderer: THREE.WebGLRenderer, config: BakeConfig): FishScene {
  installUnderwaterMedium();
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(INSCATTER_DAY.clone(), 1.0);
  scene.environment = makeEnvironment(renderer);
  scene.environmentIntensity = LIGHTS.env * config.ambient;
  const sun = new THREE.DirectionalLight(SUN_COLOR, config.sun);
  sun.position.set(...LIGHTS.sunPos);
  scene.add(sun, new THREE.HemisphereLight(SKY_COLOR.clone(), GROUND_COLOR, config.ambient));
  const cam = liveCamera(config);
  const fishY = (SWIM_FLOOR + Math.min(SWIM_CEILING, windowTopY(cam) - WINDOW_TOP_MARGIN)) / 2;
  return { scene, fishY, eyeZ: cam.position.z };
}

/** Pose the model for frame i of n. Every phase advances a whole number of cycles so the loop is seamless. */
function pose(model: FishModel, i: number, n: number, amp: number): void {
  const a = (i / n) * TAU, u = model.uniforms;
  u.uPhase.value = a;
  u.uAmp.value = amp;
  u.uBend.value = 0;
  u.uFinPhase.value = a * 2;
  u.uFlutter.value = FIN_FLUTTER;
  u.uVent.value = VENT_AMP * (0.5 + 0.5 * Math.sin(a));
  for (const p of model.pects) {
    const s = p.side;
    if (model.fan) posePectoralFan(p, a + (s > 0 ? 0 : 0.3), 0.3);   // one beat per loop, so it closes
    else posePectoral(p, a * 2, 0.35 + 0.25 * Math.sin(a * 2), 0.2 + 0.25 * Math.cos(a * 2));
    mountPectoral(p, u);
  }
}

interface Cell { readonly w: number; readonly h: number }

/** Cell big enough for every pose: length for the side view, plus the widest point seen mid-turn. */
function cellFor(box: THREE.Box3, pxPerUnit: number): Cell {
  const ext = Math.max(Math.abs(box.min.x), Math.abs(box.max.x), Math.abs(box.min.z), Math.abs(box.max.z)) * CELL_PADDING;
  const extY = Math.max(Math.abs(box.min.y), Math.abs(box.max.y)) * CELL_PADDING;
  return { w: Math.ceil((ext * 2 * pxPerUnit) / 2) * 2, h: Math.ceil((extY * 2 * pxPerUnit) / 2) * 2 };
}

/** Renders one angle's swim cycle and saves it as a sheet cropped to what that angle ever covers. */
async function bakeAngle(
  ctx: { renderer: THREE.WebGLRenderer; config: BakeConfig; model: FishModel; scene: THREE.Scene; camera: THREE.Camera; shot: CanvasRenderingContext2D },
  sp: Species, cell: Cell, angleIndex: number, yawDeg: number, amp: number,
): Promise<AngleSheet> {
  const { renderer, config, model, scene, camera, shot } = ctx;
  const cells: ImageData[] = [];
  let x0 = cell.w, y0 = cell.h, x1 = 0, y1 = 0;
  for (let i = 0; i < config.frames; i++) {
    pose(model, i, config.frames, amp);
    model.rotation.y = -yawDeg * DEG;   // +90: head-on, -90: tail-on
    renderer.render(scene, camera);
    shot.clearRect(0, 0, cell.w, cell.h);
    shot.drawImage(renderer.domElement, 0, 0, cell.w, cell.h);
    const img = shot.getImageData(0, 0, cell.w, cell.h), [bx, by, bw, bh] = alphaBox(img);
    x0 = Math.min(x0, bx); y0 = Math.min(y0, by); x1 = Math.max(x1, bx + bw); y1 = Math.max(y1, by + bh);
    cells.push(img);
  }
  // One clear pixel of margin so bilinear scaling on the Roku doesn't pick up a neighbour.
  x0 = Math.max(0, x0 - 1); y0 = Math.max(0, y0 - 1); x1 = Math.min(cell.w, x1 + 1); y1 = Math.min(cell.h, y1 + 1);
  const w = x1 - x0, h = y1 - y0, cols = Math.max(1, Math.min(config.frames, Math.floor(MAX_SHEET / w)));
  const sheet = blankCanvas(w * cols, h * Math.ceil(config.frames / cols));
  const g = context2d(sheet);
  cells.forEach((img, i) => g.putImageData(img, (i % cols) * w - x0, Math.floor(i / cols) * h - y0, x0, y0, w, h));
  const path = `fish/${sp.id}-a${angleIndex}.png`;
  await saveAsset(path, await toBlob(sheet, 'image/png'));
  requireElement('sheets', HTMLDivElement).appendChild(sheet);
  return { yaw: yawDeg, sheet: path, x: x0, y: y0, w, h, cols, mb: +((sheet.width * sheet.height * BYTES_PER_PIXEL) / BYTES_PER_MB).toFixed(2) };
}

export async function bakeFish(renderer: THREE.WebGLRenderer, config: BakeConfig, sp: Species, fishScene: FishScene): Promise<FishEntry> {
  const { scene, fishY, eyeZ } = fishScene;
  const px = config.pxPerUnit;
  const model = buildFishModel(sp);
  model.scale.setScalar(sp.size);
  model.position.set(0, fishY, 0);
  scene.add(model);
  renderer.toneMappingExposure = config.exposure;

  const box = new THREE.Box3().setFromObject(model), size = box.getSize(new THREE.Vector3());
  const cell = cellFor(box, px);
  const camera = new THREE.OrthographicCamera(-cell.w / 2 / px, cell.w / 2 / px, cell.h / 2 / px, -cell.h / 2 / px, ORTHO_NEAR, eyeZ + ORTHO_DEPTH_MARGIN);
  camera.position.set(0, fishY, eyeZ);
  camera.lookAt(0, fishY, 0);
  renderer.setPixelRatio(1);
  renderer.setSize(cell.w * SUPERSAMPLE, cell.h * SUPERSAMPLE, false);
  renderer.setClearColor(0x000000, 0);

  const eel = sp.swim.mode === 'anguilliform', amp = eel ? AMP_EEL : AMP_FISH;
  const yaws = Array.from({ length: config.yaws }, (_, r) => TAIL_ON_YAW + (SIDE_ON_YAW_RANGE * r) / (config.yaws - 1));
  const shot = readbackContext(blankCanvas(cell.w, cell.h));
  const angles: AngleSheet[] = [];
  for (const [r, yaw] of yaws.entries()) {
    angles.push(await bakeAngle({ renderer, config, model, scene, camera, shot }, sp, cell, r, yaw, amp));
  }
  scene.remove(model);
  return fishEntry(sp, config, cell, angles, size.x * px, eel);
}

function fishEntry(sp: Species, config: BakeConfig, cell: Cell, angles: AngleSheet[], lengthPx: number, eel: boolean): FishEntry {
  const { maxSpeed, zone, school, grazer, territorial, boldness, curiosity, activity, host, prey, shy, predator, nocturnal, lurker } = sp.brain;
  return {
    name: sp.name, sci: sp.sci, fact: sp.fact, count: sp.count,
    frameW: cell.w, frameH: cell.h, frames: config.frames, angles,
    // Decoded RGBA (4 bytes a pixel), what the Roku holds in texture memory with every angle loaded.
    textureMB: +angles.reduce((s, a) => s + a.mb, 0).toFixed(1),
    cruiseYaw: +(((eel ? EEL_CRUISE_YAW : CRUISE_YAW) * 180) / Math.PI).toFixed(1),
    turnRate: +((sp.swim.hoverTurn * 180) / Math.PI).toFixed(0),   // deg/s, pectoral-sculling turn at low speed
    lengthPx: Math.round(lengthPx),
    ...(eel ? { tailHz: sp.brain.tailHz } : {}),   // eels beat far slower than the player's default rate
    brain: {
      maxSpeed, zone: [zone[0], zone[1]], school, grazer, territorial, boldness, curiosity, activity,
      host: !!host, prey: !!prey, shy: shy || 0, predator: !!predator && !lurker, nocturnal: !!nocturnal,
    },
  };
}
