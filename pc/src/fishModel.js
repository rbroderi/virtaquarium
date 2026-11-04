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
  const half = (u) => {
    if (u < snout) return snoutH * (0.75 + 0.25 * (u / snout));
    const uu = (u - snout) / (1 - snout);
    let f;
    // Convex head that ends in a blunt terminal mouth (snouted species end in their tube instead).
    if (uu < m) f = (snout ? 0 : 0.17) + (snout ? 1 : 0.83) * Math.pow(Math.sin((Math.PI / 2) * (uu / m)), body.headP);
    else f = ped + (1 - ped) * Math.pow(Math.cos((Math.PI / 2) * ((uu - m) / (1 - m))), body.tailP);
    return Math.max(H * f, snout ? snoutH : 0.012);
  };
  const x = (u) => 0.5 - u * body.len;
  const halfM = half;
  const width = (u) => Math.max(halfM(u) * body.width * (1.15 - 0.55 * u), snout && u < snout ? snoutH * 0.9 : 0.004);
  // The back arches above the midline (epaxial muscle) while the mouth and tail stay on it.
  const hump = body.hump ?? 0.05;
  const centre = (u) => hump * H * Math.sin(Math.PI * Math.min(1, u * 1.05)) ** 1.5;
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
  g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 2.5 * K; gillPath(g0, 0.78, 0.035); g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.10)'; g.lineWidth = 1.5 * K; gillPath(g0 - (3 * K) / TW, 0.76, 0.035); g.stroke();
  g.strokeStyle = 'rgba(0,0,0,0.12)'; g.lineWidth = 1.5 * K; gillPath(g0 - 0.05, 0.6, 0.03); g.stroke();
  // Lateral line: a row of pored scales arching along the upper flank.
  g.fillStyle = 'rgba(0,0,0,0.14)';
  for (let u = g0 + 0.01; u < 0.95; u += 0.012) {
    const t = (u - g0) / (0.95 - g0), v = -0.5 + 0.38 * t * t;
    g.fillRect(U(u), V(v) - 0.6 * K, 2.2 * K, 1.2 * K);
  }
  // Mouth: gape line and slightly darker lips.
  if (!sp.body.snout) {
    g.fillStyle = 'rgba(0,0,0,0.5)'; g.fillRect(0, V(0.08) - 0.7 * K, U(0.045), 1.4 * K);
    g.globalCompositeOperation = 'multiply';
    const lip = g.createRadialGradient(0, V(0.08), 0, 0, V(0.08), U(0.06));
    lip.addColorStop(0, 'rgba(150,130,120,0.6)'); lip.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lip; g.fillRect(0, 0, U(0.07), TH);
    g.globalCompositeOperation = 'source-over';
  }
  // Orbit: soft shadow ring where the eyeball sits in its socket.
  {
    const ex = U(e.u), ey = V(e.v), rx = (e.r / len) * TW * 1.5;
    g.save(); g.translate(ex, ey); g.scale(1, ((e.r / prof.half(e.u)) * TH / 2) / ((e.r / len) * TW));
    const o = g.createRadialGradient(0, 0, rx * 0.6, 0, 0, rx);
    o.addColorStop(0, 'rgba(0,0,0,0.35)'); o.addColorStop(1, 'rgba(0,0,0,0)');
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
      const mask = smooth01((u - g0 + 0.005) / 0.03) * fade[i];
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

function finOutline(sp, prof, fin) {
  const sign = fin.pos === 'top' ? 1 : -1;
  const base = [], outer = [];
  for (let i = 0; i <= 14; i++) {
    const u = lerp(fin.u0, fin.u1, i / 14);
    base.push([prof.x(u), prof.centre(u) + sign * prof.half(u) * 0.85]);
  }
  const pts = fin.kind === 'spines' ? [[0, 0.02], [0.05, fin.h], [0.9, fin.h * 0.7], [1, 0.04]] : fin.pts;
  for (const [t, h] of pts) {
    const u = lerp(fin.u0, fin.u1, t);
    outer.push([prof.x(u) - (fin.sweep || 0) * h, prof.centre(u) + sign * (prof.half(u) + h)]);
  }
  return { base, outer, sign };
}

function caudalOutline(sp, prof) {
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
  const xmin = -0.52, xmax = 0.52, W = 1024, H = Math.ceil((W * (2 * ymax)) / (xmax - xmin));
  const c = makeCanvas(W, H), g = c.getContext('2d');
  const k = W / (xmax - xmin);
  g.setTransform(k, 0, 0, -k, -xmin * k, ymax * k);
  g.lineJoin = 'round';
  const rng = mulberry32(sp.id.length * 31 + 5);

  const meshes = [];   // { rays, n }: ray field per fin, for the 3D membrane
  const drawFin = (spec, outlinePts, rays, rayOrigin) => {
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
      for (let i = 0; i < 40; i++) {
        const [a, b] = rays(rng());
        const t = rng();
        g.beginPath(); g.arc(lerp(a[0], b[0], t), lerp(a[1], b[1], t), 0.008 + rng() * 0.01, 0, Math.PI * 2); g.fill();
      }
    }
    if (spec.spot) {
      const [a, b] = rays(spec.spot.t);
      const px = lerp(a[0], b[0], spec.spot.h), py = lerp(a[1], b[1], spec.spot.h);
      if (spec.spot.ring) { g.fillStyle = spec.spot.ring; g.beginPath(); g.arc(px, py, spec.spot.r * 1.35, 0, Math.PI * 2); g.fill(); }
      g.fillStyle = spec.spot.color; g.beginPath(); g.arc(px, py, spec.spot.r, 0, Math.PI * 2); g.fill();
    }
    // Membrane: a thin pigmented film, so most of the light behind it passes through.
    g.globalCompositeOperation = 'destination-out';
    g.fillStyle = `rgba(0,0,0,${1 - Math.min(0.92, spec.alpha ?? 0.9)})`;
    g.fillRect(-1, -1, 2, 2);
    // Thinner membrane towards the free margin.
    g.globalAlpha = 0.4; g.strokeStyle = '#000'; g.lineWidth = 0.012;
    g.beginPath(); smoothPath(g, outlinePts, true); g.stroke();
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    // Lepidotrichia: jointed bony rays, more opaque than the membrane, each with a lit edge.
    const nRays = Math.round(clamp(10 + (Math.max(...xs) - Math.min(...xs)) * 18, 10, 20));
    g.setLineDash([0.035, 0.0012]);   // soft-ray joints
    for (let i = 0; i <= nRays; i++) {
      const [a, b] = rays(i / nRays);
      g.strokeStyle = spec.rays || 'rgba(35,20,5,0.13)'; g.lineWidth = 0.0026;
      g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
      g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 0.0012;
      g.beginPath(); g.moveTo(a[0] + 0.0015, a[1]); g.lineTo(b[0] + 0.0015, b[1]); g.stroke();
    }
    g.setLineDash([]);
    g.restore();
    meshes.push({ rays, n: nRays });
    if (spec.edge) {
      // Pigmented margin (e.g. the clownfish's black fin edges): real but only ~1 mm wide.
      g.save();
      g.beginPath(); smoothPath(g, outlinePts, true); g.clip();
      g.globalAlpha = 0.9;
      g.strokeStyle = spec.edge; g.lineWidth = (spec.edgeW || 0.02) * 0.6;
      g.beginPath(); smoothPath(g, outlinePts, true); g.stroke();
      g.restore();
    }
  };

  // Caudal fin first (behind the body).
  {
    const xp = prof.xPed + 0.02;
    const edge = tail.slice(1, -1);
    const rays = (t) => [[xp, lerp(prof.half(1) * 0.8, -prof.half(1) * 0.8, t)], along(edge, t)];
    drawFin(sp.caudal, tail, rays);
  }

  sp.fins.forEach((spec, i) => {
    const f = fins[i];
    if (spec.kind === 'spines') {
      // Venomous spines with a low membrane between them (lionfish).
      g.save();
      g.globalAlpha = 0.45; g.fillStyle = spec.fill;
      g.beginPath(); smoothPath(g, [...f.base, ...f.outer.slice().reverse().map((p) => [p[0], lerp(p[1], f.base[0][1], 0.45)])], true); g.fill();
      g.globalAlpha = 1; g.lineCap = 'round';
      for (let s = 0; s < spec.n; s++) {
        const t = s / (spec.n - 1), u = lerp(spec.u0, spec.u1, t);
        const bx = prof.x(u), by = prof.top(u) - prof.half(u) * 0.15;
        const hh = spec.h * (0.55 + 0.45 * Math.sin(Math.PI * (0.15 + t * 0.85))) * (0.85 + rng() * 0.3);
        const tx = bx - spec.sweep * hh, ty = by + hh;
        const segs = 6;
        for (let q = 0; q < segs; q++) {
          g.strokeStyle = q % 2 ? spec.fill : spec.stripes;
          g.lineWidth = 0.012 * (1 - q / segs) + 0.003;
          g.beginPath();
          g.moveTo(lerp(bx, tx, q / segs), lerp(by, ty, q / segs));
          g.lineTo(lerp(bx, tx, (q + 1) / segs), lerp(by, ty, (q + 1) / segs));
          g.stroke();
        }
      }
      g.restore();
      meshes.push({ rays: (t) => [along(f.base, t), along(f.outer, t)], n: spec.n - 1 });
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
    drawFin(spec, outline, rays);
  });

  return { canvas: c, xmin, xmax, ymax, meshes };
}

function paintPectoral(sp) {
  const p = sp.pectoral, fan = p.kind === 'fan';
  const W = 256, H = fan ? 256 : 128;
  const c = makeCanvas(W, H), g = c.getContext('2d');
  // Base at left-centre; fin extends to the right.
  g.translate(0, H / 2);
  g.beginPath();
  if (fan) {
    g.moveTo(0, -H * 0.06);
    for (let i = 0; i <= 16; i++) {
      const a = -1.15 + (2.3 * i) / 16;
      const r = W * (0.85 + 0.12 * Math.sin(i * 1.7));
      g.lineTo(Math.cos(a) * r, Math.sin(a) * r * 0.5);
    }
    g.lineTo(0, H * 0.06);
  } else {
    g.moveTo(0, -H * 0.18);
    g.bezierCurveTo(W * 0.4, -H * 0.5, W * 0.95, -H * 0.2, W * 0.98, 0);
    g.bezierCurveTo(W * 0.9, H * 0.2, W * 0.4, H * 0.35, 0, H * 0.18);
  }
  g.closePath();
  g.globalAlpha = Math.min(0.7, p.alpha ?? 0.6);
  g.fillStyle = p.fill; g.fill();
  g.save(); g.clip();
  g.globalAlpha = 1;
  g.lineWidth = fan ? 3 : 1.5;
  const n = fan ? 16 : 10;
  for (let i = 0; i <= n; i++) {
    const a = (fan ? -1.15 : -0.45) + ((fan ? 2.3 : 0.9) * i) / n;
    if (fan && p.stripes) {
      for (let q = 0; q < 8; q++) {
        g.strokeStyle = q % 2 ? p.fill : p.stripes;
        g.beginPath();
        g.moveTo(Math.cos(a) * W * q / 8, Math.sin(a) * W * 0.5 * q / 8);
        g.lineTo(Math.cos(a) * W * (q + 1) / 8, Math.sin(a) * W * 0.5 * (q + 1) / 8);
        g.stroke();
      }
    } else {
      g.strokeStyle = 'rgba(0,0,0,0.2)';
      g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * W, Math.sin(a) * W); g.stroke();
    }
  }
  g.restore();
  if (p.edge) { g.globalAlpha = 0.85; g.strokeStyle = p.edge; g.lineWidth = 3; g.stroke(); }
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

// Pectoral fin: rays fan out from the base; pleated like the median fins and slightly cupped.
function pectoralGeometry(sp) {
  const p = sp.pectoral, fan = p.kind === 'fan';
  const pw = p.len, ph = fan ? p.len : p.len * 0.5, n = fan ? 16 : 10;
  const g = new THREE.PlaneGeometry(pw, ph, 28, 18);
  g.translate(pw / 2, 0, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), r = Math.hypot(x, y) / pw, a = Math.atan2(y, Math.max(1e-4, x));
    const spread = fan ? 2.3 : 0.9;   // angular range the painted rays cover
    pos.setZ(i, 0.03 * pw * r * Math.cos(Math.PI * (a / spread + 0.5) * n) + 0.12 * pw * r * r);
  }
  g.computeVertexNormals();
  return g;
}

