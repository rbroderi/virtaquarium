// Light through soft tissue, cheaply (docs/organic-modelling-plan.md 2.7): thin living tissue isn't lit
// like rubber. Light wraps past the terminator (scattered under the skin) and shines through thin
// parts held against it (arm tips, fins, a web, an anemone's tentacles seen against the lamp). Two
// terms on a MeshStandardMaterial, per directional light:
//   wrap: diffuse lit as (N.L + w) / (1 + w) instead of N.L (only the extra beyond N.L is added);
//   back: a transmission lobe pow(V.-L, 4) through the part towards the eye, tinted by the tissue,
//         stronger the thinner the part: thin 0 (a solid body: a little) to 1 (a membrane: all of it),
//         a constant or the per-vertex aThin attribute (thin: 'attr').
// No extra pass and no screen-space history, so the Roku bake renders it as is.
const f = (x) => x.toFixed(4);

export function addTranslucency(mat, { wrap = 0.45, back = 0.6, tint = [1.0, 0.5, 0.4], thin = 0.2 } = {}) {
  const prev = mat.onBeforeCompile, prevKey = mat.customProgramCacheKey ? mat.customProgramCacheKey.bind(mat) : null;
  const attr = thin === 'attr';
  mat.onBeforeCompile = (shader, renderer) => {
    if (prev) prev(shader, renderer);
    if (attr) shader.vertexShader = 'attribute float aThin;\nvarying float vThin;\n' + shader.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vThin = aThin;');
    shader.fragmentShader = (attr ? 'varying float vThin;\n' : `#define vThin ${f(thin)}\n`) + shader.fragmentShader.replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
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
  mat.customProgramCacheKey = () => (prevKey ? prevKey() : '') + `|sss${wrap},${back},${tint},${thin}`;
  return mat;
}
