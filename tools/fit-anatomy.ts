// Fit a species' side silhouette (body profile, fins, caudal) to traced reference photos, in 2D, and
// write the result to src/anatomy/<id>.ts (merged over species.ts by src/anatomy/index.ts).
//
//   npm run fit-anatomy -- clownfish                fit, using the refs marked side-on
//   npm run fit-anatomy -- clownfish --dry          report only
//   npm run fit-anatomy -- yellowtang --start mouth=-0.45   start a body key elsewhere (the fit is
//                                                   local: a tilted photo can stand in for a low mouth)
//   npm run fit-anatomy -- longnose --maxrot 8      search photo rotations within ±8° only
//   npm run fit-anatomy -- clownfish --check-mirror report whether each ref's mirror flag looks right
//   npm run fit-anatomy -- clownfish --png out      photo vs fit overlays into out/
//
// The silhouette is built with the same profile and fin-outline code as the renderer (src/fishModel/),
// so what is fitted is what is drawn. Reference outlines come from web/ref/<id>/refs.json (photo px);
// each is mirrored to face +x and both shapes are normalised to length 1 before comparing. Body depth is
// held inside the published range (species `anatomy.bodyDepthSL`), so fin size is not traded for depth.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { makeProfile, type P2 } from '../src/fishModel/profile.js';
import { finOutline, caudalOutline, pelvicOutline } from '../src/fishModel/fins.js';
import { pectoralOutline } from '../src/fishModel/pectoral.js';
import { SPECIES } from '../src/species.js';
import type { BandOp, Body, Fin, FittedAnatomy, FittedFin, MembraneFin, Species } from '../src/species/types.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(name);
const option = (name: string): string | undefined => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

// ---------- reference photos ----------
interface Ref { file: string; outline: P2[]; sideOn?: boolean; mirror?: boolean; rot?: number }
interface RefsFile { refs: Record<string, unknown>[] }

const isPoint = (p: unknown): p is P2 => Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number';
function asRef(r: Record<string, unknown>): Ref | null {
  const outline = r['outline'];
  if (typeof r['file'] !== 'string' || !Array.isArray(outline) || !outline.every(isPoint)) return null;
  const ref: Ref = { file: r['file'], outline };
  if (typeof r['sideOn'] === 'boolean') ref.sideOn = r['sideOn'];
  if (typeof r['mirror'] === 'boolean') ref.mirror = r['mirror'];
  if (typeof r['rot'] === 'number') ref.rot = r['rot'];
  return ref;
}
function readRefsFile(file: string): RefsFile {
  const json: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  const refs = typeof json === 'object' && json !== null ? (json as Record<string, unknown>)['refs'] : undefined;
  if (!Array.isArray(refs)) fail(`${file}: no "refs" array`);
  return { ...(json as Record<string, unknown>), refs: refs.filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null) };
}

const id = argv[0] ?? fail('usage: npm run fit-anatomy -- <species> [--dry] [--start k=v,...] [--maxrot N] [--check-mirror] [--png dir]');
const dry = flag('--dry');
const base = SPECIES.find((s) => s.id === id) ?? fail(`unknown species ${id}`);
const refDir = path.join(ROOT, 'web', 'ref', id), refsPath = path.join(refDir, 'refs.json');
const refs = readRefsFile(refsPath).refs.map(asRef).filter((r): r is Ref => r !== null && r.sideOn === true && r.outline.length > 2);
if (!refs.length) fail('no refs with "sideOn": true and an outline');

// ---------- rasterising ----------
const GW = 400, GH = 360, Y0 = -0.45, Y1 = 0.45;   // grid over x in [0, 1], y in [Y0, Y1]
const ROW = (Y1 - Y0) / GH;
const SHIFT_RANGE = 12;                             // vertical alignment search, rows
const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;
const pt = (P: readonly P2[], i: number): P2 => P[i] ?? [0, 0];

type Mask = Uint8Array;
interface Transform { x0: number; s: number; cy: number }
interface Normalised { polys: P2[][]; t: Transform }

