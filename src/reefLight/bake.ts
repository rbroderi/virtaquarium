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
// Live, every lit material (water/materials.ts addCaustics) applies them: sun visibility on the key
// light, sky visibility on the ambient light, plus the bounce. The real-time shadow map keeps only the
// fish (the reef's own sun shadows are baked), and a screen-space AO pass adds the fine contact shading
// of fish against rock and each other (one frame behind, which at fish speeds is under a pixel).
import * as THREE from 'three';
import { causticUniforms } from '../water/caustics.js';
import { isMesh } from '../water/objectGuards.js';
import { reefLightUniforms, replaceMap, markReefLightOwned, WHITE_TEXTURE } from './uniforms.js';
import { BAKE_COMMON, BAKE_PASS_FRAG, FULLSCREEN_VERT, GBUF_FRAG, GBUF_VERT, type BakePass } from './bakeShaders.js';
import type { ReefLightInfo, ReefLightOptions, ReefLightTarget } from './types.js';

const DEFAULTS = { cell: 0.1, skyDirs: 256, bounceDirs: 192, sunDirs: 64, bounces: 2, res: 2048, sunCone: 0.1 } as const;
const CELL_GROWTH = 1.15;                 // grow the cell until the atlas fits the GPU
const MAX_ATLAS_TEXELS = 4e6;
// The grid covers the reef up to just above its tallest corals; points outside it read as open water.
const GRID_LIMITS = { minY: -0.6, topMargin: 0.3, halfX: 17, minZ: -6.5, maxZ: 4 } as const;
const SCREEN_FOV_SCALE = 1.15;            // a little wider than the camera, so the drift stays covered
const SCREEN_BASE_WIDTH = 2048;
const SCREEN_MAX_ZOOM = 1.5;
const AIM_MARGIN = 0.5;
const ORTHO_NEAR = 0.1;
const DEPTH_BIAS = 0.03;
const RANGE_MARGIN = 0.9;
const VERTICAL = 0.99;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
const CELL_DECIMALS = 3;

const ADDITIVE: THREE.ShaderMaterialParameters = {
  depthTest: false, depthWrite: false, transparent: true, glslVersion: THREE.GLSL3,
  blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
  blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
};

function fibonacci(n: number): THREE.Vector3[] {
  return Array.from({ length: n }, (_, i) => {
    const y = 1 - ((i + 0.5) / n) * 2, r = Math.sqrt(1 - y * y);
    return new THREE.Vector3(Math.cos(GOLDEN_ANGLE * i) * r, y, Math.sin(GOLDEN_ANGLE * i) * r);
  });
}

/** Directions over a cone of half-angle a around axis (Vogel disc). */
function cone(axis: THREE.Vector3, a: number, n: number): THREE.Vector3[] {
  const z = axis.clone().normalize(), x = new THREE.Vector3(1, 0, 0).cross(z);
  if (x.lengthSq() < 1e-6) x.set(0, 0, 1).cross(z);
  x.normalize();
  const y = z.clone().cross(x);
  return Array.from({ length: n }, (_, i) => {
    const r = Math.tan(a) * Math.sqrt((i + 0.5) / n), t = GOLDEN_ANGLE * i;
    return z.clone().addScaledVector(x, r * Math.cos(t)).addScaledVector(y, r * Math.sin(t)).normalize();
  });
}

/** The texture an MRT target writes at location i. */
function attachment(target: THREE.WebGLRenderTarget, i: number): THREE.Texture {
  const texture = target.textures[i];
  if (!texture) throw new Error(`render target has no attachment ${i}`);
  return texture;
}

/** Packing options (the ?rl8=1 A/B: 8-bit nearest maps, as before the half-float fix). */
export interface PackOptions { readonly eightBit: boolean }

export const defaultPackOptions = (): PackOptions => ({ eightBit: new URLSearchParams(location.search).get('rl8') === '1' });

/**
 * Copy same-sized 2D textures, texel for texel, into the layers of one texture array (half float,
 * linear filtering, as the bake targets were). Returns the array target.
 */
