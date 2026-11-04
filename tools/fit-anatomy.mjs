// Fit a species' side silhouette (body profile, fins, caudal) to traced reference photos, in 2D, and
// write the result to pc/src/anatomy/<id>.js (merged over species.js by pc/src/anatomy/index.js).
//
//   node tools/fit-anatomy.mjs clownfish                fit, using the refs marked side-on
//   node tools/fit-anatomy.mjs clownfish --dry          report only
//
// The silhouette is built with the same profile and fin-outline code as the renderer (fishModel.js), so
// what is fitted is what is drawn. Reference outlines come from pc/ref/<id>/refs.json (photo px); each
// is mirrored to face +x and both shapes are normalised to length 1 before comparing. Body depth is held
// inside the published range (species `anatomy.bodyDepthSL`), so fin size is not traded for body depth.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProfile, finOutline, caudalOutline, pelvicOutline, pectoralOutline } from '../pc/src/fishModel.js';
import { SPECIES } from '../pc/src/species.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const id = process.argv[2], dry = process.argv.includes('--dry');
const base = SPECIES.find((s) => s.id === id);
if (!base) { console.error(`unknown species ${id}`); process.exit(1); }
const refs = JSON.parse(fs.readFileSync(path.join(ROOT, 'pc', 'ref', id, 'refs.json'), 'utf8')).refs
  .filter((r) => r.sideOn && r.outline?.length > 2);
if (!refs.length) { console.error('no refs with "sideOn": true and an outline'); process.exit(1); }

// ---------- rasterising ----------
const GW = 400, GH = 360, Y0 = -0.45, Y1 = 0.45;   // grid over x in [0, 1], y in [Y0, Y1]
function raster(polys) {
  const m = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++) {
    const y = Y1 - ((j + 0.5) / GH) * (Y1 - Y0);
    for (const P of polys) {
      const xs = [];
      for (let i = 0, k = P.length - 1; i < P.length; k = i++) {
        const [xa, ya] = P[k], [xb, yb] = P[i];
        if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const c0 = Math.max(0, Math.ceil(xs[q] * GW - 0.5)), c1 = Math.min(GW - 1, Math.floor(xs[q + 1] * GW - 0.5));
        for (let c = c0; c <= c1; c++) m[j * GW + c] = 1;
      }
    }
  }
  return m;
}
// Normalise polygons (fish units or photo px, y up) so their union spans x in [0, 1], centred on y = 0.
// The transform is kept on the result (.t) so points can be mapped between model and photo.
function normalise(polys) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const P of polys) for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const s = 1 / (x1 - x0), cy = (y0 + y1) / 2;
  const out = polys.map((P) => P.map(([x, y]) => [(x - x0) * s, (y - cy) * s]));
  out.t = { x0, s, cy };
  return out;
}
const ROW = (Y1 - Y0) / GH;
function iou(a, b, shift) {   // b shifted down by `shift` rows
  let i = 0, u = 0;
  for (let j = 0; j < GH; j++) {
    const jb = j - shift;
    for (let c = 0; c < GW; c++) {
      const p = a[j * GW + c], q = jb >= 0 && jb < GH ? b[jb * GW + c] : 0;
      if (p & q) i++; if (p | q) u++;
    }
  }
  return i / Math.max(1, u);
}
const bestIoU = (a, b) => { let best = 0; for (let s = -12; s <= 12; s++) best = Math.max(best, iou(a, b, s)); return best; };

