// Parallax occlusion mapping: the shader marches the view ray down into a height map and finds where it
// really meets the relief, then shifts every lookup there. Pores then hide their walls and floors as
// the view swings, as real holes do, which a bump or normal map alone (lighting only) cannot show. No
// extra texture or sampler. The height comes from one of:
//   'bump'         the material's bumpMap (the procedural rock and coral: their pores are bowls)
//   'normalAlpha'  the normal map's alpha (Tripo models: tools/heightmaps.mjs writes the colour map's
//                  cavities there and marks the material extras.pomHeight)
//
// Tangent frame from screen-space derivatives (as three's bump mapping does), so no tangent attribute.
// The march fades out where the deepest point would shift by under ~1 px on screen (distant or face-on
// relief), so it costs nothing where it can't show; at grazing angles the shift is limited (the classic POM
// failure) by clamping N.V. Assumes the shifted maps share one UV set (each shift is rescaled by its
// own UV rate, so differing repeats are fine).
//   depth: how deep the darkest texel lies below the brightest, in world units (1 unit = 12.5 cm).
import * as THREE from 'three';

/** ?pom=0 leaves materials as they were (to compare). Read once, at load. */
const PARALLAX_DISABLED_BY_URL = typeof location !== 'undefined' && new URLSearchParams(location.search).get('pom') === '0';

const DEFAULT_STEPS = 12;

export type HeightSource = 'bump' | 'normalAlpha';

interface HeightSourceGlsl {
  readonly tex: string;
  readonly uv: string;
  readonly ch: string;
}

const HEIGHT_SOURCES: Readonly<Record<HeightSource, HeightSourceGlsl>> = {
  bump: { tex: 'bumpMap', uv: 'vBumpMapUv', ch: 'x' },
  normalAlpha: { tex: 'normalMap', uv: 'vNormalMapUv', ch: 'a' },
};

export interface ParallaxOptions {
  /** March steps through the relief. */
  readonly steps?: number;
  readonly source?: HeightSource;
}

type ChunkName = keyof typeof THREE.ShaderChunk;
type Replacement = readonly [string, string];

const PARS_GLSL = /* glsl */`
uniform float uPomDepth;
vec2 pomOff = vec2(0.0);   // shift of the height map's UV to where the view ray meets the relief
float pomRate = 1.0;       // |d(height UV)/dx|, to rescale the shift for maps on other repeats
vec2 pomShift(vec2 uv) { return pomOff * length(dFdx(uv)) / max(pomRate, 1e-8); }
`;

/** The march, first thing in main (it needs only varyings). */
function marchGlsl(src: HeightSourceGlsl, steps: number): string {
  const height = (uv: string): string => `(1.0 - texture2D(${src.tex}, ${uv}).${src.ch})`;
  return /* glsl */`
  {
    vec3 P = -vViewPosition, V = normalize(vViewPosition);
    vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 dp1 = dFdx(P), dp2 = dFdy(P);
    vec2 du1 = dFdx(${src.uv}), du2 = dFdy(${src.uv});
    pomRate = length(du1);
    // Gradients of u and v over the surface (cotangent frame, Mikkelsen 2010).
    vec3 p2 = cross(dp2, N), p1 = cross(N, dp1);
    float det = dot(dp1, p2);
    // Fade by how far the deepest point shifts on screen: nothing under ~0.5 px (distant or face-on
    // relief), full from ~1.5 px. (A pixel's size on the surface: the larger of the two derivatives.)
    float pxSize = max(length(dp1), length(dp2));
    float nv0 = max(dot(N, V), 0.3);
    float shiftPx = uPomDepth * length(V - N * dot(N, V)) / nv0 / max(pxSize, 1e-6);
    float fade = smoothstep(0.5, 1.5, shiftPx);
    if (abs(det) > 1e-12 && fade > 0.0) {
      vec3 gu = (p2 * du1.x + p1 * du2.x) / det, gv = (p2 * du1.y + p1 * du2.y) / det;
      float nv = nv0;
      // A point uPomDepth below the surface along the ray sits this far across it, in UV:
      vec3 across = -(V - N * dot(N, V)) / nv * uPomDepth * fade;
      vec2 Sd = vec2(dot(across, gu), dot(across, gv));
      const int STEPS = ${steps};
      float layer = 0.0, dl = 1.0 / float(STEPS);
      vec2 uv = ${src.uv}, prevUv = uv;
      float h = ${height('uv')}, prevH = h, prevLayer = 0.0;
      for (int i = 0; i < STEPS; i++) {
        if (layer >= h) break;
        prevUv = uv; prevH = h; prevLayer = layer;
        layer += dl; uv = ${src.uv} + Sd * layer;
        h = ${height('uv')};
      }
      // Between the last step above the relief and the first below it.
      float a = layer - h, b = prevH - prevLayer, t = b / max(a + b, 1e-5);
      pomOff = mix(prevUv, uv, t) - ${src.uv};
    }
  }
`;
}