function packLayers(renderer: THREE.WebGLRenderer, textures: readonly THREE.Texture[], w: number, h: number, pack: PackOptions): THREE.WebGLArrayRenderTarget {
  const out = new THREE.WebGLArrayRenderTarget(w, h, textures.length, { depthBuffer: false });
  // WebGLArrayRenderTarget replaces the texture its options set up (three r170), so the type and
  // filters go on its own: before this the maps were 8-bit, which clipped the signed SH terms and the
  // bounce above 1, and nearest-filtered.
  if (!pack.eightBit) {
    out.texture.type = THREE.HalfFloatType;
    out.texture.minFilter = out.texture.magFilter = THREE.LinearFilter;
  }
  out.texture.generateMipmaps = false;
  const source: THREE.IUniform<THREE.Texture | null> = { value: null };
  const mat = new THREE.ShaderMaterial({
    uniforms: { src: source },
    vertexShader: FULLSCREEN_VERT,
    fragmentShader: 'uniform sampler2D src;\nvoid main() { gl_FragColor = texelFetch(src, ivec2(gl_FragCoord.xy), 0); }',
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat), scene = new THREE.Scene().add(quad), cam = new THREE.Camera();
  quad.frustumCulled = false;
  const prev = renderer.getRenderTarget();
  textures.forEach((t, i) => { source.value = t; renderer.setRenderTarget(out, i); renderer.render(scene, cam); });
  renderer.setRenderTarget(prev);
  mat.dispose(); quad.geometry.dispose();
  markReefLightOwned(out.texture);
  return out;
}

/** The grid's resolution and its 2D atlas layout (z slices in rows of `tiles`). */
interface GridLayout { readonly n: THREE.Vector3; readonly tiles: number; readonly aw: number; readonly ah: number; readonly cell: number }

function fitGrid(size: THREE.Vector3, startCell: number, maxTex: number): GridLayout {
  for (let cell = startCell; ; cell *= CELL_GROWTH) {
    const n = new THREE.Vector3(Math.ceil(size.x / cell), Math.ceil(size.y / cell), Math.ceil(size.z / cell));
    const tiles = Math.max(1, Math.round(Math.sqrt((n.z * n.y) / n.x)));
    const aw = n.x * tiles, ah = n.y * Math.ceil(n.z / tiles);
    if (aw <= maxTex && ah <= maxTex && aw * ah <= MAX_ATLAS_TEXELS) return { n, tiles, aw, ah, cell };
  }
}

/** Objects with this userData flag (and everything under them) are left out of the bake: light
 *  overlays laid on the ground, which would otherwise shade the very ground they lie on. */
export const NO_REEF_LIGHT = 'noReefLight';

export function skipsReefLight(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p.userData[NO_REEF_LIGHT] === true) return true;
  return false;
}

function reefBounds(group: THREE.Object3D, sand: THREE.Object3D | undefined): THREE.Box3 {
  const box = new THREE.Box3();
  group.traverse((o) => { if (isMesh(o) && o !== sand && !skipsReefLight(o)) box.expandByObject(o); });
  box.min.y = Math.max(box.min.y, GRID_LIMITS.minY); box.max.y += GRID_LIMITS.topMargin;
  box.min.x = Math.max(box.min.x, -GRID_LIMITS.halfX); box.max.x = Math.min(box.max.x, GRID_LIMITS.halfX);
  box.min.z = Math.max(box.min.z, GRID_LIMITS.minZ); box.max.z = Math.min(box.max.z, GRID_LIMITS.maxZ);
  return box;
}

/** The screen bake's eye (the whole frame, slightly wider) and targets. */
interface ScreenBake {
  readonly eye: THREE.PerspectiveCamera;
  readonly target: THREE.WebGLRenderTarget;
  readonly gbuffer: THREE.WebGLRenderTarget;
  readonly w: number;
  readonly h: number;
}

function createScreenBake(camera: THREE.PerspectiveCamera, maxTex: number): ScreenBake {
  const eye = camera.clone();
  // The whole frame, not a zoomed window into it (view.ts pans that window across the frame), at
  // enough pixels that the window still gets about one bake pixel per screen pixel.
  const zoom = camera.view && camera.view.enabled ? camera.view.fullWidth / camera.view.width : 1;
  eye.clearViewOffset();
  eye.fov = camera.fov * SCREEN_FOV_SCALE; eye.updateProjectionMatrix(); eye.updateMatrixWorld();
  const w = Math.min(maxTex, Math.round(SCREEN_BASE_WIDTH * Math.min(zoom, SCREEN_MAX_ZOOM))), h = Math.round(w / eye.aspect);
  const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: false, count: 2, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
  const gbuffer = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, depthBuffer: true, count: 2, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
  return { eye, target, gbuffer, w, h };
}

const uniform = <T>(value: T): THREE.IUniform<T> => ({ value });

/** The packed result of a bake, kept for saving to the cache. */
export interface PackedBake {
  readonly grid: THREE.WebGLArrayRenderTarget;
  readonly scr: THREE.WebGLArrayRenderTarget | null;
  readonly gw: number;
  readonly gh: number;
  readonly sw: number;
  readonly shh: number;
}

