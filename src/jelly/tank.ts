// The jelly tank: a backlit deep-blue void (brightest above and behind, falling off to navy at the
// edges), no reef, sand or surface in view.
import * as THREE from 'three';
import { BACKDROP_VERT, BACKDROP_FRAG } from './shaders.js';
import { makeGpuJellyBackdrop } from './webgpu.js';
import { gpuActive, tsl } from '../webgpu/tsl.js';

const BACKDROP_RADIUS = 90;
const BACKDROP_SEGMENTS = [48, 24] as const;
/** Below anything: nothing in the jelly tank stands on a floor. */
const NO_FLOOR_Y = -10;

export interface JellyBackdropUniforms {
  [name: string]: THREE.IUniform;
  uBase: { value: THREE.Color };
  uLight: { value: number };
}

/** The reef-shaped stand-in the World and main expect, with nothing in it. */
export interface JellyTank {
  readonly backdrop: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial & { uniforms: JellyBackdropUniforms }>;
  readonly group: THREE.Group;
  heightAt(x: number, z: number): number;
  readonly anemones: readonly never[];
  readonly homes: THREE.Vector3[];
  readonly caves: readonly never[];
  readonly bubbler: null;
}

export function buildJellyTank(scene: THREE.Scene): JellyTank {
  if (gpuActive()) {
    const backdrop = makeGpuJellyBackdrop(tsl());
    scene.add(backdrop);
    return {
      backdrop: backdrop as unknown as JellyTank['backdrop'],
      group: new THREE.Group(),
      heightAt: () => NO_FLOOR_Y,
      anemones: [],
      homes: [],
      caves: [],
      bubbler: null,
    };
  }
  const uniforms: JellyBackdropUniforms = { uBase: { value: new THREE.Color(1, 1, 1) }, uLight: { value: 1 } };
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false, uniforms,
    vertexShader: BACKDROP_VERT,
    fragmentShader: BACKDROP_FRAG,
  }) as THREE.ShaderMaterial & { uniforms: JellyBackdropUniforms };
  const backdrop = new THREE.Mesh(new THREE.SphereGeometry(BACKDROP_RADIUS, ...BACKDROP_SEGMENTS), mat);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  scene.add(backdrop);
  return {
    backdrop,
    group: new THREE.Group(),
    heightAt: () => NO_FLOOR_Y,
    anemones: [],
    homes: [],
    caves: [],
    bubbler: null,
  };
}