function raster(polys: readonly (readonly P2[])[]): Mask {
  const m = new Uint8Array(GW * GH);
  for (let j = 0; j < GH; j++) {
    const y = Y1 - ((j + 0.5) / GH) * (Y1 - Y0);
    for (const P of polys) {
      const xs: number[] = [];
      for (let i = 0, k = P.length - 1; i < P.length; k = i++) {
        const [xa, ya] = pt(P, k), [xb, yb] = pt(P, i);
        if ((ya > y) !== (yb > y)) xs.push(xa + ((y - ya) / (yb - ya)) * (xb - xa));
      }
      xs.sort((a, b) => a - b);
      for (let q = 0; q + 1 < xs.length; q += 2) {
        const c0 = Math.max(0, Math.ceil(at(xs, q) * GW - 0.5)), c1 = Math.min(GW - 1, Math.floor(at(xs, q + 1) * GW - 0.5));
        for (let c = c0; c <= c1; c++) m[j * GW + c] = 1;
      }
    }
  }
  return m;
}

/**
 * Normalises polygons (fish units or photo px, y up) so their union spans x in [0, 1], centred on y = 0.
 * The transform is kept (t) so points can be mapped between model and photo.
 */
function normalise(polys: readonly (readonly P2[])[]): Normalised {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const P of polys) for (const [x, y] of P) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  const s = 1 / (x1 - x0), cy = (y0 + y1) / 2;
  return { polys: polys.map((P) => P.map(([x, y]): P2 => [(x - x0) * s, (y - cy) * s])), t: { x0, s, cy } };
}

/** Intersection over union, with b shifted down by `shift` rows. */
function iou(a: Mask, b: Mask, shift: number): number {
  let i = 0, u = 0;
  for (let j = 0; j < GH; j++) {
    const jb = j - shift;
    for (let c = 0; c < GW; c++) {
      const p = at(a, j * GW + c), q = jb >= 0 && jb < GH ? at(b, jb * GW + c) : 0;
      if (p & q) i++;
      if (p | q) u++;
    }
  }
  return i / Math.max(1, u);
}

/** The best vertical alignment of b against a: [shift, IoU]. */
function bestShift(a: Mask, b: Mask): [number, number] {
  let bs = 0, bv = -1;
  for (let s = -SHIFT_RANGE; s <= SHIFT_RANGE; s++) { const v = iou(a, b, s); if (v > bv) { bv = v; bs = s; } }
  return [bs, bv];
}
const bestIoU = (a: Mask, b: Mask): number => bestShift(a, b)[1];

// Photo masks: mirror so the snout is at +x, flip y (image rows run down), then turn by the ref's in-plane
// rotation `rot` (degrees; the lab applies the same transform, so positive turns it anticlockwise on screen).
interface PhotoShape extends Normalised { toPhoto(p: P2): P2 }

