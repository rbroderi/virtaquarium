// Shrink generated scenery GLBs for real-time use. Tripo exports ~4K textures; a reef piece fills a
// small part of the screen, so 1K is plenty and use a fraction of GPU memory.
// Originals are kept in web/models/scenery/src/ and re-optimising always starts from them.
//
//   npm run optimize-scenery              all models
//   npm run optimize-scenery -- rock_a    just these
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { MeshoptEncoder } from 'meshoptimizer';
import * as THREE from 'three';
import { NodeIO, type Document, type Primitive } from '@gltf-transform/core';
import { addLods } from '../src/lod.js';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, dedup, prune, meshopt } from '@gltf-transform/functions';
import { addHeight, idsFromArgs, isMain, SCENERY_DIR } from './heightmaps.js';

const ROCK_SIZE = 1024, CORAL_SIZE = 1024;
// AVIF: colour maps can drop chroma (4:2:0); normal maps carry the parallax height in their alpha and
// must keep full chroma (4:4:4) at high quality, or the relief bands.
const COLOUR_QUALITY = 65, NORMAL_QUALITY = 90, EFFORT = 6;
// Geometry: EXT_meshopt_compression, level 'high' (14-bit positions, octahedral normals, 12-bit UVs —
// sub-millimetre on these models). Compressed last, so the height-map UV rasteriser sees full precision.
const MESHOPT_LEVEL = 'high';
const MB = 1e6;
// Scenery levels: error in pixels at each level's size limit, and attribute weights (the normal map carries the
// fine relief, so vertex normals count for less than in lod.ts's default).
const LOD_LIMITS_PX = (process.env["LOD_PX"] ?? "1e9,500,200").split(",").map(Number);
const LOD_ERROR_PX = Number(process.env["LOD_ERR"] ?? 2), LOD_WEIGHTS = { normal: Number(process.env["LOD_NW"] ?? 0.25) };

export interface OptimizeOptions {
  /** Folder holding <id>.glb (default: the scenery folder). */
  readonly dir?: string;
  /** Texture size in px (default: 1024). */
  readonly size?: number;
}

/** True when scenery.json marks the model in <id>.glb as glass: the crystal sign is re-materialled as
 *  clear glass (src/reef/crystal.ts) and never samples its textures, so it ships geometry only. */
function isGlass(dir: string, id: string): boolean {
  const manifest = path.join(dir, '..', 'scenery.json');
  if (!fs.existsSync(manifest)) return false;
  const entries: unknown = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (typeof entries !== 'object' || entries === null) return false;
  return Object.values(entries).some((e: unknown) => typeof e === 'object' && e !== null
    && (e as Record<string, unknown>)['file'] === `scenery/${id}.glb` && (e as Record<string, unknown>)['glass'] === true);
}

/**
 * Precomputes the levels of detail (src/lod.ts addLods) into every primitive: its index accessor
 * holds the distinct levels one after another, and extras.lods lists [first index, index count] per
 * level, which GLTFLoader puts on geometry.userData.lods for pickLod. Simplified in the loader's
 * normalised space (a unit box: per axis for rocks, uniform otherwise) with the loader's weights, so
 * the errors are the ones the runtime builder would have used.
 */
