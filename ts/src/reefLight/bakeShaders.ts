// GLSL for the reef light bake passes (reefLight/bake.ts).
import { RL_ATLAS } from './glsl.js';

export const BAKE_COMMON = /* glsl */`
uniform vec3 uMin, uSize, uRes;
uniform float uTiles, uW, uBias, uRange, uCell, uHasPrev, uFirst;
uniform sampler2D uVis, uBack, uAlb, uPA, uPS, uPB, uPC, uGPos, uGNrm;
uniform mat4 uVP;
uniform vec3 uDir, uSky, uGround, uSunIrr, uSunDir;
uniform vec2 uScr;
${RL_ATLAS}
const float PI = 3.141592653589793;
bool gridCell(out vec3 p) {
  vec2 px = floor(gl_FragCoord.xy);
  vec2 tile = floor(px / uRes.xy), cxy = px - tile * uRes.xy;
  float iz = tile.y * uTiles + tile.x;
  p = uMin + (vec3(cxy, iz) + 0.5) / uRes * uSize;
  return iz < uRes.z;
}
bool screenPoint(out vec3 p, out vec3 n) {
  vec2 uv = gl_FragCoord.xy / uScr;
  vec4 g = texture2D(uGPos, uv);
  n = texture2D(uGNrm, uv).xyz;
  p = g.xyz + n * 0.03;
  return g.w > 0.5;
}
vec3 proj(vec3 p) { return (uVP * vec4(p, 1.0)).xyz * 0.5 + 0.5; }   // orthographic: w = 1
float visible(vec3 q) {
  if (any(lessThan(q.xy, vec2(0.0))) || any(greaterThan(q.xy, vec2(1.0)))) return 1.0;
  return q.z - uBias <= texture2D(uVis, q.xy).x ? 1.0 : 0.0;
}
bool inGrid(vec3 s, out vec3 s01) { s01 = (s - uMin) / uSize; return all(greaterThanEqual(s01, vec3(0.0))) && all(lessThanEqual(s01, vec3(1.0))); }
// Radiance (albedo / pi x irradiance) of the reef face that the ray from p meets: the face looking back
// at p (back-face depth map), lit by the water (its own sky visibility), the sun (its own soft shadow)
// and the previous bounce.
vec3 hitL(vec3 p, vec3 q) {
  float t = q.z - texture2D(uBack, q.xy).x;
  if (t <= 0.0) t = q.z - texture2D(uVis, q.xy).x;
  vec3 nh = -uDir, s01;
  vec3 s = p + uDir * max(t, 0.0) * uRange + nh * uCell * 1.5;
  vec3 irr;
  if (inGrid(s, s01)) {
    vec4 A = rlAtlas(uPA, s01, uRes, uTiles);
    irr = mix(uGround, uSky, 0.5 + 0.5 * nh.y) * clamp(A.x + 2.0 * dot(A.yzw, nh), 0.0, 1.0)
        + uSunIrr * max(0.0, dot(nh, uSunDir)) * rlAtlas(uPS, s01, uRes, uTiles).x;
    if (uHasPrev > 0.5) {
      vec4 B = rlAtlas(uPB, s01, uRes, uTiles), C = rlAtlas(uPC, s01, uRes, uTiles);
      float cl = dot(C.rgb, RL_Y);
      if (cl > 1e-6) irr += PI * C.rgb / cl * max(0.0, B.x + 2.0 * dot(B.yzw, nh));
    }
  } else irr = mix(uGround, uSky, 0.5 + 0.5 * nh.y) + uSunIrr * max(0.0, dot(nh, uSunDir));
  return texture2D(uAlb, q.xy).rgb / PI * irr;
}
`;

export const BAKE_PASS_FRAG = {
  // Grid: sun visibility over the fixture's cone.
  gridSun: `layout(location = 0) out vec4 o0;
    void main() { vec3 p; if (!gridCell(p)) discard; o0 = vec4(visible(proj(p)) * uW); }`,
  // Grid: sky visibility SH.
  gridSky: `layout(location = 0) out vec4 o0;
    void main() { vec3 p; if (!gridCell(p)) discard; o0 = vec4(1.0, uDir) * visible(proj(p)) * uW; }`,
  // Grid: one bounce (luminance SH; mean colour and a copy of the sun visibility).
  gridBounce: `layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    void main() {
      vec3 p, p01; if (!gridCell(p)) discard;
      vec3 q = proj(p);
      vec3 L = visible(q) < 0.5 ? hitL(p, q) : vec3(0.0);
      float l = dot(L, RL_Y);
      inGrid(p, p01);
      o0 = vec4(l, l * uDir) * uW;
      o1 = vec4(L, rlAtlas(uPS, p01, uRes, uTiles).x) * uW;
    }`,
  // Screen: sun visibility per pixel (and its distance from the eye, for the live depth check).
  scrSun: `layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    uniform vec3 uEye;
    void main() {
      vec3 p, n; if (!screenPoint(p, n)) discard;
      o0 = vec4(0.0);
      o1 = vec4(visible(proj(p)) * uW, uFirst * length(p - n * 0.03 - uEye), 0.0, 0.0);
    }`,
  // Screen: sky visibility and bounce per pixel, for the pixel's own normal.
  scrBounce: `layout(location = 0) out vec4 o0; layout(location = 1) out vec4 o1;
    void main() {
      vec3 p, n; if (!screenPoint(p, n)) discard;
      vec3 q = proj(p);
      float v = visible(q), w = 4.0 * max(0.0, dot(n, uDir)) * uW;
      o0 = vec4(v < 0.5 ? hitL(p, q) * w : vec3(0.0), v * w);
      o1 = vec4(0.0);
    }`,
} as const;

export type BakePass = keyof typeof BAKE_PASS_FRAG;

/** World position and normal of the reef (and sand) seen from the bake eye. */
export const GBUF_VERT = /* glsl */`
varying vec3 vW, vN;
void main() {
  mat4 m = modelMatrix;
  #ifdef USE_INSTANCING
    m = modelMatrix * instanceMatrix;
  #endif
  vec4 w = m * vec4(position, 1.0);
  vW = w.xyz;
  vN = normalize(transpose(inverse(mat3(m))) * normal);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
export const GBUF_FRAG = /* glsl */`
varying vec3 vW, vN;
layout(location = 0) out vec4 gPos;
layout(location = 1) out vec4 gNrm;
void main() {
  vec3 n = normalize(vN);
  if (dot(n, cameraPosition - vW) < 0.0) n = -n;   // double-sided sheets: the side facing the eye
  gPos = vec4(vW, 1.0);
  gNrm = vec4(n, 0.0);
}`;

export const FULLSCREEN_VERT = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }';
