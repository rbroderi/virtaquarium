// The body skin: the species' pattern painted in (u, v) body space, then the imbricated scale lattice,
// pigment, melanin shading and the packed normal / iridescence / cavity-roughness maps derived from it.
import { clamp, lerp, mulberry32, makeCanvas, rgba, context2d } from '../util.js';
import type { BlotchesOp, PatternOp, RingsOp, Species, SpotsOp } from '../species/types.js';
import { cellHash, gillOf, gillU, mouthOf, naresOf, smooth01, type Profile } from './profile.js';
import { organicPass, roundCorners, wobble } from '../core/organic.js';
import { VARIANT_SEED_STRIDE } from './variant.js';

/** Skin texture size (texels); the scale maps are half this. */
export const SKIN_TEX_W = 2048, SKIN_TEX_H = 1024;
const TW = SKIN_TEX_W, TH = SKIN_TEX_H;
/** Stroke widths below were tuned at this texture width. */
const TUNED_WIDTH = 512;
const DEFAULT_SCALE_COUNT = 50;
const DEFAULT_HEAD_SCALES = 0.55;
const SPECKLE_DENSITY = 0.0012;
const MOTTLE_SPOTS = 70;
// Organic imperfection beyond the scale lattice's own jitter: the lateral line's pore row wanders, each
// scale's relief varies, and the height field is softened before the normal slope is taken.
/** The lateral line row drifts by up to this much of the body's half-depth, in ~this many swings. */
const LATERAL_LINE_WANDER = 0.05;
const LATERAL_LINE_WANDER_CYCLES = 2.5;
const LATERAL_LINE_SEED = { perIdChar: 274177, offset: 19 } as const;
/** Each scale's relief in the normal map varies by +- this fraction. */
const SCALE_RELIEF_VARY = 0.35;
/** 3 x 3 binomial passes over the height field before the normal map is taken. */
const HEIGHT_SOFTEN_PASSES = 1;

/** The four maps the skin painter makes. */
export interface SkinMaps {
  map: HTMLCanvasElement;
  normal: HTMLCanvasElement;
  irid: HTMLCanvasElement;
  cr: HTMLCanvasElement;
}

const at = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;

// Multiply the skin by the melanin shading layer, at 20% strength where the skin is white (bright and
// unsaturated) and full strength elsewhere.
export function applyShade(g: CanvasRenderingContext2D, sg: CanvasRenderingContext2D): void {
  const img = g.getImageData(0, 0, TW, TH), sh = sg.getImageData(0, 0, TW, TH).data, d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lo = Math.min(at(d, i), at(d, i + 1), at(d, i + 2)) / 255;
    const white = smooth01((lo - 0.62) / 0.25);
    const k = 1 - 0.8 * white;
    for (let c = 0; c < 3; c++) d[i + c] = at(d, i + c) * (1 - k * (1 - at(sh, i + c) / 255));
  }
  g.putImageData(img, 0, 0);
}

const patternAlpha = (p: PatternOp): number => (p.op === 'stripesV' ? p.alpha ?? 1 : 1);

interface Painter {
  g: CanvasRenderingContext2D;
  U(u: number): number;
  V(v: number): number;
  len: number;
  prof: Profile;
}

function bandPath({ g, U, V }: Painter, u: number, w: number, curve: number): void {
  g.beginPath();
  for (let i = 0; i <= 20; i++) { const v = -1.2 + (2.4 * i) / 20; g.lineTo(U(u - w / 2 + curve * (1 - v * v)), V(v)); }
  for (let i = 20; i >= 0; i--) { const v = -1.2 + (2.4 * i) / 20; g.lineTo(U(u + w / 2 + curve * (1 - v * v)), V(v)); }
  g.closePath();
}

function paintSpots(P: Painter, p: SpotsOp): void {
  const { g, U, V, len, prof } = P;
  const r2 = mulberry32(p.seed || 1);
  g.fillStyle = p.color;
  for (let i = 0; i < p.n; i++) {
    const u = lerp(p.u0, p.u1, r2()), v = lerp(p.v0, p.v1, r2());
    const h = prof.half(u), rr = p.r * (0.7 + r2() * 0.6);
    g.beginPath();
    g.ellipse(U(u), V(v), (rr / len) * TW, (rr / h) * TH / 2, 0, 0, Math.PI * 2);
    g.fill();
  }
}