export interface BakeResult { readonly info: ReefLightInfo; readonly packed: PackedBake }

/** Bake the reef light, returning the packed targets too (for the cache). Runs to completion. */
export function bakeReefLightPacked(renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions, pack: PackOptions = defaultPackOptions()): BakeResult {
  const steps = bakeSteps(renderer, reef, opts, pack);
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

/** How long the async bake works before giving the browser a frame (ms). */
const BAKE_SLICE_MS = 50;

/**
 * The same bake, giving the browser a frame every BAKE_SLICE_MS so the page can show progress
 * (onProgress: 0..1) instead of freezing for the whole bake.
 */
export async function bakeReefLightPackedAsync(renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions, onProgress: (done: number) => void, pack: PackOptions = defaultPackOptions()): Promise<BakeResult> {
  const steps = bakeSteps(renderer, reef, opts, pack);
  let slice = performance.now();
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
    if (performance.now() - slice < BAKE_SLICE_MS) continue;
    onProgress(r.value);
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    slice = performance.now();
  }
}

/** The bake as steps: yields the share done (0..1) after each ray direction, returns the result. */
function* bakeSteps(renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions, pack: PackOptions): Generator<number, BakeResult, void> {
  const { sun, sky, ground, camera = null } = opts;
  const skyDirs = opts.skyDirs ?? DEFAULTS.skyDirs, bounceDirs = opts.bounceDirs ?? DEFAULTS.bounceDirs;
  const sunDirs = opts.sunDirs ?? DEFAULTS.sunDirs, bounces = opts.bounces ?? DEFAULTS.bounces, res = opts.res ?? DEFAULTS.res;
  const t0 = performance.now();
  // Progress by work: a bounce direction draws three views (depth, back faces, albedo), the others one.
  const totalWork = sunDirs + skyDirs + bounces * bounceDirs * 3;
  let work = 0;
  const group = reef.group, sand = group.getObjectByName('sand');
  group.updateMatrixWorld(true);
  const box = reefBounds(group, sand);
  const size = box.getSize(new THREE.Vector3());
  const maxTex = renderer.capabilities.maxTextureSize;
  const { n, tiles, aw, ah, cell } = fitGrid(size, opts.cell ?? DEFAULTS.cell, maxTex);
  size.copy(n).multiplyScalar(cell);

  const gridRT = (count = 1): THREE.WebGLRenderTarget => new THREE.WebGLRenderTarget(aw, ah, {
    type: THREE.HalfFloatType, depthBuffer: false, count, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
  });
  const depthRT = (): THREE.WebGLRenderTarget & { depthTexture: THREE.DepthTexture } => {
    const t = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true });
    const depthTexture = new THREE.DepthTexture(res, res, THREE.FloatType);
    t.depthTexture = depthTexture;
    return Object.assign(t, { depthTexture });
  };
  const visRT = depthRT(), backRT = depthRT();
  const albRT = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, depthBuffer: true });

  // Screen bake target and the reef's G-buffer from the rest view.
  const screen = camera ? createScreenBake(camera, maxTex) : null;

  // Scenes: the reef alone (moved out of the tank scene for the bake), and one lit for albedo only.
  const occ = new THREE.Scene();
  const visMat = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide, colorWrite: false });
  const backMat = new THREE.MeshBasicMaterial({ side: THREE.BackSide, colorWrite: false });
  const gMat = new THREE.ShaderMaterial({ vertexShader: GBUF_VERT, fragmentShader: GBUF_FRAG, glslVersion: THREE.GLSL3, side: THREE.DoubleSide });
  const amb = new THREE.AmbientLight(0xffffff, Math.PI);   // outgoing radiance = albedo
  const parent = group.parent;
  occ.add(group, amb);

  const R = box.getBoundingSphere(new THREE.Sphere()).radius + AIM_MARGIN, centre = box.getCenter(new THREE.Vector3());
  const ortho = new THREE.OrthographicCamera(-R, R, R, -R, ORTHO_NEAR, 2 * R + 1);
  const aim = (d: THREE.Vector3): void => {
    ortho.position.copy(centre).addScaledVector(d, R + AIM_MARGIN);
    ortho.up.set(0, 1, 0);
    if (Math.abs(d.y) > VERTICAL) ortho.up.set(1, 0, 0);
    ortho.lookAt(centre);
    ortho.updateMatrixWorld(); ortho.updateProjectionMatrix();
  };

  const prev = {
    target: renderer.getRenderTarget(), auto: renderer.autoClear, shadow: renderer.shadowMap.autoUpdate,
    clear: renderer.getClearColor(new THREE.Color()), alpha: renderer.getClearAlpha(),
    cau: causticUniforms.uCauOn.value, ao: reefLightUniforms.uRLAOOn.value,
  };
  renderer.shadowMap.autoUpdate = false;
  renderer.autoClear = false;
  renderer.setClearColor(0x000000, 0);
  reefLightUniforms.uRLOn.value = 0; reefLightUniforms.uRLAOOn.value = 0; causticUniforms.uCauOn.value = 0;
  const sandVisible = sand ? sand.visible : false;
  const skipped: [THREE.Object3D, boolean][] = [];
  group.traverse((o) => { if (o.userData[NO_REEF_LIGHT] === true) skipped.push([o, o.visible]); });
  for (const [o] of skipped) o.visible = false;

  const U = {
    uMin: uniform(box.min.clone()), uSize: uniform(size.clone()), uRes: uniform(n.clone()), uTiles: uniform(tiles),
    uW: uniform(1), uBias: uniform(DEPTH_BIAS / (2 * R + 1)), uRange: uniform(2 * R + RANGE_MARGIN), uCell: uniform(cell),
    uHasPrev: uniform(0), uFirst: uniform(0),
    uVis: uniform<THREE.Texture>(visRT.depthTexture), uBack: uniform<THREE.Texture>(backRT.depthTexture), uAlb: uniform<THREE.Texture>(albRT.texture),
    uPA: uniform<THREE.Texture>(WHITE_TEXTURE), uPS: uniform<THREE.Texture>(WHITE_TEXTURE),
    uPB: uniform<THREE.Texture>(WHITE_TEXTURE), uPC: uniform<THREE.Texture>(WHITE_TEXTURE),
    uGPos: uniform(screen ? attachment(screen.gbuffer, 0) : WHITE_TEXTURE), uGNrm: uniform(screen ? attachment(screen.gbuffer, 1) : WHITE_TEXTURE),
    uVP: uniform(new THREE.Matrix4()), uDir: uniform(new THREE.Vector3()),
    uSky: uniform(sky.clone()), uGround: uniform(ground.clone()), uSunIrr: uniform(sun.irr.clone()),
    uSunDir: uniform(sun.dir.clone().normalize()), uScr: uniform(new THREE.Vector2(screen?.w ?? 0, screen?.h ?? 0)),
    uEye: uniform(screen ? screen.eye.position.clone() : new THREE.Vector3()),
  };
  const passMaterial = (frag: string): THREE.ShaderMaterial => new THREE.ShaderMaterial({
    uniforms: U, vertexShader: FULLSCREEN_VERT, fragmentShader: BAKE_COMMON + frag, ...ADDITIVE,
  });
  const mats: Record<BakePass, THREE.ShaderMaterial> = {
    gridSun: passMaterial(BAKE_PASS_FRAG.gridSun), gridSky: passMaterial(BAKE_PASS_FRAG.gridSky),
    gridBounce: passMaterial(BAKE_PASS_FRAG.gridBounce), scrSun: passMaterial(BAKE_PASS_FRAG.scrSun),
    scrBounce: passMaterial(BAKE_PASS_FRAG.scrBounce),
  };
  const quad = new THREE.Mesh<THREE.PlaneGeometry, THREE.Material>(new THREE.PlaneGeometry(2, 2));
  quad.frustumCulled = false;
  const quadScene = new THREE.Scene().add(quad), quadCam = new THREE.OrthographicCamera();
  const pass = (mat: THREE.Material, target: THREE.WebGLRenderTarget): void => {
    quad.material = mat; renderer.setRenderTarget(target); renderer.render(quadScene, quadCam);
  };
  const clear = (t: THREE.WebGLRenderTarget): void => { renderer.setRenderTarget(t); renderer.clear(true, false, false); };
  const drawDepth = (target: THREE.WebGLRenderTarget, mat: THREE.Material): void => {
    occ.overrideMaterial = mat;
    renderer.setRenderTarget(target); renderer.clear(true, true, false);
    renderer.render(occ, ortho);
    occ.overrideMaterial = null;
  };
  const shoot = (d: THREE.Vector3, { back = false, albedo = false } = {}): void => {
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
  if (screen) {
    if (sand) sand.visible = true;
    amb.visible = false;
    occ.overrideMaterial = gMat;
    renderer.setRenderTarget(screen.gbuffer); renderer.setClearColor(0x000000, 0); renderer.clear(true, true, false);
    renderer.render(occ, screen.eye);
    occ.overrideMaterial = null;
    clear(screen.target);
  }

  // 1. Sun: soft shadows over the fixture's cone.
  const sunRT = gridRT();
  clear(sunRT);
  U.uW.value = 1 / sunDirs;
  let first = true;
  for (const d of cone(sun.dir, sun.cone ?? DEFAULTS.sunCone, sunDirs)) {
    shoot(d);
    pass(mats.gridSun, sunRT);
    if (screen) { U.uFirst.value = first ? 1 : 0; pass(mats.scrSun, screen.target); }
    first = false;
    yield ++work / totalWork;
  }
  U.uPS.value = sunRT.texture;

  // 2. Sky visibility.
  const skyRT = gridRT();
  clear(skyRT);
  U.uW.value = 1 / skyDirs;
  for (const d of fibonacci(skyDirs)) {
    shoot(d); pass(mats.gridSky, skyRT);
    yield ++work / totalWork;
  }
  U.uPA.value = skyRT.texture;

  // 3. Bounces (ping-pong), the screen bake on the last one.
  const bounceRT = [gridRT(2), gridRT(2)] as const;
  const bounceRTFor = (k: number): THREE.WebGLRenderTarget => bounceRT[k % 2 === 0 ? 0 : 1];
  const bounceDirections = fibonacci(bounceDirs);
  for (let k = 0; k < bounces; k++) {
    const out = bounceRTFor(k);
    clear(out);
    U.uW.value = 1 / bounceDirs;
    U.uHasPrev.value = k > 0 ? 1 : 0;
    const last = k === bounces - 1;
    for (const d of bounceDirections) {
      shoot(d, { back: true, albedo: true });
      pass(mats.gridBounce, out);
      if (last && screen) pass(mats.scrBounce, screen.target);
      work += 3;
      yield work / totalWork;
    }
    U.uPB.value = attachment(out, 0); U.uPC.value = attachment(out, 1);
  }
  const fin = bounceRTFor(bounces - 1);

  renderer.setRenderTarget(prev.target);
  renderer.autoClear = prev.auto;
  renderer.shadowMap.autoUpdate = prev.shadow;
  renderer.setClearColor(prev.clear, prev.alpha);
  causticUniforms.uCauOn.value = prev.cau;
  reefLightUniforms.uRLAOOn.value = prev.ao;
  occ.remove(amb);
  parent?.add(group);
  if (sand) sand.visible = sandVisible;
  for (const [o, v] of skipped) o.visible = v;
  // The reef's sun shadows are baked now: the live shadow map keeps only what moves.
  group.traverse((o) => { if (isMesh(o)) o.castShadow = false; });
  [visRT, backRT, albRT, sunRT, bounceRTFor(bounces), screen?.gbuffer].forEach((t) => { if (t && t !== fin) t.dispose(); });
  Object.values(mats).forEach((m) => m.dispose());
  visMat.dispose(); backMat.dispose(); gMat.dispose(); quad.geometry.dispose();

  const L = reefLightUniforms;
  const gridArr = packLayers(renderer, [skyRT.texture, attachment(fin, 0), attachment(fin, 1)], aw, ah, pack);
  skyRT.dispose(); fin.dispose();
  replaceMap(L.uRLGrid, gridArr.texture);   // a re-bake replaces the last one
  L.uRLMin.value.copy(box.min); L.uRLSize.value.copy(size); L.uRLRes.value.copy(n);
  L.uRLTiles.value = tiles; L.uRLCell.value = cell; L.uRLOn.value = 1;
  L.uRLSunDir.value.copy(sun.dir).normalize();
  let scrArr: THREE.WebGLArrayRenderTarget | null = null;
  if (screen) {
    scrArr = packLayers(renderer, screen.target.textures, screen.w, screen.h, pack);
    screen.target.dispose();
    replaceMap(L.uRLScr, scrArr.texture);
    L.uRLScrVP.value.multiplyMatrices(screen.eye.projectionMatrix, screen.eye.matrixWorldInverse);
    L.uRLScrEye.value.copy(screen.eye.position); L.uRLScrOn.value = 1;
  }
  const packed: PackedBake = { grid: gridArr, scr: scrArr, gw: aw, gh: ah, sw: screen?.w ?? 0, shh: screen?.h ?? 0 };
  const info: ReefLightInfo = {
    cells: n.toArray(), cell: +cell.toFixed(CELL_DECIMALS),
    screen: screen ? [screen.w, screen.h] : null, ms: Math.round(performance.now() - t0),
  };
  console.info('Reef light baked:', info);
  return { info, packed };
}

/** Bake the reef light. Call once after buildReef (static geometry only: fish excluded). */
export function bakeReefLight(renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions): ReefLightInfo {
  return bakeReefLightPacked(renderer, reef, opts).info;
}
