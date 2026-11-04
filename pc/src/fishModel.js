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

// Rear edge of the gill cover (operculum), in body u.
export const gillU = (sp) => sp.eye.u + (0.09 / sp.body.len) + sp.eye.r * 0.6;

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
  const c = makeCanvas(TW, TH), g = c.getContext('2d');
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

  // Melanin shading (countershading, mottling, scale-margin pockets below) goes into its own multiply
  // layer, applied after the scales. White pattern areas are leucophores and iridophores that stay bright,
  // so they take only a fifth of it.
  const shade = makeCanvas(TW, TH), sg = shade.getContext('2d');
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

  // Gill cover: shadowed rear edge with a lit lip, and the fainter pre-opercle groove ahead of it.
  const gillPath = (uu, span, bow) => {
    g.beginPath();
    for (let i = 0; i <= 24; i++) { const v = -span + (2 * span * i) / 24; g.lineTo(U(uu - bow * (1 - (v / span) ** 2)), V(v)); }
  };
  g.lineCap = 'round';
  if (sp.gill !== false) {
  g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2.5 * K; gillPath(g0, 0.78, 0.035); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1.5 * K; gillPath(g0 - (3 * K) / TW, 0.76, 0.035); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1.5 * K; gillPath(g0 - 0.05, 0.6, 0.03); g.stroke();
  // Lateral line: a row of pored scales arching along the upper flank.
  g.fillStyle = 'rgba(0,0,0,0.14)';
  for (let u = g0 + 0.01; u < 0.95; u += 0.012) {
    const t = (u - g0) / (0.95 - g0), v = -0.5 + 0.38 * t * t;
    g.fillRect(U(u), V(v) - 0.6 * K, 2.2 * K, 1.2 * K);
  }
  }
  // Mouth: gape line and slightly darker lips. A long hinged gape (sp.mouth: morays) is lined dark
  // along the lip line; the jaw seam stretches over this lining when the mouth opens.
  if (sp.mouth) {
    const M = sp.mouth, lw = (M.lining ?? 0.06) * TH / 2;
    g.strokeStyle = '#2a0e10'; g.lineWidth = lw; g.lineCap = 'round';
    g.beginPath(); g.moveTo(U(-0.01), V(M.v0)); g.lineTo(U(M.u), V(M.v)); g.stroke();
  } else if (!sp.body.snout) {
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, V(0.08) - 0.7 * K, U(0.045), 1.4 * K);
    g.globalCompositeOperation = 'multiply';
    const lip = g.createRadialGradient(0, V(0.08), 0, 0, V(0.08), U(0.06));
    lip.addColorStop(0, 'rgba(150,130,120,0.6)'); lip.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lip; g.fillRect(0, 0, U(0.07), TH);
    g.globalCompositeOperation = 'source-over';
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

  // Imbricated scales, evaluated analytically in physical body space. Each scale is a disc on a
  // staggered lattice; the more anterior scale lies on top, so the visible part of every scale is
  // its rear (free) field, which rises towards the margin and then drops onto the scale behind.
  const SW = TW / 2, SH = TH / 2;
  const s = (len * (1 - g0)) / (sp.body.scales || 50), dx = s, dy = s * 0.5, r = s * 0.75;
  const height = new Float32Array(SW * SH), shadeImg = new ImageData(SW, SH), iridImg = new ImageData(SW, SH);
  const halfCol = new Float32Array(SW);
  const fade = new Float32Array(SW);   // scales smaller than a few texels would alias into moire
  for (let i = 0; i < SW; i++) {
    halfCol[i] = prof.half((i + 0.5) / SW) * 1.15;   // ~ arc length of the flank
    const texels = Math.min(s / (len / SW), dy / ((2 * halfCol[i]) / SH));
    fade[i] = smooth01((texels - 1.5) / 3);
  }
  for (let j = 0; j < SH; j++) {
    const v = ((j + 0.5) / SH) * 2 - 1;
    for (let i = 0; i < SW; i++) {
      const u = (i + 0.5) / SW, X = u * len, Y = v * halfCol[i];
      const mask = sp.body.scales === 0 ? 0 : smooth01((u - g0 + 0.005) / 0.03) * fade[i];
      let best = Infinity, bt = 0, bd = 1;
      const jr = Math.round(Y / dy);
      for (let rj = jr - 2; rj <= jr + 2; rj++) {
        const off = (rj & 1) * dx * 0.5, cy = rj * dy, ir = Math.round((X - off) / dx);
        for (let ri = ir - 1; ri <= ir + 1; ri++) {
          const cx = ri * dx + off, ddx = X - cx, ddy = Y - cy, d2 = ddx * ddx + ddy * ddy;
          if (d2 < r * r && cx < best) { best = cx; bt = ddx / r; bd = Math.sqrt(d2) / r; }
        }
      }
      const h = (0.5 + 0.5 * bt + 0.25 * (1 - bd * bd)) * mask;
      height[j * SW + i] = h * s * 0.08;   // scale relief ~8% of scale size
      // Pigment pocket along each scale's free margin; slightly paler centres.
      const pocket = smooth01((bd - 0.72) / 0.28) * (bt > 0 ? 1 : 0.3);
      const sh = 1 - mask * (0.2 * pocket - 0.04 * (1 - bd));
      const k = (j * SW + i) * 4;
      shadeImg.data[k] = shadeImg.data[k + 1] = shadeImg.data[k + 2] = clamp(sh, 0, 1) * 255; shadeImg.data[k + 3] = 255;
      // Guanine platelets: reflective exposed fields, strongest on the flanks and belly.
      const ir = mask * (0.35 + 0.65 * smooth01((v + 0.4) / 1.2)) * (0.6 + 0.4 * (bt * 0.5 + 0.5));
      iridImg.data[k] = iridImg.data[k + 1] = iridImg.data[k + 2] = ir * 255; iridImg.data[k + 3] = 255;
    }
  }
  const shadeC = makeCanvas(SW, SH); shadeC.getContext('2d').putImageData(shadeImg, 0, 0);
  sg.drawImage(shadeC, 0, 0, TW, TH);
  applyShade(g, sg);
  const irid = makeCanvas(SW, SH); irid.getContext('2d').putImageData(iridImg, 0, 0);

  // Tangent-space normal map from the height field (OpenGL convention; canvas rows run down = -v).
  const normalImg = new ImageData(SW, SH);
  const du = len / SW;
  for (let j = 0; j < SH; j++) {
    for (let i = 0; i < SW; i++) {
      const dvp = (2 * halfCol[i]) / SH;
      const hx = (height[j * SW + Math.min(SW - 1, i + 1)] - height[j * SW + Math.max(0, i - 1)]) / (2 * du);
      const hy = (height[Math.min(SH - 1, j + 1) * SW + i] - height[Math.max(0, j - 1) * SW + i]) / (2 * dvp);
      const nx = -hx, ny = hy, inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), k = (j * SW + i) * 4;
      normalImg.data[k] = (nx * inv * 0.5 + 0.5) * 255;
      normalImg.data[k + 1] = (ny * inv * 0.5 + 0.5) * 255;
      normalImg.data[k + 2] = (inv * 0.5 + 0.5) * 255;
      normalImg.data[k + 3] = 255;
    }
  }
  const normal = makeCanvas(SW, SH); normal.getContext('2d').putImageData(normalImg, 0, 0);
  return { map: c, normal, irid };
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
  for (const [t, h] of fin.pts) {
    const u = lerp(fin.u0, fin.u1, t);
    outer.push([prof.x(u) - (fin.sweep || 0) * h, prof.centre(u) + sign * (prof.half(u) + h)]);
  }
  return { base, outer, sign };
}