// Snowflake moray: rows of dendritic dark blotches, each holding a few yellow spots, over a fine
// dark speckle. rows: [{ v, du }] (du: shift along the body, so rows alternate); r: blotch radius (TL).
function paintBlotches(P: Painter, p: BlotchesOp): void {
  const { g, U, V, len, prof } = P;
  const r2 = mulberry32(p.seed || 1);
  const dot = (u: number, v: number, rr: number): void => { g.beginPath(); g.ellipse(U(u), V(v), (rr / len) * TW, (rr / prof.half(clamp(u, 0, 1))) * TH / 2, 0, 0, Math.PI * 2); g.fill(); };
  g.fillStyle = p.speck || p.color;
  for (let i = 0; i < (p.speckN || 0); i++) dot(lerp(p.u0, 1, r2()), r2() * 2.2 - 1.1, (p.speckR ?? NaN) * (0.5 + r2()));
  for (const row of p.rows) {
    for (let i = 0; i < p.n; i++) {
      const u = lerp(p.u0, p.u1, (i + 0.5 + (r2() - 0.5) * 0.4) / p.n) + (row.du || 0), v = row.v + (r2() - 0.5) * 0.2;
      const h = prof.half(clamp(u, 0, 1)), rr = p.r * (0.75 + r2() * 0.5), k = 9;
      g.fillStyle = p.color; g.beginPath();
      for (let j = 0; j < 2 * k; j++) {
        const a = (j / (2 * k)) * Math.PI * 2, rad = rr * (j % 2 ? 0.6 + 0.2 * r2() : 0.85 + 0.45 * r2());
        g.lineTo(U(u + (Math.cos(a) * rad) / len), V(v + (Math.sin(a) * rad) / h));
      }
      g.closePath(); g.fill();
      if (p.inner) g.fillStyle = p.inner;   // (else the blotch colour stays, as an unset style would)
      for (let q = 0; q < (p.innerN || 3); q++) dot(u + ((r2() - 0.5) * rr) / len, v + ((r2() - 0.5) * rr) / h, rr * (0.1 + 0.08 * r2()));
    }
  }
}

// Bands bent round a centre (RingsOp), in physical units: u spans len TL, v spans the local half-depth.
function paintRings(P: Painter, p: RingsOp): void {
  const { g, U, V, len, prof } = P, D = Math.PI / 180;
  const at = (r: number, a: number): [number, number] => {
    const u = p.u + (r * Math.cos(a)) / len;
    return [U(u), V(p.v + (r * Math.sin(a)) / Math.max(prof.half(clamp(u, 0, 1)), 1e-3))];
  };
  g.save();
  if (p.uMax != null) { g.beginPath(); g.rect(0, 0, U(p.uMax), V(1.2) + 1); g.clip(); }
  g.fillStyle = p.color;
  const STEPS = 72;
  for (let i = 0; i < p.n; i++) {
    // each ring wanders a little in radius, so neighbours pinch together and spread apart
    const rr = (a: number, s: number): number => p.r0 + i * p.dr + s * p.w / 2 + 0.18 * p.dr * Math.sin(3 * a + i * 1.7);
    g.beginPath();
    for (let k = 0; k <= STEPS; k++) { const a = (p.a0 + ((p.a1 - p.a0) * k) / STEPS) * D; g.lineTo(...at(rr(a, -1), a)); }
    for (let k = STEPS; k >= 0; k--) { const a = (p.a0 + ((p.a1 - p.a0) * k) / STEPS) * D; g.lineTo(...at(rr(a, 1), a)); }
    g.closePath(); g.fill();
  }
  const sw = p.spokeW ?? p.w, s0 = p.spokeR0 ?? 0, s1 = p.spokeR1 ?? p.r0 + p.n * p.dr;
  for (const deg of p.spokes ?? []) {
    // a tapering bar: sideways offsets at a given radius are angles of sw / 2 / r
    const a = deg * D, side = (r: number, s: number, k: number): [number, number] => at(r, a + (s * k * sw) / 2 / Math.max(r, sw));
    g.beginPath();
    g.lineTo(...side(s0, -1, 1)); g.lineTo(...side(s1, -1, 0.6)); g.lineTo(...side(s1, 1, 0.6)); g.lineTo(...side(s0, 1, 1));
    g.closePath(); g.fill();
  }
  g.restore();
}

function paintPatternOp(P: Painter, p: PatternOp): void {
  const { g, U, V, len } = P;
  switch (p.op) {
    case 'vgrad': {
      const gr = g.createLinearGradient(0, 0, 0, TH);
      for (const [v, col] of p.stops) gr.addColorStop((v + 1) / 2, col);
      g.fillStyle = gr; g.fillRect(0, 0, TW, TH);
      break;
    }
    case 'hgrad': {
      const gr = g.createLinearGradient(0, 0, TW, 0);
      for (const [u, col] of p.stops) gr.addColorStop(u, col);
      g.fillStyle = gr; g.fillRect(0, 0, TW, TH);
      break;
    }
    case 'band': {
      if (p.edge) {
        bandPath(P, p.u, p.w + (p.ew ?? NaN) * 2 / len, p.curve);
        g.fillStyle = p.edge; g.fill();
      }
      bandPath(P, p.u, p.w, p.curve);
      g.fillStyle = p.color; g.fill();
      break;
    }
    case 'stripesV': {
      const step = (p.u1 - p.u0) / p.n;
      g.fillStyle = p.color;
      for (let i = 0; i < p.n; i++) {
        bandPath(P, p.u0 + step * (i + 0.5), step * p.ratio, 0.012 * Math.sin(i));
        g.fill();
      }
      break;
    }
    case 'stripesH': {
      g.strokeStyle = p.color;
      g.lineCap = 'round';
      for (let i = 0; i < p.n; i++) {
        const v0 = -1 + (2 * (i + 0.5)) / p.n;
        g.lineWidth = p.w * TH * 0.5;
        g.beginPath();
        for (let k = 0; k <= 30; k++) {
          const u = lerp(p.u0, p.u1, k / 30);
          const v = v0 - p.tilt * (1 - (u - p.u0) / (p.u1 - p.u0)) + 0.05 * Math.sin(u * 9 + i);
          g.lineTo(U(u), V(v));
        }
        g.stroke();
      }
      break;
    }
    case 'poly': {
      // Corners round to ~0.03 TL, in texels so a corner rounds the same way however the patch is stretched.
      g.beginPath();
      for (const [x, y] of roundCorners(p.pts.map(([u, v]) => [U(u), V(v)] as const), (POLY_CORNER_RADIUS * TW) / len)) g.lineTo(x, y);
      g.closePath();
      g.fillStyle = p.color; g.fill();
      break;
    }
    case 'blob': {
      const cx = U(p.u), cy = V(p.v), rx = p.ru * TW, ry = p.rv * TH / 2;
      g.translate(cx, cy); g.scale(1, ry / rx);
      const gr = g.createRadialGradient(0, 0, rx * (1 - p.soft), 0, 0, rx);
      gr.addColorStop(0, p.color); gr.addColorStop(1, rgba(p.color, 0));
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
      break;
    }
    case 'spots': paintSpots(P, p); break;
    case 'blotches': paintBlotches(P, p); break;
    case 'rings': paintRings(P, p); break;
  }
}