// ---------- eyes ----------

// Front view of the eye (planar UV): iris stroma with radial fibres and a dark limbal ring, a large
// round pupil showing the spherical lens, and a faint silvery tapetum ring.
function paintEye(sp) {
  const N = 256, c = makeCanvas(N, N), g = c.getContext('2d'), R = N / 2;
  const rng = mulberry32(sp.id.length * 131 + 7), iris = sp.eye.iris;
  g.fillStyle = shade(iris, -0.55); g.fillRect(0, 0, N, N);
  const gr = g.createRadialGradient(R, R, R * 0.3, R, R, R * 0.98);
  gr.addColorStop(0, shade(iris, 0.25)); gr.addColorStop(0.55, iris); gr.addColorStop(0.85, shade(iris, -0.3)); gr.addColorStop(1, shade(iris, -0.7));
  g.fillStyle = gr; g.beginPath(); g.arc(R, R, R * 0.98, 0, Math.PI * 2); g.fill();
  for (let i = 0; i < 160; i++) {
    const a = rng() * Math.PI * 2, r0 = R * (0.42 + rng() * 0.1), r1 = R * (0.75 + rng() * 0.2);
    g.strokeStyle = rng() < 0.5 ? 'rgba(0,0,0,0.18)' : 'rgba(255,255,255,0.12)'; g.lineWidth = 1 + rng() * 1.5;
    g.beginPath(); g.moveTo(R + Math.cos(a) * r0, R + Math.sin(a) * r0); g.lineTo(R + Math.cos(a + 0.05) * r1, R + Math.sin(a + 0.05) * r1); g.stroke();
  }
  g.strokeStyle = 'rgba(220,235,240,0.25)'; g.lineWidth = 3;   // guanine ring around the pupil
  g.beginPath(); g.arc(R, R, R * 0.47, 0, Math.PI * 2); g.stroke();
  const pu = g.createRadialGradient(R * 0.94, R * 0.92, 0, R, R, R * 0.45);
  pu.addColorStop(0, '#0b1418'); pu.addColorStop(0.8, '#020406'); pu.addColorStop(1, '#000');
  g.fillStyle = pu; g.beginPath(); g.arc(R, R, R * 0.44, 0, Math.PI * 2); g.fill();
  return c;
}

