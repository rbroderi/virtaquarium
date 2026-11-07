// The reef light cache.
//
// The bake depends only on the reef, the light and the rest view, so its result is kept on disk and
// reused: bakeReefLightCached hashes everything the bake reads (every reef mesh's geometry in full,
// transforms, instances, material settings and a thumbnail of each texture, the light, the camera,
// the bake's options, and a fingerprint of the sources that make the reef and the bake, injected by
// the build) and loads <base>reeflight-<hash>.bin if it exists. The file holds the two texture arrays
// exactly as the GPU had them (half floats, gzipped), so a cached start renders the same as a baked
// one. After a real bake on the local dev server, the result is saved for next time (git-ignored; the
// screen bake depends on the window's shape, so each shape gets its own file).
import * as THREE from 'three';
import { isRecord } from '../core/dom.js';
import { isInstancedMesh, isLine, isMesh, isPoints, materialsOf } from '../water/objectGuards.js';
import { bakeReefLightPackedAsync, type BakeResult, type PackedBake } from './bake.js';
import { Hasher, TextureHasher } from './hash.js';
import { markReefLightOwned, reefLightUniforms, replaceMap } from './uniforms.js';
import type { ReefLightCacheOptions, ReefLightInfo, ReefLightOptions, ReefLightTarget } from './types.js';

const RL_CACHE_VERSION = 1;
const DEFAULT_CACHE_BASE = './models/cache/';
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];
const RGBA = 4;
const HEADER_LENGTH_BYTES = 4;
const HEADER_ALIGN = 8;
const SPACE = 32;
const HALF_FLOAT_BYTES = 2;
const BYTES_PER_MB = 1e6;
/** Material fields left out of the key: creation counters, which async loading can reorder. */
const UNSTABLE_MATERIAL_KEYS = ['id', 'uuid', 'version'];

// ---------- key ----------

function hasFlag(value: unknown, flag: string): boolean {
  return isRecord(value) && value[flag] === true;
}

