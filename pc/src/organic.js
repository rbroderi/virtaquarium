// Organic imperfection. Painted from exact shapes, a pattern has ruled edges, sharp corners and flat
// colour, which no living thing has: edges wander and change width and angle along their length,
// corners are round, and each colour area is patchy. These helpers break up painted textures (fish
// skins and fins, critters, worms) so they read as grown, not drawn.
import { clamp, lerp } from './util.js';

// Smooth value noise over the unit square on a cx x cy lattice, in -1..1. wrapX/wrapY: periodic in
// that direction, for textures that wrap round a body or repeat.
export function valueNoise(rng, cx, cy, wrapX = false, wrapY = false) {
  cx = Math.max(1, Math.round(cx)); cy = Math.max(1, Math.round(cy));
  const W = cx + 2, n = Float32Array.from({ length: W * (cy + 2) }, () => rng() * 2 - 1);
  // A periodic direction repeats its first lattice line at the far end.
  if (wrapX) for (let y = 0; y < cy + 2; y++) { n[y * W + cx] = n[y * W]; n[y * W + cx + 1] = n[y * W + 1]; }
  if (wrapY) for (let x = 0; x < W; x++) { n[cy * W + x] = n[x]; n[(cy + 1) * W + x] = n[W + x]; }
  return (x, y) => {
    x = wrapX ? x - Math.floor(x) : clamp(x, 0, 1); y = wrapY ? y - Math.floor(y) : clamp(y, 0, 1);
    const fx = x * cx, fy = y * cy, ix = Math.min(Math.floor(fx), cx), iy = Math.min(Math.floor(fy), cy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const i = iy * W + ix;
    return lerp(lerp(n[i], n[i + 1], tx), lerp(n[i + W], n[i + W + 1], tx), ty);
  };
}

// Smooth 1D noise for wandering a line: three random sines, about -1..1 over s in 0..1, with roughly
// `cycles` slow swings.
export function wobble(rng, cycles = 3) {
  const w = [0, 1, 2].map((k) => ({ f: cycles * (0.6 + 0.8 * rng()) * (1 + k * 1.7), p: rng() * 6.283, a: [0.62, 0.3, 0.14][k] }));
  return (s) => w.reduce((sum, q) => sum + q.a * Math.sin(q.f * 6.283 * s + q.p), 0);
}

// Round a closed polygon's corners to radius ~r (at most half of either side): each corner becomes a
// curve from r before it to r after it, so long sides (and shapes whose corners lie off the canvas)
// keep their place.
export function roundCorners(pts, r) {
  const out = [], n = pts.length;
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n], b = pts[i], c = pts[(i + 1) % n];
    const la = Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, lc = Math.hypot(c[0] - b[0], c[1] - b[1]) || 1;
    const ka = Math.min(r, la / 2) / la, kc = Math.min(r, lc / 2) / lc;
    const p = [lerp(b[0], a[0], ka), lerp(b[1], a[1], ka)], q = [lerp(b[0], c[0], kc), lerp(b[1], c[1], kc)];
    for (let k = 0; k <= 6; k++) {
      const t = k / 6, u = 1 - t;
      out.push([u * u * p[0] + 2 * u * t * b[0] + t * t * q[0], u * u * p[1] + 2 * u * t * b[1] + t * t * q[1]]);
    }
  }
  return out;
}

// Resample a canvas (context g, W x H) through a smooth random warp, then mottle its colour.
//   warp: [[cellsX, cellsY, ampX, ampY], ...] octaves: noise lattice size over the canvas and the
//         largest shift in pixels. A coarse octave bends an edge and swings its angle; a fine one moves
//         the two edges of a band apart and together, so its width varies.
//   mottle: { cellsX, cellsY, value, chroma }: patch size and how far value (all channels together)
//         and each channel on its own vary (fractions).
//   wrapX / wrapY: the canvas wraps (round a body, or tiles), so the warp and the mottle wrap too.
// Alpha is carried through the warp but not mottled.
export function organicPass(g, W, H, rng, { warp = [], mottle = null, wrapX = false, wrapY = false } = {}) {
  if (!warp.length && !mottle) return;
  const wx = warp.map(([cx, cy]) => [valueNoise(rng, cx, cy, wrapX, wrapY), valueNoise(rng, cx, cy, wrapX, wrapY)]);
  const nm = mottle ? [0, 1, 2, 3].map(() => valueNoise(rng, mottle.cellsX, mottle.cellsY, wrapX, wrapY)) : null;
  // The fields at half resolution, read back bilinearly (the noise is smooth at that scale).
  const FW = Math.ceil(W / 2) + 1, FH = Math.ceil(H / 2) + 1, F = Array.from({ length: 5 }, () => new Float32Array(FW * FH));
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) {
    const u = (x * 2) / W, v = (y * 2) / H, i = y * FW + x;
    for (let o = 0; o < warp.length; o++) { F[0][i] += warp[o][2] * wx[o][0](u, v); F[1][i] += warp[o][3] * wx[o][1](u, v); }
    const m = nm ? mottle.value * nm[3](u, v) : 0;
    for (let c = 0; c < 3; c++) F[2 + c][i] = 1 + m + (nm ? mottle.chroma * nm[c](u, v) : 0);
  }
  const src = g.getImageData(0, 0, W, H), s = src.data, out = g.createImageData(W, H), d = out.data;
  const wrap = (q, n) => ((q % n) + n) % n;
  for (let y = 0; y < H; y++) {
    const fy = y / 2, jy = Math.min(Math.floor(fy), FH - 2), ty = fy - jy;
    for (let x = 0; x < W; x++) {
      const fx = x / 2, jx = Math.min(Math.floor(fx), FW - 2), tx = fx - jx, i0 = jy * FW + jx;
      const f = (A) => lerp(lerp(A[i0], A[i0 + 1], tx), lerp(A[i0 + FW], A[i0 + FW + 1], tx), ty);
      let sx = x + f(F[0]), sy = y + f(F[1]);
      sx = wrapX ? wrap(sx, W) : clamp(sx, 0, W - 1.001); sy = wrapY ? wrap(sy, H) : clamp(sy, 0, H - 1.001);
      const px = Math.floor(sx), py = Math.floor(sy), kx = sx - px, ky = sy - py;
      const px1 = wrapX ? (px + 1) % W : Math.min(px + 1, W - 1), py1 = wrapY ? (py + 1) % H : Math.min(py + 1, H - 1);
      const p00 = (py * W + px) * 4, p10 = (py * W + px1) * 4, p01 = (py1 * W + px) * 4, p11 = (py1 * W + px1) * 4, o4 = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = lerp(lerp(s[p00 + c], s[p10 + c], kx), lerp(s[p01 + c], s[p11 + c], kx), ky);
        d[o4 + c] = c < 3 ? v * f(F[2 + c]) : v;
      }
    }
  }
  g.putImageData(out, 0, 0);
}
