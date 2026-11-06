// GLSL for reading the baked reef light in lit materials (water/materials.ts addCaustics), and the
// atlas lookup the bake passes share.

/** Trilinear lookup in a grid stored as a 2D atlas of z slices (tiles slices per row). */
export const RL_ATLAS = /* glsl */`
// rlAtlasUv: the two slices' atlas coordinates and the blend between them. Two lookups: one in a plain
// 2D atlas (the bake's passes read their previous pass so), one in a layer of a texture array (the
// finished maps).
vec3 rlAtlasUv(vec3 p01, vec3 res, float tiles, out vec2 uv1) {
  vec3 c = p01 * res - 0.5;
  float z0 = clamp(floor(c.z), 0.0, res.z - 1.0), z1 = min(z0 + 1.0, res.z - 1.0);
  vec2 atlas = res.xy * vec2(tiles, ceil(res.z / tiles));
  vec2 cxy = clamp(c.xy, vec2(0.0), res.xy - 1.0) + 0.5;
  vec2 t0 = vec2(mod(z0, tiles), floor(z0 / tiles)), t1 = vec2(mod(z1, tiles), floor(z1 / tiles));
  uv1 = (t1 * res.xy + cxy) / atlas;
  return vec3((t0 * res.xy + cxy) / atlas, clamp(c.z - z0, 0.0, 1.0));
}
vec4 rlAtlas(sampler2D t, vec3 p01, vec3 res, float tiles) {
  vec2 uv1; vec3 a = rlAtlasUv(p01, res, tiles, uv1);
  return mix(texture(t, a.xy), texture(t, uv1), a.z);
}
vec4 rlAtlas(highp sampler2DArray t, float layer, vec3 p01, vec3 res, float tiles) {
  vec2 uv1; vec3 a = rlAtlasUv(p01, res, tiles, uv1);
  return mix(texture(t, vec3(a.xy, layer)), texture(t, vec3(uv1, layer)), a.z);
}
const vec3 RL_Y = vec3(0.2126, 0.7152, 0.0722);
`;

export const REEF_LIGHT_GLSL = /* glsl */`
uniform highp sampler2DArray uRLGrid, uRLScr;
uniform sampler2D uRLAO;
uniform vec3 uRLMin, uRLSize, uRLRes, uRLSunDir, uRLScrEye;
uniform float uRLTiles, uRLCell, uRLOn, uRLLight, uRLScrOn, uRLAOOn, uRLDebug;
uniform mat4 uRLScrVP;
uniform vec2 uRLAOInv;
${RL_ATLAS}
float rlSky = 1.0, rlSun = 1.0;
vec3 rlBounce = vec3(0.0);
void rlEval(vec3 pw, vec3 nw) {
  if (uRLOn < 0.5) return;
  bool screen = false;
  if (uRLScrOn > 0.5) {
    vec4 c = uRLScrVP * vec4(pw, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (c.w > 0.0 && all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) {
      vec4 b = texture(uRLScr, vec3(uv, 1.0));
      float dist = length(pw - uRLScrEye);
      if (abs(b.g - dist) < 0.03 + 0.004 * dist) {
        vec4 a = texture(uRLScr, vec3(uv, 0.0));
        rlSky = a.a; rlBounce = a.rgb; rlSun = b.r; screen = true;
      }
    }
  }
  if (!screen) {
    // Step off the surface by a cell and a half, so the lookup reads the open side of the surface
    // rather than blending with grid points inside the rock.
    vec3 p = (pw + nw * uRLCell * 1.5 - uRLMin) / uRLSize;
    if (all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, vec3(1.0)))) {
      vec4 A = rlAtlas(uRLGrid, 0.0, p, uRLRes, uRLTiles), B = rlAtlas(uRLGrid, 1.0, p, uRLRes, uRLTiles), C = rlAtlas(uRLGrid, 2.0, p, uRLRes, uRLTiles);
      // L1 projection of max(0, n.d) over the sphere: 1/4 + n.d/2, normalised so open water gives 1.
      rlSky = clamp(A.x + 2.0 * dot(A.yzw, nw), 0.0, 1.0);
      float cl = dot(C.rgb, RL_Y);
      rlBounce = cl > 1e-6 ? C.rgb / cl * max(0.0, B.x + 2.0 * dot(B.yzw, nw)) : vec3(0.0);
      rlSun = C.a;
    }
  }
  if (uRLAOOn > 0.5) { float ao = texture2D(uRLAO, gl_FragCoord.xy * uRLAOInv).r; rlSky *= ao; rlBounce *= ao; }
}
// Baked soft shadow on the key light only (the fills of the LED rig are unshadowed).
float rlSunFor(vec3 dirView) {
  return dot(normalize((vec4(dirView, 0.0) * viewMatrix).xyz), uRLSunDir) > 0.999 ? rlSun : 1.0;
}
`;

/** Before the lights are gathered: evaluate the baked terms for this fragment. */
export const REEF_LIGHT_EVAL = 'rlEval(vCW, inverseTransformDirection(normal, viewMatrix));\n';

/** Where three.js applies its ambient-occlusion map (after the lights are gathered). */
export const REEF_LIGHT_APPLY = /* glsl */`
  reflectedLight.indirectDiffuse = reflectedLight.indirectDiffuse * rlSky + material.diffuseColor * rlBounce * uRLLight;
  reflectedLight.indirectSpecular *= mix(1.0, rlSky, 0.8);   // specular occlusion
  if (uRLDebug > 0.5) {   // inspect one baked term: 1 sun, 2 sky, 3 bounce (x4)
    vec3 dbg = uRLDebug < 1.5 ? vec3(rlSun) : uRLDebug < 2.5 ? vec3(rlSky) : rlBounce * 4.0;
    reflectedLight.directDiffuse = reflectedLight.directSpecular = reflectedLight.indirectSpecular = vec3(0.0);
    reflectedLight.indirectDiffuse = dbg;
  }
  #include <aomap_fragment>`;
