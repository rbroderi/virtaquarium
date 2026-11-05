// Builds a 3D fish from a species description:
//  - body: lofted elliptical cross-sections following the species' side profile
//  - skin: pattern painted in (u, v) body space onto a canvas texture
//  - fins: one transparent "fin sheet" through the midline (dorsal, anal, caudal) + pectorals
//  - swimming: vertex shader bends everything in a travelling wave (tail beats harder than head)
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, lerp, mulberry32, makeCanvas, shade, rgba } from './util.js';
import { addCaustics } from './water.js';

// ---------- side profile ----------

export function makeProfile(body) {
  const snout = body.snout || 0, snoutH = body.snoutH || 0;
  const m = body.m, ped = body.ped, H = body.depth / 2;
  // snoutTip: the tube's height at the mouth as a share of its height at the base (a butterflyfish beak
  // barely tapers; a tang's snout is a cone). snoutBlend: the fillet (body units) where the tube runs
  // into the face, instead of a sharp step.
  const tip = body.snoutTip ?? 0.75, blend = body.snoutBlend ?? 0;
  const smax = (a, b, k) => { if (k <= 0) return Math.max(a, b); const h = clamp(0.5 + 0.5 * (a - b) / k, 0, 1); return lerp(b, a, h) + k * h * (1 - h); };
  const half = (u) => {
    if (u < snout) return snoutH * (tip + (1 - tip) * (u / snout));
    const uu = (u - snout) / (1 - snout);
    let f;
    // Convex head that ends in a blunt terminal mouth (snouted species end in their tube instead).
    if (uu < m) f = (snout ? 0 : 0.17) + (snout ? 1 : 0.83) * Math.pow(Math.sin((Math.PI / 2) * (uu / m)), body.headP);
    else f = ped + (1 - ped) * Math.pow(Math.cos((Math.PI / 2) * ((uu - m) / (1 - m))), body.tailP);
    return snout ? smax(H * f, snoutH, blend) : Math.max(H * f, 0.012);
  };
  const x = (u) => 0.5 - u * body.len;
  const halfM = half;
  const mEnd = snout + m * (1 - snout);
  // snoutW: the snout's width over its height (a butterflyfish beak is round; a tang's is flattened).
  // headW: the head's width at the snout relative to the usual, easing back to 1 by the deepest point:
  // strongly compressed fish narrow to a wedge at the front rather than carrying their width forward.
  const headW = body.headW ?? 1;
  const width = (u) => Math.max(halfM(u) * body.width * (1.15 - 0.55 * u) * lerp(headW, 1, smooth01(u / mEnd)),
    snout && u < snout ? (body.snoutTip != null ? half(u) : snoutH) * (body.snoutW ?? 0.9) : 0.004);   // a tapered snout narrows too
  // The back arches above the midline (epaxial muscle) while the mouth and tail stay on it.
  const hump = body.hump ?? 0.05;
  // mouth: the snout's height off the midline (in H; negative is below). Tangs and butterflyfish carry
  // the mouth low under a steep forehead; the midline eases back to level by the deepest point.
  const mouth = body.mouth ?? 0;
  const centre = (u) => hump * H * Math.sin(Math.PI * Math.min(1, u * 1.05)) ** 1.5 + mouth * H * (1 - smooth01(u / mEnd));
  const top = (u) => centre(u) + halfM(u), bot = (u) => centre(u) - halfM(u);
  return { half: halfM, x, width, centre, top, bot, H, xPed: x(1) };
}

const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
// Integer hash of a scale's lattice cell (a, b) and a channel k, to [0, 1): per-scale variation that is
// the same every load (the Roku bake must reproduce).
const cellHash = (a, b, k) => {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul((b | 0) + 0x9e37, 0x165667b1) ^ Math.imul((k | 0) + 1, 0x85ebca6b);
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d); h ^= h >>> 12; h = Math.imul(h, 0x297a2d39); h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
};

// Rear edge of the gill cover (operculum), in body u.
export const gillU = (sp) => sp.eye.u + (0.09 / sp.body.len) + sp.eye.r * 0.6;

// The gill cover's free rear margin: it bows back in the middle (u at its ends, g0 - bow at the
// middle) and runs from about level with the top of the pectoral base (v = top) down and forward
// to the throat (v = bot). Null for fish without a gill cover (morays: a small round gill opening).
const gills = new WeakMap();
export function gillOf(sp) {
  if (sp.gill === false) return null;
  if (gills.has(sp)) return gills.get(sp);
  const G = { u: gillU(sp), bow: 0.035, top: -0.55, bot: 0.85 };
  const s = (v) => (2 * v - G.top - G.bot) / (G.bot - G.top);   // -1 at the top end, +1 at the throat
  G.edge = (v) => G.u - G.bow * Math.max(0, 1 - s(v) ** 2);
  G.fade = (v) => 1 - smooth01((Math.abs(s(v)) - 0.7) / 0.3);   // the margin closes at its ends
  gills.set(sp, G);
  return G;
}

// Nostrils (nares), each side: the posterior one just ahead of the eye and a little above its
// centre, the anterior one further forward; r in body units (about a tenth of the eye's radius).
export function naresOf(sp) {
  const e = sp.eye, len = sp.body.len, sn = sp.body.snout || 0;
  // On the face, not out on a snout: snouted fish have them just ahead of the eye.
  // (and back from the nose's rounded tip, where they would stretch over its front)
  const lo = sn ? sn + 0.45 * (e.u - e.r / len - sn) : Math.max(0.025, 0.3 * e.u), front = e.u - e.r / len;
  const uA = Math.max(lo, e.u - (e.r * 2.9) / len), uP = Math.max((uA + front) / 2, e.u - (e.r * 1.7) / len);
  return [
    { u: uP, v: e.v - 0.05, r: Math.min(e.r * 0.14, 0.0055) },
    { u: uA, v: e.v + 0.06, r: Math.min(e.r * 0.11, 0.0045) },
  ];
}

// The mouth, for the hinged lower jaw and the lips: the gape runs from the tip (v0) back to the corner
// of the mouth (u, v), where the lower jaw hinges (v as for the eye: +1 is ventral). sp.mouth sets it
// (the moray's long gape); otherwise a small terminal mouth ending under the front of the eye, or a
// tiny one at the end of a snout.
export function mouthOf(sp) {
  if (sp.mouth) return sp.mouth;
  const sn = sp.body.snout || 0;
  return sn ? { u: Math.min(0.03, sn * 0.25), v: 0.12, v0: 0.04 } : { u: sp.eye.u * 0.55, v: 0.2, v0: 0.08 };
}

// ---------- skin texture ----------

const TW = 2048, TH = 1024;

// Multiply the skin by the melanin shading layer, at 20% strength where the skin is white (bright and
// unsaturated) and full strength elsewhere.
function applyShade(g, sg) {
  const img = g.getImageData(0, 0, TW, TH), sh = sg.getImageData(0, 0, TW, TH).data, d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const lo = Math.min(d[i], d[i + 1], d[i + 2]) / 255;
    const white = smooth01((lo - 0.62) / 0.25);
    const k = 1 - 0.8 * white;
    for (let c = 0; c < 3; c++) d[i + c] *= 1 - k * (1 - sh[i + c] / 255);
  }
  g.putImageData(img, 0, 0);
}