/** One cell of a scale lattice's lazily filled jitter grid. */
interface Lattice { r0: number; b0: number; nb: number; ca: Float32Array; cb: Float32Array; rr: Float32Array; id: Int32Array }

/** Per scale (compact id): tilt, reflector strength and film thickness, brightness, tint, colour sums, relief. */
interface ScaleCells { tx: number[]; ty: number[]; irS: number[]; irT: number[]; val: number[]; t0: number[]; t1: number[]; t2: number[]; sum: number[]; rel: number[] }

// ---- Organic imperfection (core/organic.ts) ----
// The skin's pattern layer is resampled through a smooth random warp, then its colour is mottled.
// The warp has two octaves (~0.07 and ~0.02 TL across, up to ~0.006 and ~0.0015 TL): the coarse one
// bends an edge and swings its angle; the fine one moves the two edges of a band apart and together,
// so its width varies. The mottle (~0.1 TL patches) varies value by ~6% and each channel by ~2.5%.
// sp.organic = { warp, mottle } scales both (default 1).
/** Pattern polygons' corners round to this radius (TL). */
const POLY_CORNER_RADIUS = 0.03;
const SKIN_WARP_OCTAVES = [[0.07, 0.006], [0.022, 0.0015]] as const;   // [cell size, amplitude] in TL
const SKIN_MOTTLE = { cell: 0.1, value: 0.06, chroma: 0.025 } as const;
const ORGANIC_SKIN_SEED = { perIdChar: 104729, offset: 71 } as const;

export function organicSkin(g: CanvasRenderingContext2D, sp: Species, prof: Profile): void {
  const o = { warp: 1, mottle: 1, ...sp.organic };
  const len = sp.body.len, Hh = 2 * prof.H;   // texture spans len along u and about 2 H across v
  const pxU = TW / len, pxV = TH / Hh;        // texels per unit length
  const oct = ([cell, amp]: readonly [number, number]) => [len / cell, Hh / cell, amp * o.warp * pxU, amp * o.warp * pxV] as const;
  organicPass(g, TW, TH, mulberry32(sp.id.length * ORGANIC_SKIN_SEED.perIdChar + ORGANIC_SKIN_SEED.offset + (sp.variant ?? 0) * VARIANT_SEED_STRIDE), {
    warp: o.warp ? SKIN_WARP_OCTAVES.map(oct) : [],
    mottle: o.mottle ? { cellsX: len / SKIN_MOTTLE.cell, cellsY: Hh / SKIN_MOTTLE.cell, value: SKIN_MOTTLE.value * o.mottle, chroma: SKIN_MOTTLE.chroma * o.mottle } : null,
  });
}