// Eyeball geometry already placed in fish space (so the swim shader moves it with the head).
function eyeGeometry(prof, sp, side) {
  const e = sp.eye, geo = new THREE.SphereGeometry(1, 32, 20);
  const p = geo.attributes.position, uv = geo.attributes.uv;
  for (let i = 0; i < p.count; i++) uv.setXY(i, 0.5 - p.getX(i) * 0.5, 0.5 + p.getY(i) * 0.5);   // planar, looking along +z
  const ex = prof.x(e.u), ey = prof.centre(e.u) - e.v * prof.half(e.u);
  const ez = prof.width(e.u) * Math.sqrt(Math.max(0.05, 1 - e.v * e.v));
  const m = new THREE.Matrix4().makeTranslation(ex, ey, side * ez * 0.97)
    .multiply(new THREE.Matrix4().makeRotationY(side > 0 ? 0 : Math.PI))
    .multiply(new THREE.Matrix4().makeScale(e.r, e.r, e.r * 0.45));
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
float swimDisp(vec3 p) {
  float s = clamp((0.3 - p.x) / 0.8, 0.0, 1.0);
  float env = 0.025 + s * s * 0.16;
  float d = uAmp * env * sin(uPhase + p.x * 5.5);
  float fin = smoothstep(uFinH, uFinH + 0.15, abs(p.y));
  // Travelling wave along dorsal/anal fins (head to tail), plus turn curvature of the spine.
  d += uFlutter * fin * 0.018 * sin(uFinPhase + p.x * 14.0 + abs(p.y) * 6.0);
  d += uBend * (p.x - 0.05) * (p.x - 0.05) * 2.0;
  return d;
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
        vec3 objectNormal = vec3(normal);
        float sw0 = swimDisp(position);
        float sw1 = swimDisp(position + vec3(0.01, 0.0, 0.0));
        float slope = (sw1 - sw0) / 0.01;
        objectNormal = normalize(vec3(objectNormal.x - slope * objectNormal.z, objectNormal.y, objectNormal.z));
        #ifdef USE_TANGENT
          vec3 objectTangent = vec3(tangent.xyz);
        #endif`)
      .replace('#include <begin_vertex>', `
        vec3 transformed = vec3(position);
        transformed.z += swimDisp(position);`);
  };
  base.customProgramCacheKey = () => 'swim-' + (tissue ? tissue.kind : 'plain');
  return addCaustics(base);   // fish swim through the same focused light as the reef
}