function paintSkin(sp, prof) {
  // willReadFrequently: these canvases are read back (scale pigment, melanin), so they stay on the CPU.
  const c = makeCanvas(TW, TH), g = c.getContext('2d', { willReadFrequently: true });
  const U = (u) => u * TW, V = (v) => ((v + 1) / 2) * TH;
  const len = sp.body.len;
  const rng = mulberry32(sp.id.length * 7919 + 13);

  const bandPath = (u, w, curve) => {
    g.beginPath();
    for (let i = 0; i <= 20; i++) { const v = -1.2 + (2.4 * i) / 20; g.lineTo(U(u - w / 2 + curve * (1 - v * v)), V(v)); }
    for (let i = 20; i >= 0; i--) { const v = -1.2 + (2.4 * i) / 20; g.lineTo(U(u + w / 2 + curve * (1 - v * v)), V(v)); }
    g.closePath();
  };

  for (const p of sp.pattern) {
    g.save();
    g.globalAlpha = p.alpha ?? 1;
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
          bandPath(p.u, p.w + p.ew * 2 / len, p.curve);
          g.fillStyle = p.edge; g.fill();
        }
        bandPath(p.u, p.w, p.curve);
        g.fillStyle = p.color; g.fill();
        break;
      }
      case 'stripesV': {
        const step = (p.u1 - p.u0) / p.n;
        g.fillStyle = p.color;
        for (let i = 0; i < p.n; i++) {
          bandPath(p.u0 + step * (i + 0.5), step * p.ratio, 0.012 * Math.sin(i));
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
        g.beginPath();
        for (const [u, v] of p.pts) g.lineTo(U(u), V(v));
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
      case 'spots': {
        const r2 = mulberry32(p.seed || 1);
        g.fillStyle = p.color;
        for (let i = 0; i < p.n; i++) {
          const u = lerp(p.u0, p.u1, r2()), v = lerp(p.v0, p.v1, r2());
          const h = prof.half(u), rr = p.r * (0.7 + r2() * 0.6);
          g.beginPath();
          g.ellipse(U(u), V(v), (rr / len) * TW, (rr / h) * TH / 2, 0, 0, Math.PI * 2);
          g.fill();
        }
        break;
      }
      case 'blotches': {
        // Snowflake moray: rows of dendritic dark blotches, each holding a few yellow spots, over a fine
        // dark speckle. rows: [{ v, du }] (du: shift along the body, so rows alternate); r: blotch radius (TL).
        const r2 = mulberry32(p.seed || 1);
        const dot = (u, v, rr) => { g.beginPath(); g.ellipse(U(u), V(v), (rr / len) * TW, (rr / prof.half(clamp(u, 0, 1))) * TH / 2, 0, 0, Math.PI * 2); g.fill(); };
        g.fillStyle = p.speck || p.color;
        for (let i = 0; i < (p.speckN || 0); i++) dot(lerp(p.u0, 1, r2()), r2() * 2.2 - 1.1, p.speckR * (0.5 + r2()));
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
            g.fillStyle = p.inner;
            for (let q = 0; q < (p.innerN || 3); q++) dot(u + ((r2() - 0.5) * rr) / len, v + ((r2() - 0.5) * rr) / h, rr * (0.1 + 0.08 * r2()));
          }
        }
        break;
      }
    }
    g.restore();
  }

  const K = TW / 512;   // stroke widths below were tuned at 512 px
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
  const s0 = (len * (1 - g0)) / (sp.body.scales || 50);
  const Yarc = new Float32Array(N), halfArc = new Float32Array(SW), halfCol = new Float32Array(SW);
  for (let i = 0; i < SW; i++) {
    const u = (i + 0.5) / SW, h = prof.half(u), w = prof.width(u);
    halfCol[i] = h * 1.15;
    // Section: y = v h, z = w sqrt(1 - v^2); |d(y, z)/dv| integrated from v = 0 outwards (midpoint rule).
    const f = (v) => Math.sqrt(h * h + (w * w * v * v) / Math.max(1e-4, 1 - v * v));
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
  for (let i = 0; i < SW; i++) { const u = (i + 0.5) / SW; if (u > g0 && u < 0.85) { ref += halfArc[i]; nref++; } }
  ref = ref / Math.max(1, nref) || 1;
  const sCol = new Float32Array(SW), A = new Float32Array(SW), texCol = new Float32Array(SW);
  for (let i = 0, acc = 0; i < SW; i++) {
    sCol[i] = s0 * clamp((halfArc[i] / ref) ** 0.6, 0.5, 1.3);
    A[i] = acc + (0.5 * len) / SW / sCol[i];   // lattice coordinate along the body, in scales
    acc += len / SW / sCol[i];
    texCol[i] = Math.min(sCol[i] / (len / SW), (sCol[i] * 0.5) / ((2 * halfArc[i]) / SH));   // texels per scale row
  }
  // Scales smaller than a few texels would alias into moire: they fade out (tangs' minute scales).
  const fadeAt = (i, k) => smooth01((texCol[i] * k - 1.5) / 3);
  const headK = sp.body.headScales ?? 0.55, scaled = sp.body.scales !== 0;
  const cheekU0 = e.u + (e.r / len) * 1.4;
  const cheekV = Float32Array.from({ length: SW }, (_, i) => e.v + (1.3 * e.r) / prof.half((i + 0.5) / SW));   // below the eye
  const cheek = (i, u, v) => smooth01((u - cheekU0) / 0.02) * smooth01((v - cheekV[i]) / 0.08) * smooth01((0.75 - v) / 0.1);
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
  const hasLL = !!gillOf(sp), llJ = new Int32Array(SW).fill(-1);
  for (let i = 0; hasLL && i < SW; i++) {
    const u = (i + 0.5) / SW;
    if (u < g0 + 0.01 || u > 0.95) continue;
    const t = (u - g0) / (0.95 - g0), vll = -0.5 + 0.38 * t * t;
    llJ[i] = clamp(Math.round(((vll + 1) / 2) * SH - 0.5), 0, SH - 1);
  }
  const img = g.getImageData(0, 0, TW, TH), d = img.data;
  // Each lattice (the body's, and the cheek's at headK) keeps its cells' jitter in a grid filled on first
  // use: the search below tests 15 cells per texel, and hashing each every time was most of the cost.
  const lattice = (k) => {
    let bMax = 0;
    for (let i = 0; i < SW; i++) bMax = Math.max(bMax, halfArc[i] / (sCol[i] * 0.5 * k));
    const r0 = -3, b0 = -Math.ceil(bMax) - 4, nr = Math.ceil(A[SW - 1] / k) + 7, nb = 2 * (Math.ceil(bMax) + 4) + 1;
    return { r0, b0, nb, ca: new Float32Array(nr * nb).fill(NaN), cb: new Float32Array(nr * nb), rr: new Float32Array(nr * nb), id: new Int32Array(nr * nb).fill(-1) };
  };
  const L = [lattice(1), lattice(headK)];
  // Per scale (compact id): tilt, reflector strength and film thickness, brightness and tint, and the
  // sum of the pattern's colour over it (sampled at the lattice's resolution).
  const C = { tx: [], ty: [], irS: [], irT: [], val: [], t0: [], t1: [], t2: [], sum: [] };
  for (let j = 0; j < SH; j++) {
    const v = ((j + 0.5) / SH) * 2 - 1;
    for (let i = 0; i < SW; i++) {
      const u = (i + 0.5) / SW, p = j * SW + i, o = p * 4, head = u < g0 - 0.005, k = head ? headK : 1;
      const mask = !scaled ? 0 : (head ? cheek(i, u, v) : smooth01((u - g0 + 0.005) / 0.03)) * fadeAt(i, k);
      shadeImg.data[o + 3] = iridImg.data[o + 3] = crImg.data[o + 3] = 255;
      // Unscaled skin here: bare (head, moray), or scales too small to resolve (faded out: velvet).
      const bodyAt = !scaled || head ? 0 : smooth01((u - g0 + 0.005) / 0.03);
      const rBase = lerp(rBare, rMinute, bodyAt * (1 - fadeAt(i, 1)));
      crImg.data[o] = 255; crImg.data[o + 1] = rBase * 255;
      if (mask <= 0.002) {
        shadeImg.data[o] = shadeImg.data[o + 1] = shadeImg.data[o + 2] = 255;
        iridImg.data[o] = 0; iridImg.data[o + 1] = 128;
        continue;
      }
      const G = L[head ? 1 : 0], hk = head ? 7 : 0;
      const a = A[i] / k, b = Yarc[p] / (sCol[i] * 0.5 * k);
      let best = Infinity, bt = 0, bd = 1, bq = -1, bri = 0, brb = 0, bda = 0, bdb = 0, near = Infinity;
      const jr = Math.round(b);
      for (let rb = jr - 2; rb <= jr + 2; rb++) {
        const off = (rb & 1) * 0.5, ir = Math.round(a - off);
        for (let ri = ir - 1; ri <= ir + 1; ri++) {
          const q = (ri - G.r0) * G.nb + (rb - G.b0);
          if (G.ca[q] !== G.ca[q]) {   // NaN: not filled yet
            G.ca[q] = ri + off + (cellHash(ri, rb, 1 + hk) - 0.5) * 0.16;
            G.cb[q] = rb + (cellHash(ri, rb, 2 + hk) - 0.5) * 0.16;
            G.rr[q] = 0.75 * (1 + (cellHash(ri, rb, 3 + hk) - 0.5) * 0.16);
          }
          const ca = G.ca[q], rr = G.rr[q], da = a - ca, db = (b - G.cb[q]) * 0.5, d2 = da * da + db * db;
          // Covered by this scale and it is the most anterior so far; else remember the nearest centre
          // (jitter can leave a pinhole that no disc covers).
          if (d2 < rr * rr ? ca < best : best === Infinity && d2 / (rr * rr) < near) {
            if (d2 < rr * rr) best = ca; else near = d2 / (rr * rr);
            bt = da / rr; bd = Math.min(1, Math.sqrt(d2) / rr); bq = q; bri = ri; brb = rb; bda = da; bdb = db;
          }
        }
      }
      let c = G.id[bq];
      if (c < 0) {
        c = G.id[bq] = C.tx.length;
        const H = (n) => cellHash(bri, brb, n + hk);
        // (Tilt kept small: with almost no surface reflection under water it shows mostly in the diffuse
        // shading, and at the +-6 degrees of the platelets the flank read as crumpled stucco.)
        C.tx.push((H(4) + H(5) + H(6) - 1.5) * 0.07); C.ty.push((H(7) + H(8) + H(9) - 1.5) * 0.07);
        C.irS.push(0.55 + 0.65 * H(10)); C.irT.push(H(11));
        C.val.push(H(12) - 0.5); C.t0.push(H(13) - 0.5); C.t1.push(H(14) - 0.5); C.t2.push(H(15) - 0.5);
        C.sum.push(0, 0, 0, 0);
      }
      cellOf[p] = c; maskOf[p] = mask;
      const pa = ((2 * j) * TW + 2 * i) * 4;
      C.sum[c * 4] += d[pa]; C.sum[c * 4 + 1] += d[pa + 1]; C.sum[c * 4 + 2] += d[pa + 2]; C.sum[c * 4 + 3]++;
      const ss = sCol[i] * k, hn = 0.5 + 0.5 * bt + 0.25 * (1 - bd * bd);
      height[p] = (hn * 0.08 + C.tx[c] * bda + C.ty[c] * bdb) * ss * mask;
      // Pigment pocket along each scale's free margin; slightly paler centres.
      const pocket = smooth01((bd - 0.72) / 0.28) * (bt > 0 ? 1 : 0.3);
      let sh = 1 - mask * (0.2 * pocket - 0.04 * (1 - bd));
      let ao = 0.6 + 0.4 * smooth01(hn / 0.55);   // low at the front of the exposed field, under the margin ahead
      if (!head && llJ[i] >= 0 && Math.abs(brb - Yarc[llJ[i] * SW + i] / (sCol[i] * 0.5)) < 0.5) {
        const pore = Math.exp(-(((bda - 0.35) ** 2 + bdb * bdb) / 0.012));
        height[p] -= ss * 0.035 * pore * mask;
        ao *= 1 - 0.35 * pore;
        if (Math.abs(bdb) < 0.07 && bda > -0.3 && bda < 0.45) sh += (1 - sh) * 0.5;   // the canal, paler
      }
      const rough = lerp(0.3, rMargin, smooth01((bd - 0.75) / 0.25) * (bt > 0 ? 1 : 0));
      crImg.data[o] = lerp(1, ao, mask) * 255;
      crImg.data[o + 1] = lerp(rBase, rough, mask) * 255;
      shadeImg.data[o] = shadeImg.data[o + 1] = shadeImg.data[o + 2] = clamp(sh, 0, 1) * 255;
      // Guanine platelets: reflective exposed fields, strongest on the flanks and belly, each scale its own.
      const ir = mask * (0.35 + 0.65 * smooth01((v + 0.4) / 1.2)) * (0.6 + 0.4 * (bt * 0.5 + 0.5)) * C.irS[c];
      iridImg.data[o] = clamp(ir, 0, 1) * 255;
      iridImg.data[o + 1] = lerp(0.5, clamp(0.12 + 0.72 * C.irT[c] + 0.16 * (bt * 0.5 + 0.5), 0, 1), mask) * 255;
    }
  }
  // Chromatophores: fine dark speckle, 1-2 texels, densest on the back (sp.speckle scales the count);
  // white (leucophore) skin takes a fifth of it, as with the melanin layer below.
  const speck = new Uint8Array(TW * TH);
  for (let n = 0, nn = Math.round(TW * TH * 0.0012 * (sp.speckle ?? 1)); n < nn; n++) {
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
      const white = smooth01((Math.min(d[o], d[o + 1], d[o + 2]) / 255 - 0.62) / 0.25), s = 0.76 + 0.24 * 0.8 * white;
      d[o] *= s; d[o + 1] *= s; d[o + 2] *= s;
    }
    const p = (y >> 1) * SW + (x >> 1), c = cellOf[p];
    if (c < 0) continue;
    const m = maskOf[p], n = C.sum[c * 4 + 3], w = 0.25 * m;
    const lum = (d[o] + d[o + 1] + d[o + 2]) / 765, jit = m * (1 + (1 - lum)), val = 1 + C.val[c] * 0.05 * jit;
    d[o] = clamp((d[o] + (C.sum[c * 4] / n - d[o]) * w) * val * (1 + C.t0[c] * 0.02 * jit), 0, 255);
    d[o + 1] = clamp((d[o + 1] + (C.sum[c * 4 + 1] / n - d[o + 1]) * w) * val * (1 + C.t1[c] * 0.02 * jit), 0, 255);
    d[o + 2] = clamp((d[o + 2] + (C.sum[c * 4 + 2] / n - d[o + 2]) * w) * val * (1 + C.t2[c] * 0.02 * jit), 0, 255);
  }
  g.putImageData(img, 0, 0);

  // Melanin shading (countershading, mottling, scale-margin pockets below) goes into its own multiply
  // layer, applied after the scales. White pattern areas are leucophores and iridophores that stay bright,
  // so they take only a fifth of it.
  const shade = makeCanvas(TW, TH), sg = shade.getContext('2d', { willReadFrequently: true });
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
  for (let i = 0; i < 70; i++) {
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
  const gillPath = (du, shrink) => {   // the margin's curve, shifted du and shortened at both ends
    g.beginPath();
    for (let i = 0; i <= 24; i++) {
      const v = lerp(G.top * shrink + (1 - shrink) * (G.top + G.bot) / 2, G.bot * shrink + (1 - shrink) * (G.top + G.bot) / 2, i / 24);
      g.lineTo(U(G.edge(v) + du), V(v));
    }
  };
  g.lineCap = 'round';
  if (G) {
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
    const blade = (k) => {
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
      const hc = halfCol[i], j0 = Math.floor(((n.v + 1) / 2 - (3 * n.r) / (2 * hc)) * SH), j1 = Math.ceil(((n.v + 1) / 2 + (3 * n.r) / (2 * hc)) * SH);
      for (let j = Math.max(0, j0); j <= Math.min(SH - 1, j1); j++) {
        const du = (((i + 0.5) / SW) - n.u) * len, dv = ((((j + 0.5) / SH) * 2 - 1) - n.v) * hc, d = Math.hypot(du, dv) / n.r;
        height[j * SW + i] += n.r * (0.25 * Math.exp(-(((d - 1.1) / 0.35) ** 2)) - 0.7 * Math.exp(-d * d * 1.5));
        crImg.data[(j * SW + i) * 4] *= 1 - 0.5 * Math.exp(-d * d * 1.5);   // the pit is occluded
      }
    }
  }
  const shadeC = makeCanvas(SW, SH); shadeC.getContext('2d').putImageData(shadeImg, 0, 0);
  sg.drawImage(shadeC, 0, 0, TW, TH);
  applyShade(g, sg);
  const irid = makeCanvas(SW, SH); irid.getContext('2d').putImageData(iridImg, 0, 0);

  // Tangent-space normal map from the height field (OpenGL convention; canvas rows run down = -v).
  // Across the body the rows' spacing is their arc length (Yarc), as the scales were laid out.
  const normalImg = new ImageData(SW, SH);
  const du = len / SW;
  for (let j = 0; j < SH; j++) {
    for (let i = 0; i < SW; i++) {
      const j0 = Math.max(0, j - 1) * SW + i, j1 = Math.min(SH - 1, j + 1) * SW + i;
      const hx = (height[j * SW + Math.min(SW - 1, i + 1)] - height[j * SW + Math.max(0, i - 1)]) / (2 * du);
      const hy = (height[j1] - height[j0]) / Math.max(1e-6, Yarc[j1] - Yarc[j0]);
      const nx = -hx, ny = hy, inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), k = (j * SW + i) * 4;
      normalImg.data[k] = (nx * inv * 0.5 + 0.5) * 255;
      normalImg.data[k + 1] = (ny * inv * 0.5 + 0.5) * 255;
      normalImg.data[k + 2] = (inv * 0.5 + 0.5) * 255;
      normalImg.data[k + 3] = 255;
    }
  }
  const normal = makeCanvas(SW, SH); normal.getContext('2d').putImageData(normalImg, 0, 0);
  const cr = makeCanvas(SW, SH); cr.getContext('2d').putImageData(crImg, 0, 0);
  return { map: c, normal, irid, cr };
}

// ---------- fins ----------

// Free-standing dorsal spines (the lionfish's venomous spines, the triggerfish's trigger): n spines from
// u0 to u1, each leaning back from vertical by lean[0]..lean[1] degrees (first to last); hs are relative
// heights from the first spine to the last (resampled to n), times h (TL).
export function spineLayout(prof, fin) {
  const n = Math.max(2, fin.n), hs = fin.hs || [0.7, 1, 1, 0.9, 0.7, 0.5, 0.35], lean = fin.lean || [25, 50];
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1), u = lerp(fin.u0, fin.u1, t);
    const k = t * (hs.length - 1), j = Math.min(hs.length - 2, Math.floor(k));
    const len = fin.h * lerp(hs[j], hs[j + 1], k - j), a = THREE.MathUtils.degToRad(lerp(lean[0], lean[1], t));
    const b = [prof.x(u), prof.centre(u) + prof.half(u) * 0.85];
    out.push({ u, b, tip: [b[0] - Math.sin(a) * len, b[1] + Math.cos(a) * len], len, a });
  }
  return out;
}

export function finOutline(sp, prof, fin) {
  const sign = fin.pos === 'top' ? 1 : -1;
  const base = [], outer = [];
  for (let i = 0; i <= 14; i++) {
    const u = lerp(fin.u0, fin.u1, i / 14);
    base.push([prof.x(u), prof.centre(u) + sign * prof.half(u) * 0.85]);
  }
  if (fin.kind === 'spines') {
    // Side-view envelope: through the spine tips (photo traces fill the gaps between spines).
    const S = spineLayout(prof, fin);
    for (const s of S) outer.push(s.tip);
    outer.push([prof.x(fin.u1) - 0.01, prof.top(fin.u1) + 0.005]);
    return { base, outer, sign };
  }
  // [t, h, back]: back (optional) is how far behind its base the point lies, in place of sweep * h (a
  // filament running back past the tail).
  for (const [t, h, back] of fin.pts) {
    const u = lerp(fin.u0, fin.u1, t);
    outer.push([prof.x(u) - (back ?? (fin.sweep || 0) * h), prof.centre(u) + sign * (prof.half(u) + h)]);
  }
  return { base, outer, sign };
}

export function caudalOutline(sp, prof) {
  const c = sp.caudal, xp = prof.xPed + 0.02, hp = prof.half(1) * 0.9, tip = c.tip ?? -0.5, L = xp - tip, s = c.spread;
  switch (c.type) {
    case 'forked': return [[xp, hp], [tip + L * 0.05, s], [tip, s * 1.05], [xp - L * 0.55, 0], [tip, -s * 1.05], [tip + L * 0.05, -s], [xp, -hp]];
    case 'lunate': return [[xp, hp], [xp - L * 0.6, s * 0.7], [tip, s * 1.1], [xp - L * 0.6, s * 0.25], [xp - L * 0.62, 0], [xp - L * 0.6, -s * 0.25], [tip, -s * 1.1], [xp - L * 0.6, -s * 0.7], [xp, -hp]];
    case 'truncate': return [[xp, hp], [tip + L * 0.1, s], [tip, s * 0.95], [tip + L * 0.04, 0], [tip, -s * 0.95], [tip + L * 0.1, -s], [xp, -hp]];
    default: { // round
      const pts = [[xp, hp]];
      for (let i = 0; i <= 12; i++) {
        const a = Math.PI / 2 - (Math.PI * i) / 12;
        pts.push([xp - L * 0.35 - Math.cos(a) * L * 0.65, Math.sin(a) * s]);
      }
      pts.push([xp, -hp]);
      return pts;
    }
  }
}

function along(pts, t) {
  let total = 0;
  const seg = [];
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); total += d; }
  let target = clamp(t, 0, 1) * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const k = seg[i] > 0 ? clamp(target / seg[i], 0, 1) : 0;
      return [lerp(pts[i][0], pts[i + 1][0], k), lerp(pts[i][1], pts[i + 1][1], k)];
    }
    target -= seg[i];
  }
  return pts[pts.length - 1];
}

function smoothPath(g, pts, close) {
  g.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2, my = (pts[i][1] + pts[i + 1][1]) / 2;
    g.quadraticCurveTo(pts[i][0], pts[i][1], mx, my);
  }
  g.lineTo(pts[pts.length - 1][0], pts[pts.length - 1][1]);
  if (close) g.closePath();
}

function finFill(g, fill, x0, x1) {
  if (!Array.isArray(fill)) return fill;
  const gr = g.createLinearGradient(x0, 0, x1, 0);
  for (const [t, col] of fill) gr.addColorStop(1 - t, col);
  return gr;
}