function bakeLods(doc: Document, rock: boolean): void {
  const root = doc.getRoot(), parts: { prim: Primitive; geo: THREE.BufferGeometry }[] = [];
  const box = new THREE.Box3(), v = new THREE.Vector3();
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const world = new THREE.Matrix4().fromArray(node.getWorldMatrix());
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION'), ind = prim.getIndices();
      if (!pos || !ind) continue;
      const n = pos.getCount(), p = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const e = pos.getElement(i, []);
        v.set(e[0] ?? 0, e[1] ?? 0, e[2] ?? 0).applyMatrix4(world);
        p[i * 3] = v.x; p[i * 3 + 1] = v.y; p[i * 3 + 2] = v.z;
        box.expandByPoint(v);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3));
      for (const [semantic, name, size] of [['NORMAL', 'normal', 3], ['TEXCOORD_0', 'uv', 2]] as const) {
        const acc = prim.getAttribute(semantic);
        if (!acc) continue;
        const a = new Float32Array(n * size);
        for (let i = 0; i < n; i++) acc.getElement(i, a.subarray(i * size, i * size + size) as unknown as number[]);
        geo.setAttribute(name, new THREE.BufferAttribute(a, size));
      }
      geo.setIndex(new THREE.BufferAttribute(Uint32Array.from(ind.getArray() ?? []), 1));
      parts.push({ prim, geo });
    }
  }
  const size = box.getSize(new THREE.Vector3()), largest = Math.max(size.x, size.y, size.z);
  const scale = rock ? new THREE.Vector3(1 / size.x, 1 / size.y, 1 / size.z) : new THREE.Vector3().setScalar(1 / largest);
  for (const { prim, geo } of parts) {
    geo.applyMatrix4(new THREE.Matrix4().makeScale(scale.x, scale.y, scale.z));
    const tris = addLods(geo, LOD_WEIGHTS, LOD_ERROR_PX, LOD_LIMITS_PX);
    const index = geo.index, lods = geo.userData['lods'];
    if (!tris || !index || !Array.isArray(lods)) continue;
    const count = prim.getAttribute('POSITION')?.getCount() ?? 0;
    const ind = prim.getIndices();
    ind?.setArray(count < 65536 ? Uint16Array.from(index.array) : Uint32Array.from(index.array));
    prim.setExtras({ ...prim.getExtras(), lods, lodPx: LOD_LIMITS_PX });
    console.log(`  lods: ${tris.map(Math.round).join(' / ')} triangles`);
  }
}

export async function optimize(id: string, { dir = SCENERY_DIR, size = id.startsWith('rock') ? ROCK_SIZE : CORAL_SIZE }: OptimizeOptions = {}): Promise<void> {
  const srcDir = path.join(dir, 'src');
  const out = path.join(dir, `${id}.glb`), src = path.join(srcDir, `${id}.glb`);
  fs.mkdirSync(srcDir, { recursive: true });
  if (!fs.existsSync(src)) fs.renameSync(out, src);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const doc = await io.read(src);
  const glass = isGlass(dir, id);
  if (glass) {
    // Glass: drop the textures (and the material slots that held them) before pruning.
    for (const tex of doc.getRoot().listTextures()) tex.dispose();
  }
  await doc.transform(
    dedup(), prune(),
    // Colour and roughness as AVIF with 4:2:0 chroma; normal maps full-chroma at high quality, as the
    // parallax height lives in their alpha and banding there is visible as sliding relief.
    textureCompress({ encoder: sharp, targetFormat: 'avif', resize: [size, size], quality: COLOUR_QUALITY, effort: EFFORT, chromaSubsampling: '4:2:0', slots: /^(?!normal)/ }),
    textureCompress({ encoder: sharp, targetFormat: 'avif', resize: [size, size], quality: NORMAL_QUALITY, effort: EFFORT, chromaSubsampling: '4:4:4', slots: /^normal/ }),
  );
  await io.write(out, doc);
  // Scenery: a parallax height map in the normal map's alpha (fish models don't use one; glass has none).
  if (dir === SCENERY_DIR && !glass) await addHeight(out);
  // Mesh compression last: addHeight rasterises UVs from the geometry, so it sees the unquantised mesh.
  await MeshoptEncoder.ready;
  const packed = await io.read(out);
  await packed.transform(meshopt({ encoder: MeshoptEncoder, level: MESHOPT_LEVEL }));
  // Levels of detail come after meshopt's reorder (which would scramble the ranges) and before the
  // write that encodes the buffers (compression is deferred until then).
  if (!glass) bakeLods(packed, id.startsWith('rock'));
  await io.write(out, packed);
  const mb = (f: string): string => (fs.statSync(f).size / MB).toFixed(1);
  console.log(`${id}: ${mb(src)} MB -> ${mb(out)} MB (${size}px)`);
}

if (isMain(import.meta.url)) {
  for (const id of idsFromArgs(SCENERY_DIR)) await optimize(id);
}