function materialSummary(m: THREE.Material, textureKey: (t: THREE.Texture) => string): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m) as [string, unknown][]) {
    if (v instanceof THREE.Texture) summary[k] = textureKey(v);
    else if (v instanceof THREE.Color || v instanceof THREE.Vector2 || v instanceof THREE.Vector3) summary[k] = v.toArray();
    else if ((typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') && !UNSTABLE_MATERIAL_KEYS.includes(k)) summary[k] = v;
  }
  summary['defines'] = m.defines;
  summary['key'] = m.customProgramCacheKey();
  return summary;
}

function geometryHash(g: THREE.BufferGeometry): string {
  const G = new Hasher();
  if (g.index) G.bytes(g.index.array);
  for (const [name, at] of Object.entries(g.attributes)) {
    G.str(name);
    G.bytes(at instanceof THREE.InterleavedBufferAttribute ? at.data.array : at.array);
  }
  G.str(JSON.stringify(g.drawRange) + JSON.stringify(g.groups));
  return G.hex();
}

function hashReefScene(H: Hasher, group: THREE.Object3D): void {
  group.updateMatrixWorld(true);
  const geometries = new Map<THREE.BufferGeometry, string>(), textures = new Map<THREE.Texture, string>();
  const textureHasher = new TextureHasher();
  const textureKey = (t: THREE.Texture): string => {
    let key = textures.get(t);
    if (key === undefined) {
      const T = new Hasher();
      textureHasher.hash(T, t);
      key = T.hex();
      textures.set(t, key);
    }
    return key;
  };
  group.traverse((o) => {
    H.str(`${o.type}|${o.name}|${o.visible}`);
    if (!isMesh(o) && !isPoints(o) && !isLine(o)) return;
    H.floats(o.matrixWorld.elements);
    if (isInstancedMesh(o)) {
      H.u32(o.count); H.bytes(o.instanceMatrix.array);
      if (o.instanceColor) H.bytes(o.instanceColor.array);
    }
    const g = o.geometry;
    let gh = geometries.get(g);
    if (gh === undefined) { gh = geometryHash(g); geometries.set(g, gh); }
    H.str(gh);
    for (const m of materialsOf(o)) {
      if (!hasFlag(m, 'isMaterial')) continue;
      H.str(JSON.stringify(materialSummary(m, textureKey)));
    }
  });
}

function reefLightKey(renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions, sourceFingerprint: string): string {
  const H = new Hasher();
  H.u32(RL_CACHE_VERSION);
  H.str(sourceFingerprint);
  const { sun, sky, ground, camera, ...rest } = opts;
  H.str(JSON.stringify(rest));
  H.floats([...sun.dir.toArray(), sun.irr.r, sun.irr.g, sun.irr.b, sun.cone ?? 0.1, sky.r, sky.g, sky.b, ground.r, ground.g, ground.b]);
  if (camera) {
    camera.updateMatrixWorld();
    H.floats([...camera.projectionMatrix.elements, ...camera.matrixWorld.elements, camera.fov, camera.aspect, camera.near, camera.far]);
    H.str(JSON.stringify(camera.view ?? null));
  }
  H.u32(renderer.capabilities.maxTextureSize);
  hashReefScene(H, reef.group);
  return H.hex();
}

// ---------- the file: [u32 header length][JSON header, space-padded to 8][grid halves][screen halves], gzipped ----------

/** Uniforms saved with a bake (everything else follows from the maps). */
const VECTOR_UNIFORMS = ['uRLMin', 'uRLSize', 'uRLRes', 'uRLSunDir', 'uRLScrEye'] as const;
const SCALAR_UNIFORMS = ['uRLTiles', 'uRLCell', 'uRLScrOn'] as const;
const MATRIX_UNIFORMS = ['uRLScrVP'] as const;
/** The order the JS build wrote them in. */
const UNIFORM_KEYS = ['uRLMin', 'uRLSize', 'uRLRes', 'uRLTiles', 'uRLCell', 'uRLSunDir', 'uRLScrVP', 'uRLScrEye', 'uRLScrOn'] as const;
type SavedUniform = (typeof UNIFORM_KEYS)[number];

const isVectorUniform = (k: SavedUniform): k is (typeof VECTOR_UNIFORMS)[number] => (VECTOR_UNIFORMS as readonly string[]).includes(k);
const isScalarUniform = (k: SavedUniform): k is (typeof SCALAR_UNIFORMS)[number] => (SCALAR_UNIFORMS as readonly string[]).includes(k);
const isMatrixUniform = (k: SavedUniform): k is (typeof MATRIX_UNIFORMS)[number] => (MATRIX_UNIFORMS as readonly string[]).includes(k);

function readUniform(k: SavedUniform): number | number[] {
  const L = reefLightUniforms;
  if (isScalarUniform(k)) return L[k].value;
  if (isVectorUniform(k)) return L[k].value.toArray();
  return L[k].value.toArray();
}

const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');

function writeUniform(k: SavedUniform, v: unknown): void {
  const L = reefLightUniforms;
  if (isScalarUniform(k)) { if (typeof v === 'number') L[k].value = v; return; }
  if (!isNumberArray(v)) return;
  if (isVectorUniform(k)) L[k].value.fromArray(v);
  else if (isMatrixUniform(k)) L[k].value.fromArray(v);
}

interface CacheHeader {
  readonly key: string;
  readonly version: number;
  readonly info: ReefLightInfo;
  readonly grid: [number, number, number];
  readonly scr: [number, number, number] | null;
  readonly u: Record<string, unknown>;
}

const isTriple = (v: unknown): v is [number, number, number] => isNumberArray(v) && v.length === 3;

function parseInfo(value: unknown): ReefLightInfo | null {
  if (!isRecord(value)) return null;
  const { cells, cell, screen, ms } = value;
  if (!isNumberArray(cells) || typeof cell !== 'number' || typeof ms !== 'number') return null;
  const shot = isNumberArray(screen) && screen.length === 2 ? ([screen[0] ?? 0, screen[1] ?? 0] as [number, number]) : null;
  return { cells, cell, screen: shot, ms };
}

function parseHeader(value: unknown): CacheHeader | null {
  if (!isRecord(value)) return null;
  const { key, version, info, grid, scr, u } = value;
  const parsedInfo = parseInfo(info);
  if (typeof key !== 'string' || typeof version !== 'number' || !isTriple(grid) || !isRecord(u) || !parsedInfo) return null;
  if (scr !== null && !isTriple(scr)) return null;
  return { key, version, info: parsedInfo, grid, scr, u };
}

/** Read a texture-array target's layers back as half floats (bit for bit what the GPU holds). */
function readLayers(renderer: THREE.WebGLRenderer, rt: THREE.WebGLArrayRenderTarget, w: number, h: number): Uint16Array<ArrayBuffer> {
  const gl = renderer.getContext();
  if (!(gl instanceof WebGL2RenderingContext)) throw new Error('reef light cache needs WebGL2');
  const layers = rt.depth, px = w * h * RGBA, out = new Uint16Array(px * layers), prev = renderer.getRenderTarget();
  for (let l = 0; l < layers; l++) {
    renderer.setRenderTarget(rt, l);
    const dst = out.subarray(l * px, (l + 1) * px);
    if (gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.HALF_FLOAT && gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) === gl.RGBA) {
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.HALF_FLOAT, dst);
    } else {
      const f = new Float32Array(px);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, f);
      for (let i = 0; i < px; i++) dst[i] = THREE.DataUtils.toHalfFloat(f[i] ?? 0);   // exact: they are halves
    }
  }
  renderer.setRenderTarget(prev);
  return out;
}