// cachedMaps: the relief maps come from the skin cache, so only the colour sheet and ray layout are made.
function paintFins(sp, prof, cachedMaps = false) {
  // Bounds of everything drawn on the sheet.
  let ymax = prof.H * 1.25, xmin = -0.52;
  const fins = sp.fins.map((f) => finOutline(sp, prof, f));
  for (const f of fins) for (const p of f.outer) { ymax = Math.max(ymax, Math.abs(p[1]) + 0.03); xmin = Math.min(xmin, p[0] - 0.02); }
  const tail = caudalOutline(sp, prof);
  for (const p of tail) ymax = Math.max(ymax, Math.abs(p[1]) + 0.03);
  if (sp.pelvic) for (const p of pelvicOutline(sp, prof).outline) ymax = Math.max(ymax, Math.abs(p[1]) + 0.03);
  const xmax = 0.52, W = 2048, H = Math.ceil((W * (2 * ymax)) / (xmax - xmin));
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const k = W / (xmax - xmin);
  g.setTransform(k, 0, 0, -k, -xmin * k, ymax * k);
  g.lineJoin = 'round';
  // Relief at half resolution, in the same layout: the rays are raised and stiffer than the membrane.
  // It becomes the fins' normal map, and their thickness (rays block more backlight: dark lines on a
  // glowing membrane) and roughness (finMaps below).
  const HW = W / 2, HH = Math.ceil(H / 2), hcv = makeCanvas(HW, HH), hg = hcv.getContext('2d');
  hg.fillStyle = '#000'; hg.fillRect(0, 0, HW, HH);
  hg.setTransform(k / 2, 0, 0, -k / 2, (-xmin * k) / 2, (ymax * k) / 2);
  hg.lineCap = 'round'; hg.strokeStyle = '#fff';
  const rng = mulberry32(sp.id.length * 31 + 5);

  const meshes = [];   // { rays, n }: ray field per fin, for the 3D membrane
  const tubes = [];    // spines and rays modelled as tapered tubes (tubeGeometry)
  const drawFin = (spec, outlinePts, rays, mer = {}, marginPts = null) => {
    g.save();
    g.beginPath(); smoothPath(g, outlinePts, true);
    const xs = outlinePts.map((p) => p[0]);
    g.fillStyle = finFill(g, spec.fill, Math.min(...xs), Math.max(...xs));
    g.fill();
    g.clip();
    g.globalAlpha = 1;
    for (const pnt of spec.paint || []) {
      g.fillStyle = pnt.color;
      g.beginPath();
      g.moveTo(...rays(pnt.t0)[0]); g.lineTo(...rays(pnt.t0)[1]); g.lineTo(...rays(pnt.t1)[1]); g.lineTo(...rays(pnt.t1)[0]);
      g.closePath(); g.fill();
    }
    if (spec.band) {
      g.fillStyle = spec.band.color;
      g.beginPath();
      const a = spec.band.t, b = spec.band.t + spec.band.w;
      g.moveTo(...rays(a)[0]); g.lineTo(...rays(a)[1]); g.lineTo(...rays(b)[1]); g.lineTo(...rays(b)[0]);
      g.fill();
    }
    if (spec.spots) {
      g.fillStyle = spec.spots;
      // spotR: mean spot radius (TL); spotN: how many.
      const sr = spec.spotR ?? 0.013;
      for (let i = 0; i < (spec.spotN ?? 40); i++) {
        const [a, b] = rays(rng());
        const t = rng();
        g.beginPath(); g.arc(lerp(a[0], b[0], t), lerp(a[1], b[1], t), sr * (0.6 + 0.8 * rng()), 0, Math.PI * 2); g.fill();
      }
    }
    if (spec.spot) {
      const [a, b] = rays(spec.spot.t);
      const px = lerp(a[0], b[0], spec.spot.h), py = lerp(a[1], b[1], spec.spot.h);
      if (spec.spot.ring) { g.fillStyle = spec.spot.ring; g.beginPath(); g.arc(px, py, spec.spot.r * 1.35, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = spec.spot.color; g.beginPath(); g.arc(px, py, spec.spot.r, 0, Math.PI * 2); g.fill();
    }
    // Ray count: from the species' meristics (spines + soft rays) when known, else by fin size.
    const n = mer.n ?? Math.round(clamp(10 + (Math.max(...xs) - Math.min(...xs)) * 18, 10, 20));
    const spines = mer.spines || 0;
    // Membrane: a thin pigmented film, densest at the base and thinning towards the free margin, so
    // more of the light behind it passes through near the edge.
    let bc = [0, 0], oc = [0, 0];
    for (let i = 0; i <= 8; i++) { const [a, b] = rays(i / 8); bc = [bc[0] + a[0] / 9, bc[1] + a[1] / 9]; oc = [oc[0] + b[0] / 9, oc[1] + b[1] / 9]; }
    // spec.solid: a thick, skin-covered fin fold (morays), opaque to the margin. spec.thin: how much the
    // film thins by the margin (0.38; tangs' fins stay nearly opaque).
    const a0 = spec.solid ? 1 : Math.min(0.95, (spec.alpha ?? 0.9) + 0.05);
    g.globalCompositeOperation = 'destination-out';
    const mg = g.createLinearGradient(bc[0], bc[1], oc[0], oc[1]);
    for (let s = 0; s <= 4; s++) mg.addColorStop(s / 4, `rgba(0,0,0,${spec.solid ? 0 : 1 - a0 * (1 - (spec.thin ?? 0.38) * (s / 4) ** 2)})`);
    g.fillStyle = mg; g.fillRect(-1, -1, 2, 2);
    // Spiny fins: the membrane is incised between the spine tips, which stand free.
    g.fillStyle = '#000';
    for (let i = 0; i < spines - 1 && i < n; i++) {
      const [ba, ta] = rays(i / n), [bb, tb] = rays((i + 1) / n);
      const deep = [lerp(lerp(ta[0], tb[0], 0.5), lerp(ba[0], bb[0], 0.5), 0.3), lerp(lerp(ta[1], tb[1], 0.5), lerp(ba[1], bb[1], 0.5), 0.3)];
      const out = (t, b) => [t[0] + (t[0] - b[0]) * 0.3, t[1] + (t[1] - b[1]) * 0.3];
      g.beginPath(); g.moveTo(...ta); g.lineTo(...out(ta, ba)); g.lineTo(...out(tb, bb)); g.lineTo(...tb); g.lineTo(...deep); g.closePath(); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
    // Fin rays, more opaque than the membrane, and raised (the relief layer: the light picks out their
    // edges as it really falls, rather than a painted lit edge that stays lit on the shadow side).
    // Spines are single, stiff and unjointed; soft rays (lepidotrichia) are jointed and branch towards
    // the margin (the outermost principal caudal rays stay simple).
    const rayCol = spec.rays || 'rgba(35,20,5,0.13)';
    const line = (a, b, w, col) => {
      g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      if (spec.solid) return;   // a moray's skin-covered fin fold: smooth
      hg.lineWidth = w * 1.3; hg.globalAlpha = Math.min(1, g.globalAlpha * 1.4); hg.setLineDash(g.getLineDash());
      hg.beginPath(); hg.moveTo(a[0], a[1]); hg.lineTo(b[0], b[1]); hg.stroke();
    };
    for (let i = 0; i <= n; i++) {
      const t = i / n, [a, b] = rays(t);
      if (i < spines) {
        g.setLineDash([]);
        line(a, b, 0.0045, rayCol);
        continue;
      }
      g.setLineDash([0.035, 0.0012]);   // soft-ray joints
      const simple = mer.simpleEnds && (i === 0 || i === n);
      const m = simple ? b : [lerp(a[0], b[0], 0.55), lerp(a[1], b[1], 0.55)], q = [lerp(a[0], b[0], 0.2), lerp(a[1], b[1], 0.2)];
      g.globalAlpha = 0.35;   // rays crowd together at the base; they read fainter there
      line(a, q, 0.0026, rayCol);
      g.globalAlpha = 1;
      line(q, m, 0.0026, rayCol);
      if (!simple) for (const s of [-1, 1]) line(m, rays(clamp(t + (s * 0.22) / n, 0, 1))[1], 0.0018, rayCol);
    }
    g.setLineDash([]); hg.setLineDash([]); hg.globalAlpha = 1;
    g.restore();
    meshes.push({ rays, n });
    if (spec.edge) {
      // Pigmented margin (e.g. the clownfish's black submarginal band), edgeW wide, optionally with
      // a narrow translucent unpigmented fringe outside it. Only the free margin, not the base.
      const ew = spec.edgeW || 0.006, fw = spec.fringe ? spec.fringeW || 0.008 : 0;
      g.save();
      g.beginPath(); smoothPath(g, outlinePts, true); g.clip();
      g.beginPath(); smoothPath(g, marginPts || outlinePts, !marginPts);
      g.globalAlpha = 0.95;
      g.strokeStyle = spec.edge; g.lineWidth = 2 * (ew + fw); g.stroke();
      if (fw) {
        g.globalAlpha = 1; g.lineWidth = 2 * fw;
        g.globalCompositeOperation = 'destination-out'; g.stroke();
        g.globalCompositeOperation = 'source-over'; g.strokeStyle = spec.fringe; g.stroke();
      }
      g.restore();
    }
  };
  const meristics = (name) => { const m = sp.anatomy?.[name]; return m ? { spines: m.spines || 0, n: (m.spines || 0) + m.rays - 1 } : {}; };

  // Caudal fin first (behind the body).
  {
    const xp = prof.xPed + 0.02;
    const edge = tail.slice(1, -1);
    const rays = (t) => [[xp, lerp(prof.half(1) * 0.8, -prof.half(1) * 0.8, t)], along(edge, t)];
    // 17 principal caudal rays (9 + 8, the outer two unbranched) in nearly all spiny-rayed fishes.
    drawFin(sp.caudal, tail, rays, { n: (sp.anatomy?.caudalRays ?? 17) - 1, simpleEnds: true }, tail);
  }

  sp.fins.forEach((spec, i) => {
    const f = fins[i];
    if (spec.kind === 'spines') {
      // Free spines (3D tubes, below) joined only near the base by a low, deeply incised web; each spine
      // carries a membrane flag along its rear edge (lionfish), banded like the spine.
      const S = spineLayout(prof, spec), N = S.length;
      const at = (s, k) => [lerp(s.b[0], s.tip[0], k), lerp(s.b[1], s.tip[1], k)];
      const rays = (t) => {
        const k = t * (N - 1), j = Math.min(N - 2, Math.floor(k)), q = k - j;
        return [0, 1].map((e) => [lerp(at(S[j], e)[0], at(S[j + 1], e)[0], q), lerp(at(S[j], e)[1], at(S[j + 1], e)[1], q)]);
      };
      const web = spec.web ?? 0.3, alpha = spec.alpha ?? 0.6;
      g.save();
      g.fillStyle = spec.fill; g.globalAlpha = alpha;
      g.beginPath(); g.moveTo(...S[0].b);
      for (let i = 0; i < N; i++) {
        g.lineTo(...at(S[i], web));
        if (i < N - 1) { const m = rays((i + 0.5) / (N - 1)); g.lineTo(lerp(m[0][0], m[1][0], web * 0.45), lerp(m[0][1], m[1][1], web * 0.45)); }
      }
      g.lineTo(...S[N - 1].b); g.closePath(); g.fill();
      const flag = spec.flag ?? 0, fl = spec.flagLen ?? 0.85;
      for (const s of S) {
        if (!flag) break;
        const back = [-Math.cos(s.a), -Math.sin(s.a)], w = flag * s.len;
        const edge = [];
        for (let q = 0; q <= 10; q++) {
          const k = (q / 10) * fl, p = at(s, k), ww = w * Math.sin(Math.PI * Math.min(1, (k / fl) * 0.85 + 0.15)) ** 0.6;
          edge.push([p[0] + back[0] * ww, p[1] + back[1] * ww]);
        }
        g.save();
        g.beginPath(); g.moveTo(...s.b); for (const p of edge) g.lineTo(...p); g.lineTo(...at(s, fl)); g.closePath();
        g.globalAlpha = alpha; g.fill(); g.clip();
        if (spec.stripes) {
          // Bands across spine and flag together, about one per 0.025 TL.
          const nb = Math.max(3, Math.round(s.len / 0.025));
          g.globalAlpha = 0.85; g.strokeStyle = spec.stripes; g.lineWidth = s.len / nb * 0.5;
          for (let q = 0; q < nb; q++) {
            const p = at(s, (q + 0.5) / nb);
            g.beginPath(); g.moveTo(...p); g.lineTo(p[0] + back[0] * w * 1.3, p[1] + back[1] * w * 1.3); g.stroke();
          }
        }
        g.restore();
      }
      g.restore();
      meshes.push({ rays, n: N - 1 });
      // The spines themselves, on the membrane's pleat ridges (see finMesh) so they stay on the web.
      S.forEach((s, i) => {
        const z = 0.035 * s.len * Math.cos(Math.PI * i);
        const bend = spec.bend ?? 0.06, nrm = [Math.cos(s.a), Math.sin(s.a)];
        const mid = at(s, 0.5);
        tubes.push({
          pts: [[...s.b, 0], [mid[0] - nrm[0] * bend * s.len, mid[1] - nrm[1] * bend * s.len, z * 0.5], [...s.tip, z]],
          r0: spec.r ?? 0.005, r1: (spec.r ?? 0.005) * 0.2, color: spec.color || spec.fill, stripes: spec.stripes,
          nb: spec.stripes ? Math.max(3, Math.round(s.len / 0.025)) : 0,
        });
      });
      return;
    }
    const outline = [...f.base, ...f.outer.slice().reverse()];
    const rays = (t) => {
      // Interpolate the outer edge at t.
      const pts = spec.pts;
      let j = 0;
      while (j < pts.length - 2 && pts[j + 1][0] < t) j++;
      const tt = clamp((t - pts[j][0]) / Math.max(1e-6, pts[j + 1][0] - pts[j][0]), 0, 1);
      const o = [lerp(f.outer[j][0], f.outer[j + 1][0], tt), lerp(f.outer[j][1], f.outer[j + 1][1], tt)];
      return [along(f.base, t), o];
    };
    drawFin(spec, outline, rays, meristics(spec.meristic), f.outer);
  });

  if (sp.pelvic) {
    // Paired pelvic fins: painted once in side view, meshed twice and splayed out from the belly.
    const pv = pelvicOutline(sp, prof);
    drawFin(sp.pelvic, pv.outline, pv.rays, meristics('pelvic'), pv.outline.slice(1, -1));   // distal margin, not the spine
    meshes[meshes.length - 1].xforms = pv.xforms;
  }

  return { canvas: c, xmin, xmax, ymax, meshes, tubes, ...(cachedMaps ? {} : finMaps(hcv)) };
}

// ---- Skin detail tiles ----
// The body's own maps hold one texel per ~1-2 mm of a 10 cm fish: enough for its scales, not for what a
// close look shows on real skin. A tiling normal map adds that, repeated over the body UV at a rate set by
// the species' scale count (detailFor below) and faded out in the shader once it is finer than the screen
// can show, so it costs nothing at tank distance (the mipmaps would only average it away). Kinds:
//  - velvet: minute ctenoid scales (tangs, the Moorish idol: 150 along the lateral line, below the body
//    map's resolution), a lattice of 8 x 8 scales per tile, each with its comb of spinules;
//  - ctenoid / cycloid: within one scale, the growth rings (circuli) and, on ctenoid scales, spinules;
//    the tile spans 2 x 2 scales;
//  - mucus: a scaleless eel's skin, fine creases and pores.
const detailTiles = new Map();
function detailTile(kind) {
  if (detailTiles.has(kind)) return detailTiles.get(kind);
  const S = 256, h = new Float32Array(S * S), rng = mulberry32(kind.length * 977 + 3);
  // Periodic value noise with P cells across the tile (so the tile wraps seamlessly).
  const noise = (P) => {
    const gv = Float32Array.from({ length: P * P }, () => rng());
    return (x, y) => {
      const fx = x * P, fy = y * P, i = Math.floor(fx), j = Math.floor(fy), tx = smooth01(fx - i), ty = smooth01(fy - j);
      const at = (a, b) => gv[(((b % P) + P) % P) * P + (((a % P) + P) % P)];
      return lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), ty);
    };
  };
  // An imbricated lattice of nc columns x 2nc rows (row spacing half a scale) wrapping on the tile, as on
  // the body: returns { hn (height of the exposed field), bt, bd, da, db } at (x, y).
  const lattice = (nc) => (x, y) => {
    const a = x * nc, b = y * nc * 2, jr = Math.round(b);
    let best = Infinity, out = null;
    for (let rb = jr - 2; rb <= jr + 2; rb++) {
      const off = (rb & 1) * 0.5, ir = Math.round(a - off), wr = ((rb % (2 * nc)) + 2 * nc) % (2 * nc);
      for (let ri = ir - 1; ri <= ir + 1; ri++) {
        const wi = ((ri % nc) + nc) % nc;
        const ca = ri + off + (cellHash(wi, wr, 31) - 0.5) * 0.16, cb = rb + (cellHash(wi, wr, 32) - 0.5) * 0.16;
        const rr = 0.75 * (1 + (cellHash(wi, wr, 33) - 0.5) * 0.16), da = a - ca, db = (b - cb) * 0.5, d2 = da * da + db * db;
        if (d2 < rr * rr && ca < best) { best = ca; const bd = Math.sqrt(d2) / rr, bt = da / rr; out = { hn: 0.5 + 0.5 * bt + 0.25 * (1 - bd * bd), bt, bd, da, db }; }
      }
    }
    return out || { hn: 0, bt: 0, bd: 1, da: 0, db: 0 };
  };
  let amp;   // relief in texels at height 1
  if (kind === 'velvet') {
    const L = lattice(8);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const c = L(x / S, y / S), comb = c.bt > 0 ? smooth01((c.bd - 0.7) / 0.3) * (0.5 + 0.5 * Math.sin(Math.atan2(c.db, c.da) * 22)) : 0;
      h[y * S + x] = c.hn + 0.3 * comb;
    }
    amp = 3;
  } else if (kind === 'mucus') {
    const n1 = noise(8), n2 = noise(16), n3 = noise(48);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const u = x / S, v = y / S, w = n2(u, v) * 0.15;   // creases wander
      const crease = (1 - Math.abs(2 * n1(u + w, v - w) - 1)) ** 4;
      h[y * S + x] = -crease + 0.25 * n3(u, v);
    }
    amp = 2;
  } else {
    // Circuli: concentric growth rings on each scale (about 14 across its radius), plus on ctenoid scales a
    // field of fine spinule points over the exposed rear.
    const L = lattice(2), spin = noise(64);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const c = L(x / S, y / S), r = Math.hypot(c.da, c.db);
      let v = 0.35 * Math.sin(r * Math.PI * 2 * 14 / 0.75) * (1 - c.bd * 0.5);
      if (kind === 'ctenoid' && c.bt > 0.1) v += 0.8 * smooth01((c.bt - 0.1) / 0.4) * (spin(x / S, y / S) - 0.5);
      h[y * S + x] = v;
    }
    amp = 1.2;
  }
  const img = new ImageData(S, S), H = (x, y) => h[((y + S) % S) * S + ((x + S) % S)];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const nx = -(H(x + 1, y) - H(x - 1, y)) * 0.5 * amp, ny = (H(x, y + 1) - H(x, y - 1)) * 0.5 * amp;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), o = (y * S + x) * 4;
    img.data[o] = (nx * inv * 0.5 + 0.5) * 255; img.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255; img.data[o + 2] = (inv * 0.5 + 0.5) * 255; img.data[o + 3] = 255;
  }
  const c = makeCanvas(S, S); c.getContext('2d').putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16;
  detailTiles.set(kind, t);
  return t;
}
// Which tile a species gets, how often it repeats over the body UV (u: nose to tail, v: back to belly,
// kept square in physical size), and how strongly it bends the normal.
function detailFor(sp, prof) {
  const sc = sp.body.scales, g0 = gillU(sp), len = sp.body.len;
  const kind = sc === 0 ? 'mucus' : sc >= 100 ? 'velvet' : (sp.body.scaleType ?? 'ctenoid');
  let ref = 0, n = 0;
  for (let u = Math.max(0.05, g0); u < 0.85; u += 0.02) { ref += prof.half(u) * 1.15; n++; }
  ref /= Math.max(1, n);
  const repU = kind === 'mucus' ? 24 : kind === 'velvet' ? sc / (8 * (1 - g0)) : sc / (2 * (1 - g0));
  const str = { velvet: 1.0, mucus: 0.6, ctenoid: 0.22, cycloid: 0.25 }[kind];   // (ctenoid at 0.35 chalked white skin)
  return { kind, tex: detailTile(kind), rep: new THREE.Vector2(repU, (repU * 2 * ref) / len), str };
}

