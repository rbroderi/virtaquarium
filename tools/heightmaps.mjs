// Height maps for parallax (pc/src/parallax.js) for the generated models. Tripo gives colour,
// roughness/metalness and a tangent-space normal map, but no height. Integrating the normal map was
// tried first: it holds only fine grain and thin edges, while the pits and pores seen on the models are
// in the colour map, as dark bowls (the delit albedo keeps their occlusion). So the height is the colour
// map's local darkness.
//
//  - Per UV island: the texture is an atlas of islands cut from the surface. Triangles are rasterised
//    into a mask and every filter is mask-aware, so islands never bleed into each other.
//  - Local relief only: a mask-aware blur is subtracted, so a dark colour patch (maroon crust beside
//    cream rock) doesn't become a hole, only its small pits do.
//  - The bulk of the surface sits at the top (alpha 1) and only pits go down: a depth common to the
//    whole surface would make the texture slide over the geometry as the view moves.
//  - Near island edges the height eases to the top, so a cut shows no step.
// The result goes into the normal map's alpha (no extra texture or sampler) and the material is marked
// (extras.pomHeight), which the page reads to turn parallax on.
//
//   node tools/heightmaps.mjs              every scenery model with a normal map
//   node tools/heightmaps.mjs rock_a       just these
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'pc', 'models', 'scenery');
const WORK = 1024;      // working resolution (upsampled back to the normal map's size)
const HIGHPASS = 20;    // blur radius (texels) removed as "where on the island"

// Rasterise the UV triangles of every primitive using `mat` into an island mask (1 inside).
function uvMask(doc, mat, W, H) {
  const mask = new Uint8Array(W * H);
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    if (prim.getMaterial() !== mat) continue;
    const uv = prim.getAttribute('TEXCOORD_0'), ind = prim.getIndices();
    if (!uv) continue;
    const U = uv.getArray(), I = ind ? ind.getArray() : null, n = I ? I.length : uv.getCount();
    for (let t = 0; t < n; t += 3) {
      const a = I ? I[t] : t, b = I ? I[t + 1] : t + 1, c = I ? I[t + 2] : t + 2;
      const p = [a, b, c].map((k) => [U[k * 2] * W - 0.5, U[k * 2 + 1] * H - 0.5]);   // glTF UV: v down the image
      const x0 = Math.max(0, Math.floor(Math.min(p[0][0], p[1][0], p[2][0]))), x1 = Math.min(W - 1, Math.ceil(Math.max(p[0][0], p[1][0], p[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(p[0][1], p[1][1], p[2][1]))), y1 = Math.min(H - 1, Math.ceil(Math.max(p[0][1], p[1][1], p[2][1])));
      const e = (q, r, x, y) => (r[0] - q[0]) * (y - q[1]) - (r[1] - q[1]) * (x - q[0]);
      const area = e(p[0], p[1], p[2][0], p[2][1]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const w0 = e(p[1], p[2], x, y) / area, w1 = e(p[2], p[0], x, y) / area, w2 = e(p[0], p[1], x, y) / area;
        if (w0 >= -0.02 && w1 >= -0.02 && w2 >= -0.02) mask[y * W + x] = 1;
      }
    }
  }
  return mask;
}

// Mask-aware box blur (separable, normalised by the mask), radius r.
function maskedBlur(src, mask, W, H, r) {
  const tmp = new Float32Array(W * H), tw = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    let s = 0, w = 0;
    for (let x = -r; x < W + r; x++) {
      const xa = x + r, xr = x - r - 1;
      if (xa >= 0 && xa < W && mask[y * W + xa]) { s += src[y * W + xa]; w++; }
      if (xr >= 0 && xr < W && mask[y * W + xr]) { s -= src[y * W + xr]; w--; }
      if (x >= 0 && x < W) { tmp[y * W + x] = s; tw[y * W + x] = w; }
    }
  }
  for (let x = 0; x < W; x++) {
    let s = 0, w = 0;
    for (let y = -r; y < H + r; y++) {
      const ya = y + r, yr = y - r - 1;
      if (ya >= 0 && ya < H) { s += tmp[ya * W + x]; w += tw[ya * W + x]; }
      if (yr >= 0 && yr < H) { s -= tmp[yr * W + x]; w -= tw[yr * W + x]; }
      if (y >= 0 && y < H) out[y * W + x] = w > 0 ? s / w : 0;
    }
  }
  return out;
}

// Distance (texels, capped) to the nearest texel outside the mask: two-pass chamfer.
function edgeDistance(mask, W, H, cap) {
  const d = new Float32Array(W * H);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? cap : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; if (!d[i]) continue;
    if (x > 0) d[i] = Math.min(d[i], d[i - 1] + 1); if (y > 0) d[i] = Math.min(d[i], d[i - W] + 1);
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; if (!d[i]) continue;
    if (x < W - 1) d[i] = Math.min(d[i], d[i + 1] + 1); if (y < H - 1) d[i] = Math.min(d[i], d[i + W] + 1);
  }
  return d;
}

