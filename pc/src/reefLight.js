// Baked reef light: the static reef is lit once, at load, by ray casting on the GPU, and the live
// renderer only adds what the moving fish change.
//
// Rays are cast in many directions; for each direction the reef is drawn once into depth maps looking
// back along it, so every point's ray is tested at once (open if nothing in the depth map lies between
// the point and the light side). Three things are baked:
//   sun   soft shadows of the static reef from a light of finite size: 64 directions over the cone of
//         the fixture, averaged (sharp where a rock meets the sand, softening with distance)
//   sky   the share of the water's diffuse light (hemisphere + environment) a point can see, cosine
//         weighted for its normal: dark crevices, overhangs and cave interiors
//   bounce  light reflected by the reef surfaces a point sees instead of open water, in colour, two
//         bounces deep (a crevice in purple coralline rock is lit purple, a cave by its sunlit floor)
// They are stored twice:
//   - a 3D grid around the reef (every 0.1 units; L1 spherical harmonics, so any normal can look it
//     up). Fish use it: they darken and pick up reef colour under a ledge or in a cave.
//   - a screen bake from the camera's rest position, per pixel at full resolution, for the reef itself.
//     Reef fragments find their pixel by projecting into the rest view (the camera's drift is small;
//     where parallax reveals something the bake didn't see, the depth check fails and the grid is used).
// Live, every lit material (water.js addCaustics) applies them: sun visibility on the key light,
// sky visibility on the ambient light, plus the bounce. The real-time shadow map keeps only the fish
// (the reef's own sun shadows are baked), and a screen-space AO pass adds the fine contact shading of
// fish against rock and each other (one frame behind, which at fish speeds is under a pixel).
import * as THREE from 'three';
import { causticUniforms } from './water.js';

const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
white.needsUpdate = true;

export const reefLightUniforms = {
  uRLA: { value: white },   // grid: sky visibility SH (open fraction, mean open direction)
  uRLB: { value: white },   // grid: bounce luminance SH
  uRLC: { value: white },   // grid: bounce colour (rgb), sun visibility (a)
  uRLMin: { value: new THREE.Vector3() },
  uRLSize: { value: new THREE.Vector3(1, 1, 1) },
  uRLRes: { value: new THREE.Vector3(1, 1, 1) },
  uRLTiles: { value: 1 },
  uRLCell: { value: 0.1 },
  uRLOn: { value: 0 },
  uRLLight: { value: 1 },   // light level (bounce was baked at full daylight)
  uRLSunDir: { value: new THREE.Vector3(0, 1, 0) },
  uRLScrA: { value: white },   // screen: bounce (rgb), sky visibility (a)
  uRLScrB: { value: white },   // screen: sun visibility (r), distance from the bake eye (g)
  uRLScrVP: { value: new THREE.Matrix4() },
  uRLScrEye: { value: new THREE.Vector3() },
  uRLScrOn: { value: 0 },
  uRLAO: { value: white },
  uRLAOInv: { value: new THREE.Vector2(1, 1) },
  uRLAOOn: { value: 0 },
  uRLDebug: { value: 0 },
};

// Trilinear lookup in a grid stored as a 2D atlas of z slices (tiles slices per row).
const RL_ATLAS = /* glsl */`
vec4 rlAtlas(sampler2D t, vec3 p01, vec3 res, float tiles) {
  vec3 c = p01 * res - 0.5;
  float z0 = clamp(floor(c.z), 0.0, res.z - 1.0), z1 = min(z0 + 1.0, res.z - 1.0);
  vec2 atlas = res.xy * vec2(tiles, ceil(res.z / tiles));
  vec2 cxy = clamp(c.xy, vec2(0.0), res.xy - 1.0) + 0.5;
  vec2 t0 = vec2(mod(z0, tiles), floor(z0 / tiles)), t1 = vec2(mod(z1, tiles), floor(z1 / tiles));
  return mix(texture2D(t, (t0 * res.xy + cxy) / atlas), texture2D(t, (t1 * res.xy + cxy) / atlas), clamp(c.z - z0, 0.0, 1.0));
}
const vec3 RL_Y = vec3(0.2126, 0.7152, 0.0722);
`;

