// Baked reef light: ray-cast visibility of the open water from every point around the static reef.
//
// The water's diffuse light (hemisphere + environment) arrives from all directions, and a point in a
// crevice, under the cave roof, at the foot of a rock or in a coral's shade sees only part of it. We
// cast rays from a 3D grid of points in DIRS directions spread over the sphere: for each direction the
// reef is rendered once into a depth map looking back along it, and a grid point's ray is open if
// nothing in the depth map lies between it and the light side. The grid stores, per point, the open
// fraction and the mean open direction (L1 spherical harmonics), which gives the cosine-weighted
// visibility for any surface normal. Every lit material samples the grid (water.js addCaustics), so
// rocks, sand, corals and the fish passing under an overhang all lose the light they cannot see.
// The sun keeps its real-time shadow map (it moves with the light rig).
//
// The grid is stored as a 2D atlas of z slices (tx slices per row) in a half-float render target, so
// the bake runs entirely on the GPU and nothing is read back.
import * as THREE from 'three';

const white = new THREE.DataTexture(new Uint8Array([255, 0, 0, 0]), 1, 1);
white.needsUpdate = true;

export const reefLightUniforms = {
  uRLTex: { value: white },
  uRLMin: { value: new THREE.Vector3() },
  uRLSize: { value: new THREE.Vector3(1, 1, 1) },
  uRLRes: { value: new THREE.Vector3(1, 1, 1) },   // grid cells x, y, z
  uRLTiles: { value: 1 },                          // z slices per atlas row
  uRLCell: { value: 0.1 },
  uRLOn: { value: 0 },
  uRLBounce: { value: 0.18 },   // light returned by the (sunlit, pale) rock that blocks a ray
};

// Cosine-weighted open-water visibility at world point pw with world normal nw (1 = fully open).
export const REEF_LIGHT_GLSL = /* glsl */`
uniform sampler2D uRLTex;
uniform vec3 uRLMin, uRLSize, uRLRes;
uniform float uRLTiles, uRLCell, uRLOn, uRLBounce;
vec4 rlSlice(vec2 cxy, float z) {
  vec2 tile = vec2(mod(z, uRLTiles), floor(z / uRLTiles));
  vec2 atlas = uRLRes.xy * vec2(uRLTiles, ceil(uRLRes.z / uRLTiles));
  return texture2D(uRLTex, (tile * uRLRes.xy + clamp(cxy, vec2(0.0), uRLRes.xy - 1.0) + 0.5) / atlas);
}
float reefLight(vec3 pw, vec3 nw) {
  if (uRLOn < 0.5) return 1.0;
  // Step off the surface by a cell and a half, so the lookup reads the open side of the surface
  // rather than blending with grid points inside the rock.
  vec3 p = (pw + nw * uRLCell * 1.5 - uRLMin) / uRLSize;
  if (any(lessThan(p, vec3(0.0))) || any(greaterThan(p, vec3(1.0)))) return 1.0;
  vec3 c = p * uRLRes - 0.5;
  float z0 = clamp(floor(c.z), 0.0, uRLRes.z - 1.0), z1 = min(z0 + 1.0, uRLRes.z - 1.0);
  vec4 s = mix(rlSlice(c.xy, z0), rlSlice(c.xy, z1), clamp(c.z - z0, 0.0, 1.0));
  // L1 projection of max(0, n.d) over the sphere: 1/4 + n.d/2, normalised so open water gives 1.
  float e = clamp(s.x + 2.0 * dot(s.yzw, nw), 0.0, 1.0);
  return e + (1.0 - e) * uRLBounce;
}
`;

// Applied where three.js applies its ambient-occlusion map (after the lights are gathered).
export const REEF_LIGHT_APPLY = /* glsl */`
  {
    float rl = reefLight(vCW, inverseTransformDirection(normal, viewMatrix));
    reflectedLight.indirectDiffuse *= rl;
    reflectedLight.indirectSpecular *= mix(1.0, rl, 0.8);
  }
  #include <aomap_fragment>`;

