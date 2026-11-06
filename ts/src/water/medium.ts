// Underwater light transport: world scale, the tank's surface and glass, and the per-channel
// Beer-Lambert medium that replaces three.js fog.
//
// World scale: 1 unit = 12.5 cm (tank is 2.0 m x 1.1 m x 0.75 m).
//   L = L_surface * Td(depth) * T(path) + L_inscatter(dir) * (1 - T(path))
// where T = exp(-c * path) uses beam attenuation c (absorption + scattering) and
// Td = exp(-Kd * depth below surface) dims light reaching deeper surfaces.
// Coefficients are for clear tropical reef water (per metre), converted to per unit.
import * as THREE from 'three';

export const METRES_PER_UNIT = 0.125;
/** Beam attenuation c, red/green/blue (1/m). */
const BEAM_ATTENUATION_PER_M = [0.60, 0.17, 0.12] as const;
/** Diffuse downwelling attenuation Kd, red/green/blue (1/m). */
const DOWNWELLING_ATTENUATION_PER_M = [0.45, 0.07, 0.05] as const;
export const SURFACE_Y = 9.4;
export const GLASS_Z = 3.3;

/** Shared time and caustic-strength uniforms (every water-lit material reads them). */
export const waterUniforms: { uTime: THREE.IUniform<number>; uCaustic: THREE.IUniform<number> } = {
  uTime: { value: 0 },
  uCaustic: { value: 1 },
};

const perUnitVec3 = (perMetre: readonly number[]): string =>
  `vec3(${perMetre.map((x) => (x * METRES_PER_UNIT).toFixed(5)).join(', ')})`;

export const UW_GLSL = /* glsl */`
const vec3 UW_C = ${perUnitVec3(BEAM_ATTENUATION_PER_M)};
const vec3 UW_KD = ${perUnitVec3(DOWNWELLING_ATTENUATION_PER_M)};
const float UW_SURFACE = ${SURFACE_Y.toFixed(2)};
const float UW_GLASS = ${GLASS_Z.toFixed(2)};
// Camera white balance: undo the downwelling attenuation at reef depth, like an
// underwater photographer's custom white balance (the eye adapts the same way).
const vec3 UW_WB = exp(UW_KD * 7.0);   // balanced for the reef zone (~0.3 m above the sand)
// Radiance scattered towards the eye by an infinitely long water path in direction dir,
// starting at height y: brighter towards the sunlit surface, darker looking down and deeper.
vec3 uwInscatter(vec3 base, vec3 dir, float y) {
  float up = smoothstep(-0.7, 0.95, dir.y);
  vec3 c = base * (0.45 + 1.1 * up * up);
  return c * exp(-UW_KD * max(0.0, UW_SURFACE - y) * 1.5);
}
// Length of the part of the eye ray that lies inside the water (camera is outside the glass).
float uwPath(vec3 p, vec3 cam) {
  float d = length(p - cam);
  if (cam.z <= UW_GLASS) return d;
  return d * clamp((UW_GLASS - p.z) / max(1e-3, cam.z - p.z), 0.0, 1.0);
}
`;

const FOG_PARS_VERTEX = '#ifdef USE_FOG\n varying float vFogDepth;\n varying vec3 vUWWorld;\n#endif\n';
const FOG_VERTEX = `#ifdef USE_FOG
    vFogDepth = - mvPosition.z;
    {
      vec4 uwW = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        uwW = instanceMatrix * uwW;
      #endif
      vUWWorld = (modelMatrix * uwW).xyz;
    }
  #endif\n`;
const FOG_PARS_FRAGMENT = `#ifdef USE_FOG
    uniform vec3 fogColor;
    varying float vFogDepth;
    varying vec3 vUWWorld;
    #ifdef FOG_EXP2
      uniform float fogDensity;
    #else
      uniform float fogNear;
      uniform float fogFar;
    #endif
    ${UW_GLSL}
  #endif\n`;
const FOG_FRAGMENT = `#ifdef USE_FOG
    {
      vec3 uwDir = normalize(vUWWorld - cameraPosition);
      #ifdef FOG_EXP2
        float uwK = fogDensity;
      #else
        float uwK = 1.0;
      #endif
      vec3 T = exp(-UW_C * uwPath(vUWWorld, cameraPosition) * uwK);
      vec3 Td = exp(-UW_KD * max(0.0, UW_SURFACE - vUWWorld.y));
      float yMid = mix(vUWWorld.y, min(cameraPosition.y, UW_SURFACE), 0.5);
      gl_FragColor.rgb = (gl_FragColor.rgb * Td * T + uwInscatter(fogColor, uwDir, yMid) * (1.0 - T)) * UW_WB;
    }
  #endif\n`;

const isUnderwaterMediumInstalled = (): boolean => THREE.ShaderChunk.fog_fragment === FOG_FRAGMENT;

/**
 * Patches the fog chunks once, before any material compiles. fogColor = inscatter base radiance,
 * fogDensity = turbidity multiplier (1 = nominal). Idempotent.
 */
export function installUnderwaterMedium(): void {
  if (isUnderwaterMediumInstalled()) return;
  const chunks = THREE.ShaderChunk;
  chunks.fog_pars_vertex = FOG_PARS_VERTEX;
  chunks.fog_vertex = FOG_VERTEX;
  chunks.fog_pars_fragment = FOG_PARS_FRAGMENT;
  chunks.fog_fragment = FOG_FRAGMENT;
}

/** Inscatter base radiance (linear) at full daylight: blue-green, as seen in reef water. */
export const INSCATTER_DAY = new THREE.Color(0.030, 0.20, 0.33);
