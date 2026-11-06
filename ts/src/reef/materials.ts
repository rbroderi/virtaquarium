// Reef materials: the standard lit material with caustics, and the sway that bends soft tissue and
// plants with the water.
import * as THREE from 'three';
import { addCaustics, waterUniforms } from '../water.js';

const GLSL_DIGITS = 4;

/** A caustic-lit MeshStandardMaterial (water.ts addCaustics). */
export function stdMat(params: THREE.MeshStandardMaterialParameters): THREE.MeshStandardMaterial {
  return addCaustics(new THREE.MeshStandardMaterial(params));
}

export interface SwayOptions {
  /** Tip displacement along the model's own x (scaled with the model). */
  readonly ax?: number;
  /** Tip displacement along the model's own z. */
  readonly az?: number;
  /** Main frequency (Hz-ish, radians per second of uTime). */
  readonly hz?: number;
  /** Model-space height of the top, where the bend is full. */
  readonly hTop?: number;
}

const SWAY_DEFAULTS = { ax: 0.05, az: 0.035, hz: 1.0, hTop: 1 } as const;

/**
 * Soft tissue and plants sway with the water. h = height up the model (0 at the base, 1 at the top,
 * position.y / hTop in model units) and the bend grows with h^2. The phase comes from where each piece
 * stands, so neighbours don't move in step, and a second harmonic keeps it from looking mechanical.
 * key: the program cache key (materials with the same key share the compiled shader).
 */
export function addSway<M extends THREE.Material>(mat: M, key: string, options: SwayOptions = {}): M {
  const ax = options.ax ?? SWAY_DEFAULTS.ax, az = options.az ?? SWAY_DEFAULTS.az;
  const hz = options.hz ?? SWAY_DEFAULTS.hz, hTop = options.hTop ?? SWAY_DEFAULTS.hTop;
  const prev = mat.onBeforeCompile.bind(mat);
  const f = (x: number): string => x.toFixed(GLSL_DIGITS);
  mat.onBeforeCompile = (shader, r) => {
    prev(shader, r);
    shader.uniforms['uTime'] = waterUniforms.uTime;
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      {
        #ifdef USE_INSTANCING
        vec3 swayAt = instanceMatrix[3].xyz;
        #else
        vec3 swayAt = modelMatrix[3].xyz;
        #endif
        float h = clamp(position.y / ${f(hTop)}, 0.0, 1.0), ph = swayAt.x * 1.7 + swayAt.z * 2.3;
        float s = sin(uTime * ${f(hz)} + ph) + 0.35 * sin(uTime * ${f(hz * 2.3)} + ph * 1.9);
        transformed.x += s * ${f(ax)} * h * h;
        transformed.z += cos(uTime * ${f(hz * 0.8)} + ph * 1.3) * ${f(az)} * h * h;
      }`);
  };
  mat.customProgramCacheKey = () => key;
  return mat;
}

/** The (first) material of a mesh, for the per-mesh patches that expect one. */
export function firstMaterial(mesh: THREE.Mesh): THREE.Material | undefined {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}
