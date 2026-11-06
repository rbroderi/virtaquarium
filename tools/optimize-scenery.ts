// Shrink generated scenery GLBs for real-time use. Tripo exports ~4K textures; a reef piece fills a
// small part of the screen, so 2K (rocks) and 1K (corals) are plenty and use a fraction of GPU memory.
// Originals are kept in web/models/scenery/src/ and re-optimising always starts from them.
//
//   npm run optimize-scenery              all models
//   npm run optimize-scenery -- rock_a    just these
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, dedup, prune } from '@gltf-transform/functions';
import { addHeight, idsFromArgs, isMain, SCENERY_DIR } from './heightmaps.js';

const ROCK_SIZE = 2048, CORAL_SIZE = 1024;
const COLOUR_QUALITY = 88, NORMAL_QUALITY = 96;
const MB = 1e6;

export interface OptimizeOptions {
  /** Folder holding <id>.glb (default: the scenery folder). */
  readonly dir?: string;
  /** Texture size in px (default: 2048 for rocks, 1024 otherwise). */
  readonly size?: number;
}

export async function optimize(id: string, { dir = SCENERY_DIR, size = id.startsWith('rock') ? ROCK_SIZE : CORAL_SIZE }: OptimizeOptions = {}): Promise<void> {
  const srcDir = path.join(dir, 'src');
  const out = path.join(dir, `${id}.glb`), src = path.join(srcDir, `${id}.glb`);
  fs.mkdirSync(srcDir, { recursive: true });
  if (!fs.existsSync(src)) fs.renameSync(out, src);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(src);
  await doc.transform(
    dedup(), prune(),
    // Colour and roughness as WebP; normal maps stay lossless-ish (high quality) to avoid banding.
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: COLOUR_QUALITY, slots: /^(?!normal)/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: NORMAL_QUALITY, slots: /^normal/ }),
  );
  await io.write(out, doc);
  // Scenery: a parallax height map in the normal map's alpha (fish models don't use one).
  if (dir === SCENERY_DIR) await addHeight(out);
  const mb = (f: string): string => (fs.statSync(f).size / MB).toFixed(1);
  console.log(`${id}: ${mb(src)} MB -> ${mb(out)} MB (${size}px)`);
}

if (isMain(import.meta.url)) {
  for (const id of idsFromArgs(SCENERY_DIR)) await optimize(id);
}
