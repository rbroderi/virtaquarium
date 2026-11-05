// Parallax occlusion mapping for bump-mapped surfaces (rock pores, coral, sand): the bump map is a
// height map, so the shader can march the view ray down into it and find where it really meets the
// surface, shifting every lookup there. Pores then hide their walls and floors as the view swings, as
// real holes do, which a bump or normal map alone (lighting only) cannot show. No extra texture: it
// reads the material's own bumpMap.
//
// Tangent frame from screen-space derivatives (as three's bump mapping does), so no tangent attribute.
// The march fades out where the height map's texels fall under ~0.15 px on screen (pores under a few
// pixels), so distant rock costs nothing; at grazing angles the shift is limited (the classic POM failure) by clamping N.V.
//   depth: how deep the darkest texel lies below the brightest, in world units (1 unit = 12.5 cm).

import * as THREE from 'three';

// ?pom=0 leaves materials as they were (to compare).
const OFF = typeof location !== 'undefined' && new URLSearchParams(location.search).get('pom') === '0';

export function addParallax(mat, depth, { steps = 12 } = {}) {
  if (OFF) return mat;
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  mat.onBeforeCompile = (shader, r) => {
    if (prev) prev(shader, r);
    shader.uniforms.uPomDepth = { value: depth };
    const glsl = /* glsl */`
uniform float uPomDepth;
vec2 pomOff = vec2(0.0);   // shift of the bump map's UV to where the view ray meets the relief
#ifdef USE_MAP
vec2 pomMapOff = vec2(0.0);
#endif
`;
    // The march, first thing in main (it needs only varyings).
    const march = /* glsl */`
  {
    vec3 P = -vViewPosition, V = normalize(vViewPosition);
    vec3 N = normalize(vNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    vec3 dp1 = dFdx(P), dp2 = dFdy(P);
    vec2 du1 = dFdx(vBumpMapUv), du2 = dFdy(vBumpMapUv);
    // Gradients of u and v over the surface (cotangent frame, Mikkelsen 2010).
    vec3 p2 = cross(dp2, N), p1 = cross(N, dp1);
    float det = dot(dp1, p2);
    vec2 texels = vec2(textureSize(bumpMap, 0));
    float pxPerTexel = 1.0 / max(1e-6, max(length(du1 * texels), length(du2 * texels)));
    // (a pore spans ~5-20 texels, so the relief still reads at a quarter of a pixel per texel)
    float fade = smoothstep(0.15, 0.35, pxPerTexel);
    if (abs(det) > 1e-12 && fade > 0.0) {
      vec3 gu = (p2 * du1.x + p1 * du2.x) / det, gv = (p2 * du1.y + p1 * du2.y) / det;
      float nv = max(dot(N, V), 0.3);
      // A point uPomDepth below the surface along the ray sits this far across it, in UV:
      vec3 across = -(V - N * dot(N, V)) / nv * uPomDepth * fade;
      vec2 S = vec2(dot(across, gu), dot(across, gv));
      const int STEPS = ${steps};
      float layer = 0.0, dl = 1.0 / float(STEPS);
      vec2 uv = vBumpMapUv, prevUv = uv;
      float h = 1.0 - texture2D(bumpMap, uv).x, prevH = h, prevLayer = 0.0;
      for (int i = 0; i < STEPS; i++) {
        if (layer >= h) break;
        prevUv = uv; prevH = h; prevLayer = layer;
        layer += dl; uv = vBumpMapUv + S * layer;
        h = 1.0 - texture2D(bumpMap, uv).x;
      }
      // Between the last step above the relief and the first below it.
      float a = layer - h, b = prevH - prevLayer, t = b / max(a + b, 1e-5);
      pomOff = mix(prevUv, uv, t) - vBumpMapUv;
      #ifdef USE_MAP
        vec2 m1 = dFdx(vMapUv);
        pomMapOff = pomOff * length(m1) / max(length(du1), 1e-8);
      #endif
    }
  }
`;
    // Every lookup goes to the found point: the colour map, and the bump's own height samples (so the
    // relief is lit where it is seen). The chunks are still #includes here, so edited copies replace them.
    const mapChunk = THREE.ShaderChunk.map_fragment.replace('texture2D( map, vMapUv )', 'texture2D( map, vMapUv + pomMapOff )');
    const bumpChunk = THREE.ShaderChunk.bumpmap_pars_fragment
      .replace('float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv ).x;', 'float Hll = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff ).x;')
      .replace('float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdx ).x - Hll;', 'float dBx = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff + dSTdx ).x - Hll;')
      .replace('float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + dSTdy ).x - Hll;', 'float dBy = bumpScale * texture2D( bumpMap, vBumpMapUv + pomOff + dSTdy ).x - Hll;');
    if (!mapChunk.includes('pomMapOff') || !bumpChunk.includes('pomOff')) console.warn('parallax: three.js chunks changed; parallax off');
    // The globals go after three's declarations (bumpmap_pars needs pomOff), the march first thing in main.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <bumpmap_pars_fragment>', glsl + bumpChunk)
      .replace('#include <map_fragment>', mapChunk)
      .replace('void main() {', 'void main() {\n' + march);
  };
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '-pom' + steps;
  return mat;
}