export const REEF_LIGHT_GLSL = /* glsl */`
uniform sampler2D uRLA, uRLB, uRLC, uRLScrA, uRLScrB, uRLAO;
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
      vec4 b = texture2D(uRLScrB, uv);
      float dist = length(pw - uRLScrEye);
      if (abs(b.g - dist) < 0.03 + 0.004 * dist) {
        vec4 a = texture2D(uRLScrA, uv);
        rlSky = a.a; rlBounce = a.rgb; rlSun = b.r; screen = true;
      }
    }
  }
  if (!screen) {
    // Step off the surface by a cell and a half, so the lookup reads the open side of the surface
    // rather than blending with grid points inside the rock.
    vec3 p = (pw + nw * uRLCell * 1.5 - uRLMin) / uRLSize;
    if (all(greaterThanEqual(p, vec3(0.0))) && all(lessThanEqual(p, vec3(1.0)))) {
      vec4 A = rlAtlas(uRLA, p, uRLRes, uRLTiles), B = rlAtlas(uRLB, p, uRLRes, uRLTiles), C = rlAtlas(uRLC, p, uRLRes, uRLTiles);
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

// Before the lights are gathered: evaluate the baked terms for this fragment.
export const REEF_LIGHT_EVAL = 'rlEval(vCW, inverseTransformDirection(normal, viewMatrix));\n';

// Where three.js applies its ambient-occlusion map (after the lights are gathered).
export const REEF_LIGHT_APPLY = /* glsl */`
  reflectedLight.indirectDiffuse = reflectedLight.indirectDiffuse * rlSky + material.diffuseColor * rlBounce * uRLLight;
  reflectedLight.indirectSpecular *= mix(1.0, rlSky, 0.8);   // specular occlusion
  if (uRLDebug > 0.5) {   // inspect one baked term: 1 sun, 2 sky, 3 bounce (x4)
    vec3 dbg = uRLDebug < 1.5 ? vec3(rlSun) : uRLDebug < 2.5 ? vec3(rlSky) : rlBounce * 4.0;
    reflectedLight.directDiffuse = reflectedLight.directSpecular = reflectedLight.indirectSpecular = vec3(0.0);
    reflectedLight.indirectDiffuse = dbg;
  }
  #include <aomap_fragment>`;

// ---------- bake ----------

const BAKE_COMMON = /* glsl */`
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

const FRAG = {
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
};

// World position and normal of the reef (and sand) seen from the bake eye.
const GBUF_VERT = /* glsl */`
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
const GBUF_FRAG = /* glsl */`
varying vec3 vW, vN;
layout(location = 0) out vec4 gPos;
layout(location = 1) out vec4 gNrm;
void main() {
  vec3 n = normalize(vN);
  if (dot(n, cameraPosition - vW) < 0.0) n = -n;   // double-sided sheets: the side facing the eye
  gPos = vec4(vW, 1.0);
  gNrm = vec4(n, 0.0);
}`;

const additive = {
  depthTest: false, depthWrite: false, transparent: true, glslVersion: THREE.GLSL3,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
};

function fibonacci(n) {
  const golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(1 - y * y);
    return new THREE.Vector3(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
  });
}

// Directions over a cone of half-angle a around axis (Vogel disc).
function cone(axis, a, n) {
  const z = axis.clone().normalize(), x = new THREE.Vector3(1, 0, 0).cross(z);
  if (x.lengthSq() < 1e-6) x.set(0, 0, 1).cross(z);
  x.normalize();
  const y = z.clone().cross(x), golden = Math.PI * (3 - Math.sqrt(5));
  return Array.from({ length: n }, (_, i) => {
    const r = Math.tan(a) * Math.sqrt((i + 0.5) / n), t = golden * i;
    return z.clone().addScaledVector(x, r * Math.cos(t)).addScaledVector(y, r * Math.sin(t)).normalize();
  });
}