// From the fins' relief layer (white = ray): a tangent-space normal map (each ray a rounded ridge), and
// one data map, R = thickness (rays ~4x the membrane, read by the tissue light term) and G = roughness
// (rays 0.33, membrane 0.45; roughnessMap reads G).
function finMaps(src) {
  const w = src.width, h = src.height, soft = makeCanvas(w, h), sg = soft.getContext('2d', { willReadFrequently: true });
  sg.filter = 'blur(1px)'; sg.drawImage(src, 0, 0); sg.filter = 'none';
  const H = sg.getImageData(0, 0, w, h).data, nImg = new ImageData(w, h), dImg = new ImageData(w, h);
  const at = (x, y) => H[(Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))) * 4] / 255;
  const S = 0.9;   // slope per texel of full relief (a ray ~3 texels wide: its flanks tilt ~25 degrees)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4, hx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * S, hy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * S;
    const nx = -hx, ny = hy, inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), r = at(x, y);
    nImg.data[o] = (nx * inv * 0.5 + 0.5) * 255; nImg.data[o + 1] = (ny * inv * 0.5 + 0.5) * 255; nImg.data[o + 2] = (inv * 0.5 + 0.5) * 255; nImg.data[o + 3] = 255;
    dImg.data[o] = r * 255; dImg.data[o + 1] = (0.45 - 0.12 * r) * 255; dImg.data[o + 3] = 255;
  }
  const normal = makeCanvas(w, h), data = makeCanvas(w, h);
  normal.getContext('2d').putImageData(nImg, 0, 0); data.getContext('2d').putImageData(dImg, 0, 0);
  return { normal, data };
}

// Pelvic fin in side view: inserted on the belly just behind the pectoral base, the spine as its leading
// edge, rays fanning back and down. sp.pelvic: { u, len (TL), angle (deg below backwards), base, splay }.
export function pelvicOutline(sp, prof) {
  const p = sp.pelvic, len = sp.body.len, base = p.base ?? 0.03;
  const belly = (x) => { const u = (0.5 - x) / len; return prof.centre(u) - prof.half(u) * 0.9; };
  const x0 = prof.x(p.u);
  const b = (t) => { const x = x0 - t * base; return [x, belly(x)]; };
  // Ray direction and length across the fin: the spine is steep and shorter, the longest ray about a
  // third of the way back, the last rays shallow and short.
  const ang = (t) => THREE.MathUtils.degToRad(lerp(p.angle + 22, p.angle - 18, t));
  const rlen = (t) => p.len * (0.7 + 1.3725 * t - 1.4725 * t * t);
  const tip = (t) => { const o = b(t), a = ang(t), r = rlen(t); return [o[0] - Math.cos(a) * r, o[1] - Math.sin(a) * r]; };
  const outer = [];
  for (let i = 0; i <= 12; i++) outer.push(tip(i / 12));
  const outline = [b(0), ...outer, b(1)];
  const xforms = [1, -1].map((side) => {
    const by = b(0.5)[1], z = side * prof.width(p.u) * 0.35;
    return new THREE.Matrix4().makeTranslation(0, by, z)
      .multiply(new THREE.Matrix4().makeRotationX(-side * (p.splay ?? 0.35)))
      .multiply(new THREE.Matrix4().makeTranslation(0, -by, 0));
  });
  return { outline, rays: (t) => [b(t), tip(t)], xforms };
}

// Pectoral planform: 'fan' (lionfish wings), 'round' (broad paddle) or the default narrow blade.
// spread: angle the rays cover; yk: vertical squash of the ray fan on the texture.
function pectShape(p) {
  const fan = p.kind === 'fan', round = p.kind === 'round';
  return { fan, round, spread: fan ? 2.3 : round ? 1.7 : 0.9, yk: fan ? 0.5 : round ? 0.6 : 1 };
}
// Pectoral ray count: from the species' meristics when known.
const pectoralRays = (sp) => (sp.anatomy?.pectoralRays ?? (sp.pectoral.kind === 'fan' ? 17 : 11)) - 1;
// Fan pectoral ray lengths (fraction of p.len): longest in the middle of the fan, slightly irregular.
const fanLen = (sp, i) => { const n = pectoralRays(sp); return 0.8 + 0.15 * Math.sin(Math.PI * (0.2 + (0.7 * i) / n)) + 0.04 * Math.sin(i * 1.7); };
const pectBands = (sp, i) => Math.max(3, Math.round((fanLen(sp, i) * sp.pectoral.len) / 0.03));
// Pleat and cup of the pectoral surface at (x, y) in its own plane (base at the origin, x outwards).
function pectZ(sp, x, y) {
  const p = sp.pectoral, { spread, yk } = pectShape(p), pw = p.len, n = pectoralRays(sp);
  const r = Math.hypot(x, y) / pw, a = Math.atan2(y / yk, Math.max(1e-4, x));
  return 0.03 * pw * r * Math.cos(Math.PI * (a / spread + 0.5) * n) + 0.12 * pw * r * r;
}
// Side view of a fan pectoral as the lab poses it (opened by `open` rad about the vertical), for
// silhouette fitting: the fan dominates a lionfish's outline.
export function pectoralOutline(sp, prof, open = 0.9) {   // as lab.js poses fans
  const p = sp.pectoral, { spread, yk } = pectShape(p), n = pectoralRays(sp), pw = p.len;
  const px = prof.x(p.u), py = prof.centre(p.u) - p.v * prof.half(p.u), k = Math.cos(open);
  const pts = [[px, py + 0.01]];
  for (let i = 0; i <= n; i++) {
    const a = -spread / 2 + (spread * i) / n, r = fanLen(sp, i) * pw;
    pts.push([px - Math.cos(a) * r * k, py - Math.sin(a) * r * yk]);
  }
  pts.push([px, py - 0.01]);
  return pts;
}
// Fan pectoral rays as tubes, in the fin's own space (the canvas y runs down, so geometry y = -canvas y).
function pectoralTubes(sp) {
  const p = sp.pectoral, { fan, spread, yk } = pectShape(p);
  if (!fan) return [];
  const n = pectoralRays(sp), pw = p.len, out = [];
  for (let i = 0; i <= n; i++) {
    const a = -spread / 2 + (spread * i) / n, L = fanLen(sp, i), pts = [];
    for (let q = 0; q <= 6; q++) {
      const r = (L * q) / 6, x = Math.cos(a) * r * pw, y = -Math.sin(a) * r * yk * pw;
      pts.push([x, y, pectZ(sp, x, y)]);
    }
    out.push({ pts, r0: p.rayR ?? 0.004, r1: (p.rayR ?? 0.004) * 0.25, color: p.rayColor || p.fill, stripes: p.stripes, nb: p.stripes ? pectBands(sp, i) : 0 });
  }
  return out;
}

function paintPectoral(sp) {
  const p = sp.pectoral, { fan, round, spread, yk } = pectShape(p);
  const W = 512, H = fan || round ? 512 : 256, K = W / 256;   // widths below were tuned at 256 px
  const c = makeCanvas(W, H), g = c.getContext('2d');
  // Base at left-centre; fin extends to the right. The free margin is traced separately from the base
  // so a pigmented edge follows only the margin.
  g.translate(0, H / 2);
  // Rounded paddle (damselfishes): the rays' tips lie on a broad arc; the outer rays are shorter.
  const arc = (first) => {
    for (let i = 0; i <= 24; i++) {
      const a = -spread / 2 + (spread * i) / 24, r = W * (0.97 - 0.14 * (a / (spread / 2)) ** 2);
      g[i || !first ? 'lineTo' : 'moveTo'](Math.cos(a) * r, Math.sin(a) * r * yk);
    }
  };
  const margin = (free = false) => {
    if (round) {
      if (free) { arc(true); return; }
      g.moveTo(0, -H * 0.07); arc(false); g.lineTo(0, H * 0.07);
    } else if (fan) {
      // Through each ray tip, the membrane incised deeply between them so the tips stand free.
      const nr = pectoralRays(sp), ang = (i) => -spread / 2 + (spread * i) / nr, pt = (a, r) => [Math.cos(a) * r * W, Math.sin(a) * r * W * yk];
      g.moveTo(0, -H * 0.06);
      for (let i = 0; i <= nr; i++) {
        g.lineTo(...pt(ang(i), fanLen(sp, i)));
        if (i < nr) g.lineTo(...pt(ang(i + 0.5), (p.web ?? 0.62) * Math.min(fanLen(sp, i), fanLen(sp, i + 1))));
      }
      g.lineTo(0, H * 0.06);
    } else {
      g.moveTo(0, -H * 0.18);
      g.bezierCurveTo(W * 0.4, -H * 0.5, W * 0.95, -H * 0.2, W * 0.98, 0);
      g.bezierCurveTo(W * 0.9, H * 0.2, W * 0.4, H * 0.35, 0, H * 0.18);
    }
  };
  g.beginPath(); margin(); g.closePath();
  g.fillStyle = p.fill; g.fill();
  g.save(); g.clip();
  // Membrane thinning from base to margin, as on the median fins.
  const a0 = Math.min(0.85, (p.alpha ?? 0.6) + 0.05);
  g.globalCompositeOperation = 'destination-out';
  const mg = g.createRadialGradient(0, 0, 0, 0, 0, W);
  for (let s = 0; s <= 4; s++) mg.addColorStop(s / 4, `rgba(0,0,0,${1 - a0 * (1 - 0.38 * (s / 4) ** 2)})`);
  g.fillStyle = mg; g.fillRect(0, -H / 2, W, H);
  g.globalCompositeOperation = 'source-over';
  const n = pectoralRays(sp), a0r = -spread / 2, span = spread;
  const dir = (a, r) => [Math.cos(a) * r, Math.sin(a) * r * yk];
  for (let i = 0; i <= n; i++) {
    const a = a0r + (span * i) / n;
    if (fan) {
      // The rays are 3D tubes (pectoralTubes); the membrane takes a narrow banded flag along each.
      const L = fanLen(sp, i) * W, nb = pectBands(sp, i);
      g.lineWidth = ((p.flag ?? 0.012) / p.len) * W;
      for (let q = 0; q < nb; q++) {
        g.strokeStyle = q % 2 && p.stripes ? p.stripes : p.fill;
        g.beginPath(); g.moveTo(...dir(a, (L * q) / nb)); g.lineTo(...dir(a, (L * (q + 1)) / nb)); g.stroke();
      }
    } else {
      // Jointed soft rays (the first is simple), branching at about half their length.
      g.setLineDash([0.12 * W, 0.006 * W]);
      g.strokeStyle = 'rgba(0,0,0,0.2)'; g.lineWidth = 1.5 * K;
      const br = i > 0 ? 0.5 : 1;
      g.beginPath(); g.moveTo(0, 0); g.lineTo(...dir(a, W * br)); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 0.7 * K;
      g.beginPath(); g.moveTo(0, 1.2 * K); g.lineTo(...dir(a, W * br).map((v, k) => v + k * 1.2 * K)); g.stroke();
      if (br < 1) {
        g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 1.1 * K;
        for (const s of [-1, 1]) { g.beginPath(); g.moveTo(...dir(a, W * br)); g.lineTo(...dir(a + (s * 0.22 * span) / n, W)); g.stroke(); }
      }
      g.setLineDash([]);
    }
  }
  if (p.spots) {
    g.fillStyle = p.spots;
    const rng = mulberry32(sp.id.length * 17 + 3);
    const sr = ((p.spotR ?? 0.006) / p.len) * W;
    for (let i = 0; i < (p.spotN ?? 60); i++) {
      const a = a0r + span * rng(), r = W * (0.15 + 0.75 * rng());
      g.beginPath(); g.arc(...dir(a, r), sr * (0.6 + 0.8 * rng()), 0, Math.PI * 2); g.fill();
    }
  }
  if (p.edge) {
    // edgeW in body lengths (TL), like the median fins; drawn on the free margin only.
    const ew = ((p.edgeW ?? 0.006 * p.len) / p.len) * W;
    g.globalAlpha = 0.95; g.strokeStyle = p.edge; g.lineWidth = 2 * ew;
    g.beginPath(); margin(true); g.stroke();
  }
  g.restore();
  return c;
}

// ---------- 3D fins ----------