// ---------- geometry ----------

function bodyGeometry(prof, sp) {
  const NU = 110, NA = 56, CAP = 5;
  const e = sp.eye, len = sp.body.len, g0 = gillU(sp);
  // Section exponent: compressed fish (tangs, angels) have a lens-shaped section, thickest along the
  // spine and sharp at the fin bases (> 1); round-bodied fish (gramma, lionfish) are fuller (< 1).
  const flank = 1.6 - sp.body.width * 1.6;
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
    return [prof.centre(u) + cy * h, Math.sign(sz) * z];
  };
  const pos = [], uv = [], thick = [], idx = [];
  const ringOf = (x, u, scale, uvU) => {
    for (let a = 0; a < NA; a++) {
      const th = (a / NA) * Math.PI * 2;
      const [y, z] = section(u, th);
      const yc = prof.centre(u);
      pos.push(x, yc + (y - yc) * scale, z * scale);
      uv.push(uvU, (1 + Math.cos(th)) / 2);
      thick.push(2 * Math.abs(z * scale));   // tissue a backlight has to pass through
    }
  };
  // Rounded nose cap: rings shrinking on a quarter ellipse ahead of u = 0.
  const capLen = Math.min(prof.half(0), prof.width(0)) * 0.55;
  pos.push(prof.x(0) + capLen, prof.centre(0), 0); uv.push(0, 0.5); thick.push(0);
  for (let k = CAP; k >= 1; k--) {
    const phi = (k / (CAP + 1)) * Math.PI / 2;
    ringOf(prof.x(0) + Math.sin(phi) * capLen, 0, Math.cos(phi), 0);
  }
  for (const u of us) ringOf(prof.x(u), u, 1, u);
  const tailIdx = pos.length / 3;
  pos.push(prof.x(1) - 0.004, prof.centre(1), 0); uv.push(1, 0.5); thick.push(0);
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
  const pect = paintPectoral(sp);
  const eye = paintEye(sp);
  const tex = (c, srgb = true) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const finGeo = mergeGeometries(fins.meshes.map((m) => finMesh(m, fins)));
  const pectGeo = pectoralGeometry(sp);
  const a = {
    prof,
    bodyGeo: bodyGeometry(prof, sp),
    finGeo, pectGeo,
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

function buildCustomModel(sp, model) {
  const uniforms = {
    uPhase: { value: 0 }, uAmp: { value: 1 }, uFlutter: { value: 1 }, uFinH: { value: model.finH }, uBend: { value: 0 }, uFinPhase: { value: 0 },
  };
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

// opts.model: a model from loadFishModel; opts.procedural: ignore models.json for this species.
export function buildFishModel(sp, opts = {}) {
  if (opts.model) return buildCustomModel(sp, opts.model);
  if (!opts.procedural && custom.has(sp.id)) return buildCustomModel(sp, custom.get(sp.id));
  const a = speciesAssets(sp);
  const uniforms = {
    uPhase: { value: 0 }, uAmp: { value: 1 }, uFlutter: { value: 1 }, uFinH: { value: a.prof.H }, uBend: { value: 0 }, uFinPhase: { value: 0 },
  };
  const bodyMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.skinTex, normalMap: a.normalTex, iridescenceMap: a.iridTex,
    roughness: 0.42, metalness: 0.0, ior: IN_WATER_IOR,
    iridescence: sp.iridescent ? 1.0 : 0.35, iridescenceIOR: 1.8, iridescenceThicknessRange: [180, 420],   // guanine platelet stacks
  }), uniforms, { kind: 'body', sizeMM: sp.size * 125 });
  const finMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.finTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 0.45, alphaTest: 0.01, ior: IN_WATER_IOR,
  }), uniforms, { kind: 'fin', thickMM: 0.15 * sp.size * 8 });
  // Pectorals move on their own pivots, so the body wave is off for them (zero uniforms); they
  // still get the membrane light transport.
  const still = { uPhase: { value: 0 }, uAmp: { value: 0 }, uFlutter: { value: 0 }, uFinH: { value: 1 }, uBend: { value: 0 }, uFinPhase: { value: 0 } };
  const pectMat = makeSwimMaterial(new THREE.MeshPhysicalMaterial({
    map: a.pectTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, roughness: 0.45, alphaTest: 0.01, ior: IN_WATER_IOR,
  }), still, { kind: 'fin', thickMM: 0.15 * sp.size * 8 });

  const group = new THREE.Group();
  const body = new THREE.Mesh(a.bodyGeo, bodyMat);
  const fins = new THREE.Mesh(a.finGeo, finMat);
  fins.renderOrder = 1;
  group.add(fins, body);

  const pects = [];
  const p = sp.pectoral, pu = p.u;
  const px = a.prof.x(pu), py = a.prof.centre(pu) - p.v * a.prof.half(pu), pz = a.prof.width(pu);
  for (const side of [1, -1]) {
    const pivot = new THREE.Group();
    pivot.position.set(px, py, side * pz * 0.9);
    const m = new THREE.Mesh(a.pectGeo, pectMat);
    m.renderOrder = 2;
    m.rotation.y = Math.PI; // point backwards
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

  group.userData = { uniforms, pects, fan: p.kind === 'fan' };
  return group;
}

export function speciesCanvases(sp) { return speciesAssets(sp).canvases; }