// Bake the reef light. Call once after buildReef (static geometry only: fish excluded).
//   sun:  { dir (towards the light), irr (Color: colour x intensity at full daylight), cone (half-angle, rad) }
//   sky, ground: hemisphere colours x intensity at full daylight
//   camera: the rest view to bake per pixel (omit to bake the grid only)
export function bakeReefLight(renderer, reef, {
  sun, sky, ground, camera = null,
  cell = 0.1, skyDirs = 256, bounceDirs = 192, sunDirs = 64, bounces = 2, res = 2048,
} = {}) {
  const t0 = performance.now();
  const group = reef.group, sand = group.getObjectByName('sand');
  group.updateMatrixWorld(true);
  const box = new THREE.Box3();
  group.traverse((o) => { if (o.isMesh && o !== sand) box.expandByObject(o); });
  // The grid covers the reef up to just above its tallest corals; points outside it read as open water.
  box.min.y = Math.max(box.min.y, -0.6); box.max.y += 0.3;
  box.min.x = Math.max(box.min.x, -17); box.max.x = Math.min(box.max.x, 17);
  box.min.z = Math.max(box.min.z, -6.5); box.max.z = Math.min(box.max.z, 4);
  const size = box.getSize(new THREE.Vector3());
  const maxTex = renderer.capabilities.maxTextureSize;
  let n, tiles, aw, ah;
  for (;; cell *= 1.15) {
    n = new THREE.Vector3(Math.ceil(size.x / cell), Math.ceil(size.y / cell), Math.ceil(size.z / cell));
    tiles = Math.max(1, Math.round(Math.sqrt((n.z * n.y) / n.x)));
    aw = n.x * tiles; ah = n.y * Math.ceil(n.z / tiles);
    if (aw <= maxTex && ah <= maxTex && aw * ah <= 4e6) break;
  }
  size.copy(n).multiplyScalar(cell);

  const gridRT = (count = 1) => new THREE.WebGLRenderTarget(aw, ah, {
    type: THREE.HalfFloatType, depthBuffer: false, count, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const depthRT = () => {
    const t = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true });
    t.depthTexture = new THREE.DepthTexture(res, res, THREE.FloatType);
    return t;
  };
  const visRT = depthRT(), backRT = depthRT();
  const albRT = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: true });

  // Screen bake target and the reef's G-buffer from the rest view (a little wider than the camera,
  // so the drift and a wider window stay covered).
  let eye = null, scrRT = null, gRT = null, sw = 0, shh = 0;
  if (camera) {
    eye = camera.clone();
    // The whole frame, not a zoomed window into it (view.js pans that window across the frame), at
    // enough pixels that the window still gets about one bake pixel per screen pixel.
    const zoom = camera.view && camera.view.enabled ? camera.view.fullWidth / camera.view.width : 1;
    eye.clearViewOffset();
    eye.fov = camera.fov * 1.15; eye.updateProjectionMatrix(); eye.updateMatrixWorld();
    sw = Math.min(maxTex, Math.round(2048 * Math.min(zoom, 1.5))); shh = Math.round(sw / eye.aspect);
    scrRT = new THREE.WebGLRenderTarget(sw, shh, { type: THREE.HalfFloatType, depthBuffer: false, count: 2, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    gRT = new THREE.WebGLRenderTarget(sw, shh, { type: THREE.FloatType, depthBuffer: true, count: 2, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  }

  // Scenes: the reef alone (moved out of the tank scene for the bake), and one lit for albedo only.
  const occ = new THREE.Scene();
  const visMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });
  const backMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, colorWrite: false });
  const gMat = new THREE.ShaderMaterial({ vertexShader: GBUF_VERT, fragmentShader: GBUF_FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide });
  const amb = new THREE.AmbientLight(0xffffff, Math.PI);   // outgoing radiance = albedo
  const parent = group.parent;
  occ.add(group, amb);

  const R = box.getBoundingSphere(new THREE.Sphere()).radius + 0.5, centre = box.getCenter(new THREE.Vector3());
  const ortho = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, 2 * R + 1);
  const aim = (d) => {
    ortho.position.copy(centre).addScaledVector(d, R + 0.5);
    ortho.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.99) ortho.up.set(1, 0, 0);
    ortho.lookAt(centre);
    ortho.updateMatrixWorld(); ortho.updateProjectionMatrix();
  };

  const prev = {
    target: renderer.getRenderTarget(), auto: renderer.autoClear, shadow: renderer.shadowMap.autoUpdate,
    clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
    rl: reefLightUniforms.uRLOn.value, cau: causticUniforms.uCauOn.value, ao: reefLightUniforms.uRLAOOn.value,
  };
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  reefLightUniforms.uRLOn.value = 0; reefLightUniforms.uRLAOOn.value = 0; causticUniforms.uCauOn.value = 0;
  const sandVis = sand ? sand.visible : false;

  const U = {
    uMin: { value: box.min.clone() }, uSize: { value: size.clone() }, uRes: { value: n.clone() }, uTiles: { value: tiles },
    uW: { value: 1 }, uBias: { value: 0.03 / (2 * R + 1) }, uRange: { value: 2 * R + 0.9 }, uCell: { value: cell },
    uHasPrev: { value: 0 }, uFirst: { value: 0 },
    uVis: { value: visRT.depthTexture }, uBack: { value: backRT.depthTexture }, uAlb: { value: albRT.texture },
    uPA: { value: white }, uPS: { value: white }, uPB: { value: white }, uPC: { value: white },
    uGPos: { value: gRT ? gRT.textures[0] : white }, uGNrm: { value: gRT ? gRT.textures[1] : white },
    uVP: { value: new THREE.Matrix4() }, uDir: { value: new THREE.Vector3() },
    uSky: { value: sky.clone() }, uGround: { value: ground.clone() }, uSunIrr: { value: sun.irr.clone() },
    uSunDir: { value: sun.dir.clone().normalize() }, uScr: { value: new THREE.Vector2(sw, shh) },
    uEye: { value: eye ? eye.position.clone() : new THREE.Vector3() },
  };
  const mats = Object.fromEntries(Object.entries(FRAG).map(([k, f]) => [k, new THREE.ShaderMaterial({
    uniforms: U, vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: BAKE_COMMON + f, ...additive,
  })]));
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene().add(quad), quadCam = new THREE.OrthographicCamera();
  const pass = (mat, target) => { quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam); };
  const clear = (t) => { renderer.setRenderTarget(t); renderer.clear(true, false, false); };
  const drawDepth = (target, mat) => {
    occ.overrideMaterial = mat;
    renderer.setRenderTarget(target); renderer.clear(true, true, false);
    renderer.render(occ, ortho);
    occ.overrideMaterial = null;
  };
  const shoot = (d, { back = false, albedo = false } = {}) => {
    aim(d);
    if (sand) sand.visible = false;   // the sand is the floor every point stands on, not an occluder
    amb.visible = false;
    drawDepth(visRT, visMat);
    if (back) drawDepth(backRT, backMat);
    if (albedo) {
      amb.visible = true;
      renderer.setRenderTarget(albRT); renderer.clear(true, true, false);
      renderer.render(occ, ortho);
    }
    U.uVP.value.multiplyMatrices(ortho.projectionMatrix, ortho.matrixWorldInverse);
    U.uDir.value.copy(d);
  };

  // G-buffer of the rest view (sand included: it is the main receiver of the rocks' shadows).
  if (gRT) {
    if (sand) sand.visible = true;
    amb.visible = false;
    occ.overrideMaterial = gMat;
    renderer.setRenderTarget(gRT); renderer.setClearColor(0x000000, 0); renderer.clear(true, true, false);
    renderer.render(occ, eye);
    occ.overrideMaterial = null;
    clear(scrRT);
  }

  // 1. Sun: soft shadows over the fixture's cone.
  const sunRT = gridRT();
  clear(sunRT);
  const sunDirsV = cone(sun.dir, sun.cone ?? 0.1, sunDirs);
  U.uW.value = 1 / sunDirs;
  sunDirsV.forEach((d, i) => {
    shoot(d);
    pass(mats.gridSun, sunRT);
    if (scrRT) { U.uFirst.value = i === 0 ? 1 : 0; pass(mats.scrSun, scrRT); }
  });
  U.uPS.value = sunRT.texture;

  // 2. Sky visibility.
  const skyRT = gridRT();
  clear(skyRT);
  U.uW.value = 1 / skyDirs;
  for (const d of fibonacci(skyDirs)) { shoot(d); pass(mats.gridSky, skyRT); }
  U.uPA.value = skyRT.texture;

  // 3. Bounces (ping-pong), the screen bake on the last one.
  const bRT = [gridRT(2), gridRT(2)];
  const bdirs = fibonacci(bounceDirs);
  for (let k = 0; k < bounces; k++) {
    const out = bRT[k % 2];
    clear(out);
    U.uW.value = 1 / bounceDirs;
    U.uHasPrev.value = k > 0 ? 1 : 0;
    const last = k === bounces - 1;
    for (const d of bdirs) {
      shoot(d, { back: true, albedo: true });
      pass(mats.gridBounce, out);
      if (last && scrRT) pass(mats.scrBounce, scrRT);
    }
    U.uPB.value = out.textures[0]; U.uPC.value = out.textures[1];
  }
  const fin = bRT[(bounces - 1) % 2];

  renderer.setRenderTarget(prev.target);
  renderer.autoClear = prev.auto;
  renderer.shadowMap.autoUpdate = prev.shadow;
  renderer.setClearColor(prev.clear, prev.alpha);
  causticUniforms.uCauOn.value = prev.cau;
  reefLightUniforms.uRLAOOn.value = prev.ao;
  occ.remove(amb);
  parent.add(group);
  if (sand) sand.visible = sandVis;
  // The reef's sun shadows are baked now: the live shadow map keeps only what moves.
  group.traverse((o) => { if (o.isMesh) o.castShadow = false; });
  [visRT, backRT, albRT, sunRT, bRT[(bounces) % 2], gRT].forEach((t) => t && t !== fin && t.dispose());
  Object.values(mats).forEach((m) => m.dispose());
  visMat.dispose(); backMat.dispose(); gMat.dispose(); quad.geometry.dispose();

  const L = reefLightUniforms;
  L.uRLA.value = skyRT.texture; L.uRLB.value = fin.textures[0]; L.uRLC.value = fin.textures[1];
  L.uRLMin.value.copy(box.min); L.uRLSize.value.copy(size); L.uRLRes.value.copy(n);
  L.uRLTiles.value = tiles; L.uRLCell.value = cell; L.uRLOn.value = 1;
  L.uRLSunDir.value.copy(sun.dir).normalize();
  if (scrRT) {
    L.uRLScrA.value = scrRT.textures[0]; L.uRLScrB.value = scrRT.textures[1];
    L.uRLScrVP.value.multiplyMatrices(eye.projectionMatrix, eye.matrixWorldInverse);
    L.uRLScrEye.value.copy(eye.position); L.uRLScrOn.value = 1;
  }
  const info = { cells: n.toArray(), cell: +cell.toFixed(3), screen: scrRT ? [sw, shh] : null, ms: Math.round(performance.now() - t0) };
  console.info('Reef light baked:', info);
  return info;
}