function photoNorm(r: Ref, rot: number): PhotoShape {
  const n = r.outline.length;
  const cx = r.outline.reduce((s, p) => s + p[0], 0) / n, cy = r.outline.reduce((s, p) => s + p[1], 0) / n;
  const a = (-rot * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const P = r.outline.map(([x, y]): P2 => {
    const dx = x - cx, dy = y - cy, rx = dx * c - dy * s, ry = dx * s + dy * c;   // rotate in image space
    return [r.mirror ? -rx : rx, -ry];
  });
  const N = normalise([P]), t = N.t;
  return {
    ...N,
    // Normalised coords -> photo px (inverse of the above).
    toPhoto: ([nx, ny]) => {
      const X = nx / t.s + t.x0, Y = ny / t.s + t.cy, rx = r.mirror ? -X : X, ry = -Y;
      return [cx + rx * c + ry * s, cy - rx * s + ry * c];
    },
  };
}
const photoMask = (r: Ref, rot: number): Mask => raster(photoNorm(r, rot).polys);

interface Photo { readonly ref: Ref; readonly file: string; rot: number; mask: Mask }
const photos: Photo[] = refs.map((r) => ({ ref: r, file: r.file, rot: r.rot ?? 0, mask: photoMask(r, r.rot ?? 0) }));

// Fish in photos are rarely level: search each ref's rotation against the current model. --maxrot N
// narrows the search to ±N degrees, for when the model can't yet draw the shape and the fit would
// rather tilt the photos (a long tapering head turned into a tilt).
const DEFAULT_MAX_ROT = 30;
const maxRot = option('--maxrot') !== undefined ? Number(option('--maxrot')) : DEFAULT_MAX_ROT;
function fitRotations(sp: Species): void {
  const m = raster(silhouette(sp).polys);
  for (const ph of photos) {
    let best = -1;
    for (let d = -maxRot; d <= maxRot; d += 1) {
      const mask = photoMask(ph.ref, d), v = bestIoU(m, mask);
      if (v > best) { best = v; ph.rot = d; ph.mask = mask; }
    }
  }
  console.log(`  rotations: ${photos.map((p) => `${p.file} ${p.rot}°`).join(', ')}`);
}

// ---------- procedural silhouette ----------
const NOSE_CAP = 0.55, CAP_STEPS = 6, BODY_STEPS = 80;

function silhouette(sp: Species): Normalised {
  const prof = makeProfile(sp.body), polys: P2[][] = [];
  const cap = Math.min(prof.half(0), prof.width(0)) * NOSE_CAP;   // nose cap, as in bodyGeometry
  const capPt = (k: number, sign: number): P2 => {
    const a = (k / CAP_STEPS) * Math.PI / 2;
    return [prof.x(0) + Math.cos(a) * cap, prof.centre(0) + sign * Math.sin(a) * prof.half(0)];
  };
  const body: P2[] = [];
  for (let k = 0; k <= CAP_STEPS; k++) body.push(capPt(k, 1));
  for (let i = 0; i <= BODY_STEPS; i++) { const u = i / BODY_STEPS; body.push([prof.x(u), prof.top(u)]); }
  for (let i = BODY_STEPS; i >= 0; i--) { const u = i / BODY_STEPS; body.push([prof.x(u), prof.bot(u)]); }
  for (let k = CAP_STEPS; k >= 0; k--) body.push(capPt(k, -1));
  polys.push(body);
  for (const f of sp.fins) { const o = finOutline(sp, prof, f); polys.push([...o.base, ...o.outer.slice().reverse()]); }
  polys.push(caudalOutline(sp, prof).map(([x, y]): P2 => [x, prof.centre(1) + y]));
  if (sp.pelvic) polys.push(pelvicOutline(sp, prof).outline);   // paired, but splayed only slightly: side view
  if (sp.pectoral?.kind === 'fan') polys.push(pectoralOutline(sp, prof));   // lionfish wings reach past the body
  return normalise(polys);
}

// Fins on the same edge follow one another (a spiny dorsal ends where the soft dorsal begins).
const FIN_OVERLAP = 0.02;
const finsAt = (sp: Species, pos: 'top' | 'bottom'): Fin[] => sp.fins.filter((f) => f.pos === pos).sort((a, b) => a.u0 - b.u0);
const overlaps = (sp: Species): boolean => (['top', 'bottom'] as const).some((pos) => {
  const fs = finsAt(sp, pos);
  return fs.some((f, i) => i > 0 && f.u0 < (fs[i - 1]?.u1 ?? 0) - FIN_OVERLAP);
});
const score = (sp: Species): number => {
  if (overlaps(sp)) return 0;
  const m = raster(silhouette(sp).polys);
  return photos.reduce((s, p) => s + bestIoU(m, p.mask), 0) / photos.length;
};

// ---------- parameters ----------
const clone = <T>(o: T): T => structuredClone(o);
const DEFAULT_DEPTH_SL: [number, number] = [0.4, 0.55];
const [bdLo, bdHi] = base.anatomy?.bodyDepthSL ?? DEFAULT_DEPTH_SL;

interface Param { get(s: Species): number; set(s: Species, v: number): void; lo: number; hi: number }
const P: Param[] = [];
const add = (get: Param['get'], set: Param['set'], lo: number, hi: number): void => { P.push({ get, set, lo, hi }); };

type BodyKey = 'depth' | 'm' | 'headP' | 'tailP' | 'ped' | 'hump' | 'mouth' | 'snout' | 'snoutH';
const BODY_KEYS: readonly BodyKey[] = ['depth', 'm', 'headP', 'tailP', 'ped', 'hump', 'mouth', 'snout', 'snoutH'];
const isBodyKey = (k: string): k is BodyKey => (BODY_KEYS as readonly string[]).includes(k);
const bodyKey = (k: BodyKey, lo: number, hi: number): void => add((s) => s.body[k] ?? 0, (s, v) => { s.body[k] = v; }, lo, hi);

const finAt = (s: Species, i: number): Fin => s.fins[i] ?? fail(`fin ${i} missing`);
const membrane = (s: Species, i: number): MembraneFin => {
  const f = finAt(s, i);
  return f.kind === 'spines' ? fail(`fin ${i} is a spine row`) : f;
};

// Body depth is depth/len in SL terms: the body (u in [0, 1]) is the standard length.
add((s) => s.body.depth / s.body.len, (s, v) => { s.body.depth = v * s.body.len; }, bdLo, bdHi);
bodyKey('m', 0.25, 0.6); bodyKey('headP', 0.3, 1.6); bodyKey('tailP', 0.5, 2.5); bodyKey('ped', 0.25, 0.65); bodyKey('hump', 0, 0.16); bodyKey('mouth', -0.7, 0.2);
if (base.body.snout) { bodyKey('snout', 0.06, 0.32); bodyKey('snoutH', 0.01, 0.05); }   // butterflyfish beaks
const FIN_SHIFT = 0.15, FIN_GROW = 0.1, FIN_PT_MAX = 0.35;
// Spines thinner than this don't survive the photo traces (they read as background), so their height
// stays as written in species.ts instead of being fitted down to the membrane's outline.
const THIN_SPINE_R = 0.004;
const fitsHeight = (f: Fin): boolean => f.kind === 'spines' && f.r >= THIN_SPINE_R;
base.fins.forEach((f, fi) => {
  add((s) => finAt(s, fi).u0, (s, v) => { finAt(s, fi).u0 = v; }, Math.max(0.05, f.u0 - FIN_SHIFT), Math.min(0.95, f.u0 + FIN_SHIFT));
  add((s) => finAt(s, fi).u1, (s, v) => { finAt(s, fi).u1 = v; }, Math.max(0.1, f.u1 - FIN_SHIFT), Math.min(1, f.u1 + FIN_GROW));
  if (f.kind === 'spines') {
    const spines = (s: Species): { h: number } => { const g = finAt(s, fi); return g.kind === 'spines' ? g : fail(`fin ${fi} changed kind`); };
    if (fitsHeight(f)) add((s) => spines(s).h, (s, v) => { spines(s).h = v; }, f.h * 0.5, f.h * 1.6);
    return;
  }
  add((s) => membrane(s, fi).sweep ?? 0, (s, v) => { membrane(s, fi).sweep = v; }, 0, 1);
  f.pts.forEach((_, pi) => {
    const point = (s: Species) => membrane(s, fi).pts[pi] ?? fail(`fin ${fi} point ${pi} missing`);
    add((s) => point(s)[1], (s, v) => { point(s)[1] = v; }, 0, FIN_PT_MAX);
  });
});
add((s) => s.caudal.spread, (s, v) => { s.caudal.spread = v; }, 0.08, 0.4);
if (base.pectoral?.kind === 'fan') {
  const pu = base.pectoral.u;
  const fk = (k: 'len' | 'u' | 'v', lo: number, hi: number): void =>
    add((s) => s.pectoral?.[k] ?? 0, (s, v) => { if (s.pectoral) s.pectoral[k] = v; }, lo, hi);
  fk('len', 0.3, 0.65); fk('u', Math.max(0.1, pu - 0.08), pu + 0.08); fk('v', -0.2, 0.6);
}
if (base.pelvic) {
  const pu = base.pelvic.u;
  const pk = (k: 'u' | 'len' | 'angle', lo: number, hi: number): void =>
    add((s) => s.pelvic?.[k] ?? 0, (s, v) => { if (s.pelvic) s.pelvic[k] = v; }, lo, hi);
  pk('u', Math.max(0.1, pu - 0.1), pu + 0.1); pk('len', 0.06, 0.25); pk('angle', 10, 70);
}

// --check-mirror: each ref's best IoU against the current model as traced and mirrored. A ref whose
// `mirror` flag is wrong fits a fish facing backwards, and the shape fit bends to suit it.
const MIRROR_ROT_STEP = 2, MIRROR_MARGIN = 0.02;
if (flag('--check-mirror')) {
  const m = raster(silhouette(base).polys);
  for (const r of refs) {
    const best = (mirror: boolean): number => {
      let b = 0;
      for (let d = -DEFAULT_MAX_ROT; d <= DEFAULT_MAX_ROT; d += MIRROR_ROT_STEP) b = Math.max(b, bestIoU(m, photoMask({ ...r, mirror }, d)));
      return b;
    };
    const as = best(r.mirror === true), flip = best(r.mirror !== true);
    console.log(`  ${r.file}: mirror ${r.mirror === true} IoU ${as.toFixed(3)}, flipped ${flip.toFixed(3)}${flip > as + MIRROR_MARGIN ? '  <-- mirror looks wrong' : ''}`);
  }
  process.exit(0);
}

// ---------- coordinate descent ----------
let sp = clone(base);
const start = option('--start');
if (start) {
  for (const kv of start.split(',')) {
    const [k = '', v = ''] = kv.split('=');
    if (!isBodyKey(k)) fail(`--start: ${k} is not one of ${BODY_KEYS.join(', ')}`);
    sp.body[k] = Number(v);
  }
}
for (const p of P) p.set(sp, Math.min(p.hi, Math.max(p.lo, p.get(sp))));   // start inside the bounds
for (const pos of ['top', 'bottom'] as const) {   // and with the fins in sequence (an earlier fit may not be)
  const fs = finsAt(sp, pos);
  for (let i = 1; i < fs.length; i++) {
    const prev = fs[i - 1], cur = fs[i];
    if (prev && cur && cur.u0 < prev.u1 - FIN_OVERLAP) { const m = (cur.u0 + prev.u1) / 2; prev.u1 = m; cur.u0 = m; }
  }
}
console.log(`${id}: ${photos.length} side-on refs (${photos.map((p) => p.file).join(', ')}); start IoU ${score(sp).toFixed(3)}`);
const ROUNDS = 2, STEP0 = 0.12, STEP_MIN = 0.004, MIN_GAIN = 1e-4;
let best = 0;
for (let round = 0; round < ROUNDS; round++) {   // rotations and shape depend on each other: alternate
  fitRotations(sp);
  best = score(sp);
  for (let step = STEP0; step > STEP_MIN; step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const p of P) {
        for (const dir of [1, -1]) {
          const t = clone(sp), v = p.get(t) + dir * step * (p.hi - p.lo);
          if (v < p.lo || v > p.hi) continue;
          p.set(t, v);
          const s = score(t);
          if (s > best + MIN_GAIN) { best = s; sp = t; improved = true; }
        }
      }
    }
  }
  console.log(`  round ${round + 1}: IoU ${best.toFixed(3)}`);
}
for (const ph of photos) console.log(`  ${ph.file}: ${bestIoU(raster(silhouette(sp).polys), ph.mask).toFixed(3)}`);