const ACCUM_FRAG = /* glsl */`
uniform sampler2D uDepth;
uniform mat4 uVP;
uniform vec3 uDir, uMin, uSize, uRes;
uniform float uTiles, uW, uBias;
void main() {
  vec2 px = floor(gl_FragCoord.xy);
  vec2 tile = floor(px / uRes.xy), cxy = px - tile * uRes.xy;
  float iz = tile.y * uTiles + tile.x;
  if (iz >= uRes.z) discard;
  vec3 p = uMin + (vec3(cxy, iz) + 0.5) / uRes * uSize;
  vec3 ndc = (uVP * vec4(p, 1.0)).xyz;   // orthographic: w = 1
  vec2 uv = ndc.xy * 0.5 + 0.5;
  float d = ndc.z * 0.5 + 0.5;
  float v = 1.0;
  if (all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) v = d - uBias <= texture2D(uDepth, uv).x ? 1.0 : 0.0;
  gl_FragColor = vec4(v, v * uDir) * uW;
}`;

// Bake the reef's visibility grid. Call once after buildReef (static geometry only: fish excluded).
export function bakeReefLight(renderer, reef, { cell = 0.1, dirs = 256, res = 2048 } = {}) {
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

  const atlas = new THREE.WebGLRenderTarget(aw, ah, {
    type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const depthRT = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true });
  depthRT.depthTexture = new THREE.DepthTexture(res, res, THREE.FloatType);

  const occ = new THREE.Scene();
  occ.overrideMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });
  const parent = group.parent, sandVis = sand ? sand.visible : false;
  if (sand) sand.visible = false;   // the sand is the floor every point stands on, not an occluder
  occ.add(group);

  const centre = box.getCenter(new THREE.Vector3()), R = box.getBoundingSphere(new THREE.Sphere()).radius + 0.5;
  const cam = new THREE.OrthographicCamera(-R, R, R, -R, 0.1, 2 * R + 1);
  const accum = new THREE.ShaderMaterial({
    uniforms: {
      uDepth: { value: depthRT.depthTexture }, uVP: { value: new THREE.Matrix4() }, uDir: { value: new THREE.Vector3() },
      uMin: { value: box.min.clone() }, uSize: { value: size.clone() }, uRes: { value: n.clone() },
      uTiles: { value: tiles }, uW: { value: 1 / dirs }, uBias: { value: 0.03 / (2 * R + 1) },
    },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: ACCUM_FRAG,
    depthTest: false, depthWrite: false, transparent: true,
    blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), accum);
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene().add(quad), quadCam = new THREE.OrthographicCamera();

  const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevShadow = renderer.shadowMap.autoUpdate;
  const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  renderer.setRenderTarget(atlas);
  renderer.clear(true, false, false);
  const golden = Math.PI * (3 - Math.sqrt(5)), d = new THREE.Vector3();
  for (let i = 0; i < dirs; i++) {
    // Fibonacci sphere: even coverage of all directions.
    const y = 1 - ((i + 0.5) / dirs) * 2, r = Math.sqrt(1 - y * y);
    d.set(Math.cos(golden * i) * r, y, Math.sin(golden * i) * r);
    cam.position.copy(centre).addScaledVector(d, R + 0.5);
    cam.up.set(0, 1, 0);
    if (Math.abs(d.y) > 0.99) cam.up.set(1, 0, 0);
    cam.lookAt(centre);
    cam.updateMatrixWorld(); cam.updateProjectionMatrix();
    renderer.setRenderTarget(depthRT);
    renderer.clear(true, true, false);
    renderer.render(occ, cam);
    accum.uniforms.uVP.value.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    accum.uniforms.uDir.value.copy(d);
    renderer.setRenderTarget(atlas);
    renderer.render(quadScene, quadCam);
  }
  renderer.setRenderTarget(prevTarget);
  renderer.autoClear = prevAuto;
  renderer.shadowMap.autoUpdate = prevShadow;
  renderer.setClearColor(prevClear, prevAlpha);
  parent.add(group);
  if (sand) sand.visible = sandVis;
  depthRT.dispose(); accum.dispose(); quad.geometry.dispose(); occ.overrideMaterial.dispose();

  const U = reefLightUniforms;
  U.uRLTex.value = atlas.texture;
  U.uRLMin.value.copy(box.min); U.uRLSize.value.copy(size); U.uRLRes.value.copy(n);
  U.uRLTiles.value = tiles; U.uRLCell.value = cell; U.uRLOn.value = 1;
  const info = { cells: n.toArray(), cell: +cell.toFixed(3), dirs, ms: Math.round(performance.now() - t0) };
  console.info('Reef light baked:', info);
  return info;
}