// ---------- live screen-space ambient occlusion ----------
//
// Hemisphere AO from the last frame's depth (WaterRenderer's HDR target), at half resolution with a
// depth-aware blur. Materials read it for their ambient light only, so sunlit tops stay bright.
const AO_FRAG = /* glsl */`
uniform sampler2D tDepth;
uniform mat4 uProj, uProjInv;
uniform vec2 uTexel;
uniform float uRadius, uStrength;
varying vec2 vUv;
vec3 vpos(vec2 uv) { float d = texture2D(tDepth, uv).x; vec4 p = uProjInv * vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0); return p.xyz / p.w; }
float ign(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }
void main() {
  if (texture2D(tDepth, vUv).x >= 0.9999) { gl_FragColor = vec4(1.0); return; }
  vec3 P = vpos(vUv);
  vec3 dx1 = vpos(vUv + vec2(uTexel.x, 0.0)) - P, dx0 = P - vpos(vUv - vec2(uTexel.x, 0.0));
  vec3 dy1 = vpos(vUv + vec2(0.0, uTexel.y)) - P, dy0 = P - vpos(vUv - vec2(0.0, uTexel.y));
  vec3 N = normalize(cross(abs(dx1.z) < abs(dx0.z) ? dx1 : dx0, abs(dy1.z) < abs(dy0.z) ? dy1 : dy0));
  if (dot(N, P) > 0.0) N = -N;   // towards the eye (view space)
  vec3 T = normalize(abs(N.x) < 0.9 ? cross(N, vec3(1.0, 0.0, 0.0)) : cross(N, vec3(0.0, 1.0, 0.0))), Bt = cross(N, T);
  float a0 = ign(gl_FragCoord.xy) * 6.2831853, j = ign(gl_FragCoord.yx + 17.0), occ = 0.0;
  const int K = 12;
  for (int i = 0; i < K; i++) {
    float f = (float(i) + 0.5) / float(K), r = sqrt(f), th = a0 + float(i) * 2.399963;
    vec3 dir = T * cos(th) * r + Bt * sin(th) * r + N * sqrt(1.0 - f);   // cosine-weighted
    vec3 S = P + dir * uRadius * mix(0.15, 1.0, fract(f * 7.13 + j));
    vec4 c = uProj * vec4(S, 1.0);
    vec2 uv = c.xy / c.w * 0.5 + 0.5;
    if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) continue;
    float sz = vpos(uv).z;
    occ += (sz >= S.z + 0.01 ? 1.0 : 0.0) * smoothstep(0.0, 1.0, uRadius / max(1e-3, abs(P.z - sz)));
  }
  gl_FragColor = vec4(vec3(1.0 - uStrength * occ / float(K)), 1.0);
}`;
const BLUR_FRAG = /* glsl */`
uniform sampler2D tAO, tDepth;
uniform mat4 uProjInv;
uniform vec2 uStep;
varying vec2 vUv;
float lz(vec2 uv) { vec4 p = uProjInv * vec4(0.0, 0.0, texture2D(tDepth, uv).x * 2.0 - 1.0, 1.0); return p.z / p.w; }
void main() {
  float z0 = lz(vUv), s = 0.0, w = 0.0;
  for (int i = -4; i <= 4; i++) {
    vec2 uv = vUv + uStep * float(i);
    float g = exp(-float(i * i) / 8.0) * exp(-abs(lz(uv) - z0) * 6.0);
    s += texture2D(tAO, uv).r * g; w += g;
  }
  gl_FragColor = vec4(vec3(s / w), 1.0);
}`;