// ---------- bands ----------
// With the silhouettes aligned, walk the model's body midline, map each point into every photo and
// look for white (unsaturated relative to the pixel's own brightness, so exposure does not matter).
const MIDLINE_STEPS = 200, PATCH = 3, MIN_RUN = 3;
const WHITE_MIN = 90, WHITE_RATIO = 0.72, WHITE_SHARE = 0.5;
type Run = [number, number];
interface PhotoRuns { file: string; runs: Run[] }

async function measureBands(fitSp: Species): Promise<PhotoRuns[]> {
  const model = silhouette(fitSp), mt = model.t, prof = makeProfile(fitSp.body), mModel = raster(model.polys);
  const perPhoto: PhotoRuns[] = [];
  for (const ph of photos) {
    const [bs] = bestShift(mModel, ph.mask);
    const N = photoNorm(ph.ref, ph.rot);
    const { data, info } = await sharp(path.join(refDir, ph.file)).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const white: boolean[] = [];
    for (let i = 0; i <= MIDLINE_STEPS; i++) {
      const u = i / MIDLINE_STEPS, nx = (prof.x(u) - mt.x0) * mt.s, ny = (prof.centre(u) - mt.cy) * mt.s + bs * ROW;
      const [px, py] = N.toPhoto([nx, ny]);
      let hit = 0, n = 0;
      for (let dy = -PATCH; dy <= PATCH; dy++) for (let dx = -PATCH; dx <= PATCH; dx++) {
        const x = Math.round(px + dx), y = Math.round(py + dy);
        if (x < 0 || y < 0 || x >= info.width || y >= info.height) continue;
        const k = (y * info.width + x) * 3, r = at(data, k), g = at(data, k + 1), b = at(data, k + 2);
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        n++;
        if (mx > WHITE_MIN && mn > WHITE_RATIO * mx) hit++;
      }
      white.push(n > 0 && hit / n > WHITE_SHARE);
    }
    // Runs of white along the body: [u start, u end].
    const runs: Run[] = [];
    for (let i = 0, s = -1; i <= white.length; i++) {
      const w = white[i] === true;
      if (w && s < 0) s = i;
      if (!w && s >= 0) { if (i - s >= MIN_RUN) runs.push([s / MIDLINE_STEPS, (i - 1) / MIDLINE_STEPS]); s = -1; }
    }
    perPhoto.push({ file: ph.file, runs });
  }
  return perPhoto;
}

