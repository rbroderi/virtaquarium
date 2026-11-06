// Bubble sprites: the live bubble shader (water Bubbles) on single bubbles of a few sizes, flattened as
// they are live (aspect 1 + 0.16 d[mm]), for the Roku player to send up the airstone's column with the
// same rise speed.
import * as THREE from 'three';
import { Bubbles } from '../water.js';
import { context2d, mulberry32 } from '../util.js';
import { SUPERSAMPLE, type BakeConfig } from './config.js';
import { blankCanvas, saveAsset, toBlob } from './io.js';
import type { BubblesEntry } from './manifest.js';

export const BUBBLE_MM = [1.5, 2.5, 3.5, 5] as const;
const BUBBLE_SEED = 5;
/** A little over mid-depth scale, for bubbles nearer the glass. */
const NEAR_GLASS_SCALE = 1.15;
const MM_PER_METRE = 1000;
const METRES_PER_UNIT = 0.125;   // 12.5 cm per world unit
const CELL_HEADROOM = 1.3, CELL_PADDING_PX = 4;
/** Flattening per mm of diameter above 1 mm. */
const FLATTEN_PER_MM = 0.16;
const CAMERA_Z = 10, CAMERA_NEAR = 0.1, CAMERA_FAR = 20;
const SHEET_PATH = 'fish/bubbles.png';

export async function bakeBubbles(renderer: THREE.WebGLRenderer, config: BakeConfig, scene: THREE.Scene): Promise<BubblesEntry> {
  const bubbles = new Bubbles(scene, new THREE.Vector3(), mulberry32(BUBBLE_SEED));
  bubbles.mesh.count = 1;
  const px = config.pxPerUnit * NEAR_GLASS_SCALE;
  const largest = BUBBLE_MM[BUBBLE_MM.length - 1] ?? 0;
  const cell = Math.ceil((largest / MM_PER_METRE / METRES_PER_UNIT) * px * CELL_HEADROOM) + CELL_PADDING_PX;
  const half = cell / 2 / px;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, CAMERA_NEAR, CAMERA_FAR);
  cam.position.set(0, 0, CAMERA_Z);
  cam.lookAt(0, 0, 0);
  renderer.setPixelRatio(1);
  renderer.setSize(cell * SUPERSAMPLE, cell * SUPERSAMPLE, false);
  renderer.setClearColor(0x000000, 0);
  renderer.toneMappingExposure = config.exposure;
  const sheet = blankCanvas(cell * BUBBLE_MM.length, cell);
  const g = context2d(sheet);
  BUBBLE_MM.forEach((mm, i) => {
    const r = mm / (2 * MM_PER_METRE) / METRES_PER_UNIT, aspect = 1 + FLATTEN_PER_MM * Math.max(0, mm - 1);
    bubbles.mesh.setMatrixAt(0, new THREE.Matrix4().makeScale(r * Math.cbrt(aspect), r / Math.pow(aspect, 2 / 3), r * Math.cbrt(aspect)));
    bubbles.mesh.instanceMatrix.needsUpdate = true;
    renderer.render(scene, cam);
    g.drawImage(renderer.domElement, i * cell, 0, cell, cell);
  });
  scene.remove(bubbles.mesh);
  await saveAsset(SHEET_PATH, await toBlob(sheet, 'image/png'));
  return { sheet: SHEET_PATH, cell, mm: BUBBLE_MM, pxPerUnit: +px.toFixed(1) };
}
