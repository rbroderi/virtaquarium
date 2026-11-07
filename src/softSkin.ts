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
import { gpuActive, tsl, type Tsl } from './webgpu/tsl.js';
import type { LightingModelDirectInput, Node, NodeBuilder, ShaderNodeObject, StackNode } from 'three/webgpu';

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
  const wrap = options.wrap ?? DEFAULTS.wrap, back = options.back ?? DEFAULTS.back;
  const tint = options.tint ?? DEFAULTS.tint, thin = options.thin ?? DEFAULTS.thin;
  if (gpuActive()) {
    // WebGPURenderer never runs onBeforeCompile, so the GLSL below is dead; the same wrap + transmission
    // lobes go through a per-instance lighting model instead (the node material has no fragment hook).
    const t = tsl();
    const nodeMat = mat as unknown as {
      setupLightingModel: (builder: unknown) => InstanceType<Tsl['PhysicalLightingModel']>;
      customProgramCacheKey: () => string;
    };
    nodeMat.setupLightingModel = () => translucencyLightingModel(t, wrap, back, tint, thin);
    const prevKey = nodeMat.customProgramCacheKey.bind(mat);
    nodeMat.customProgramCacheKey = () => prevKey() + `|sss${wrap},${back},${tint.join(',')},${thin}`;
    return mat;
  }
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

/** A lighting model that adds the wrap and transmission lobes of addTranslucency to a standard node
 *  material's direct light (the WebGL GLSL adds them in lights_fragment_end; WebGPURenderer never runs
 *  that, so the terms live here and run per directional light before the stock Lambert + GGX). */
function translucencyLightingModel(t: Tsl, wrap: number, back: number, tint: TissueTint, thin: number | 'attr'): InstanceType<Tsl['PhysicalLightingModel']> {
  const thinNode = thin === 'attr' ? t.attribute('aThin', 'float') : t.float(thin);
  class TranslucencyLightingModel extends t.PhysicalLightingModel {
    override direct(input: LightingModelDirectInput, stack: StackNode, builder: NodeBuilder): void {
      const L = input.lightDirection as unknown as ShaderNodeObject<Node>;
      const lc = input.lightColor as unknown as ShaderNodeObject<Node>;
      const N = t.transformedNormalView;
      const ndl = N.dot(L);
      // Only the extra light past the terminator is added (the standard Lambert keeps its own N.L).
      const wrapped = ndl.add(t.float(wrap)).div(t.float(1 + wrap)).max(t.float(0)).sub(ndl.max(t.float(0)));
      const lobe = t.positionViewDirection.dot(L.negate()).saturate().pow(4)
        .mul(t.float(0.3).sub(ndl).saturate())
        .mul(t.float(0.15).add(t.float(0.85).mul(thinNode)));
      const irr = lc.div(Math.PI);
      const alb = t.diffuseColor.rgb;
      (input.reflectedLight.directDiffuse as unknown as ShaderNodeObject<Node>)
        .addAssign(alb.mul(irr).mul(wrapped));
      (input.reflectedLight.directDiffuse as unknown as ShaderNodeObject<Node>)
        .addAssign(alb.mul(irr).mul(lobe).mul(t.float(back)).mul(t.vec3(tint[0], tint[1], tint[2])));
      super.direct(input, stack, builder);
    }
  }
  return new TranslucencyLightingModel();
}
