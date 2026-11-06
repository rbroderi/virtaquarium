// The live tank's camera at rest and light colours (as main), shared by every bake stage.
import * as THREE from 'three';
import { setStrip } from '../view.js';
import { SCREEN, type BakeConfig } from './config.js';

export const SUN_COLOR = 0xfff2dc;
export const SKY_COLOR = new THREE.Color(0.86, 0.92, 1.0);
export const GROUND_COLOR = 0x8a7458;
const FOV = 40;
const NEAR = 0.1;
const FAR = 120;
export const CAMERA_POSITION = new THREE.Vector3(0, 4.6, 15);
const LOOK_AT = new THREE.Vector3(0, 3.9, 0);

/** The live tank's camera at rest (main), framed on the strip the Roku shows (view.ts). */
export function liveCamera(config: BakeConfig): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(FOV, SCREEN.w / SCREEN.h, NEAR, FAR);
  camera.position.copy(CAMERA_POSITION);
  camera.lookAt(LOOK_AT);
  camera.updateMatrixWorld();
  setStrip(camera, SCREEN.w, SCREEN.h, config.view);
  return camera;
}
