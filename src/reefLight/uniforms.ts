// The baked reef light's live uniforms, shared by every lit material (water/materials.ts addCaustics).
// The baked maps are texture arrays (one unit each in every lit material, instead of one per map: the
// fish shaders are at the GPU's 16 units with the caustics and their own maps).
import * as THREE from 'three';

const RGBA_BYTES = 4;
const WHITE = 255;
const GRID_LAYERS = 3;
const SCREEN_LAYERS = 2;
const DEFAULT_CELL = 0.1;

function whiteTexture(): THREE.DataTexture {
  const texture = new THREE.DataTexture(new Uint8Array([WHITE, WHITE, WHITE, WHITE]), 1, 1);
  texture.needsUpdate = true;
  return texture;
}

function whiteArray(layers: number): THREE.DataArrayTexture {
  const texture = new THREE.DataArrayTexture(new Uint8Array(RGBA_BYTES * layers).fill(WHITE), 1, 1, layers);
  texture.needsUpdate = true;
  return texture;
}

/** A 1x1 white texture: the neutral stand-in for a map not baked yet. */
export const WHITE_TEXTURE = whiteTexture();

export interface ReefLightUniforms {
  /** Grid, by layer: 0 sky visibility SH (open fraction, mean open direction), 1 bounce luminance SH,
   *  2 bounce colour (rgb) and sun visibility (a). */
  uRLGrid: THREE.IUniform<THREE.Texture>;
  uRLMin: THREE.IUniform<THREE.Vector3>;
  uRLSize: THREE.IUniform<THREE.Vector3>;
  uRLRes: THREE.IUniform<THREE.Vector3>;
  uRLTiles: THREE.IUniform<number>;
  uRLCell: THREE.IUniform<number>;
  uRLOn: THREE.IUniform<number>;
  /** Light level (bounce was baked at full daylight). */
  uRLLight: THREE.IUniform<number>;
  uRLSunDir: THREE.IUniform<THREE.Vector3>;
  /** Screen, by layer: 0 bounce (rgb) and sky visibility (a), 1 sun visibility (r) and distance from the bake eye (g). */
  uRLScr: THREE.IUniform<THREE.Texture>;
  uRLScrVP: THREE.IUniform<THREE.Matrix4>;
  uRLScrEye: THREE.IUniform<THREE.Vector3>;
  uRLScrOn: THREE.IUniform<number>;
  uRLAO: THREE.IUniform<THREE.Texture>;
  uRLAOInv: THREE.IUniform<THREE.Vector2>;
  uRLAOOn: THREE.IUniform<number>;
  uRLDebug: THREE.IUniform<number>;
}

export const reefLightUniforms: ReefLightUniforms = {
  uRLGrid: { value: whiteArray(GRID_LAYERS) },
  uRLMin: { value: new THREE.Vector3() },
  uRLSize: { value: new THREE.Vector3(1, 1, 1) },
  uRLRes: { value: new THREE.Vector3(1, 1, 1) },
  uRLTiles: { value: 1 },
  uRLCell: { value: DEFAULT_CELL },
  uRLOn: { value: 0 },
  uRLLight: { value: 1 },
  uRLSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uRLScr: { value: whiteArray(SCREEN_LAYERS) },
  uRLScrVP: { value: new THREE.Matrix4() },
  uRLScrEye: { value: new THREE.Vector3() },
  uRLScrOn: { value: 0 },
  uRLAO: { value: WHITE_TEXTURE },
  uRLAOInv: { value: new THREE.Vector2(1, 1) },
  uRLAOOn: { value: 0 },
  uRLDebug: { value: 0 },
};

/** Marks a texture as owned by the reef light (a re-bake or cache load may dispose it). */
export function markReefLightOwned(texture: THREE.Texture): void {
  texture.userData['rl'] = true;
}

/** Replaces a baked map, disposing the previous one if the reef light made it. */
export function replaceMap(uniform: THREE.IUniform<THREE.Texture>, texture: THREE.Texture): void {
  const previous = uniform.value;
  uniform.value = texture;
  if (previous.userData['rl'] === true) previous.dispose();
}