function arrayTexture(data: Uint16Array<ArrayBuffer>, w: number, h: number, layers: number): THREE.DataArrayTexture {
  const t = new THREE.DataArrayTexture(data, w, h, layers);
  t.type = THREE.HalfFloatType; t.format = THREE.RGBAFormat;
  t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
  markReefLightOwned(t);
  t.needsUpdate = true;
  return t;
}

async function saveReefLight(renderer: THREE.WebGLRenderer, bake: PackedBake, path: string, key: string, info: ReefLightInfo): Promise<void> {
  const head = {
    key, version: RL_CACHE_VERSION, info, grid: [bake.gw, bake.gh, bake.grid.depth], scr: bake.scr ? [bake.sw, bake.shh, bake.scr.depth] : null,
    u: Object.fromEntries(UNIFORM_KEYS.map((k) => [k, readUniform(k)])),
  };
  const grid = readLayers(renderer, bake.grid, bake.gw, bake.gh), scr = bake.scr ? readLayers(renderer, bake.scr, bake.sw, bake.shh) : new Uint16Array(0);
  const json = new TextEncoder().encode(JSON.stringify(head));
  const pad = (HEADER_ALIGN - ((HEADER_LENGTH_BYTES + json.length) % HEADER_ALIGN)) % HEADER_ALIGN;
  const len = new Uint32Array([json.length + pad]);
  const body = new Blob([len, json, new Uint8Array(pad).fill(SPACE), grid, scr]).stream().pipeThrough(new CompressionStream('gzip'));
  const blob = await new Response(body).blob();
  await fetch(`/__save?path=${path}`, { method: 'POST', body: blob });
  console.info(`Reef light cached: ${path} (${(blob.size / BYTES_PER_MB).toFixed(1)} MB)`);
}

async function loadReefLight(reef: ReefLightTarget, res: Response, key: string): Promise<ReefLightInfo | null> {
  if (!res.body) return null;
  const buf = await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const headerLength = new Uint32Array(buf, 0, 1)[0] ?? 0;
  const head = parseHeader(JSON.parse(new TextDecoder().decode(new Uint8Array(buf, HEADER_LENGTH_BYTES, headerLength)).trim()));
  if (!head || head.key !== key || head.version !== RL_CACHE_VERSION) return null;
  const [gw, gh, gn] = head.grid, gridHalves = gw * gh * RGBA * gn;
  const L = reefLightUniforms;
  replaceMap(L.uRLGrid, arrayTexture(new Uint16Array(buf, HEADER_LENGTH_BYTES + headerLength, gridHalves), gw, gh, gn));
  if (head.scr) {
    const [sw, sh, sn] = head.scr;
    replaceMap(L.uRLScr, arrayTexture(new Uint16Array(buf, HEADER_LENGTH_BYTES + headerLength + gridHalves * HALF_FLOAT_BYTES, sw * sh * RGBA * sn), sw, sh, sn));
  }
  for (const k of UNIFORM_KEYS) writeUniform(k, head.u[k]);
  L.uRLOn.value = 1;
  // As after a bake: the reef's sun shadows are in the maps, the live shadow map keeps what moves.
  reef.group.traverse((o) => { if (isMesh(o)) o.castShadow = false; });
  return { ...head.info, cached: true };
}

// ---------- public ----------

/** A save in flight (headless checks wait for it); resolved when none is. */
class PendingSave {
  private current: Promise<void> = Promise.resolve();
  get promise(): Promise<void> { return this.current; }
  set(save: Promise<void>): void { this.current = save; }
}
const pendingSave = new PendingSave();