const bandOps = sp.pattern.flatMap((p, i): [BandOp, number][] => (p.op === 'band' ? [[p, i]] : []));
const measured = await measureBands(sp);
for (const m of measured) console.log(`  white runs ${m.file}: ${m.runs.map(([a, b]) => `${a.toFixed(3)}-${b.toFixed(3)}`).join(', ')}`);
const median = (a: readonly number[]): number => { const s = [...a].sort((x, y) => x - y); return s.length ? at(s, Math.floor(s.length / 2)) : NaN; };
// White bands (clownfish) match the white runs; coloured or dark bands on a white body (copperband) match
// the gaps between them.
const WHITE_HEX_MIN = 180, BAND_SEARCH = 0.12, MIN_PHOTOS = 2;
const isWhite = (hex: string): boolean => {
  const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(...c) > WHITE_HEX_MIN && Math.min(...c) > WHITE_RATIO * Math.max(...c);
};
const gaps = (runs: readonly Run[]): Run[] => runs.slice(1).map(([a], i): Run => [runs[i]?.[1] ?? 0, a]);
interface Band { index: number; u: number; w: number; from: number; n: number }
const bands: Band[] = [];
for (const [op, pi] of bandOps) {
  // The measured run nearest to the model's band, per photo; median over photos.
  const cs: number[] = [], ws: number[] = [];
  for (const m of measured) {
    let near: Run | null = null, bd = BAND_SEARCH;
    for (const [a, b] of isWhite(op.color) ? m.runs : gaps(m.runs)) { const d = Math.abs((a + b) / 2 - op.u); if (d < bd) { bd = d; near = [a, b]; } }
    if (near) { cs.push((near[0] + near[1]) / 2); ws.push(near[1] - near[0]); }
  }
  if (cs.length >= MIN_PHOTOS) bands.push({ index: pi, u: median(cs), w: median(ws), from: op.u, n: cs.length });
}
for (const b of bands) console.log(`  band ${b.index}: u ${b.from} -> ${b.u.toFixed(3)}, w ${b.w.toFixed(3)} (${b.n} photos)`);