export function paintSkin(sp: Species, prof: Profile): SkinMaps {
  // willReadFrequently: these canvases are read back (scale pigment, melanin), so they stay on the CPU.
  const c = makeCanvas(TW, TH), g = context2d(c, { willReadFrequently: true });
  const U = (u: number): number => u * TW, V = (v: number): number => ((v + 1) / 2) * TH;
  const len = sp.body.len;
  const rng = mulberry32(sp.id.length * 7919 + 13 + (sp.variant ?? 0) * VARIANT_SEED_STRIDE);
  const painter: Painter = { g, U, V, len, prof };

  for (const p of sp.pattern) {
    g.save();
    g.globalAlpha = patternAlpha(p);
    paintPatternOp(painter, p);
    g.restore();
  }
  organicSkin(g, sp, prof);

  const K = TW / TUNED_WIDTH;
  const e = sp.eye, g0 = gillU(sp);

  // ---- Imbricated scales ----
  // Each scale is a disc on a staggered lattice; the more anterior scale lies on top, so the visible part
  // of every scale is its rear (free) field, which rises towards the margin and then drops onto the scale
  // behind. Evaluated at half the albedo's resolution, in physical body space:
  //  - across the body, by arc length from the lateral midline (texture v is -cos(theta), which crowds
  //    the back and belly), so scales don't stretch over the dorsal and ventral curves;
  //  - scale size follows body depth (power 0.6), so rows run on along the body and scales shrink to the
  //    peduncle and nape, as on the real fish; small scales on the cheek (sp.body.headScales, size factor);
  //  - each scale is a little out of place and size, and tilted on its own (+-6 degrees): its reflector
  //    platelets then flash scale by scale as the fish turns, instead of one sheet of sheen;
  //  - the guanine film's strength and thickness vary per scale (iridescence map R and G): neighbouring
  //    scales differ in hue and the average is near neutral, or for structural colour (sp.iridescent)
  //    stay in a narrow band.
  const SW = TW / 2, SH = TH / 2, N = SW * SH;
  const s0 = (len * (1 - g0)) / (sp.body.scales || DEFAULT_SCALE_COUNT);
  const Yarc = new Float32Array(N), halfArc = new Float32Array(SW), halfCol = new Float32Array(SW);
  for (let i = 0; i < SW; i++) {
    const u = (i + 0.5) / SW, h = prof.half(u), w = prof.width(u);
    halfCol[i] = h * 1.15;
    // Section: y = v h, z = w sqrt(1 - v^2); |d(y, z)/dv| integrated from v = 0 outwards (midpoint rule).
    const f = (v: number): number => Math.sqrt(h * h + (w * w * v * v) / Math.max(1e-4, 1 - v * v));
    for (const dir of [1, -1]) {
      let acc = 0, vp = 0;
      for (let jj = 0; jj < SH / 2; jj++) {
        const j = dir > 0 ? SH / 2 + jj : SH / 2 - 1 - jj, v = ((j + 0.5) / SH) * 2 - 1;
        for (let q = 0; q < 3; q++) acc += f(vp + ((v - vp) * (q + 0.5)) / 3) * Math.abs(v - vp) / 3;
        vp = v;
        Yarc[j * SW + i] = dir * acc;
      }
      if (dir > 0) halfArc[i] = acc;
    }
  }
  let ref = 0, nref = 0;
  for (let i = 0; i < SW; i++) { const u = (i + 0.5) / SW; if (u > g0 && u < 0.85) { ref += at(halfArc, i); nref++; } }
  ref = ref / Math.max(1, nref) || 1;
  const sCol = new Float32Array(SW), A = new Float32Array(SW), texCol = new Float32Array(SW);
  for (let i = 0, acc = 0; i < SW; i++) {
    const s = s0 * clamp((at(halfArc, i) / ref) ** 0.6, 0.5, 1.3);
    sCol[i] = s;
    const sc = at(sCol, i);   // (as stored: float32)
    A[i] = acc + (0.5 * len) / SW / sc;   // lattice coordinate along the body, in scales
    acc += len / SW / sc;
    texCol[i] = Math.min(sc / (len / SW), (sc * 0.5) / ((2 * at(halfArc, i)) / SH));   // texels per scale row
  }
  // Scales smaller than a few texels would alias into moire: they fade out (tangs' minute scales).
  const fadeAt = (i: number, k: number): number => smooth01((at(texCol, i) * k - 1.5) / 3);
  const headK = sp.body.headScales ?? DEFAULT_HEAD_SCALES, scaled = sp.body.scales !== 0;
  const cheekU0 = e.u + (e.r / len) * 1.4;
  const cheekV = Float32Array.from({ length: SW }, (_, i) => e.v + (1.3 * e.r) / prof.half((i + 0.5) / SW));   // below the eye
  const cheek = (i: number, u: number, v: number): number => smooth01((u - cheekU0) / 0.02) * smooth01((v - at(cheekV, i)) / 0.08) * smooth01((0.75 - v) / 0.1);
  const height = new Float32Array(N), cellOf = new Int32Array(N).fill(-1), maskOf = new Float32Array(N);
  const shadeImg = new ImageData(SW, SH), iridImg = new ImageData(SW, SH);
  // Cavity and roughness (one map: aoMap reads R, roughnessMap reads G). Cavity: the groove each free
  // margin overhangs, where the scale behind starts, is occluded (no ambient or environment light).
  // Roughness: the exposed field is smooth; the margin rougher, more so with a comb of spinules
  // (ctenoid: most reef perciforms) than the smooth edge of a wrasse's (cycloid) scale; scaleless skin
  // and the head are a smooth mucus film; minute scales too small to resolve (tangs: velvet) rough.
  const crImg = new ImageData(SW, SH);
  const ctenoid = (sp.body.scaleType ?? 'ctenoid') === 'ctenoid', rMargin = ctenoid ? 0.55 : 0.42;
  const rBare = !scaled ? 0.3 : 0.28, rMinute = 0.5;
  // Lateral line: the row of pored scales arching along the upper flank (each has a pore over the canal,
  // which runs under the scale as a slightly paler tube). Only fish with a gill cover have it laid out.
  // The row's arch wanders a little, so the line is irregular rather than a plotted curve.
  const hasLL = !!gillOf(sp), llJ = new Int32Array(SW).fill(-1);
  const llWob = hasLL ? wobble(mulberry32(sp.id.length * LATERAL_LINE_SEED.perIdChar + LATERAL_LINE_SEED.offset), LATERAL_LINE_WANDER_CYCLES) : null;
  for (let i = 0; hasLL && i < SW; i++) {
    const u = (i + 0.5) / SW;
    if (u < g0 + 0.01 || u > 0.95) continue;
    const t = (u - g0) / (0.95 - g0), vll = -0.5 + 0.38 * t * t + LATERAL_LINE_WANDER * (llWob ? llWob(t) : 0);
    llJ[i] = clamp(Math.round(((vll + 1) / 2) * SH - 0.5), 0, SH - 1);
  }
  const img = g.getImageData(0, 0, TW, TH), d = img.data;
  // Each lattice (the body's, and the cheek's at headK) keeps its cells' jitter in a grid filled on first
  // use: the search below tests 15 cells per texel, and hashing each every time was most of the cost.
  const lattice = (k: number): Lattice => {
    let bMax = 0;
    for (let i = 0; i < SW; i++) bMax = Math.max(bMax, at(halfArc, i) / (at(sCol, i) * 0.5 * k));
    const r0 = -3, b0 = -Math.ceil(bMax) - 4, nr = Math.ceil(at(A, SW - 1) / k) + 7, nb = 2 * (Math.ceil(bMax) + 4) + 1;
    return { r0, b0, nb, ca: new Float32Array(nr * nb).fill(NaN), cb: new Float32Array(nr * nb), rr: new Float32Array(nr * nb), id: new Int32Array(nr * nb).fill(-1) };
  };
  const L = [lattice(1), lattice(headK)] as const;
  const C: ScaleCells = { tx: [], ty: [], irS: [], irT: [], val: [], t0: [], t1: [], t2: [], sum: [], rel: [] };
  const sd = shadeImg.data, id = iridImg.data, cd = crImg.data;
  for (let j = 0; j < SH; j++) {
    const v = ((j + 0.5) / SH) * 2 - 1;
    for (let i = 0; i < SW; i++) {
      const u = (i + 0.5) / SW, p = j * SW + i, o = p * 4, head = u < g0 - 0.005, k = head ? headK : 1;
      const mask = !scaled ? 0 : (head ? cheek(i, u, v) : smooth01((u - g0 + 0.005) / 0.03)) * fadeAt(i, k);
      sd[o + 3] = id[o + 3] = cd[o + 3] = 255;
      // Unscaled skin here: bare (head, moray), or scales too small to resolve (faded out: velvet).
      const bodyAt = !scaled || head ? 0 : smooth01((u - g0 + 0.005) / 0.03);
      const rBase = lerp(rBare, rMinute, bodyAt * (1 - fadeAt(i, 1)));
      cd[o] = 255; cd[o + 1] = rBase * 255;
      if (mask <= 0.002) {
        sd[o] = sd[o + 1] = sd[o + 2] = 255;
        id[o] = 0; id[o + 1] = 128;
        continue;
      }
      const G = L[head ? 1 : 0], hk = head ? 7 : 0;
      const a = at(A, i) / k, b = at(Yarc, p) / (at(sCol, i) * 0.5 * k);
      let best = Infinity, bt = 0, bd = 1, bq = -1, bri = 0, brb = 0, bda = 0, bdb = 0, near = Infinity;
      const jr = Math.round(b);
      for (let rb = jr - 2; rb <= jr + 2; rb++) {
        const off = (rb & 1) * 0.5, ir = Math.round(a - off);
        for (let ri = ir - 1; ri <= ir + 1; ri++) {
          const q = (ri - G.r0) * G.nb + (rb - G.b0);
          const filled = G.ca[q];
          if (filled !== filled) {   // NaN: not filled yet
            G.ca[q] = ri + off + (cellHash(ri, rb, 1 + hk) - 0.5) * 0.16;
            G.cb[q] = rb + (cellHash(ri, rb, 2 + hk) - 0.5) * 0.16;
            G.rr[q] = 0.75 * (1 + (cellHash(ri, rb, 3 + hk) - 0.5) * 0.16);
          }
          const ca = at(G.ca, q), rr = at(G.rr, q), da = a - ca, db = (b - at(G.cb, q)) * 0.5, d2 = da * da + db * db;
          // Covered by this scale and it is the most anterior so far; else remember the nearest centre
          // (jitter can leave a pinhole that no disc covers).
          if (d2 < rr * rr ? ca < best : best === Infinity && d2 / (rr * rr) < near) {
            if (d2 < rr * rr) best = ca; else near = d2 / (rr * rr);
            bt = da / rr; bd = Math.min(1, Math.sqrt(d2) / rr); bq = q; bri = ri; brb = rb; bda = da; bdb = db;
          }
        }
      }
      let cell = at(G.id, bq);
      if (cell < 0) {
        cell = G.id[bq] = C.tx.length;
        const H = (n: number): number => cellHash(bri, brb, n + hk);
        // (Tilt kept small: with almost no surface reflection under water it shows mostly in the diffuse
        // shading, and at the +-6 degrees of the platelets the flank read as crumpled stucco.)
        C.tx.push((H(4) + H(5) + H(6) - 1.5) * 0.07); C.ty.push((H(7) + H(8) + H(9) - 1.5) * 0.07);
        C.irS.push(0.55 + 0.65 * H(10)); C.irT.push(H(11));
        C.val.push(H(12) - 0.5); C.t0.push(H(13) - 0.5); C.t1.push(H(14) - 0.5); C.t2.push(H(15) - 0.5);
        C.rel.push(1 + SCALE_RELIEF_VARY * (H(16) - 0.5));
        C.sum.push(0, 0, 0, 0);
      }
      cellOf[p] = cell; maskOf[p] = mask;
      const pa = ((2 * j) * TW + 2 * i) * 4, cs = cell * 4;
      C.sum[cs] = at(C.sum, cs) + at(d, pa); C.sum[cs + 1] = at(C.sum, cs + 1) + at(d, pa + 1);
      C.sum[cs + 2] = at(C.sum, cs + 2) + at(d, pa + 2); C.sum[cs + 3] = at(C.sum, cs + 3) + 1;
      const ss = at(sCol, i) * k, hn = 0.5 + 0.5 * bt + 0.25 * (1 - bd * bd);
      height[p] = (hn * 0.08 * at(C.rel, cell) + at(C.tx, cell) * bda + at(C.ty, cell) * bdb) * ss * mask;
      // Pigment pocket along each scale's free margin; slightly paler centres.
      const pocket = smooth01((bd - 0.72) / 0.28) * (bt > 0 ? 1 : 0.3);
      let sh = 1 - mask * (0.2 * pocket - 0.04 * (1 - bd));
      let ao = 0.6 + 0.4 * smooth01(hn / 0.55);   // low at the front of the exposed field, under the margin ahead
      const ll = at(llJ, i);
      if (!head && ll >= 0 && Math.abs(brb - at(Yarc, ll * SW + i) / (at(sCol, i) * 0.5)) < 0.5) {
        const pore = Math.exp(-(((bda - 0.35) ** 2 + bdb * bdb) / 0.012));
        height[p] = at(height, p) - ss * 0.035 * pore * mask;
        ao *= 1 - 0.35 * pore;
        if (Math.abs(bdb) < 0.07 && bda > -0.3 && bda < 0.45) sh += (1 - sh) * 0.5;   // the canal, paler
      }
      const rough = lerp(0.3, rMargin, smooth01((bd - 0.75) / 0.25) * (bt > 0 ? 1 : 0));
      cd[o] = lerp(1, ao, mask) * 255;
      cd[o + 1] = lerp(rBase, rough, mask) * 255;
      sd[o] = sd[o + 1] = sd[o + 2] = clamp(sh, 0, 1) * 255;
      // Guanine platelets: reflective exposed fields, strongest on the flanks and belly, each scale its own.
      const irv = mask * (0.35 + 0.65 * smooth01((v + 0.4) / 1.2)) * (0.6 + 0.4 * (bt * 0.5 + 0.5)) * at(C.irS, cell);
      id[o] = clamp(irv, 0, 1) * 255;
      id[o + 1] = lerp(0.5, clamp(0.12 + 0.72 * at(C.irT, cell) + 0.16 * (bt * 0.5 + 0.5), 0, 1), mask) * 255;
    }
  }
  // Chromatophores: fine dark speckle, 1-2 texels, densest on the back (sp.speckle scales the count);
  // white (leucophore) skin takes a fifth of it, as with the melanin layer below.
  const speck = new Uint8Array(TW * TH);
  for (let n = 0, nn = Math.round(TW * TH * SPECKLE_DENSITY * (sp.speckle ?? 1)); n < nn; n++) {
    const x = Math.floor(rng() * TW), y = Math.floor(rng() * TH), big = rng() < 0.4;
    if (rng() > 0.3 + 0.7 * (1 - y / TH)) continue;
    speck[y * TW + x] = 1;
    if (big) { if (x + 1 < TW) speck[y * TW + x + 1] = 1; if (y + 1 < TH) speck[(y + 1) * TW + x] = 1; }
  }
  // Pigment follows the scales: each scale's colour pulls a quarter of the way to its own mean (half
  // smeared stripes narrower than a scale, the emperor angel's, into beads), so pattern edges step
  // along scale outlines (on real fish a band ends at a row of scales, not on a vector curve), and each
  // scale is a little lighter or darker than its neighbours (more so in dark areas).
  for (let y = 0; y < TH; y++) for (let x = 0; x < TW; x++) {
    const o = (y * TW + x) * 4;
    if (speck[y * TW + x]) {
      const white = smooth01((Math.min(at(d, o), at(d, o + 1), at(d, o + 2)) / 255 - 0.62) / 0.25), s = 0.76 + 0.24 * 0.8 * white;
      d[o] = at(d, o) * s; d[o + 1] = at(d, o + 1) * s; d[o + 2] = at(d, o + 2) * s;
    }
    const p = (y >> 1) * SW + (x >> 1), cell = at(cellOf, p);
    if (cell < 0) continue;
    const cs = cell * 4, m = at(maskOf, p), n = at(C.sum, cs + 3), w = 0.25 * m;
    const lum = (at(d, o) + at(d, o + 1) + at(d, o + 2)) / 765, jit = m * (1 + (1 - lum)), val = 1 + at(C.val, cell) * 0.05 * jit;
    d[o] = clamp((at(d, o) + (at(C.sum, cs) / n - at(d, o)) * w) * val * (1 + at(C.t0, cell) * 0.02 * jit), 0, 255);
    d[o + 1] = clamp((at(d, o + 1) + (at(C.sum, cs + 1) / n - at(d, o + 1)) * w) * val * (1 + at(C.t1, cell) * 0.02 * jit), 0, 255);
    d[o + 2] = clamp((at(d, o + 2) + (at(C.sum, cs + 2) / n - at(d, o + 2)) * w) * val * (1 + at(C.t2, cell) * 0.02 * jit), 0, 255);
  }
  g.putImageData(img, 0, 0);

  // Melanin shading (countershading, mottling, scale-margin pockets below) goes into its own multiply
  // layer, applied after the scales. White pattern areas are leucophores and iridophores that stay bright,
  // so they take only a fifth of it.
  const shade = makeCanvas(TW, TH), sg = context2d(shade, { willReadFrequently: true });
  sg.fillStyle = '#ffffff'; sg.fillRect(0, 0, TW, TH);
  sg.globalCompositeOperation = 'multiply';
  // Countershading (darker back, paler belly, as on nearly every reef fish) and soft mottling.
  let gr = sg.createLinearGradient(0, 0, 0, TH);
  gr.addColorStop(0, '#d8d8d8'); gr.addColorStop(0.45, '#f4f4f4'); gr.addColorStop(1, '#ffffff');
  sg.fillStyle = gr; sg.fillRect(0, 0, TW, TH);
  g.save();
  g.globalCompositeOperation = 'screen';
  gr = g.createLinearGradient(0, 0, 0, TH);
  gr.addColorStop(0.55, 'rgba(255,255,255,0)'); gr.addColorStop(1, 'rgba(255,255,255,0.16)');
  g.fillStyle = gr; g.fillRect(0, 0, TW, TH);
  for (let i = 0; i < MOTTLE_SPOTS; i++) {
    const x = rng() * TW, y = rng() * TH, r = (20 + rng() * 60) * K, dark = rng() < 0.5;
    const t = dark ? sg : g;
    t.globalCompositeOperation = dark ? 'multiply' : 'screen';
    const m = t.createRadialGradient(x, y, 0, x, y, r);
    m.addColorStop(0, dark ? 'rgba(200,200,200,0.35)' : 'rgba(255,255,255,0.05)'); m.addColorStop(1, 'rgba(255,255,255,0)');
    t.fillStyle = m; t.fillRect(x - r, y - r, r * 2, r * 2);
  }
  g.restore();
  sg.globalCompositeOperation = 'multiply';

  // Gill cover: a soft shadow behind its rear margin (the margin itself is a step in the body mesh,
  // with the gill opening under it), and the fainter pre-opercle groove ahead of it. (No painted lit
  // lip: a highlight in the colour map stays lit on the shadow side.)
  const G = gillOf(sp);
  g.lineCap = 'round';
  if (G) {
    const gillPath = (du: number, shrink: number): void => {   // the margin's curve, shifted du and shortened at both ends
      g.beginPath();
      for (let i = 0; i <= 24; i++) {
        const v = lerp(G.top * shrink + (1 - shrink) * (G.top + G.bot) / 2, G.bot * shrink + (1 - shrink) * (G.top + G.bot) / 2, i / 24);
        g.lineTo(U(G.edge(v) + du), V(v));
      }
    };
    g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 3.5 * K; gillPath((2 * K) / TW, 1); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1.5 * K; gillPath(-0.05, 0.75); g.stroke();
    // (The lateral line is a row of pored scales in the scale lattice above, not painted marks.)
  }
  // Mouth: the gape is lined dark (the inside of the mouth); the jaw seam in the body mesh stretches
  // over this lining when the lower jaw drops. The lips (raised in the mesh) are a little darker.
  {
    const M = mouthOf(sp), lw = (M.lining ?? 0.03) * TH / 2;
    g.globalCompositeOperation = 'multiply';
    g.strokeStyle = 'rgba(170,150,145,0.55)'; g.lineWidth = lw * 3.2; g.lineCap = 'round';
    g.beginPath(); g.moveTo(U(-0.01), V(M.v0)); g.lineTo(U(M.u), V(M.v)); g.stroke();
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = '#2a0e10'; g.lineWidth = lw; g.lineCap = 'round';
    g.beginPath(); g.moveTo(U(-0.01), V(M.v0)); g.lineTo(U(M.u), V(M.v)); g.stroke();
  }
  // Nostrils: two small openings each side between the eye and the snout tip, the rear one just
  // ahead of the eye and a little higher (pits with a raised rim in the normal map below, which the
  // light catches as it really falls; dark inside).
  const nares = sp.nares === false ? [] : naresOf(sp);
  for (const n of nares) {
    const rx = (n.r / len) * TW, ry = (n.r / prof.half(n.u)) * TH / 2;
    g.fillStyle = 'rgba(10,6,6,0.55)';
    g.beginPath(); g.ellipse(U(n.u), V(n.v), rx, ry, 0, 0, Math.PI * 2); g.fill();
  }
  // Tangs' caudal spine (sp.scalpel): a blade that lies in a groove on the peduncle, its sheath
  // outlined dark (raised in the mesh by reliefOf).
  if (sp.scalpel) {
    // A lance: sharp at the front (the free point), rounder at the hinged rear.
    const S = sp.scalpel, rx = (S.len / 2) * TW, ry = ((S.len * len * 0.11) / prof.half(S.u)) * TH / 2;
    const blade = (k: number): void => {
      const cx = U(S.u), cy = V(S.v);
      g.beginPath(); g.moveTo(cx - rx * k, cy);
      g.quadraticCurveTo(cx - rx * 0.2, cy - ry * 2 * k, cx + rx * k, cy - ry * 0.3 * k);
      g.quadraticCurveTo(cx + rx * 1.15 * k, cy, cx + rx * k, cy + ry * 0.3 * k);
      g.quadraticCurveTo(cx - rx * 0.2, cy + ry * 2 * k, cx - rx * k, cy);
    };
    g.fillStyle = 'rgba(0,0,0,0.35)'; blade(1.12); g.fill();   // the groove it lies in
    g.fillStyle = S.color; blade(1); g.fill();
  }
  // Orbit: only a faint shading where the skin rolls into the socket (photos show a soft rim, not a
  // dark ring).
  {
    const ex = U(e.u), ey = V(e.v), rx = (e.r / len) * TW * 1.3;
    g.save(); g.translate(ex, ey); g.scale(1, ((e.r / prof.half(e.u)) * TH / 2) / ((e.r / len) * TW));
    const o = g.createRadialGradient(0, 0, rx * 0.75, 0, 0, rx);
    o.addColorStop(0, 'rgba(0,0,0,0.1)'); o.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = o; g.beginPath(); g.arc(0, 0, rx, 0, Math.PI * 2); g.fill();
    g.restore();
  }

  // Nostril pits: a hollow with a slightly raised rim, in the same physical units as the scales.
  for (const n of nares) {
    const i0 = Math.floor((n.u - (3 * n.r) / len) * SW), i1 = Math.ceil((n.u + (3 * n.r) / len) * SW);
    for (let i = Math.max(0, i0); i <= Math.min(SW - 1, i1); i++) {
      const hc = at(halfCol, i), j0 = Math.floor(((n.v + 1) / 2 - (3 * n.r) / (2 * hc)) * SH), j1 = Math.ceil(((n.v + 1) / 2 + (3 * n.r) / (2 * hc)) * SH);
      for (let j = Math.max(0, j0); j <= Math.min(SH - 1, j1); j++) {
        const du = (((i + 0.5) / SW) - n.u) * len, dv = ((((j + 0.5) / SH) * 2 - 1) - n.v) * hc, dd = Math.hypot(du, dv) / n.r;
        const q = j * SW + i;
        height[q] = at(height, q) + n.r * (0.25 * Math.exp(-(((dd - 1.1) / 0.35) ** 2)) - 0.7 * Math.exp(-dd * dd * 1.5));
        cd[q * 4] = at(cd, q * 4) * (1 - 0.5 * Math.exp(-dd * dd * 1.5));   // the pit is occluded
      }
    }
  }
  const shadeC = makeCanvas(SW, SH); context2d(shadeC).putImageData(shadeImg, 0, 0);
  sg.drawImage(shadeC, 0, 0, TW, TH);
  applyShade(g, sg);
  const irid = makeCanvas(SW, SH); context2d(irid).putImageData(iridImg, 0, 0);

  // Soften the height field before taking the slope (a 3 x 3 binomial), so the scale and pore edges read
  // as overlapping tissue rather than ruled boundaries.
  let soft = height, tmp = new Float32Array(N);
  for (let pass = 0; pass < HEIGHT_SOFTEN_PASSES; pass++) {
    for (let j = 0; j < SH; j++) for (let i = 0; i < SW; i++) {
      const up = Math.max(0, j - 1) * SW, dn = Math.min(SH - 1, j + 1) * SW, lf = Math.max(0, i - 1), rt = Math.min(SW - 1, i + 1), p = j * SW + i;
      tmp[p] = (at(soft, p) * 4 + (at(soft, j * SW + lf) + at(soft, j * SW + rt) + at(soft, up + i) + at(soft, dn + i)) * 2
        + at(soft, up + lf) + at(soft, up + rt) + at(soft, dn + lf) + at(soft, dn + rt)) / 16;
    }
    [soft, tmp] = [tmp, soft];
  }
  const heightS = soft;

  // Tangent-space normal map from the height field (OpenGL convention; canvas rows run down = -v).
  // Across the body the rows' spacing is their arc length (Yarc), as the scales were laid out.
  const normalImg = new ImageData(SW, SH), nd = normalImg.data;
  const du = len / SW;
  for (let j = 0; j < SH; j++) {
    for (let i = 0; i < SW; i++) {
      const j0 = Math.max(0, j - 1) * SW + i, j1 = Math.min(SH - 1, j + 1) * SW + i;
      const hx = (at(heightS, j * SW + Math.min(SW - 1, i + 1)) - at(heightS, j * SW + Math.max(0, i - 1))) / (2 * du);
      const hy = (at(heightS, j1) - at(heightS, j0)) / Math.max(1e-6, at(Yarc, j1) - at(Yarc, j0));
      const nx = -hx, ny = hy, inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), k = (j * SW + i) * 4;
      nd[k] = (nx * inv * 0.5 + 0.5) * 255;
      nd[k + 1] = (ny * inv * 0.5 + 0.5) * 255;
      nd[k + 2] = (inv * 0.5 + 0.5) * 255;
      nd[k + 3] = 255;
    }
  }
  const normal = makeCanvas(SW, SH); context2d(normal).putImageData(normalImg, 0, 0);
  const cr = makeCanvas(SW, SH); context2d(cr).putImageData(crImg, 0, 0);
  return { map: c, normal, irid, cr };
}
