// Caustics modulate the direct (sun / fixture) light on any lit material, including the swimming fish:
// the irradiance multiplier is applied to each directional light before it is shaded, so shadows and
// the BRDF stay correct. Chains with an existing onBeforeCompile (swim shader, tissue light).
import * as THREE from 'three';
import { CAUSTIC_LOOKUP_GLSL, causticUniforms } from './caustics.js';
import { reefLightUniforms } from '../reefLight/uniforms.js';
import { REEF_LIGHT_APPLY, REEF_LIGHT_EVAL, REEF_LIGHT_GLSL } from '../reefLight/glsl.js';

const LIGHTS_WITH_CAUSTICS = THREE.ShaderChunk.lights_fragment_begin.replace(
  'getDirectionalLightInfo( directionalLight, directLight );',
  'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= causticAt( vCW ) * rlSunFor( directionalLight.direction );');

const WORLD_POSITION_VARYING = `#include <project_vertex>
      {
        vec4 cw = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          cw = instanceMatrix * cw;
        #endif
        vCW = (modelMatrix * cw).xyz;
      }`;

/** Adds caustics and the baked reef light to a lit material; returns the same material. */
export function addCaustics<M extends THREE.Material>(mat: M): M {
  const previousCompile = mat.onBeforeCompile.bind(mat);
  const previousKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    previousCompile(shader, renderer);
    Object.assign(shader.uniforms, causticUniforms, reefLightUniforms);
    shader.vertexShader = 'varying vec3 vCW;\n' + shader.vertexShader.replace('#include <project_vertex>', WORLD_POSITION_VARYING);
    // ...and the baked reef light (reefLight/): soft sun shadows of the reef, the share of the water's
    // ambient light a point can see, and the light the reef reflects onto it.
    shader.fragmentShader = 'varying vec3 vCW;\n' + CAUSTIC_LOOKUP_GLSL + REEF_LIGHT_GLSL
      + shader.fragmentShader.replace('#include <lights_fragment_begin>', REEF_LIGHT_EVAL + LIGHTS_WITH_CAUSTICS)
        .replace('#include <aomap_fragment>', REEF_LIGHT_APPLY);
  };
  mat.customProgramCacheKey = () => previousKey() + '|caustic';
  return mat;
}