// A fin membrane meshed on its rays: rows run from the base to the edge, and the membrane is
// fan-folded (rays on alternate ridges and valleys), which gives fins their pleated relief and
// broken-up highlights. UVs index the fin sheet texture, which is drawn in fish coordinates.
function finMesh({ rays, n }, sheet) {
  const NT = Math.max(24, n * 4), NS = 10, pos = [], uv = [], idx = [];
  for (let i = 0; i <= NT; i++) {
    const t = i / NT, [b, o] = rays(t);
    const ex = o[0] + (o[0] - b[0]) * 0.05, ey = o[1] + (o[1] - b[1]) * 0.05;   // overshoot; alpha trims it
    const L = Math.hypot(ex - b[0], ey - b[1]);
    for (let j = 0; j <= NS; j++) {
      const sj = j / NS, x = lerp(b[0], ex, sj), y = lerp(b[1], ey, sj);
      pos.push(x, y, 0.035 * L * sj * Math.cos(Math.PI * t * n));
      uv.push((x - sheet.xmin) / (sheet.xmax - sheet.xmin), (y + sheet.ymax) / (2 * sheet.ymax));
    }
  }
  for (let i = 0; i < NT; i++) {
    for (let j = 0; j < NS; j++) {
      const a = i * (NS + 1) + j, b = a + NS + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Tapered tube along a smooth path through d.pts (fish space): spines, free fin rays, tentacles.
// d: { pts, r0, r1, color, stripes?, nb? (bands), flat? (thickness across z / width), shape?: 'leaf' }.
// Bands are crisp: rings are doubled at each band boundary. Colours go in a vertex colour attribute.
function tubeGeometry(d, seg = 7) {
  const curve = new THREE.CatmullRomCurve3(d.pts.map((p) => new THREE.Vector3(...p)));
  const nb = d.nb || 0, ts = [];
  for (let i = 0; i <= 16; i++) ts.push(i / 16);
  for (let q = 1; q < nb; q++) ts.push(q / nb - 1e-3, q / nb + 1e-3);
  ts.sort((a, b) => a - b);
  const ca = new THREE.Color(d.color), cb = new THREE.Color(d.stripes || d.color);
  const flat = d.flat ?? 1, pos = [], col = [], idx = [];
  const T = new THREE.Vector3(), N = new THREE.Vector3(), B = new THREE.Vector3(), Z = new THREE.Vector3(0, 0, 1);
  for (const t of ts) {
    const p = curve.getPointAt(t);
    curve.getTangentAt(t, T);
    N.copy(Z).addScaledVector(T, -T.dot(Z));
    if (N.lengthSq() < 1e-6) N.set(0, 1, 0);
    N.normalize(); B.crossVectors(T, N);
    const r = d.shape === 'leaf' ? lerp(d.r0, d.r1, t) + d.r0 * 1.4 * Math.sin(Math.PI * t) ** 1.5 : lerp(d.r0, d.r1, t);
    const c = nb && Math.floor(t * nb) % 2 ? cb : ca;
    for (let k = 0; k < seg; k++) {
      const a = (k / seg) * Math.PI * 2;
      pos.push(p.x + (N.x * flat * Math.cos(a) + B.x * Math.sin(a)) * r, p.y + (N.y * flat * Math.cos(a) + B.y * Math.sin(a)) * r, p.z + (N.z * flat * Math.cos(a) + B.z * Math.sin(a)) * r);
      col.push(c.r, c.g, c.b);
    }
  }
  const R = ts.length;
  for (let i = 0; i < R - 1; i++) {
    for (let k = 0; k < seg; k++) {
      const a = i * seg + k, b = i * seg + ((k + 1) % seg);
      idx.push(a, b, a + seg, b, b + seg, a + seg);
    }
  }
  const tip = curve.getPointAt(1);
  pos.push(tip.x, tip.y, tip.z); col.push(...(nb && (nb - 1) % 2 ? cb : ca).toArray());
  for (let k = 0; k < seg; k++) idx.push((R - 1) * seg + k, (R - 1) * seg + ((k + 1) % seg), R * seg);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  // On the lower jaw (d.jaw): swings down with it as the mouth opens (FISH_JAW).
  g.setAttribute('aJaw', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3).fill(d.jaw ? 1 : 0), 1));
  g.setAttribute('aJawG', new THREE.Float32BufferAttribute(new Float32Array(pos.length / 3), 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Paired appendages on the head and body (supraorbital tentacles, lappets), both sides:
// sp.appendages: [{ u, v (as the eye), len (TL), dir: [x, y, z out], r, flat, shape, color, stripes, nb, bend }].
function appendageTubes(sp, prof) {
  const out = [], M = mouthOf(sp);
  for (const a of sp.appendages || []) {
    // Rooted on the lower jaw (below the gape, ahead of its corner): it moves with the jaw.
    const jaw = a.u < M.u && a.v > lerp(M.v0, M.v, a.u / M.u);
    for (const side of [1, -1]) {
      const x = prof.x(a.u), y = prof.centre(a.u) - a.v * prof.half(a.u);
      const z = side * flankZ(sp, prof, a.u, a.v);
      const d = new THREE.Vector3(a.dir[0], a.dir[1], side * a.dir[2]).normalize().multiplyScalar(a.len);
      const bend = a.bend ?? 0.15;
      // The base starts a quarter of the length inside the skin, so it grows out of it rather than
      // touching it at a point (a leaf-shaped lappet would otherwise sit on a thin stalk).
      const x0 = x - d.x * 0.25, y0 = y - d.y * 0.25, z0 = z - d.z * 0.25 - side * a.r;
      out.push({
        pts: [[x0, y0, z0], [x + d.x * 0.4 - bend * d.y * 0.4, y + d.y * 0.4 + bend * d.x * 0.4, z + d.z * 0.4], [x + d.x, y + d.y, z + d.z]],
        r0: a.r, r1: a.r * 0.15, flat: a.flat, shape: a.shape, color: a.color, stripes: a.stripes, nb: a.nb || 0, jaw,
      });
    }
  }
  return out;
}

// Pectoral fin: rays fan out from the base; pleated like the median fins and slightly cupped.
function pectoralGeometry(sp) {
  const p = sp.pectoral, { fan, round } = pectShape(p);
  const pw = p.len, ph = fan || round ? p.len : p.len * 0.5;
  const g = fan ? new THREE.PlaneGeometry(pw, ph, 64, 64) : new THREE.PlaneGeometry(pw, ph, 28, 18);   // fans: pleats fine enough for every ray
  g.translate(pw / 2, 0, 0);
  const pos = g.attributes.position;
  // The ray angle as painted is atan2(y / yk, x) (the texture squashes the fan vertically by yk).
  for (let i = 0; i < pos.count; i++) pos.setZ(i, pectZ(sp, pos.getX(i), pos.getY(i)));
  g.computeVertexNormals();
  return g;
}

// ---------- eyes ----------

// Front view of the eye (planar UV): iris stroma with radial fibres, a round pupil about two thirds of
// the iris diameter (the spherical lens fills it), and a faint silvery ring at the pupil margin.
// sp.eye: pupil (radius / eyeball radius), irisR (iris radius / eyeball radius; outside it the eyeball
// shows the iris colour fading into the orbit skin rather than a dark limbus), fleck (melanophores
// around the pupil, e.g. the clownfish's dark inner iris).
function paintEye(sp) {
  const N = 512, c = makeCanvas(N, N), g = c.getContext('2d'), R = N / 2, K = N / 256;
  const e = sp.eye, rng = mulberry32(sp.id.length * 131 + 7), iris = e.iris;
  const ir = e.irisR ?? 0.98, pr = e.pupil ?? 0.44;
  g.fillStyle = shade(iris, -0.15); g.fillRect(0, 0, N, N);
  const gr = g.createRadialGradient(R, R, R * pr * 0.7, R, R, R * ir);
  gr.addColorStop(0, shade(iris, 0.2)); gr.addColorStop(0.55, iris); gr.addColorStop(0.9, shade(iris, -0.2)); gr.addColorStop(1, shade(iris, -0.35));
  g.fillStyle = gr; g.beginPath(); g.arc(R, R, R * ir, 0, Math.PI * 2); g.fill();
  if (e.fleck) {
    const fr = e.fleckR ?? pr + (ir - pr) * 0.75;
    for (let i = 0; i < 900; i++) {
      const a = rng() * Math.PI * 2, r = R * (pr + (fr - pr) * rng() ** 1.3);
      g.fillStyle = e.fleck; g.globalAlpha = 0.25 + rng() * 0.5;
      g.beginPath(); g.arc(R + Math.cos(a) * r, R + Math.sin(a) * r, (0.8 + rng() * 2) * K, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
  }
  for (let i = 0; i < 160; i++) {
    const a = rng() * Math.PI * 2, r0 = R * (pr + rng() * 0.08), r1 = R * ir * (0.75 + rng() * 0.2);
    g.strokeStyle = rng() < 0.5 ? 'rgba(0,0,0,0.16)' : 'rgba(255,255,255,0.1)'; g.lineWidth = (1 + rng() * 1.5) * K;
    g.beginPath(); g.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0); g.lineTo(R + Math.cos(a + 0.05) * r1, R + Math.sin(a + 0.05) * r1); g.stroke();
  }
  g.strokeStyle = 'rgba(220,235,240,0.25)'; g.lineWidth = 2.5 * K;   // guanine ring at the pupil margin
  g.beginPath(); g.arc(R, R, R * (pr + 0.025), 0, Math.PI * 2); g.stroke();
  const pu = g.createRadialGradient(R * 0.94, R * 0.92, 0, R, R, R * pr);
  pu.addColorStop(0, '#0d1820'); pu.addColorStop(0.8, '#03060a'); pu.addColorStop(1, '#000');
  g.fillStyle = pu; g.beginPath(); g.arc(R, R, R * pr, 0, Math.PI * 2); g.fill();
  return c;
}

// Iridescence mask for the eye: the iris' iridophore ring, brightest just outside the pupil and fading
// out across the iris, with radial streaks (same layout as paintEye's texture).
function paintEyeRing(sp) {
  const N = 128, R = N / 2, e = sp.eye, ir = e.irisR ?? 0.98, pr = e.pupil ?? 0.44;
  const img = new ImageData(N, N), rng = mulberry32(sp.id.length * 17 + 9);
  const streak = Float32Array.from({ length: 64 }, () => 0.6 + 0.4 * rng());
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const dx = (x + 0.5 - R) / R, dy = (y + 0.5 - R) / R, r = Math.hypot(dx, dy), o = (y * N + x) * 4;
    const a = ((Math.atan2(dy, dx) / (Math.PI * 2)) + 1) % 1;
    const ring = r < pr ? 0 : Math.exp(-(((r - pr - 0.04) / 0.05) ** 2)) + 0.35 * smooth01((ir - r) / 0.15) * smooth01((r - pr) / 0.05);
    img.data[o] = img.data[o + 1] = img.data[o + 2] = clamp(ring * streak[Math.floor(a * 64)], 0, 1) * 255; img.data[o + 3] = 255;
  }
  const c = makeCanvas(N, N); c.getContext('2d').putImageData(img, 0, 0);
  return c;
}

// Eyeball geometry already placed in fish space (so the swim shader moves it with the head).
// Gill cover: how far it stands proud of the body (a share of the body's half-width), rising over
// its rear half to a step at the free margin. cover: whether the point is on the cover (the body mesh
// puts two coincident rings on the margin, one each side of the step); by default, ahead of the margin.
const COVER = 0.05;
function coverAt(G, u, v, cover) {
  if (!G) return 0;
  const edge = G.edge(v);
  if (!(cover ?? u <= edge)) return 0;
  return smooth01((u - (edge - 0.13)) / 0.12) * G.fade(v);
}

// The skin's distance from the midplane at body position u and texture height v (-1 dorsal, +1
// ventral), before relief: the body mesh's cross-section, shared with the eyes so they sit on it.
function flankZ(sp, prof, u, v, cover) {
  const e = sp.eye, len = sp.body.len, cy = -v;
  // Section exponent: compressed fish (tangs, angels) have a lens-shaped section, thickest along the
  // spine and sharp at the fin bases (> 1); round-bodied fish (gramma, lionfish) are fuller (< 1).
  const flank = sp.body.flank ?? 1.6 - sp.body.width * 1.6;
  const h = prof.half(u);
  let z = Math.pow(Math.sqrt(Math.max(0, 1 - cy * cy)), flank) * prof.width(u);
  z *= 1 - 0.25 * Math.max(0, cy) ** 4;                                  // narrow dorsal ridge (fin base)
  z *= 1 + 0.12 * Math.max(0, -cy) * (1 - smooth01(u / 0.6));            // fuller belly over the gut
  z *= 1 + COVER * coverAt(gillOf(sp), u, v, cover);                    // gill cover overhangs the flank
  const du = (u - e.u) / (e.r * 1.6 / len), dv = (v - e.v) / (e.r * 1.6 / Math.max(h, 1e-3));
  z *= 1 + 0.07 * Math.exp(-(du * du + dv * dv));                       // eye socket
  return z;
}

function eyeGeometry(prof, sp, side) {
  const e = sp.eye, geo = new THREE.SphereGeometry(1, 32, 20);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 - p.getX(i) * 0.5, 0.5 + p.getY(i) * 0.5);   // planar, looking along +z
  const ex = prof.x(e.u), ey = prof.centre(e.u) - e.v * prof.half(e.u);
  const zAt = (u, v) => flankZ(sp, prof, u, v);
  const ez = zAt(e.u, e.v);
  // The cornea sits nearly flush with the head (only the lens bulges a little), so the eyeball is a
  // shallow cap just proud of the socket, turned to the head's surface there: the head narrows towards
  // the snout and rounds over at the top, and a cap facing straight out would stand proud at its front
  // and upper edges (bug eyes, head-on).
  const du = 0.01, dv = 0.02, len = sp.body.len;
  const dzdx = (zAt(e.u + du, e.v) - zAt(e.u - du, e.v)) / (2 * du) / -len;
  const dzdy = (zAt(e.u, e.v + dv) - zAt(e.u, e.v - dv)) / (2 * dv) / -Math.max(prof.half(e.u), 1e-3);
  // The surface normal in the cap's own frame (the left cap is the right one turned half round y).
  const n = new THREE.Vector3(-dzdx * side, -dzdy, 1).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  const m = new THREE.Matrix4().makeTranslation(ex, ey, side * ez * 0.96)
    .multiply(new THREE.Matrix4().makeRotationY(side > 0 ? 0 : Math.PI))
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(q))
    .multiply(new THREE.Matrix4().makeScale(e.r, e.r, e.r * 0.3));
  geo.applyMatrix4(m);
  // Which eye (+1 right, -1 left): the gaze shader moves the iris forward on both.
  geo.setAttribute('eyeSide', new THREE.Float32BufferAttribute(new Float32Array(p.count).fill(side), 1));
  return geo;
}

// ---------- swim shader ----------

// Shared GLSL: lateral (z) displacement that grows towards the tail; fins also flutter.
const SWIM_GLSL = /* glsl */`
uniform float uPhase;
uniform float uAmp;
uniform float uFlutter;
uniform float uFinH;
uniform float uBend;
uniform float uFinPhase;
uniform float uXPed;    // x of the caudal peduncle (the caudal blade lags behind it)
uniform float uVent;    // opercular flare, 0..~0.04
uniform float uAnguil;  // 1 = anguilliform (eels): the whole body undulates
uniform float uLift;    // front of the body raised (an eel resting with its head up)
uniform float uBendTail; // the rear half's turn bend: a damped spring behind uBend, so the tail lags into a turn and overshoots out of it
uniform float uFold;    // dorsal and anal fins fold down and back (0 erect .. 1 folded at speed)
uniform float uCup;     // extra caudal lag when the tail works hard (the blade flexes more)
uniform float uSpineOn; // 1: the midline also follows uSpine, a simulated chain (the moray's body)
uniform vec2 uSpine[12]; // chain offsets (lateral z, vertical y) at x = 0.5 .. -0.5 in 11 equal steps
vec2 spineAt(float x) {
  float f = clamp((0.5 - x) * 11.0, 0.0, 10.999);
  int i = int(f);
  return mix(uSpine[i], uSpine[i + 1], f - float(i));
}
// Lateral offset of the spine (the body midline) at x; x runs from +0.5 (snout) to -0.5 (tail tip).
// Body wave h = A(s) sin(wt + kx): wavelength ~0.95 BL (carangiform-like), amplitude from a small head
// recoil (~0.02 BL) through a minimum ~0.15 BL behind the snout to ~0.1 BL at the tail tip at cruise.
// The caudal blade trails the peduncle by ~45 deg. uBend adds the curvature of a turn.
// Anguilliform: ~0.6 BL wavelength (1.5-2 waves on the body), amplitude ~0.03 BL at the head rising
// to ~0.1 BL at the tail, no separate caudal blade.
float spineH(float x) {
  x = max(x, -0.55);   // (a fin filament trailing past the tail follows the tail, not a wave grown on past it)
  float s = 0.5 - x;
  float env = mix(0.02 - 0.06 * s + 0.2 * s * s, 0.03 + 0.07 * s, uAnguil);
  float lag = (0.8 + uCup) * (1.0 - uAnguil) * (1.0 - smoothstep(uXPed - 0.12, uXPed + 0.02, x));
  float bend = mix(uBendTail, uBend, smoothstep(-0.3, 0.2, x));
  return uAmp * env * sin(uPhase + x * mix(6.6, 10.5, uAnguil) - lag) + bend * (x - 0.05) * (x - 0.05) * 2.0 + uSpineOn * spineAt(x).x;
}
// Raise the front of the body, bending up ahead of x = 0.1.
float liftY(float x) { float d = max(0.0, x - 0.1); return uLift * d * d * 2.5 + uSpineOn * spineAt(x).y; }
// Travelling wave along the dorsal/anal fins (head to tail), confined to the fins.
float finFlutter(vec3 p) {
  float fin = smoothstep(uFinH, uFinH + 0.15, abs(p.y));
  return uFlutter * fin * 0.018 * sin(uFinPhase + p.x * 14.0 + abs(p.y) * 6.0);
}
// Gill cover breathing: the rear of the operculum flares out and back (aCover: the share of the flare
// each body vertex takes, most at the margin; the rings behind the margin stay put, so the gill
// opening under it widens).
#ifdef FISH_COVER
attribute float aCover;
float ventScale(vec3 p) { return 1.0 + uVent * 1.5 * aCover; }
#else
float ventScale(vec3 p) { return 1.0; }
#endif
`;

// Light transport through fish tissue (physically motivated, cheap enough for every fish):
//  - transmission: Beer-Lambert through the tissue thickness in mm; red survives furthest, so thin
//    parts (dorsal ridge, peduncle, fin bases, fins) glow warm when backlit, with a forward-scattering
//    lobe when looking towards the light;
//  - diffusion: subsurface scattering softens the terminator (wrapped Lambert, wider for red);
//  - ambient light arriving from behind (downwelling, water radiance) also passes through.
const TISSUE_GLSL = /* glsl */`
#ifdef FISH_TISSUE
{
  vec3 Nn = normal;
  vec3 Tt = exp(-uTissueSigma * tissueThickMM);
  vec3 alb = material.diffuseColor;
  // White pattern is a dense leucophore/iridophore layer that scatters light back before it reaches
  // the red-transmitting muscle, so white skin gets only a fifth of the tissue glow.
  float leu = 1.0 - 0.8 * smoothstep(0.55, 0.85, min(alb.r, min(alb.g, alb.b)));
  Tt *= leu;
  #if NUM_DIR_LIGHTS > 0
  for (int i = 0; i < NUM_DIR_LIGHTS; i++) {
    vec3 L = directionalLights[i].direction;
    float ndl = dot(Nn, L);
    float back = saturate(-ndl);
    float lobe = pow(saturate(dot(geometryViewDir, -L)), 6.0);
    reflectedLight.directDiffuse += alb * Tt * directionalLights[i].color * RECIPROCAL_PI * back * (1.0 + 2.5 * lobe);
    vec3 wrapped = saturate((vec3(ndl) + uWrap) / (1.0 + uWrap));
    reflectedLight.directDiffuse += alb * directionalLights[i].color * RECIPROCAL_PI * max(wrapped - saturate(ndl), 0.0) * leu;
  }
  #endif
  vec3 backIrr = vec3(0.0);
  #if NUM_HEMI_LIGHTS > 0
  for (int i = 0; i < NUM_HEMI_LIGHTS; i++) backIrr += getHemisphereLightIrradiance(hemisphereLights[i], -Nn);
  #endif
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
  backIrr += getIBLIrradiance(-Nn);
  #endif
  reflectedLight.indirectDiffuse += alb * Tt * backIrr * RECIPROCAL_PI;
}
#endif
`;

// tissue: null (plain), { kind: 'body', sizeMM } (thickness from the aThick attribute, fish units)
// or { kind: 'fin', thickMM } (thin membrane).
export function makeSwimMaterial(base, uniforms, tissue = null) {
  base.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    if (tissue) {
      const body = tissue.kind === 'body';
      Object.assign(shader.uniforms, {
        // Absorption+scattering loss per mm of fish tissue (muscle/skin): blue-green die out first.
        uTissueSigma: { value: body ? new THREE.Vector3(0.38, 0.8, 1.05) : new THREE.Vector3(0.9, 1.4, 1.8) },
        uWrap: { value: body ? new THREE.Vector3(0.45, 0.22, 0.14) : new THREE.Vector3(0.0, 0.0, 0.0) },
        uSizeMM: { value: tissue.sizeMM || 100 },
        uThickMM: { value: tissue.thickMM || 0.2 },
      });
      shader.defines = { ...shader.defines, FISH_TISSUE: '' };
      shader.vertexShader = (body ? 'attribute float aThick;\nvarying float vThick;\n' : '') + shader.vertexShader
        .replace('#include <fog_vertex>', '#include <fog_vertex>\n' + (body ? 'vThick = aThick;' : ''));
      shader.fragmentShader = 'uniform vec3 uTissueSigma;\nuniform vec3 uWrap;\nuniform float uSizeMM;\nuniform float uThickMM;\n' +
        (body ? 'varying float vThick;\n#define tissueThickMM (vThick * uSizeMM)\n'
          // A fin's rays are ~4x the membrane's thickness (thickMap R), so backlit they show dark on a glowing film.
          // (thickMap is the fin's roughnessMap, whose R holds it: read through that sampler, not a unit of its own.)
          : tissue.thickMap ? '#define tissueThickMM (uThickMM * mix(1.0, 4.0, texture2D(roughnessMap, vRoughnessMapUv).r))\n'
          : '#define tissueThickMM uThickMM\n') +
        shader.fragmentShader.replace('#include <lights_fragment_end>', '#include <lights_fragment_end>\n' + TISSUE_GLSL);
    }
    shader.vertexShader = SWIM_GLSL + shader.vertexShader
      .replace('#include <beginnormal_vertex>', `
        // Each cross-section is carried by the spine curve and turned to its tangent, so the body keeps
        // its length and the caudal blade pitches with the wave (instead of a sideways shear).
        float swH = spineH(position.x);
        float swT = atan((spineH(position.x + 0.005) - swH) / 0.005);
        float swC = cos(swT), swS = sin(swT);
        vec3 objectNormal = vec3(normal);
        #ifdef FISH_JAW
          // The jaw's shear (below) applied to its normals (inverse transpose of its x-derivative, with the
          // angle easing off along x by aJawG), so the lowered chin and the stretched throat are lit as
          // they now lie.
          { float a = -uGape * aJaw, k = uGape * aJawG, dx = position.x - uHinge.x;
            float dEx = cos(a) - 1.0 + dx * sin(a) * k, dDy = sin(a) - dx * cos(a) * k;   // da/dx = -k
            objectNormal.x = (objectNormal.x - dDy * objectNormal.y) / (1.0 + dEx); }
        #endif
        objectNormal = vec3(objectNormal.x * swC - objectNormal.z * swS, objectNormal.y, objectNormal.x * swS + objectNormal.z * swC);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 p0 = position;
        #ifdef FISH_JAW
          // Lower jaw (aJaw: 1 on the jaw): drops as if turned down about the hinge at the corner of the
          // mouth, but each point moves as its lip does at the same x (a shear), so the chin's underside,
          // below the hinge, comes down with the lip instead of swinging back into the throat.
          { float a = -uGape * aJaw, dx = p0.x - uHinge.x;
            p0.x += dx * (cos(a) - 1.0); p0.y += dx * sin(a); }
        #endif
        #ifdef FISH_FIN
          // Median fins fold: rays above the body lower and sweep back (not the caudal blade).
          { float over = abs(p0.y) - uFinH;
            if (over > 0.0 && p0.x > uXPed + 0.03) {
              float k = uFold * smoothstep(0.0, 0.05, over);
              p0.y = sign(p0.y) * (uFinH + over * (1.0 - 0.55 * k));
              p0.x -= over * 0.35 * k;
            } }
        #endif
        vec3 transformed = p0;
        float swZ = p0.z * ventScale(p0) + finFlutter(p0);
        transformed.x = p0.x - swZ * swS;
        transformed.y = p0.y + liftY(p0.x);
        transformed.z = swH + swZ * swC;`);
    if (tissue?.kind === 'fin') shader.defines = { ...shader.defines, FISH_FIN: '' };
    if (tissue?.packed) {
      // Second channels of the packed body maps (see buildFishModel): film thickness from the iridescence
      // map's G, and the cavity from the roughness map's R, applied as three's aoMap would (indirect
      // diffuse, sheen and specular occlusion), without a sampler each.
      shader.fragmentShader = shader.fragmentShader
        .replace('material.iridescenceThickness = iridescenceThicknessMaximum;',
          'material.iridescenceThickness = mix( iridescenceThicknessMinimum, iridescenceThicknessMaximum, texture2D( iridescenceMap, vIridescenceMapUv ).g );')
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        #ifdef USE_ROUGHNESSMAP
        { float ambientOcclusion = texture2D( roughnessMap, vRoughnessMapUv ).r;
          reflectedLight.indirectDiffuse *= ambientOcclusion;
          #if defined( USE_SHEEN )
            sheenSpecularIndirect *= ambientOcclusion;
          #endif
          #if defined( USE_ENVMAP ) && defined( STANDARD )
            float dotNV = saturate( dot( geometryNormal, geometryViewDir ) );
            reflectedLight.indirectSpecular *= computeSpecularOcclusion( dotNV, ambientOcclusion, material.roughness );
          #endif
        }
        #endif`);
    }
    if (tissue?.detail) {
      // Skin detail (detailTile): a tiling normal added to the body's own (UDN blend), faded out by the
      // tile's size on screen: fully there while a tile spans 40+ px, gone below ~12 px.
      const D = tissue.detail;
      Object.assign(shader.uniforms, { uDetail: { value: D.tex }, uDetailRep: { value: D.rep }, uDetailStr: { value: D.str } });
      shader.fragmentShader = 'uniform sampler2D uDetail;\nuniform vec2 uDetailRep;\nuniform float uDetailStr;\n' + shader.fragmentShader
        .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          mapN.xy *= normalScale;
          { vec2 dUv = vNormalMapUv * uDetailRep;
            float fw = max(length(dFdx(dUv)), length(dFdy(dUv)));
            float k = uDetailStr * (1.0 - smoothstep(1.0 / 40.0, 1.0 / 12.0, fw));
            if (k > 0.001) { vec3 dN = texture2D(uDetail, dUv).xyz * 2.0 - 1.0; mapN = vec3(mapN.xy + dN.xy * k, mapN.z); } }
          normal = normalize( tbn * mapN );
        #else
          #include <normal_fragment_maps>
        #endif`);
    }
    if (tissue?.night) {
      // Night (and stress) colours: chromatophores contract or expand over minutes (Hobson 1972: at dusk
      // many diurnal reef fish pale or blotch, others darken). uNight 0..1, set in fish.js.
      //   pale: desaturates towards a light mottled grey (yellow tang's white night patch, blue tang's fade)
      //   dark: desaturates and darkens (chromis, idol)
      const pale = tissue.night === 'pale';
      shader.fragmentShader = 'uniform float uNight;\n' + shader.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        { float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
          ${pale
    ? 'float blot = 0.5 + 0.5 * sin(vMapUv.x * 23.0 + sin(vMapUv.y * 9.0) * 2.0); vec3 night = mix(vec3(l), vec3(0.75 + 0.2 * blot), 0.45);'
    : 'vec3 night = vec3(l) * 0.45 + diffuseColor.rgb * 0.12;'}
          diffuseColor.rgb = mix(diffuseColor.rgb, night, uNight * 0.8); }`);
    }
    if (tissue?.jaw) {
      shader.defines = { ...shader.defines, FISH_JAW: '' };
      shader.vertexShader = 'attribute float aJaw;\nattribute float aJawG;\nuniform float uGape;\nuniform vec2 uHinge;\n' + shader.vertexShader;
    }
    if (tissue?.cover) {
      // Inside the mouth and the gill opening (aSlit): the skin texture carried in, in shadow and
      // reddened (blood-rich lining and gills), so it reads as a cavity rather than a hole.
      shader.defines = { ...shader.defines, FISH_COVER: '' };
      shader.vertexShader = 'attribute float aSlit;\nvarying float vSlit;\n' + shader.vertexShader
        .replace('vec3 transformed = p0;', 'vec3 transformed = p0;\n        vSlit = aSlit;');
      shader.fragmentShader = 'varying float vSlit;\n' + shader.fragmentShader
        .replace('#include <map_fragment>', '#include <map_fragment>\n  diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(0.32, 0.16, 0.15) + vec3(0.03, 0.006, 0.008), vSlit);')
        // A cavity is shadowed: no sheen off its walls and little direct light (its walls facing the light
        // would otherwise stand out as pale bands); the skin shows faintly by the ambient light.
        .replace('#include <aomap_fragment>', 'reflectedLight.directSpecular *= 1.0 - vSlit;\n  reflectedLight.indirectSpecular *= 1.0 - vSlit;\n  reflectedLight.directDiffuse *= 1.0 - 0.85 * vSlit;\n  #include <aomap_fragment>');
    }
  };
  base.customProgramCacheKey = () => 'swim-' + (tissue ? tissue.kind + (tissue.jaw ? '-jaw' : '') + (tissue.cover ? '-cover' : '') + (tissue.night ? '-night-' + tissue.night : '') + (tissue.thickMap ? '-thick' : '') + (tissue.detail ? '-detail' : '') + (tissue.packed ? '-packed' : '') : 'plain');
  return addCaustics(base);   // fish swim through the same focused light as the reef
}

// ---------- geometry ----------

// Head relief (sp.ridges): ridges (h > 0) and grooves (h < 0) drawn on the side view as segments from
// (u0, v0) to (u1, v1) (v as for the eye), w wide and h high (TL), raised along the section's radius:
// the lionfish's bony suborbital stay and brow, the triggerfish's groove before the eye and its lips.
function reliefOf(sp, prof) {
  const P = (u, v) => [prof.x(u), prof.centre(u) - v * prof.half(u)];
  const S = sp.scalpel, len = sp.body.len;
  const all = [...(sp.ridges || []), ...(S ? [{ u0: S.u - S.len * 0.35, v0: S.v, u1: S.u + S.len * 0.35, v1: S.v, w: S.len * len * 0.12, h: S.len * len * 0.05 }] : [])];
  const R = all.map((r) => ({ ...r, a: P(r.u0, r.v0), b: P(r.u1 ?? r.u0, r.v1 ?? r.v0) }));
  return (x, y) => {
    let d = 0;
    for (const r of R) {
      const ex = r.b[0] - r.a[0], ey = r.b[1] - r.a[1], L2 = ex * ex + ey * ey;
      const t = L2 > 0 ? clamp(((x - r.a[0]) * ex + (y - r.a[1]) * ey) / L2, 0, 1) : 0;
      const dx = x - r.a[0] - t * ex, dy = y - r.a[1] - t * ey;
      d += r.h * Math.exp(-(dx * dx + dy * dy) / (r.w * r.w));
    }
    return d;
  };
}

function bodyGeometry(prof, sp) {
  const fine = !!sp.ridges, NU = fine ? 170 : 140, NA = 112;
  const relief = reliefOf(sp, prof);
  const len = sp.body.len, G = gillOf(sp), M = mouthOf(sp);
  const us = [];
  for (let i = 0; i <= NU; i++) { const t = i / NU; us.push(t * t * 0.35 + t * 0.65); }
  // Ring angles (th = 0 is the dorsal midline, texture v = -cos th): closer together on the flanks,
  // where the mouth, eye and gill margin are, than over the back and belly.
  const thAt = (a) => { const t = a / NA; return Math.PI * 2 * t - 0.12 * Math.sin(Math.PI * 4 * t); };
  // The gape: every ring has a vertex on it each side (index iL on +z, NA - iL on -z), the angles
  // round it eased so the line falls on that vertex; ahead of the corner of the mouth the vertex is
  // doubled twice over (upper lip, its inner face, the lower lip's inner face, lower lip), so the jaws
  // part along a clean seam and the band between the inner faces is the inside of the mouth.
  const lineV = (u) => lerp(M.v0, M.v, clamp(u / M.u, 0, 1));
  const th0 = Math.acos(-lineV(M.u * 0.5));
  let iL = 1;
  for (let a = 1; a < NA / 2; a++) if (Math.abs(thAt(a) - th0) < Math.abs(thAt(iL) - th0)) iL = a;
  const W = 10, angle = (a, u) => {
    const d = Math.acos(clamp(-lineV(u), -1, 1)) - thAt(iL);
    const w = (k) => Math.max(0, 1 - Math.abs(a - k) / W);
    return thAt(a) + d * w(iL) - d * w(NA - iL);   // mirrored on the -z side
  };
  // Near the gill margin the rings bend to follow its bow, so none crosses it; the body-side rings of
  // the margin sit GAP behind it, and the rings behind those stay behind.
  const GAP = 0.0025;
  const backU = (v) => G.edge(v) + GAP * G.fade(v);
  const bendU = (u, v) => {
    if (!G) return u;
    const b = u - (G.u - G.edge(v)) * Math.max(0, 1 - Math.abs(u - G.u) / 0.08);
    return u > G.u ? Math.max(b, backU(v) + 0.001) : b;
  };
  // Lips: raised either side of the gape, with a crease along it, fading out past the corner.
  const mw = Math.min(0.004 + 0.05 * M.u, 0.12 * prof.half(M.u));
  // sc: the nose dome's shrink at this ring; the lips shrink with it and meet at the tip (at full size
  // they climbed the shrinking dome, a dark V over the mouth head-on).
  const lips = (u, v, h, sc = 1) => {
    const t = ((u - M.u) * len) / mw;
    if (t > 1.5) return 0;
    const w = mw * Math.min(1, sc), dy = (v - lineV(u)) * h;
    const lip = Math.exp(-(((dy - w) / (0.7 * w)) ** 2)) + Math.exp(-(((dy + w) / (0.7 * w)) ** 2));
    return (0.4 * lip - 0.35 * Math.exp(-((dy / (0.45 * w)) ** 2))) * w * (1 - smooth01(t + 0.5));
  };
  const R = NA + 6;   // vertices per ring: NA round it, and the three extra copies on the gape each side
  const pos = [], uv = [], thick = [], idx = [], jaw = [], jawG = [], cov = [], slit = [];
  // One ring at body position u0, or a ring of the nose dome (capX: its x; the section at uSec
  // shrunk by scale, while u0 places the mouth, jaw and texture). seam: the rings on the gill margin,
  // { cover, slit, back }: the cover's edge (twice: its outer face and the start of the gill opening)
  // and, GAP behind and a little sunk, the body's (the opening's far side, then skin).
  const ringOf = (u0, scale = 1, capX = null, seam = null, uSec = null) => {
    const mouthRing = (seam ? G.u : u0) < M.u;
    // dv: texture offset for the lips' inner faces, so the inside of the mouth maps the skin just above
    // and below the gape (shown darkened, FISH_COVER) rather than one stretched row of it.
    const put = (a, jw, sl, dv = 0) => {
      const v = -Math.cos(thAt(a));   // which part of the gill margin this vertex sits on
      const u = seam ? (seam.back ? backU(v) : G.edge(v)) : capX != null ? u0 : bendU(u0, v);
      const th = angle(a, u), cy = Math.cos(th), vv = -cy;
      const us_ = uSec ?? u, h = prof.half(us_) * scale, yc = prof.centre(us_), x = capX ?? prof.x(u);
      let y = yc + cy * h, z = flankZ(sp, prof, us_, vv, seam ? !seam.back : undefined) * scale;
      if (seam?.back && seam.slit) z *= 1 - 0.04 * G.fade(vv);   // the gill chamber is sunk under the cover
      const k = 1 + (relief(x, y) + lips(u, vv, h, scale)) / Math.max(Math.hypot(y - yc, z), 2 * mw * Math.min(1, scale), 1e-3);
      y = yc + (y - yc) * k; z *= k;
      pos.push(x, y, Math.sign(Math.sin(th)) * z);
      uv.push(u, clamp((1 + cy) / 2 + dv, 0, 1));
      // Tissue a backlight has to pass through: across the body on the flanks, but no less than most
      // of the section's smaller axis at the back, belly and nose, where the distance to the midplane
      // falls to nothing yet the light still crosses the whole body (they glowed as thin lines).
      thick.push(2 * Math.max(z, 0.8 * Math.min(prof.width(us_), prof.half(us_))));
      jaw.push(jw);
      jawG.push(jw > 0 ? wjG : 0);
      // How much of the breathing flare (fish.js) a point takes: most at the cover's margin.
      const c = capX != null || seam?.back ? 0 : coverAt(G, u, vv, seam ? true : undefined);
      cov.push(c * c);
      slit.push(sl);
    };
    // The lower jaw's share of the swing eases off over the last 30% before the corner, so the chin
    // and throat skin stretch smoothly there instead of creasing against the head behind.
    const wj = mouthRing ? 1 - smooth01((u0 - 0.7 * M.u) / (0.3 * M.u)) : 0;
    // and how fast it eases (per unit x), for the shader to tilt the normals to match
    const tj = (u0 - 0.7 * M.u) / (0.3 * M.u);
    const wjG = mouthRing && capX == null && tj > 0 && tj < 1 ? (6 * tj * (1 - tj)) / (0.3 * M.u) / len : 0;
    const gs = seam?.slit ? 1 : 0, mi = mouthRing ? 1 : gs, mj = wj, MV = mouthRing ? 0.05 : 0;
    for (let a = 0; a < NA; a++) {
      const lower = a > iL && a < NA - iL ? wj : 0;
      if (a === iL) {
        // Down the +z side: upper lip, its inner face, the lower lip's inner face, the lower lip
        // (texture v rises dorsally).
        put(a, 0, gs); put(a, 0, mi, MV); put(a, mj, mi, -MV); put(a, mj, gs);
      } else if (a === NA - iL) {
        // Back up the -z side: lower lip first.
        put(a, mj, gs); put(a, mj, mi, -MV); put(a, 0, mi, MV); put(a, 0, gs);
      } else put(a, lower, gs);
    }
  };
  const tip = (u) => { thick.push(1.6 * Math.min(prof.width(u), prof.half(u))); jaw.push(0); jawG.push(0); cov.push(0); slit.push(0); };
  // Nose: an elliptical dome taking over from the head at uS, where the head's surface still slopes
  // gently enough to round over (most heads rise almost vertically from a blunt front at u = 0, and a
  // cap set on that front sat on it as a separate knob with a crease round it). The dome leaves the
  // head at its own slope, so there is no crease, and closes at the tip; its rings shrink the section
  // at uS while carrying the mouth, jaw and texture on from u = uS to 0.
  const dh = (u) => (prof.half(u + 1e-3) - prof.half(Math.max(0, u - 1e-3))) / (u + 1e-3 - Math.max(0, u - 1e-3));
  const ROUND = 0.8;   // the dome's length along x over its height (1: a hemisphere)
  const domeAt = (u) => { const r = prof.half(u); return { r, t: (dh(u) / len / r) * ROUND * r }; };   // t: tan of where the dome joins
  let uS = 0;
  for (let u = 0; u < Math.min(0.06, 0.7 * M.u + 0.01); u += 0.002) { uS = u; if (domeAt(u).t < Math.tan(1.0)) break; }
  const { r: rS, t: tS } = domeAt(uS);
  const phi0 = Math.atan(Math.max(0, tS)), aX = (ROUND * rS) / Math.cos(phi0);   // x semi-axis of the dome's ellipse
  const domeLen = aX * (1 - Math.sin(phi0)), xS = prof.x(uS), DOME = 7;
  // The snout tip, four times over: for the upper jaw's skin, the lower jaw's (it moves with it), and
  // the inner faces of each, which close the front of the open mouth.
  for (const [jw, sl] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
    // (the inner copies map the skin either side of the gape, as the lips' inner faces do)
    pos.push(xS + domeLen, prof.centre(uS), 0); uv.push(0, sl ? clamp((1 - M.v0) / 2 + (jw ? -0.05 : 0.05), 0, 1) : 0.5); tip(uS);
    jaw[jaw.length - 1] = jw; slit[slit.length - 1] = sl;
  }
  let rings = 0;
  for (let k = DOME; k >= 1; k--, rings++) {
    const phi = phi0 + (k / (DOME + 1)) * (Math.PI / 2 - phi0);
    ringOf(uS * (1 - k / (DOME + 1)), Math.cos(phi) / Math.cos(phi0), xS + aX * (Math.sin(phi) - Math.sin(phi0)), null, uS);
  }
  const slitRings = [];
  let seamed = !G;
  for (const u of [uS, ...us.filter((u) => u > uS + 1e-4)]) {
    if (!seamed && u > G.u) {
      for (const seam of [{}, { slit: true }, { slit: true, back: true }, { back: true }]) {
        if (seam.slit) slitRings.push(rings);
        ringOf(G.u, 1, null, seam); rings++;
      }
      seamed = true;
    }
    ringOf(u); rings++;
  }
  const tailIdx = pos.length / 3;
  pos.push(prof.x(1) - 0.004, prof.centre(1), 0); uv.push(1, 0.5); tip(1);
  const ring = (i) => 4 + i * R;
  // Fan from the tip: upper-jaw pairs to the upper tip, lower-jaw pairs to the lower, and a pair that
  // spans the gape (an inner face of each lip) to both inner tips.
  for (let a = 0; a < R; a++) {
    const p = ring(0) + a, q = ring(0) + ((a + 1) % R), jp = jaw[p] > 0, jq = jaw[q] > 0;
    if (jp === jq) idx.push(jp ? 1 : 0, q, p);
    else if (jq) idx.push(3, q, p, 3, p, 2);   // down the +z side: upper (p) to lower (q)
    else idx.push(2, q, p, 2, p, 3);           // back up the -z side
  }
  for (let i = 0; i < rings - 1; i++) {
    for (let a = 0; a < R; a++) {
      const a1 = (a + 1) % R;
      const p0 = ring(i) + a, p1 = ring(i) + a1, p2 = ring(i + 1) + a, p3 = ring(i + 1) + a1;
      idx.push(p0, p1, p2, p1, p3, p2);
    }
  }
  const last = ring(rings - 1);
  for (let a = 0; a < R; a++) idx.push(last + a, last + ((a + 1) % R), tailIdx);
  // The rings run around +x, so the triangles above wind inwards; flip them so faces point outwards.
  for (let t = 0; t < idx.length; t += 3) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aThick', new THREE.Float32BufferAttribute(thick, 1));
  g.setAttribute('aJaw', new THREE.Float32BufferAttribute(jaw, 1));
  g.setAttribute('aJawG', new THREE.Float32BufferAttribute(jawG, 1));
  g.setAttribute('aCover', new THREE.Float32BufferAttribute(cov, 1));
  g.setAttribute('aSlit', new THREE.Float32BufferAttribute(slit, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  // Coincident copies (the gape, the gill margin) have no normal of their own where the faces between
  // them have no width: take a neighbour's, along the ring and then across the gill margin.
  const n = g.attributes.normal, bad = (i) => Math.hypot(n.getX(i), n.getY(i), n.getZ(i)) < 0.5;
  const copy = (i, j) => n.setXYZ(i, n.getX(j), n.getY(j), n.getZ(j));
  for (const i of [1, 2, 3]) if (bad(i)) copy(i, 0);   // the tip's copies
  slitRings.forEach((r, k) => { for (let a = 0; a < R; a++) if (bad(ring(r) + a)) copy(ring(r) + a, ring(k ? r + 1 : r - 1) + a); });
  for (let i = 0; i < rings; i++) {
    for (let a = 0; a < R; a++) if (bad(ring(i) + a)) copy(ring(i) + a, ring(i) + ((a + R - 1) % R));
    for (let a = R - 1; a >= 0; a--) if (bad(ring(i) + a)) copy(ring(i) + a, ring(i) + ((a + 1) % R));
  }
  return g;
}

// ---------- assembled model (cached per species) ----------

const cache = new Map();

// ---- Skin texture cache (pc/models/skins/, git-ignored) ----
// Painting a species' skin (the scale lattice, pigment, normal and sheen maps) and its fins' relief
// maps takes ~1 s. The results are saved as lossless PNGs and reused while nothing that made them has
// changed: the key hashes the species' look (everything but behaviour) and the source of the painters,
// so editing either repaints. loadSkinCache() reads the saved maps before fish are built; species
// painted live are saved back when the page is served locally (tools/serve.mjs accepts the POST).
const SKIN_CACHE_VERSION = 1;
const SKIN_MAPS = ['skin', 'normal', 'irid', 'cr', 'finNormal', 'finData'];
const skinCache = new Map();   // id -> { key, img: { name: HTMLImageElement } }
let skinBase = null;           // where to save live-painted maps, or null (not local)
function skinKey(sp) {
  const look = JSON.stringify(sp, (k, v) => (['brain', 'fact', 'name', 'sci', 'swim'].includes(k) ? undefined : v));
  const src = [paintSkin, paintFins, finMaps, applyShade, makeProfile, gillU, gillOf, naresOf, mouthOf, finOutline, caudalOutline, pelvicOutline, cellHash].map(String).join('');
  let h = 0x811c9dc5;
  for (const s of [String(SKIN_CACHE_VERSION), look, src]) for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}
export async function loadSkinCache(species, base = './models/skins/') {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  skinBase = local ? new URL(base, location.href).pathname.replace(/^\//, '') : null;
  let hits = 0;
  await Promise.all(species.map(async (sp) => {
    const key = skinKey(sp);
    try {
      const r = await fetch(`${base}${sp.id}.json`, { cache: 'no-cache' });
      if (!r.ok || (await r.json()).key !== key) return;
      const img = {};
      await Promise.all(SKIN_MAPS.map(async (n) => {
        // onload, not decode(): decode() can wait indefinitely in a background tab.
        img[n] = await new Promise((ok, fail) => {
          const im = new Image();
          im.onload = () => ok(im); im.onerror = fail;
          setTimeout(() => fail(new Error('timeout')), 20000);
          im.src = `${base}${sp.id}-${n}.png?${key}`;
        });
      }));
      skinCache.set(sp.id, { key, img }); hits++;
    } catch { /* not cached (or unreadable): paint it live */ }
  }));
  console.log(`Skin cache: ${hits}/${species.length} species`);
}
function saveSkin(sp, key, canvases) {
  if (!skinBase) return;
  const post = (path, body) => fetch(`/__save?path=${skinBase}${path}`, { method: 'POST', body }).catch(() => {});
  Promise.all(SKIN_MAPS.map((n) => new Promise((ok) => canvases[n].toBlob(ok, 'image/png')).then((b) => post(`${sp.id}-${n}.png`, b))))
    .then(() => post(`${sp.id}.json`, JSON.stringify({ key })));   // last, so a half-written set never matches
}

function speciesAssets(sp) {
  if (cache.has(sp.id)) return cache.get(sp.id);
  const prof = makeProfile(sp.body);
  const hit = skinCache.get(sp.id), key = hit ? hit.key : skinKey(sp);
  const fins = paintFins(sp, prof, !!hit);
  const skin = hit ? { map: hit.img.skin, normal: hit.img.normal, irid: hit.img.irid, cr: hit.img.cr } : paintSkin(sp, prof);
  if (hit) { fins.normal = hit.img.finNormal; fins.data = hit.img.finData; }
  else saveSkin(sp, key, { skin: skin.map, normal: skin.normal, irid: skin.irid, cr: skin.cr, finNormal: fins.normal, finData: fins.data });
  // The skin's mean colour (for the velvet sheen of minute-scaled species), from an 8 x 4 reduction.
  const avg = (() => {
    const t = makeCanvas(8, 4), tg = t.getContext('2d', { willReadFrequently: true });
    tg.drawImage(skin.map, 0, 0, 8, 4);
    const px = tg.getImageData(0, 0, 8, 4).data, s = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) for (let ch = 0; ch < 3; ch++) s[ch] += px[i + ch] / 255 / 32;
    return new THREE.Color().setRGB(s[0], s[1], s[2], THREE.SRGBColorSpace);
  })();
  const pect = sp.pectoral ? paintPectoral(sp) : makeCanvas(4, 4);
  const eye = paintEye(sp);
  const tex = (c, srgb = true) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 16;   // the flank is often seen at grazing angles (three clamps to what the GPU has)
    return t;
  };
  const finGeo = mergeGeometries(fins.meshes.flatMap((m) => {
    const geo = finMesh(m, fins);
    return m.xforms ? m.xforms.map((x) => geo.clone().applyMatrix4(x)) : [geo];
  }));
  const pectGeo = sp.pectoral ? pectoralGeometry(sp) : null;
  const tubes = (list) => (list.length ? mergeGeometries(list.map((d) => tubeGeometry(d))) : null);
  const a = {
    prof,
    bodyGeo: bodyGeometry(prof, sp),
    finGeo, pectGeo,
    tubeGeo: tubes([...fins.tubes, ...appendageTubes(sp, prof)]), pectTubeGeo: tubes(sp.pectoral ? pectoralTubes(sp) : []),
    skinTex: tex(skin.map), normalTex: tex(skin.normal, false), iridTex: tex(skin.irid, false), crTex: tex(skin.cr, false), skinAvg: avg, detail: detailFor(sp, prof),
    eyeRingTex: tex(paintEyeRing(sp), false), finTex: tex(fins.canvas), finNormalTex: tex(fins.normal, false), finDataTex: tex(fins.data, false), pectTex: tex(pect), eyeTex: tex(eye),
    eyeGeos: [1, -1].map((side) => eyeGeometry(prof, sp, side)),
    canvases: { skin: skin.map, fins: fins.canvas, pect },
  };
  cache.set(sp.id, a);
  return a;
}


// ---------- external models (e.g. generated with Tripo3D) ----------
//
// pc/models/models.json maps species id -> { file, flip?, rotate?: [deg x, y, z], finFrac? }.
// Each model is normalised into fish space: longest axis -> x, nose towards +x, centred,
// length 1. The transform is baked into the geometry so the swim shader (which bends along
// object-space x) animates even an unrigged static mesh.
const custom = new Map();

export async function loadCustomModels(species, base = './models/') {
  let manifest;
  try {
    const r = await fetch(base + 'models.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    manifest = await r.json();
  } catch { return []; }
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  const loader = new GLTFLoader();
  const loaded = [];
  await Promise.all(species.map(async (sp) => {
    const cfg = manifest[sp.id];
    if (!cfg || !cfg.file) return;
    try {
      const gltf = await loader.loadAsync(base + cfg.file);
      custom.set(sp.id, normaliseModel(gltf.scene, cfg));
      loaded.push(sp.id);
    } catch (e) {
      console.warn(`Model for ${sp.id} failed to load, using procedural fish`, e);
    }
  }));
  return loaded;
}

function normaliseModel(root, cfg) {
  root.updateMatrixWorld(true);
  const r = cfg.rotate || [0, 0, 0];
  const pre = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(...r.map(THREE.MathUtils.degToRad)));
  // Gather meshes with their world transforms (plus the manual rotation).
  const parts = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(pre, o.matrixWorld));
    parts.push({ g, mat: o.material });
  });
  const box = new THREE.Box3();
  for (const p of parts) { p.g.computeBoundingBox(); box.union(p.g.boundingBox); }
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  // Longest horizontal axis is the body; rotate it onto x if it lies along z.
  const m = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
  let len = size.x, height = size.y;
  if (size.z > size.x) { m.premultiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)); len = size.z; }
  if (cfg.flip) m.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
  m.premultiply(new THREE.Matrix4().makeScale(1 / len, 1 / len, 1 / len));
  for (const p of parts) { p.g.applyMatrix4(m); p.g.computeVertexNormals(); }
  return { parts, finH: (height / len) * (cfg.finFrac ?? 0.3) };
}

// The swim shader's uniforms (SWIM_GLSL) with their resting values; every swim material needs the full set.
function swimUniforms(over = {}) {
  return {
    uPhase: { value: 0 }, uAmp: { value: 1 }, uFlutter: { value: 1 }, uFinH: { value: 1 }, uBend: { value: 0 }, uFinPhase: { value: 0 },
    uXPed: { value: -0.3 }, uVent: { value: 0 }, uAnguil: { value: 0 }, uLift: { value: 0 },
    uBendTail: { value: 0 }, uFold: { value: 0 }, uCup: { value: 0 }, uSpineOn: { value: 0 }, uSpine: { value: new Float32Array(24) },
    ...over,
  };
}

function buildCustomModel(sp, model) {
  const uniforms = swimUniforms({ uFinH: { value: model.finH }, uXPed: { value: -0.3 } });
  const group = new THREE.Group();
  for (const p of model.parts) {
    const mats = (Array.isArray(p.mat) ? p.mat : [p.mat]).map((src) => {
      const mat = src.clone();
      // Submerged skin: in-water Fresnel (see IN_WATER_IOR), no clearcoat or sheen.
      if (mat.isMeshStandardMaterial) {
        const phys = mat.isMeshPhysicalMaterial ? mat : new THREE.MeshPhysicalMaterial();
        if (phys !== mat) THREE.MeshStandardMaterial.prototype.copy.call(phys, mat);
        phys.ior = IN_WATER_IOR; phys.clearcoat = 0; phys.sheen = 0;
        return makeSwimMaterial(phys, uniforms);
      }
      return makeSwimMaterial(mat, uniforms);
    });
    group.add(new THREE.Mesh(p.g, mats.length === 1 ? mats[0] : mats));
  }
  group.userData = { uniforms, pects: [], fan: false, custom: true };
  return group;
}

// Load one GLB outside models.json (e.g. pc/models/fish/<id>.glb) for side-by-side comparison.
export async function loadFishModel(url, cfg = {}) {
  const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
  return normaliseModel((await new GLTFLoader().loadAsync(url)).scene, cfg);
}

// The fish is submerged: its mucus (n ~1.38) meets water (n ~1.33), a relative index of ~1.04, so the
// surface reflects ~0.04% at normal incidence instead of the 4% three.js assumes for air. No clearcoat
// or sheen either; the visible shine of a fish in water comes from the guanine iridophores (iridescence).
const IN_WATER_IOR = 1.04;

// Labriform pectoral stroke for one fin pivot at stroke phase `ph`: abduction (opening, sin rising) is
// the recovery, when the fin feathers (turns its chord edge-on to the flow) and its rays partly
// collapse; on the power stroke back towards the body it is flat and fully spread.
// open: opening angle (rad); flap: roll of the stroke plane (rad).
export function posePectoral(p, ph, open, flap) {
  const s = p.userData.side, rec = Math.max(0, Math.cos(ph)), fin = p.children[0];
  p.rotation.set(0, s * open, flap);
  fin.rotation.x = s * 0.6 * rec;
  fin.scale.y = 1 - 0.25 * rec;
}

// finDepth: fins write depth (and cut out below 15% alpha, under the faintest fringe), set before building fish. The photo camera
// needs it so translucent fins focus with the body; otherwise fins don't write depth, which avoids
// sorting artefacts between overlapping membranes.
export const fishRender = { finDepth: false };

// opts.model: a model from loadFishModel; opts.procedural: ignore models.json for this species.
export function buildFishModel(sp, opts = {}) {
  if (opts.model) return buildCustomModel(sp, opts.model);
  if (!opts.procedural && custom.has(sp.id)) return buildCustomModel(sp, custom.get(sp.id));
  const a = speciesAssets(sp);
  const uniforms = swimUniforms({
    uFinH: { value: a.prof.H }, uXPed: { value: a.prof.xPed },
    uAnguil: { value: sp.swim?.mode === 'anguilliform' ? 1 : 0 },
    uGape: { value: 0 }, uHinge: { value: new THREE.Vector2(9, 9) }, uNight: { value: 0 },
  });
  const M = mouthOf(sp);   // the lower jaw hinges at the corner of the mouth
  uniforms.uHinge.value.set(a.prof.x(M.u), a.prof.centre(M.u) - M.v * a.prof.half(M.u));
  const bodyMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    // Packed maps, each read through one sampler (the fish shader is at the GPU's 16 texture units with the
    // caustics and reef light): iridescenceMap R = strength, G = film thickness; roughnessMap G =
    // roughness (smooth exposed field, rough comb margins, velvet minute scales), R = cavity (the groove
    // under each free margin, the nostril pits). makeSwimMaterial's `packed` reads the second channels.
    map: a.skinTex, normalMap: a.normalTex, iridescenceMap: a.iridTex,
    roughnessMap: a.crTex, roughness: 1, metalness: 0.0, ior: IN_WATER_IOR,
    // Minute ctenoid scales (velvet): their spinules retro-reflect a little (a low sheen in the body's
    // own colour; any stronger and the fish turns milky).
    ...(a.detail.kind === 'velvet' && { sheen: 0.15, sheenRoughness: 0.6, sheenColor: a.skinAvg.clone().multiplyScalar(0.6) }),
    // Scales overlap in rows along the body, so a light's glint stretches along the flank rather than
    // sitting as a round spot (the body UV's u runs nose to tail, so the tangent is the body axis).
    anisotropy: sp.body.scales === 0 ? 0 : 0.45,
    // Guanine platelet stacks. Silvery and white skin: stack spacing varies widely from scale to scale
    // (hues average out near neutral). Structural colour (sp.iridescent: the chromis' blue-green):
    // regular stacks in a narrow band. sp.irid = { range: [nm, nm], strength } overrides.
    iridescence: sp.irid?.strength ?? (sp.iridescent ? 1.0 : 0.35), iridescenceIOR: 1.8,
    iridescenceThicknessRange: sp.irid?.range ?? (sp.iridescent ? [310, 370] : [200, 620]),
  }), uniforms, { kind: 'body', sizeMM: sp.size * 125, jaw: true, cover: !!gillOf(sp), night: sp.night, detail: a.detail, packed: true });
  // Raised rays (normalMap), rays glossier than the membrane (roughnessMap G x 1) and thicker (thickMap R).
  const finMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.finTex, normalMap: a.finNormalTex, roughnessMap: a.finDataTex, transparent: true, side: THREE.DoubleSide,
    depthWrite: fishRender.finDepth, roughness: 1, alphaTest: fishRender.finDepth ? 0.15 : 0.01, ior: IN_WATER_IOR,
  }), uniforms, { kind: 'fin', thickMM: 0.15 * sp.size * 8, thickMap: a.finDataTex });
  // Pectorals move on their own pivots, so the body wave is off for them (zero uniforms); they
  // still get the membrane light transport.
  const still = swimUniforms({ uAmp: { value: 0 }, uFlutter: { value: 0 }, uFinH: { value: 1 }, uXPed: { value: -9 } });
  const pectMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.pectTex, transparent: true, side: THREE.DoubleSide, depthWrite: fishRender.finDepth, roughness: 0.45, alphaTest: fishRender.finDepth ? 0.15 : 0.01, ior: IN_WATER_IOR,
  }), still, { kind: 'fin', thickMM: 0.15 * sp.size * 8 });

  const group = new THREE.Group();
  const body = new THREE.Mesh(a.bodyGeo, bodyMat);
  const fins = new THREE.Mesh(a.finGeo, finMat);
  fins.renderOrder = 1;
  group.add(fins, body);
  // Spines, free rays and tentacles: solid, glossy, banded by vertex colour; thin enough to glow when backlit.
  const tubeMat = (u, jaw = false) => makeSwimMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, ior: IN_WATER_IOR }), u, { kind: 'fin', thickMM: 0.8 * sp.size * 8, jaw });
  if (a.tubeGeo) group.add(new THREE.Mesh(a.tubeGeo, tubeMat(uniforms, true)));   // chin lappets ride on the lower jaw

  const pects = [], pectTubeMat = a.pectTubeGeo ? tubeMat(still) : null;
  const p = sp.pectoral;
  for (const side of p ? [1, -1] : []) {
    const px = a.prof.x(p.u), py = a.prof.centre(p.u) - p.v * a.prof.half(p.u), pz = a.prof.width(p.u);
    const pivot = new THREE.Group();
    pivot.position.set(px, py, side * pz * 0.9);
    const m = new THREE.Mesh(a.pectGeo, pectMat);
    m.renderOrder = 2;
    m.rotation.y = Math.PI; // point backwards
    if (a.pectTubeGeo) m.add(new THREE.Mesh(a.pectTubeGeo, pectTubeMat));
    pivot.add(m);
    pivot.userData.side = side;
    group.add(pivot);
    pects.push(pivot);
  }

  // Cornea: smooth, but its index (~1.376) nearly matches water, so in the tank it barely reflects.
  // The spherical lens behind it (n ~1.67 at the core) bulges through the pupil and reflects ~1.2%
  // against water, 30 times the skin: that is the catchlight in every photo. A thin clearcoat (fixed
  // F0 0.04 x 0.3) gives it.
  const eyeMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.eyeTex, roughness: 0.1, ior: IN_WATER_IOR, clearcoat: 0.3, clearcoatRoughness: 0.04,
    // The iris' reflective iridophore ring round the pupil (moves with the gaze, as the map does).
    iridescence: 0.3, iridescenceIOR: 1.8, iridescenceThicknessRange: [260, 420], iridescenceMap: a.eyeRingTex,
  }), uniforms);
  // Eye movement: the eyeball turns under a nearly flush cornea, so the iris and pupil slide across the
  // cap. uGaze = (forward, up) in texture units, set per fish in fish.js (saccades and counter-rolling).
  uniforms.uGaze = { value: new THREE.Vector2() };
  {
    const prev = eyeMat.onBeforeCompile, prevKey = eyeMat.customProgramCacheKey.bind(eyeMat);
    a.eyeTex.wrapS = a.eyeTex.wrapT = a.eyeRingTex.wrapS = a.eyeRingTex.wrapT = THREE.ClampToEdgeWrapping;
    eyeMat.onBeforeCompile = (s, r) => {
      prev(s, r);
      s.uniforms.uGaze = uniforms.uGaze;
      s.vertexShader = 'attribute float eyeSide;\nvarying float vEyeSide;\n' + s.vertexShader.replace('#include <uv_vertex>', '#include <uv_vertex>\n  vEyeSide = eyeSide;');
      s.fragmentShader = 'uniform vec2 uGaze;\nvarying float vEyeSide;\n' + s.fragmentShader.replace('#include <map_fragment>', `
        #ifdef USE_MAP
          diffuseColor *= texture2D(map, vMapUv + vec2(uGaze.x * vEyeSide, -uGaze.y));
        #endif`).replace('texture2D( iridescenceMap, vIridescenceMapUv )', 'texture2D( iridescenceMap, vIridescenceMapUv + vec2(uGaze.x * vEyeSide, -uGaze.y) )');
    };
    eyeMat.customProgramCacheKey = () => prevKey() + '-eye';
  }
  for (const geo of a.eyeGeos) group.add(new THREE.Mesh(geo, eyeMat));

  group.userData = { uniforms, pects, fan: p?.kind === 'fan' };
  return group;
}

export function speciesCanvases(sp) { return speciesAssets(sp).canvases; }