// ---------- result ----------
const r3 = (v: number): number => Math.round(v * 1000) / 1000;
const fitBody: Partial<Body> = {};
for (const k of BODY_KEYS) {
  if ((k === 'snout' || k === 'snoutH') && !sp.body.snout) continue;
  fitBody[k] = r3(sp.body[k] ?? 0);
}
const fitFin = (f: Fin): FittedFin => f.kind === 'spines'
  ? { u0: r3(f.u0), u1: r3(f.u1), ...(fitsHeight(f) ? { h: r3(f.h) } : {}) }
  : { u0: r3(f.u0), u1: r3(f.u1), sweep: r3(f.sweep ?? 0), pts: f.pts.map(([t, h]): [number, number] => [t, r3(h)]) };
const fit: FittedAnatomy = {
  bands: bands.map((b) => ({ index: b.index, u: r3(b.u), w: r3(b.w) })),
  body: fitBody,
  fins: sp.fins.map(fitFin),
  caudal: { spread: r3(sp.caudal.spread) },
  ...(sp.pelvic ? { pelvic: { u: r3(sp.pelvic.u), len: r3(sp.pelvic.len), angle: Math.round(sp.pelvic.angle) } } : {}),
  ...(sp.pectoral?.kind === 'fan' ? { pectoral: { u: r3(sp.pectoral.u), v: r3(sp.pectoral.v), len: r3(sp.pectoral.len) } } : {}),
};
console.log(`  body depth ${((fitBody.depth ?? 0) / sp.body.len).toFixed(3)} SL (published ${bdLo}-${bdHi})`);
const BOUND_EPS = 1e-6;
const atBound = P.filter((p) => { const v = p.get(sp); return v <= p.lo + BOUND_EPS || v >= p.hi - BOUND_EPS; }).length;
if (atBound) console.log(`  ${atBound} parameter(s) ended on a bound`);

