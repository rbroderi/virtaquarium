// The PMREM environment on the WebGPU path, in TSL (the WebGL path is src/water/backdrop.ts
// makeEnvironment, a ShaderMaterial WebGPURenderer never runs). The same Snell's-window sky + inscatter
// + sand-upwelling radiance field, generated once by the common PMREM generator into a CubeUV texture
// that the standard node materials' EnvironmentNode samples directly (it is marked isPMREMTexture, so
// the node path skips re-generating it). scene.environment then feeds the fish/shell speculars' IBL.
import * as THREE from 'three';
import type { Node, ShaderNodeObject, WebGPURenderer } from 'three/webgpu';
import { tsl } from '../webgpu/tsl.js';
import { INSCATTER_DAY, SURFACE_Y } from './medium.js';

type NodeObject = ShaderNodeObject<Node>;

const ENVIRONMENT_RADIUS = 10;
const ENVIRONMENT_SEGMENTS: readonly [number, number] = [64, 32];
const ENVIRONMENT_BLUR_SIGMA = 0.02;
/** The environment's in-water path starts at a fixed depth of 5 units (backdrop.ts makeEnvironment). */
const ENVIRONMENT_DEPTH = 5.0;
/** Downwelling attenuation per unit (medium.ts metres x METRES_PER_UNIT). */
const KD_PER_UNIT = [0.45 * 0.125, 0.07 * 0.125, 0.05 * 0.125] as const;

/** Image-based ambient light for the underwater radiance field (backdrop.ts makeEnvironment, in TSL). */
export function makeGpuEnvironment(renderer: WebGPURenderer): THREE.Texture {
  const t = tsl();
  const base = t.vec3(INSCATTER_DAY.r, INSCATTER_DAY.g, INSCATTER_DAY.b);
  const kd = t.vec3(KD_PER_UNIT[0], KD_PER_UNIT[1], KD_PER_UNIT[2]);
  const surfaceY = t.float(SURFACE_Y);

  const material = new t.NodeMaterial();
  material.fragmentNode = t.Fn(() => {
    const dir = t.positionLocal.normalize() as unknown as NodeObject;   // the sphere sits at the origin
    // medium.ts uwInscatter(uBase, dir, 5.0): radiance scattered from an infinite water path.
    const up = t.smoothstep(t.float(-0.7), t.float(0.95), dir.y);
    const water = base.mul(t.float(0.45).add(t.float(1.1).mul(up).mul(up)))
      .mul(t.exp(kd.mul(t.max(t.float(0), surfaceY.sub(t.float(ENVIRONMENT_DEPTH)))).mul(t.float(1.5)).negate()));
    // Snell's window overhead: the sky squeezed into a ~97 degree cone, brighter than the water column.
    const win = t.smoothstep(
      t.float(Math.cos(THREE.MathUtils.degToRad(50))), t.float(Math.cos(THREE.MathUtils.degToRad(46))), dir.y);
    const sky = t.vec3(0.95, 1.0, 1.05).mul(t.float(2.2))
      .mul(t.exp(kd.mul(surfaceY.sub(t.float(ENVIRONMENT_DEPTH))).negate()));
    const sand = t.vec3(0.32, 0.29, 0.24).mul(t.float(0.35));
    const c = t.mix(t.mix(water, sky, win), sand, t.smoothstep(t.float(-0.1), t.float(-0.6), dir.y));
    return t.vec4(c, 1);
  })();
  material.fog = false;
  material.side = THREE.BackSide;

  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(ENVIRONMENT_RADIUS, ...ENVIRONMENT_SEGMENTS), material));
  const pmrem = new t.PMREMGenerator(renderer);
  const target = pmrem.fromScene(scene, ENVIRONMENT_BLUR_SIGMA);
  pmrem.dispose();
  return target.texture;
}
