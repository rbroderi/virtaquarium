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

// ?pom=0 leaves materials as they were (to compare).
const OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('pom') === '0';

const SRC = {
  bump: { tex: 'bumpMap', uv: 'vBumpMapUv', ch: 'x' },
  normalAlpha: { tex: 'normalMap', uv: 'vNormalMapUv', ch: 'a' },
};

export function addParallax(mat, depth, { steps = 12, source = 'bump' } = {}) {
  if (OFF) return mat;
  const S = SRC[source];
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uPomDepth = { value: depth };
    const glsl = /* glsl */`
uniform float uPomDepth;
vec2 pomOff = vec2(0.0);   // shift of the height map's UV to where the view ray meets the relief
float pomRate = 1.0;       // |d(height UV)/dx|, to rescale the shift for maps on other repeats
vec2 pomShift(vec2 uv) { return pomOff * length(dFdx(uv)) / max(pomRate, 1e-8); }
`;
    const H = (uv) => `(1.0 - texture2D(${S.tex}, ${uv}).${S.ch})`;
    // The march, first thing in main (it needs only varyings).
    const march = /* glsl */`
  {
    vec3 P = -vViewPosition, V = normalize(vViewPosition);
    vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 dp1 = dFdx(P), dp2 = dFdy(P);
    vec2 du1 = dFdx(${S.uv}), du2 = dFdy(${S.uv});
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
      vec2 uv = ${S.uv}, prevUv = uv;
      float h = ${H('uv')}, prevH = h, prevLayer = 0.0;
      for (int i = 0; i < STEPS; i++) {
        if (layer >= h) break;
        prevUv = uv; prevH = h; prevLayer = layer;
        layer += dl; uv = ${S.uv} + Sd * layer;
        h = ${H('uv')};
      }
      // Between the last step above the relief and the first below it.
      float a = layer - h, b = prevH - prevLayer, t = b / max(a + b, 1e-5);
      pomOff = mix(prevUv, uv, t) - ${S.uv};
    }
  }
`;
    // Every lookup goes to the found point. The chunks are still #includes here, so edited copies
    // replace them; a lookup a chunk doesn't have is simply not there to shift.
    const C = THREE.ShaderChunk;
    const patch = (chunk, pairs) => pairs.reduce((s, [a, b]) => s.replace(a, b), C[chunk]);
    const chunks = {
      map_fragment: patch('map_fragment', [['texture2D( map, vMapUv )', 'texture2D( map, vMapUv + pomShift(vMapUv) )']]),
      roughnessmap_fragment: patch('roughnessmap_fragment', [['texture2D( roughnessMap, vRoughnessMapUv )', 'texture2D( roughnessMap, vRoughnessMapUv + pomShift(vRoughnessMapUv) )']]),
      metalnessmap_fragment: patch('metalnessmap_fragment', [['texture2D( metalnessMap, vMetalnessMapUv )', 'texture2D( metalnessMap, vMetalnessMapUv + pomShift(vMetalnessMapUv) )']]),
      normal_fragment_maps: patch('normal_fragment_maps', [['texture2D( normalMap, vNormalMapUv )', 'texture2D( normalMap, vNormalMapUv + pomShift(vNormalMapUv) )']]),
      bumpmap_pars_fragment: patch('bumpmap_pars_fragment', [
        ['float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;', 'float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff ).x;'],
        ['float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;', 'float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff + dSTdx ).x - Hll;'],
        ['float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;', 'float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff + dSTdy ).x - Hll;'],
      ]),
    };
    if (!chunks.map_fragment.includes('pomShift') || !chunks.bumpmap_pars_fragment.includes('pomOff') || !chunks.normal_fragment_maps.includes('pomShift')) {
      console.warn('parallax: three.js chunks changed; parallax off');
      return;
    }
    let fs = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + glsl);
    for (const [k, v] of Object.entries(chunks)) fs = fs.replace(`#include <${k}>`, v);
    shader.fragmentShader = fs.replace('void main() {', 'void main() {\n' + march);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '-pom' + steps + source;
  return mat;
}
