// Shrink generated scenery GLBs for real-time use. Tripo exports ~4K textures; a reef piece fills a
// small part of the screen, so 2K (rocks) and 1K (corals) are plenty and use a fraction of GPU memory.
// Originals are kept in web/models/scenery/src/ and re-optimising always starts from them.
//
//   npm run optimize-scenery              all models
//   npm run optimize-scenery -- rock_a    just these
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { MeshoptEncoder } from 'meshoptimizer';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, dedup, prune, meshopt } from '@gltf-transform/functions';
import { addHeight, idsFromArgs, isMain, SCENERY_DIR } from './heightmaps.js';

const ROCK_SIZE = 2048, CORAL_SIZE = 1024;
// AVIF: colour maps can drop chroma (4:2:0); normal maps carry the parallax height in their alpha and
// must keep full chroma (4:4:4) at high quality, or the relief bands.
const COLOUR_QUALITY = 65, NORMAL_QUALITY = 90, EFFORT = 6;
// Geometry: EXT_meshopt_compression, level 'high' (14-bit positions, octahedral normals, 12-bit UVs —
// sub-millimetre on these models). Compressed last, so the height-map UV rasteriser sees full precision.
const MESHOPT_LEVEL = 'high';
const MB = 1e6;

export interface OptimizeOptions {
  /** Folder holding <id>.glb (default: the scenery folder). */
  readonly dir?: string;
  /** Texture size in px (default: 2048 for rocks, 1024 otherwise). */
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
  await io.write(out, packed);
  const mb = (f: string): string => (fs.statSync(f).size / MB).toFixed(1);
  console.log(`${id}: ${mb(src)} MB -> ${mb(out)} MB (${size}px)`);
}

if (isMain(import.meta.url)) {
  for (const id of idsFromArgs(SCENERY_DIR)) await optimize(id);
}
