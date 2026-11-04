// Shrink generated scenery GLBs for real-time use. Tripo exports ~4K textures; a reef piece fills a
// small part of the screen, so 2K (rocks) and 1K (corals) are plenty and use a fraction of GPU memory.
// Originals are kept in pc/models/scenery/src/ and re-optimising always starts from them.
//
//   node tools/optimize-scenery.mjs            all models
//   node tools/optimize-scenery.mjs rock_a     just these
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { textureCompress, dedup, prune } from '@gltf-transform/functions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'pc', 'models', 'scenery');

// dir/size default to the scenery folder and rock/coral sizes; fish models pass their own.
export async function optimize(id, { dir = DIR, size = id.startsWith('rock') ? 2048 : 1024 } = {}) {
  const srcDir = path.join(dir, 'src');
  const out = path.join(dir, `${id}.glb`), src = path.join(srcDir, `${id}.glb`);
  fs.mkdirSync(srcDir, { recursive: true });
  if (!fs.existsSync(src)) fs.renameSync(out, src);
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(src);
  await doc.transform(
    dedup(), prune(),
    // Colour and roughness as WebP; normal maps stay lossless-ish (high quality) to avoid banding.
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 88, slots: /^(?!normal)/ }),
    textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [size, size], quality: 96, slots: /^normal/ }),
  );
  await io.write(out, doc);
  const mb = (f) => (fs.statSync(f).size / 1e6).toFixed(1);
  console.log(`${id}: ${mb(src)} MB -> ${mb(out)} MB (${size}px)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2)
    : fs.readdirSync(DIR).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
  for (const id of ids) await optimize(id);
}