// --png <dir>: photo (red) vs fit (green) overlays, overlap yellow.
const pngDir = option('--png');
if (pngDir) {
  const m = raster(silhouette(sp).polys);
  fs.mkdirSync(pngDir, { recursive: true });
  for (const ph of photos) {
    const [bs] = bestShift(m, ph.mask);
    const buf = Buffer.alloc(GW * GH * 3);
    for (let j = 0; j < GH; j++) for (let c = 0; c < GW; c++) {
      const jb = j - bs, q = jb >= 0 && jb < GH ? at(ph.mask, jb * GW + c) : 0, p = at(m, j * GW + c), k = (j * GW + c) * 3;
      buf[k] = q ? 230 : 20; buf[k + 1] = p ? 210 : 20; buf[k + 2] = 20;
    }
    await sharp(buf, { raw: { width: GW, height: GH, channels: 3 } }).png().toFile(path.join(pngDir, `fit-${path.parse(ph.file).name}.png`));
  }
  console.log(`  overlays in ${pngDir}`);
}
if (dry) {
  console.log(JSON.stringify(fit, null, 1));
  process.exit(0);
}

// Save the fitted rotations so the lab shows each photo level too.
const all = readRefsFile(refsPath);
for (const ph of photos) { const r = all.refs.find((x) => x['file'] === ph.file); if (r) r['rot'] = ph.rot; }
fs.writeFileSync(refsPath, JSON.stringify(all, null, 2) + '\n');
const out = path.join(ROOT, 'src', 'anatomy', `${id}.ts`);
const extra = argv.length > 1 ? ` (with ${argv.slice(1).join(' ')})` : '';
fs.writeFileSync(out, `// Generated by tools/fit-anatomy.ts from web/ref/${id}/refs.json (side-on refs: ${photos.map((p) => p.file).join(', ')}).
// Mean silhouette IoU ${best.toFixed(3)}. Re-run the tool rather than editing by hand${extra}.
import type { FittedAnatomy } from '../species/types.js';

const fitted: FittedAnatomy = ${JSON.stringify(fit, null, 2)};

export default fitted;
`);
console.log(`wrote ${path.relative(ROOT, out)} (a new species also needs registering in src/anatomy/index.ts)`);