/** The reef light save in flight, if any (resolves at once when none is). */
export const pendingReefLightSave = (): Promise<void> => pendingSave.promise;

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** The URL-derived defaults (?rlcache=0 always bakes; saving only on the local dev server). */
function cachePolicy(opts: ReefLightCacheOptions): { base: string; alwaysBake: boolean; save: boolean } {
  return {
    base: opts.base ?? DEFAULT_CACHE_BASE,
    alwaysBake: opts.alwaysBake ?? new URLSearchParams(location.search).get('rlcache') === '0',
    save: opts.save ?? LOCAL_HOSTS.includes(location.hostname),
  };
}

/** bakeReefLight, or its saved result when nothing it reads has changed (see the header comment). */
async function bakeReefLightCachedPacked(
  renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions, cacheOpts: ReefLightCacheOptions,
): Promise<{ info: ReefLightInfo; packed: PackedBake | null }> {
  const policy = cachePolicy(cacheOpts);
  const progress = cacheOpts.onProgress ?? ((): void => undefined);
  const bake = (): Promise<BakeResult> => bakeReefLightPackedAsync(renderer, reef, opts, (done) => progress('bake', done));
  if (policy.alwaysBake) { const { info, packed } = await bake(); return { info, packed }; }
  progress('cache', 0);
  let key: string | null = null;
  const t0 = performance.now();
  try { key = reefLightKey(renderer, reef, opts, cacheOpts.sourceFingerprint); } catch (e) { console.warn('Reef light cache key:', errorText(e)); }
  const tKey = performance.now() - t0;
  if (key) {
    try {
      const r = await fetch(`${policy.base}reeflight-${key}.bin`, { cache: 'no-cache' });
      if (r.ok) {
        const info = await loadReefLight(reef, r, key);
        if (info) { console.info(`Reef light from cache (key ${Math.round(tKey)} ms, total ${Math.round(performance.now() - t0)} ms)`); return { info, packed: null }; }
      }
    } catch (e) { console.warn('Reef light cache:', errorText(e)); }
  }
  progress('bake', 0);
  const { info, packed } = await bake();
  if (key && policy.save) {
    const path = new URL(`${policy.base}reeflight-${key}.bin`, location.href).pathname.replace(/^\//, '');
    pendingSave.set(saveReefLight(renderer, packed, path, key, info).catch((e: unknown) => { console.warn('Reef light cache save:', errorText(e)); }));
  }
  return { info, packed };
}

export async function bakeReefLightCached(
  renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions, cacheOpts: ReefLightCacheOptions,
): Promise<ReefLightInfo> {
  return (await bakeReefLightCachedPacked(renderer, reef, opts, cacheOpts)).info;
}

/** Replaces the baked maps with CPU-backed texture arrays read back from the WebGL bake targets, so a
 *  WebGPURenderer (which cannot sample the WebGL texture objects) can bind them. The cache path already
 *  loads CPU halves, so this only runs after a fresh bake. */
export function cpuFromPacked(renderer: THREE.WebGLRenderer, packed: PackedBake): void {
  const L = reefLightUniforms;
  const grid = readLayers(renderer, packed.grid, packed.gw, packed.gh);
  replaceMap(L.uRLGrid, arrayTexture(grid, packed.gw, packed.gh, packed.grid.depth));
  if (packed.scr) {
    const scr = readLayers(renderer, packed.scr, packed.sw, packed.shh);
    replaceMap(L.uRLScr, arrayTexture(scr, packed.sw, packed.shh, packed.scr.depth));
  }
}

/** bakeReefLightCached for the WebGPU display path: the bake runs on a WebGL renderer (the offline
 *  passes are ShaderMaterials WebGPURenderer never runs) and the maps are re-read as CPU arrays. */
export async function bakeReefLightCachedGpu(
  renderer: THREE.WebGLRenderer, reef: ReefLightTarget, opts: ReefLightOptions, cacheOpts: ReefLightCacheOptions,
): Promise<ReefLightInfo> {
  const { info, packed } = await bakeReefLightCachedPacked(renderer, reef, opts, cacheOpts);
  if (packed) {
    try { cpuFromPacked(renderer, packed); } catch (e) { console.warn('Reef light CPU read-back:', errorText(e)); }
  }
  return info;
}