export async function addHeight(file) {
  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const doc = await io.read(file);
  let done = 0;
  for (const mat of doc.getRoot().listMaterials()) {
    const tex = mat.getNormalTexture(), base = mat.getBaseColorTexture();
    if (!tex || !base) continue;
    const meta = await sharp(Buffer.from(tex.getImage())).metadata(), FW = meta.width, FH = meta.height;
    const W = Math.min(WORK, FW), H = Math.round((W * FH) / FW);
    const mask = uvMask(doc, mat, W, H);
    if (process.env.HM_DEBUG) await sharp(Buffer.from(mask.map((m) => m * 255)), { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(ROOT, 'out', 'hm-mask.png'));
    // Cavities from the colour map: a delit Tripo albedo still carries the pits as dark bowls (its normal
    // map holds only fine grain), so local darkness is depth. A 1-texel blur drops compression noise; the
    // high-pass keeps colour patches (maroon crust next to cream rock) from reading as holes.
    const lum = Float32Array.from(await sharp(Buffer.from(base.getImage())).resize(W, H).removeAlpha().greyscale().raw().toBuffer());
    const fine = maskedBlur(lum, mask, W, H, 1), low = maskedBlur(lum, mask, W, H, HIGHPASS);
    const rel = new Float32Array(W * H), vals = [];
    for (let i = 0; i < W * H; i++) if (mask[i]) { rel[i] = fine[i] - low[i]; vals.push(rel[i]); }
    if (vals.length < 100) continue;
    vals.sort((a, b) => a - b);
    // The top 30% of the surface at alpha 1, the darkest 1% at 0.
    const pTop = vals[Math.floor(vals.length * 0.7)], pLow = vals[Math.floor(vals.length * 0.01)], range = Math.max(1e-6, pTop - pLow);
    const edge = edgeDistance(mask, W, H, 6);
    const alpha = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) {
      const a = mask[i] ? Math.min(1, Math.max(0, 1 - (pTop - rel[i]) / range)) : 1;
      const k = Math.min(1, edge[i] / 6);
      alpha[i] = Math.round(255 * (1 - k * (1 - a)));
    }
    if (process.env.HM_DEBUG) await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).png().toFile(path.join(ROOT, 'out', 'hm-alpha.png'));
    // (one channel out, explicitly: sharp may hand back a resized greyscale image as RGB)
    const alphaFull = await sharp(alpha, { raw: { width: W, height: H, channels: 1 } }).resize(FW, FH).extractChannel(0).raw().toBuffer();
    const rgb = await sharp(Buffer.from(tex.getImage())).removeAlpha().toColourspace('srgb').raw().toBuffer();
    if (alphaFull.length !== FW * FH || rgb.length !== FW * FH * 3) throw new Error(`${file}: unexpected channel layout`);
    const rgba = Buffer.alloc(FW * FH * 4);
    for (let i = 0; i < FW * FH; i++) { rgba[i * 4] = rgb[i * 3]; rgba[i * 4 + 1] = rgb[i * 3 + 1]; rgba[i * 4 + 2] = rgb[i * 3 + 2]; rgba[i * 4 + 3] = alphaFull[i]; }
    const webp = await sharp(rgba, { raw: { width: FW, height: FH, channels: 4 } }).webp({ quality: 96, alphaQuality: 100 }).toBuffer();
    tex.setImage(new Uint8Array(webp)).setMimeType('image/webp');
    mat.setExtras({ ...mat.getExtras(), pomHeight: true });
    let cover = 0; for (let i = 0; i < W * H; i++) cover += mask[i];
    console.log(`${path.basename(file)} ${mat.getName() || 'material'}: height in normal alpha (${FW}x${FH}, islands cover ${Math.round((100 * cover) / (W * H))}%, relief range ${range.toFixed(1)} grey levels)`);
    done++;
  }
  if (done) {
    // Through a temporary file: on Windows the server or a browser can hold the GLB open for a moment.
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, await io.writeBinary(doc));
    for (let k = 0; ; k++) {
      try { fs.renameSync(tmp, file); break; } catch (e) { if (k > 20) throw e; await new Promise((r) => setTimeout(r, 250)); }
    }
  }
  return done;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ids = process.argv.slice(2).length ? process.argv.slice(2)
    : fs.readdirSync(DIR).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4));
  for (const id of ids) {
    const t0 = Date.now();
    const n = await addHeight(path.join(DIR, `${id}.glb`));
    if (!n) console.log(`${id}: no normal map`);
    else console.log(`${id}: ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
}