const patchChunk = (chunk: ChunkName, pairs: readonly Replacement[]): string =>
  pairs.reduce((s, [from, to]) => s.replace(from, to), THREE.ShaderChunk[chunk]);

/**
 * Every lookup goes to the found point. The chunks are still #includes when onBeforeCompile runs, so
 * edited copies replace them; a lookup a chunk doesn't have is simply not there to shift.
 */
function shiftedChunks(): Readonly<Record<string, string>> {
  return {
    map_fragment: patchChunk('map_fragment', [['texture2D( map, vMapUv )', 'texture2D( map, vMapUv + pomShift(vMapUv) )']]),
    roughnessmap_fragment: patchChunk('roughnessmap_fragment', [['texture2D( roughnessMap, vRoughnessMapUv )', 'texture2D( roughnessMap, vRoughnessMapUv + pomShift(vRoughnessMapUv) )']]),
    metalnessmap_fragment: patchChunk('metalnessmap_fragment', [['texture2D( metalnessMap, vMetalnessMapUv )', 'texture2D( metalnessMap, vMetalnessMapUv + pomShift(vMetalnessMapUv) )']]),
    normal_fragment_maps: patchChunk('normal_fragment_maps', [['texture2D( normalMap, vNormalMapUv )', 'texture2D( normalMap, vNormalMapUv + pomShift(vNormalMapUv) )']]),
    bumpmap_pars_fragment: patchChunk('bumpmap_pars_fragment', [
      ['float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;', 'float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff ).x;'],
      ['float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;', 'float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff + dSTdx ).x - Hll;'],
      ['float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;', 'float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff + dSTdy ).x - Hll;'],
    ]),
  };
}

/** True when three's chunks still have the lookups we rewrite (a three.js upgrade can move them). */
function chunksStillMatch(chunks: Readonly<Record<string, string>>): boolean {
  return Boolean(chunks['map_fragment']?.includes('pomShift') && chunks['bumpmap_pars_fragment']?.includes('pomOff') && chunks['normal_fragment_maps']?.includes('pomShift'));
}

export function addParallax<M extends THREE.Material>(mat: M, depth: number, options: ParallaxOptions = {}): M {
  if (PARALLAX_DISABLED_BY_URL) return mat;
  const steps = options.steps ?? DEFAULT_STEPS, source = options.source ?? 'bump';
  const src = HEIGHT_SOURCES[source];
  const prev = mat.onBeforeCompile.bind(mat), prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms['uPomDepth'] = { value: depth };
    const chunks = shiftedChunks();
    if (!chunksStillMatch(chunks)) {
      console.warn('parallax: three.js chunks changed; parallax off');
      return;
    }
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + PARS_GLSL);
    for (const [name, code] of Object.entries(chunks)) fs = fs.replace(`#include <${name}>`, code);
    shader.fragmentShader = fs.replace('void main() {', 'void main() {\n' + marchGlsl(src, steps));
  };
  mat.customProgramCacheKey = () => prevKey() + '-pom' + steps + source;
  return mat;
}