export function caudalOutline(sp, prof) {
  const c = sp.caudal, xp = prof.xPed + 0.02, hp = prof.half(1) * 0.9, tip = -0.5, L = xp - tip, s = c.spread;
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

function paintFins(sp, prof) {
  // Bounds of everything drawn on the sheet.
  let ymax = prof.H * 1.25;
  const fins = sp.fins.map((f) => finOutline(sp, prof, f));
  for (const f of fins) for (const p of f.outer) ymax = Math.max(ymax, Math.abs(p[1]) + 0.03);
  const tail = caudalOutline(sp, prof);
  for (const p of tail) ymax = Math.max(ymax, Math.abs(p[1]) + 0.03);
  if (sp.pelvic) for (const p of pelvicOutline(sp, prof).outline) ymax = Math.max(ymax, Math.abs(p[1]) + 0.03);
  const xmin = -0.52, xmax = 0.52, W = 2048, H = Math.ceil((W * (2 * ymax)) / (xmax - xmin));
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const k = W / (xmax - xmin);
  g.setTransform(k, 0, 0, -k, -xmin * k, ymax * k);
  g.lineJoin = 'round';
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
    // Fin rays, more opaque than the membrane, each with a lit edge. Spines are single, stiff and
    // unjointed; soft rays (lepidotrichia) are jointed and branch towards the margin (the outermost
    // principal caudal rays stay simple).
    const rayCol = spec.rays || 'rgba(35,20,5,0.13)';
    const line = (a, b, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke(); };
    for (let i = 0; i <= n; i++) {
      const t = i / n, [a, b] = rays(t), lit = (p) => [p[0] + 0.0015, p[1]];
      if (i < spines) {
        g.setLineDash([]);
        line(a, b, 0.0045, rayCol); line(lit(a), lit(b), 0.0016, 'rgba(255,255,255,0.18)');
        continue;
      }
      g.setLineDash([0.035, 0.0012]);   // soft-ray joints
      const simple = mer.simpleEnds && (i === 0 || i === n);
      const m = simple ? b : [lerp(a[0], b[0], 0.55), lerp(a[1], b[1], 0.55)], q = [lerp(a[0], b[0], 0.2), lerp(a[1], b[1], 0.2)];
      g.globalAlpha = 0.35;   // rays crowd together at the base; they read fainter there
      line(a, q, 0.0026, rayCol);
      g.globalAlpha = 1;
      line(q, m, 0.0026, rayCol); line(lit(q), lit(m), 0.0012, 'rgba(255,255,255,0.14)');
      if (!simple) for (const s of [-1, 1]) line(m, rays(clamp(t + (s * 0.22) / n, 0, 1))[1], 0.0018, rayCol);
    }
    g.setLineDash([]);
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

  return { canvas: c, xmin, xmax, ymax, meshes, tubes };
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
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Paired appendages on the head and body (supraorbital tentacles, lappets), both sides:
// sp.appendages: [{ u, v (as the eye), len (TL), dir: [x, y, z out], r, flat, shape, color, stripes, nb, bend }].
function appendageTubes(sp, prof) {
  const out = [];
  for (const a of sp.appendages || []) {
    for (const side of [1, -1]) {
      const x = prof.x(a.u), y = prof.centre(a.u) - a.v * prof.half(a.u);
      const z = side * prof.width(a.u) * Math.sqrt(Math.max(0.05, 1 - a.v * a.v)) * 0.9;
      const d = new THREE.Vector3(a.dir[0], a.dir[1], side * a.dir[2]).normalize().multiplyScalar(a.len);
      const bend = a.bend ?? 0.15;
      out.push({
        pts: [[x, y, z], [x + d.x * 0.5 - bend * d.y * 0.5, y + d.y * 0.5 + bend * d.x * 0.5, z + d.z * 0.5], [x + d.x, y + d.y, z + d.z]],
        r0: a.r, r1: a.r * 0.15, flat: a.flat, shape: a.shape, color: a.color, stripes: a.stripes, nb: a.nb || 0,
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

// Eyeball geometry already placed in fish space (so the swim shader moves it with the head).
function eyeGeometry(prof, sp, side) {
  const e = sp.eye, geo = new THREE.SphereGeometry(1, 32, 20);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 - p.getX(i) * 0.5, 0.5 + p.getY(i) * 0.5);   // planar, looking along +z
  const ex = prof.x(e.u), ey = prof.centre(e.u) - e.v * prof.half(e.u);
  const zAt = (u, v) => prof.width(u) * Math.sqrt(Math.max(0.05, 1 - v * v));
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
uniform float uXGill;   // x of the gill cover's rear edge
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
// Gill cover breathing: the rear of the operculum flares out and back.
float ventScale(vec3 p) {
  float m = (1.0 - smoothstep(uXGill, uXGill + 0.07, p.x)) * step(uXGill - 0.004, p.x);
  return 1.0 + uVent * m * (1.0 - smoothstep(uFinH * 0.5, uFinH * 0.9, abs(p.y)));
}
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
        (body ? 'varying float vThick;\n#define tissueThickMM (vThick * uSizeMM)\n' : '#define tissueThickMM uThickMM\n') +
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
        objectNormal = vec3(objectNormal.x * swC - objectNormal.z * swS, objectNormal.y, objectNormal.x * swS + objectNormal.z * swC);
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 p0 = position;
        #ifdef FISH_JAW
          // Lower jaw: turns down about the hinge at the corner of the mouth (aJaw: 1 on the jaw).
          { float a = -uGape * aJaw, c = cos(a), s = sin(a); vec2 d = p0.xy - uHinge;
            p0.xy = uHinge + vec2(d.x * c - d.y * s, d.x * s + d.y * c); }
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
    if (tissue?.jaw) {
      shader.defines = { ...shader.defines, FISH_JAW: '' };
      shader.vertexShader = 'attribute float aJaw;\nuniform float uGape;\nuniform vec2 uHinge;\n' + shader.vertexShader;
    }
  };
  base.customProgramCacheKey = () => 'swim-' + (tissue ? tissue.kind + (tissue.jaw ? '-jaw' : '') : 'plain');
  return addCaustics(base);   // fish swim through the same focused light as the reef
}

// ---------- geometry ----------

// Head relief (sp.ridges): ridges (h > 0) and grooves (h < 0) drawn on the side view as segments from
// (u0, v0) to (u1, v1) (v as for the eye), w wide and h high (TL), raised along the section's radius:
// the lionfish's bony suborbital stay and brow, the triggerfish's groove before the eye and its lips.
function reliefOf(sp, prof) {
  const P = (u, v) => [prof.x(u), prof.centre(u) - v * prof.half(u)];
  const R = (sp.ridges || []).map((r) => ({ ...r, a: P(r.u0, r.v0), b: P(r.u1 ?? r.u0, r.v1 ?? r.v0) }));
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
  const fine = !!sp.ridges, NU = fine ? 160 : 110, NA = fine ? 80 : 56, CAP = 5;
  const relief = reliefOf(sp, prof);
  const e = sp.eye, len = sp.body.len, g0 = gillU(sp);
  // Section exponent: compressed fish (tangs, angels) have a lens-shaped section, thickest along the
  // spine and sharp at the fin bases (> 1); round-bodied fish (gramma, lionfish) are fuller (< 1).
  const flank = sp.body.flank ?? 1.6 - sp.body.width * 1.6;
  const us = [];
  for (let i = 0; i <= NU; i++) { const t = i / NU; us.push(t * t * 0.35 + t * 0.65); }
  // Cross-section at body position u and angle th (th = 0 is the dorsal midline).
  const section = (u, th) => {
    const h = prof.half(u), w = prof.width(u), cy = Math.cos(th), sz = Math.sin(th);
    const v = -cy;   // texture v: -1 dorsal, +1 ventral
    let z = Math.pow(Math.abs(sz), flank) * w;
    z *= 1 - 0.25 * Math.max(0, cy) ** 4;                                  // narrow dorsal ridge (fin base)
    z *= 1 + 0.12 * Math.max(0, -cy) * (1 - smooth01(u / 0.6));            // fuller belly over the gut
    const op = smooth01((u - (g0 - 0.14)) / 0.13) * (1 - smooth01((u - (g0 - 0.01)) / 0.022));
    z *= 1 + 0.045 * op * (1 - Math.abs(cy) ** 3);                         // gill cover overhangs the flank
    const du = (u - e.u) / (e.r * 1.6 / len), dv = (v - e.v) / (e.r * 1.6 / Math.max(h, 1e-3));
    z *= 1 + 0.07 * Math.exp(-(du * du + dv * dv));                       // eye socket
    let y = prof.centre(u) + cy * h;
    if (fine) {
      const yc = prof.centre(u), ry = y - yc, k = 1 + relief(prof.x(u), y) / Math.max(1e-3, Math.hypot(ry, z));
      y = yc + ry * k; z *= k;
    }
    return [y, Math.sign(sz) * z];
  };
  const pos = [], uv = [], thick = [], idx = [], jaw = [];
  // Lower jaw (sp.mouth): vertices below the lip line, ahead of the corner of the mouth.
  const M = sp.mouth, jawAt = (u, v) => (M && u < M.u && v > lerp(M.v0, M.v, u / M.u) ? 1 : 0);
  const ringOf = (x, u, scale, uvU) => {
    for (let a = 0; a < NA; a++) {
      const th = (a / NA) * Math.PI * 2;
      const [y, z] = section(u, th);
      const yc = prof.centre(u);
      pos.push(x, yc + (y - yc) * scale, z * scale);
      uv.push(uvU, (1 + Math.cos(th)) / 2);
      thick.push(2 * Math.abs(z * scale));   // tissue a backlight has to pass through
      jaw.push(jawAt(u, -Math.cos(th)));
    }
  };
  // Rounded nose cap: rings shrinking on a quarter ellipse ahead of u = 0.
  const capLen = Math.min(prof.half(0), prof.width(0)) * 0.55;
  pos.push(prof.x(0) + capLen, prof.centre(0), 0); uv.push(0, 0.5); thick.push(0); jaw.push(0);
  for (let k = CAP; k >= 1; k--) {
    const phi = (k / (CAP + 1)) * Math.PI / 2;
    ringOf(prof.x(0) + Math.sin(phi) * capLen, 0, Math.cos(phi), 0);
  }
  for (const u of us) ringOf(prof.x(u), u, 1, u);
  const tailIdx = pos.length / 3;
  pos.push(prof.x(1) - 0.004, prof.centre(1), 0); uv.push(1, 0.5); thick.push(0); jaw.push(0);
  const rings = CAP + us.length, ring = (i) => 1 + i * NA;
  for (let a = 0; a < NA; a++) idx.push(0, ring(0) + ((a + 1) % NA), ring(0) + a);
  for (let i = 0; i < rings - 1; i++) {
    for (let a = 0; a < NA; a++) {
      const a1 = (a + 1) % NA;
      const p0 = ring(i) + a, p1 = ring(i) + a1, p2 = ring(i + 1) + a, p3 = ring(i + 1) + a1;
      idx.push(p0, p1, p2, p1, p3, p2);
    }
  }
  const last = ring(rings - 1);
  for (let a = 0; a < NA; a++) idx.push(last + a, last + ((a + 1) % NA), tailIdx);
  // The rings run around +x, so the triangles above wind inwards; flip them so faces point outwards.
  for (let t = 0; t < idx.length; t += 3) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aThick', new THREE.Float32BufferAttribute(thick, 1));
  if (M) g.setAttribute('aJaw', new THREE.Float32BufferAttribute(jaw, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------- assembled model (cached per species) ----------

const cache = new Map();

function speciesAssets(sp) {
  if (cache.has(sp.id)) return cache.get(sp.id);
  const prof = makeProfile(sp.body);
  const skin = paintSkin(sp, prof);
  const fins = paintFins(sp, prof);
  const pect = sp.pectoral ? paintPectoral(sp) : makeCanvas(4, 4);
  const eye = paintEye(sp);
  const tex = (c, srgb = true) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
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
    skinTex: tex(skin.map), normalTex: tex(skin.normal, false), iridTex: tex(skin.irid, false), finTex: tex(fins.canvas), pectTex: tex(pect), eyeTex: tex(eye),
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
    uXPed: { value: -0.3 }, uXGill: { value: 9 }, uVent: { value: 0 }, uAnguil: { value: 0 }, uLift: { value: 0 },
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
    uFinH: { value: a.prof.H }, uXPed: { value: a.prof.xPed }, uXGill: { value: a.prof.x(gillU(sp)) },
    uAnguil: { value: sp.swim?.mode === 'anguilliform' ? 1 : 0 },
    uGape: { value: 0 }, uHinge: { value: new THREE.Vector2(9, 9) },
  });
  if (sp.mouth) uniforms.uHinge.value.set(a.prof.x(sp.mouth.u), a.prof.centre(sp.mouth.u) - sp.mouth.v * a.prof.half(sp.mouth.u));
  const bodyMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.skinTex, normalMap: a.normalTex, iridescenceMap: a.iridTex,
    roughness: sp.body.scales === 0 ? 0.3 : 0.42, metalness: 0.0, ior: IN_WATER_IOR,   // scaleless skin: a mucus film
    iridescence: sp.iridescent ? 1.0 : 0.35, iridescenceIOR: 1.8, iridescenceThicknessRange: [180, 420],   // guanine platelet stacks
  }), uniforms, { kind: 'body', sizeMM: sp.size * 125, jaw: !!sp.mouth });
  const finMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.finTex, transparent: true, side: THREE.DoubleSide, depthWrite: fishRender.finDepth, roughness: 0.45, alphaTest: fishRender.finDepth ? 0.15 : 0.01, ior: IN_WATER_IOR,
  }), uniforms, { kind: 'fin', thickMM: 0.15 * sp.size * 8 });
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
  const tubeMat = (u) => makeSwimMaterial(new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.38, ior: IN_WATER_IOR }), u, { kind: 'fin', thickMM: 0.8 * sp.size * 8 });
  if (a.tubeGeo) group.add(new THREE.Mesh(a.tubeGeo, tubeMat(uniforms)));

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
  const eyeMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.eyeTex, roughness: 0.1, ior: IN_WATER_IOR,
  }), uniforms);
  for (const geo of a.eyeGeos) group.add(new THREE.Mesh(geo, eyeMat));

  group.userData = { uniforms, pects, fan: p?.kind === 'fan' };
  return group;
}

export function speciesCanvases(sp) { return speciesAssets(sp).canvases; }
