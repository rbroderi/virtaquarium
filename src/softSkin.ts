// Light through soft tissue, cheaply: thin living tissue isn't lit
// like rubber. Light wraps past the terminator (scattered under the skin) and shines through thin
// parts held against it (arm tips, fins, a web, an anemone's tentacles seen against the lamp). Two
// terms on a MeshStandardMaterial, per directional light:
//   wrap: diffuse lit as (N.L + w) / (1 + w) instead of N.L (only the extra beyond N.L is added);
//   back: a transmission lobe pow(V.-L, 4) through the part towards the eye, tinted by the tissue,
//         stronger the thinner the part: thin 0 (a solid body: a little) to 1 (a membrane: all of it),
//         a constant or the per-vertex aThin attribute (thin: 'attr').
// No extra pass and no screen-space history, so the Roku bake renders it as is.
import type * as THREE from 'three';
import { gpuActive } from './webgpu/tsl.js';

const GLSL_DIGITS = 4;
const f = (x: number): string => x.toFixed(GLSL_DIGITS);

export type TissueTint = readonly [number, number, number];

export interface TranslucencyOptions {
  /** Diffuse wrap past the terminator. */
  readonly wrap?: number;
  /** Strength of the transmission lobe. */
  readonly back?: number;
  /** Colour of light through the tissue. */
  readonly tint?: TissueTint;
  /** 0 solid .. 1 membrane, or 'attr' for the per-vertex aThin attribute. */
  readonly thin?: number | 'attr';
}

const DEFAULTS = { wrap: 0.45, back: 0.6, tint: [1.0, 0.5, 0.4] as TissueTint, thin: 0.2 } as const;

export function addTranslucency<M extends THREE.Material>(mat: M, options: TranslucencyOptions = {}): M {
  if (gpuActive()) {
    // The wrap + transmission lobe are per-directional-light lighting terms; the WebGPU standard node
    // material has no hook for them, so they stay WebGL-only for now (see notes/webgpu-plan.md).
    return mat;
  }
  const wrap = options.wrap ?? DEFAULTS.wrap, back = options.back ?? DEFAULTS.back;
  const tint = options.tint ?? DEFAULTS.tint, thin = options.thin ?? DEFAULTS.thin;
  const prev = mat.onBeforeCompile.bind(mat), prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    if (thin === 'attr') shader.vertexShader = 'attribute float aThin;\nvarying float vThin;\n' + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vThin = aThin;');
    const thinDecl = thin === 'attr' ? 'varying float vThin;\n' : `#define vThin ${f(thin)}\n`;
    shader.fragmentShader = thinDecl + shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
      #if NUM_DIR_LIGHTS > 0
      for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
        vec3 L = directionalLights[i].direction, lc = directionalLights[i].color * RECIPROCAL_PI;
        float ndl = dot(normal, L);
        float wrapped = max((ndl + ${f(wrap)}) / ${f(1 + wrap)}, 0.0) - max(ndl, 0.0);
        float lobe = pow(saturate(dot(geometryViewDir, -L)), 4.0) * saturate(0.3 - ndl) * (0.15 + 0.85 * vThin);
        reflectedLight.directDiffuse += material.diffuseColor * lc * (wrapped + lobe * ${f(back)} * vec3(${tint.map(f).join(', ')}));
      }
      #endif`);
  };
  mat.customProgramCacheKey = () => prevKey() + `|sss${wrap},${back},${tint.join(',')},${thin}`;
  return mat;
}