// Photo masks: mirror so the snout is at +x, flip y (image rows run down), then turn by the ref's in-plane
// rotation `rot` (degrees; the lab applies the same transform, so positive turns it anticlockwise on screen).
function photoNorm(r, rot) {
  const n = r.outline.length, cx = r.outline.reduce((s, p) => s + p[0], 0) / n, cy = r.outline.reduce((s, p) => s + p[1], 0) / n;
  const a = (-rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const P = r.outline.map(([x, y]) => {
    const dx = x - cx, dy = y - cy, rx = dx * c - dy * s, ry = dx * s + dy * c;   // rotate in image space
    return [r.mirror ? -rx : rx, -ry];
  });
  const N = normalise([P]), t = N.t;
  // Normalised coords -> photo px (inverse of the above).
  N.toPhoto = ([nx, ny]) => {
    const X = nx / t.s + t.x0, Y = ny / t.s + t.cy, rx = r.mirror ? -X : X, ry = -Y;
    return [cx + rx * c + ry * s, cy - rx * s + ry * c];
  };
  return N;
}
const photoMask = (r, rot) => raster(photoNorm(r, rot));
const photos = refs.map((r) => ({ ref: r, file: r.file, rot: r.rot ?? 0, mask: photoMask(r, r.rot ?? 0) }));
// Fish in photos are rarely level: search each ref's rotation against the current model.
function fitRotations(sp) {
  const m = raster(silhouette(sp));
  for (const ph of photos) {
    let best = -1;
    for (let d = -30; d <= 30; d += 1) {
      const mask = photoMask(ph.ref, d), v = bestIoU(m, mask);
      if (v > best) { best = v; ph.rot = d; ph.mask = mask; }
    }
  }
  console.log(`  rotations: ${photos.map((p) => `${p.file} ${p.rot}°`).join(', ')}`);
}

// ---------- procedural silhouette ----------
function silhouette(sp) {
  const prof = makeProfile(sp.body), polys = [];
  const cap = Math.min(prof.half(0), prof.width(0)) * 0.55;   // nose cap, as in bodyGeometry
  const body = [];
  for (let k = 0; k <= 6; k++) { const a = (k / 6) * Math.PI / 2; body.push([prof.x(0) + Math.cos(a) * cap, prof.centre(0) + Math.sin(a) * prof.half(0)]); }
  for (let i = 0; i <= 80; i++) { const u = i / 80; body.push([prof.x(u), prof.top(u)]); }
  for (let i = 80; i >= 0; i--) { const u = i / 80; body.push([prof.x(u), prof.bot(u)]); }
  for (let k = 6; k >= 0; k--) { const a = (k / 6) * Math.PI / 2; body.push([prof.x(0) + Math.cos(a) * cap, prof.centre(0) - Math.sin(a) * prof.half(0)]); }
  polys.push(body);
  for (const f of sp.fins) { const o = finOutline(sp, prof, f); polys.push([...o.base, ...o.outer.slice().reverse()]); }
  polys.push(caudalOutline(sp, prof).map(([x, y]) => [x, prof.centre(1) + y]));
  if (sp.pelvic) polys.push(pelvicOutline(sp, prof).outline);   // paired, but splayed only slightly: side view
  if (sp.pectoral.kind === 'fan') polys.push(pectoralOutline(sp, prof));   // lionfish wings reach past the body
  return normalise(polys);
}
// Fins on the same edge follow one another (a spiny dorsal ends where the soft dorsal begins).
const overlaps = (sp) => ['top', 'bottom'].some((pos) => {
  const fs = sp.fins.filter((f) => f.pos === pos).sort((a, b) => a.u0 - b.u0);
  return fs.some((f, i) => i > 0 && f.u0 < fs[i - 1].u1 - 0.02);
});
const score = (sp) => { if (overlaps(sp)) return 0; const m = raster(silhouette(sp)); return photos.reduce((s, p) => s + bestIoU(m, p.mask), 0) / photos.length; };

// ---------- parameters ----------
const clone = (o) => JSON.parse(JSON.stringify(o));
const A = base.anatomy || {};
const [bdLo, bdHi] = A.bodyDepthSL || [0.4, 0.55];
// Each parameter: [get, set, lo, hi] on a species clone.
const P = [];
const add = (get, set, lo, hi) => P.push({ get, set, lo, hi });
const bodyKey = (k, lo, hi) => add((s) => s.body[k] ?? 0, (s, v) => { s.body[k] = v; }, lo, hi);
// Body depth is depth/len in SL terms: the body (u in [0, 1]) is the standard length.
add((s) => s.body.depth / s.body.len, (s, v) => { s.body.depth = v * s.body.len; }, bdLo, bdHi);
bodyKey('m', 0.25, 0.6); bodyKey('headP', 0.3, 1.6); bodyKey('tailP', 0.5, 2.5); bodyKey('ped', 0.25, 0.65); bodyKey('hump', 0, 0.16);
base.fins.forEach((f, fi) => {
  add((s) => s.fins[fi].u0, (s, v) => { s.fins[fi].u0 = v; }, Math.max(0.05, f.u0 - 0.15), Math.min(0.95, f.u0 + 0.15));
  add((s) => s.fins[fi].u1, (s, v) => { s.fins[fi].u1 = v; }, Math.max(0.1, f.u1 - 0.15), Math.min(1, f.u1 + 0.1));
  if (f.kind === 'spines') { add((s) => s.fins[fi].h, (s, v) => { s.fins[fi].h = v; }, f.h * 0.5, f.h * 1.6); return; }
  add((s) => s.fins[fi].sweep ?? 0, (s, v) => { s.fins[fi].sweep = v; }, 0, 1);
  (f.pts || []).forEach((_, pi) => add((s) => s.fins[fi].pts[pi][1], (s, v) => { s.fins[fi].pts[pi][1] = v; }, 0, 0.35));
});
add((s) => s.caudal.spread, (s, v) => { s.caudal.spread = v; }, 0.08, 0.4);
if (base.pectoral.kind === 'fan') {
  const fk = (k, lo, hi) => add((s) => s.pectoral[k], (s, v) => { s.pectoral[k] = v; }, lo, hi);
  fk('len', 0.3, 0.65); fk('u', Math.max(0.1, base.pectoral.u - 0.08), base.pectoral.u + 0.08); fk('v', -0.2, 0.6);
}
if (base.pelvic) {
  const pk = (k, lo, hi) => add((s) => s.pelvic[k], (s, v) => { s.pelvic[k] = v; }, lo, hi);
  pk('u', Math.max(0.1, base.pelvic.u - 0.1), base.pelvic.u + 0.1); pk('len', 0.06, 0.25); pk('angle', 10, 70);
}

// ---------- coordinate descent ----------
let sp = clone(base);
for (const p of P) p.set(sp, Math.min(p.hi, Math.max(p.lo, p.get(sp))));   // start inside the bounds
for (const pos of ['top', 'bottom']) {   // and with the fins in sequence (an earlier fit may not be)
  const fs = sp.fins.filter((f) => f.pos === pos).sort((a, b) => a.u0 - b.u0);
  for (let i = 1; i < fs.length; i++) if (fs[i].u0 < fs[i - 1].u1 - 0.02) { const m = (fs[i].u0 + fs[i - 1].u1) / 2; fs[i - 1].u1 = m; fs[i].u0 = m; }
}
console.log(`${id}: ${photos.length} side-on refs (${photos.map((p) => p.file).join(', ')}); start IoU ${score(sp).toFixed(3)}`);
let best = 0;
for (let round = 0; round < 2; round++) {   // rotations and shape depend on each other: alternate
  fitRotations(sp);
  best = score(sp);
  for (let step = 0.12; step > 0.004; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const p of P) {
        for (const dir of [1, -1]) {
          const t = clone(sp), v = p.get(t) + dir * step * (p.hi - p.lo);
          if (v < p.lo || v > p.hi) continue;
          p.set(t, v);
          const s = score(t);
          if (s > best + 1e-4) { best = s; sp = t; improved = true; }
        }
      }
    }
  }
  console.log(`  round ${round + 1}: IoU ${best.toFixed(3)}`);
}
for (const ph of photos) console.log(`  ${ph.file}: ${bestIoU(raster(silhouette(sp)), ph.mask).toFixed(3)}`);
// ---------- bands ----------
// With the silhouettes aligned, walk the model's body midline, map each point into every photo and
// look for white (unsaturated relative to the pixel's own brightness, so exposure does not matter).
const { default: sharp } = await import('sharp');
async function measureBands(sp) {
  const polys = silhouette(sp), mt = polys.t, prof = makeProfile(sp.body), mModel = raster(polys);
  const perPhoto = [];
  for (const ph of photos) {
    let bs = 0, bv = -1;
    for (let s = -12; s <= 12; s++) { const v = iou(mModel, ph.mask, s); if (v > bv) { bv = v; bs = s; } }
    const N = photoNorm(ph.ref, ph.rot);
    const { data, info } = await sharp(path.join(ROOT, 'pc', 'ref', id, ph.file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const white = [];
    for (let i = 0; i <= 200; i++) {
      const u = i / 200, nx = (prof.x(u) - mt.x0) * mt.s, ny = (prof.centre(u) - mt.cy) * mt.s + bs * ROW;
      const [px, py] = N.toPhoto([nx, ny]);
      let hit = 0, n = 0;
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const x = Math.round(px + dx), y = Math.round(py + dy);
        if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
        const k = (y * info.width + x) * 3, mx = Math.max(data[k], data[k + 1], data[k + 2]), mn = Math.min(data[k], data[k + 1], data[k + 2]);
        n++; if (mx > 90 && mn > 0.72 * mx) hit++;
      }
      white.push(n && hit / n > 0.5);
    }
    // Runs of white along the body: [u start, u end].
    const runs = [];
    for (let i = 0, s = -1; i <= white.length; i++) {
      if (white[i] && s < 0) s = i;
      if (!white[i] && s >= 0) { if (i - s >= 3) runs.push([s / 200, (i - 1) / 200]); s = -1; }
    }
    perPhoto.push({ file: ph.file, runs });
  }
  return perPhoto;
}
const bandOps = sp.pattern.map((p, i) => [p, i]).filter(([p]) => p.op === 'band');
const measured = await measureBands(sp);
for (const m of measured) console.log(`  white runs ${m.file}: ${m.runs.map(([a, b]) => `${a.toFixed(3)}-${b.toFixed(3)}`).join(', ')}`);
const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const bands = [];
bandOps.forEach(([op, pi]) => {
  // The measured run nearest to the model's band, per photo; median over photos.
  const cs = [], ws = [];
  for (const m of measured) {
    let best = null, bd = 0.12;
    for (const [a, b] of m.runs) { const d = Math.abs((a + b) / 2 - op.u); if (d < bd) { bd = d; best = [a, b]; } }
    if (best) { cs.push((best[0] + best[1]) / 2); ws.push(best[1] - best[0]); }
  }
  if (cs.length >= 2) bands.push({ index: pi, u: median(cs), w: median(ws), from: op.u, n: cs.length });
});
for (const b of bands) console.log(`  band ${b.index}: u ${b.from} -> ${b.u.toFixed(3)}, w ${b.w.toFixed(3)} (${b.n} photos)`);

const r3 = (v) => Math.round(v * 1000) / 1000;
const fit = {
  bands: bands.map((b) => ({ index: b.index, u: r3(b.u), w: r3(b.w) })),
  body: Object.fromEntries(['depth', 'm', 'headP', 'tailP', 'ped', 'hump'].map((k) => [k, r3(sp.body[k])])),
  fins: sp.fins.map((f) => (f.kind === 'spines' ? { u0: r3(f.u0), u1: r3(f.u1), h: r3(f.h) } : { u0: r3(f.u0), u1: r3(f.u1), sweep: r3(f.sweep ?? 0), pts: f.pts?.map(([t, h]) => [t, r3(h)]) })),
  caudal: { spread: r3(sp.caudal.spread) },
  ...(sp.pelvic ? { pelvic: { u: r3(sp.pelvic.u), len: r3(sp.pelvic.len), angle: Math.round(sp.pelvic.angle) } } : {}),
  ...(sp.pectoral.kind === 'fan' ? { pectoral: { u: r3(sp.pectoral.u), v: r3(sp.pectoral.v), len: r3(sp.pectoral.len) } } : {}),
};
console.log(`  body depth ${(fit.body.depth / sp.body.len).toFixed(3)} SL (published ${bdLo}-${bdHi})`);
const atBound = P.filter((p) => { const v = p.get(sp); return v <= p.lo + 1e-6 || v >= p.hi - 1e-6; }).length;
if (atBound) console.log(`  ${atBound} parameter(s) ended on a bound`);
// --png <dir>: photo (red) vs fit (green) overlays, overlap yellow.
const pngDir = process.argv[process.argv.indexOf('--png') + 1];
if (process.argv.includes('--png') && pngDir) {
  const { default: sharp } = await import('sharp');
  const m = raster(silhouette(sp));
  for (const ph of photos) {
    let bs = 0, bv = -1;
    for (let s = -12; s <= 12; s++) { const v = iou(m, ph.mask, s); if (v > bv) { bv = v; bs = s; } }
    const buf = Buffer.alloc(GW * GH * 3);
    for (let j = 0; j < GH; j++) for (let c = 0; c < GW; c++) {
      const jb = j - bs, q = jb >= 0 && jb < GH ? ph.mask[jb * GW + c] : 0, p = m[j * GW + c], k = (j * GW + c) * 3;
      buf[k] = q ? 230 : 20; buf[k + 1] = p ? 210 : 20; buf[k + 2] = 20;
    }
    await sharp(buf, { raw: { width: GW, height: GH, channels: 3 } }).png().toFile(path.join(pngDir, `fit-${path.parse(ph.file).name}.png`));
  }
  console.log(`  overlays in ${pngDir}`);
}
if (dry) { console.log(JSON.stringify(fit, null, 1)); process.exit(0); }
// Save the fitted rotations so the lab shows each photo level too.
const refsPath = path.join(ROOT, 'pc', 'ref', id, 'refs.json'), all = JSON.parse(fs.readFileSync(refsPath, 'utf8'));
for (const ph of photos) { const r = all.refs.find((x) => x.file === ph.file); if (r) r.rot = ph.rot; }
fs.writeFileSync(refsPath, JSON.stringify(all, null, 2) + '\n');
const out = path.join(ROOT, 'pc', 'src', 'anatomy', `${id}.js`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `// Generated by tools/fit-anatomy.mjs from pc/ref/${id}/refs.json (side-on refs: ${photos.map((p) => p.file).join(', ')}).
// Mean silhouette IoU ${best.toFixed(3)}. Re-run the tool rather than editing by hand.
export default ${JSON.stringify(fit, null, 2)};
`);
console.log(`wrote ${path.relative(ROOT, out)}`);