export class ScreenAO {
  constructor(renderer, { radius = 0.3, strength = 0.65 } = {}) {
    this.renderer = renderer;
    this.rt = [0, 1].map(() => new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }));
    const vert = 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }';
    this.ao = new THREE.ShaderMaterial({
      uniforms: { tDepth: { value: null }, uProj: { value: new THREE.Matrix4() }, uProjInv: { value: new THREE.Matrix4() }, uTexel: { value: new THREE.Vector2() }, uRadius: { value: radius }, uStrength: { value: strength } },
      vertexShader: vert, fragmentShader: AO_FRAG, depthTest: false, depthWrite: false,
    });
    this.blur = new THREE.ShaderMaterial({
      uniforms: { tAO: { value: null }, tDepth: { value: null }, uProjInv: this.ao.uniforms.uProjInv, uStep: { value: new THREE.Vector2() } },
      vertexShader: vert, fragmentShader: BLUR_FRAG, depthTest: false, depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.ao);
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene().add(this.quad);
    this.camera = new THREE.Camera();
    this._size = new THREE.Vector2();
  }

  update(depthTexture, camera) {
    const r = this.renderer;
    r.getDrawingBufferSize(this._size);
    const w = Math.max(1, Math.ceil(this._size.x / 2)), h = Math.max(1, Math.ceil(this._size.y / 2));
    for (const t of this.rt) if (t.width !== w || t.height !== h) t.setSize(w, h);
    const prev = r.getRenderTarget();
    const a = this.ao.uniforms;
    a.tDepth.value = depthTexture;
    a.uProj.value.copy(camera.projectionMatrix); a.uProjInv.value.copy(camera.projectionMatrixInverse);
    a.uTexel.value.set(1 / w, 1 / h);
    const draw = (mat, target) => { this.quad.material = mat; r.setRenderTarget(target); r.render(this.scene, this.camera); };
    draw(this.ao, this.rt[0]);
    const b = this.blur.uniforms;
    b.tDepth.value = depthTexture;
    b.tAO.value = this.rt[0].texture; b.uStep.value.set(1 / w, 0); draw(this.blur, this.rt[1]);
    b.tAO.value = this.rt[1].texture; b.uStep.value.set(0, 1 / h); draw(this.blur, this.rt[0]);
    r.setRenderTarget(prev);
    const L = reefLightUniforms;
    L.uRLAO.value = this.rt[0].texture;
    L.uRLAOInv.value.set(1 / this._size.x, 1 / this._size.y);
    L.uRLAOOn.value = 1;
  }
}
