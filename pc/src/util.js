// Shared helpers: seeded RNG, value noise, colour utilities.

export function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const range = (rng, a, b) => a + (b - a) * rng();
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length)];

export function wrapAngle(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

// 2D/3D value noise with fractal sum.
export class Noise {
  constructor(rng) {
    this.vals = new Float32Array(256);
    this.perm = new Uint8Array(512);
    const p = [];
    for (let i = 0; i < 256; i++) { this.vals[i] = rng(); p.push(i); }
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }
  _v(x, y, z) { const P = this.perm; return this.vals[P[(x & 255) + P[(y & 255) + P[z & 255]]]]; }
  noise3(x, y, z) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
    const v = (a, b, c) => this._v(xi + a, yi + b, zi + c);
    const x00 = lerp(v(0, 0, 0), v(1, 0, 0), xf), x10 = lerp(v(0, 1, 0), v(1, 1, 0), xf);
    const x01 = lerp(v(0, 0, 1), v(1, 0, 1), xf), x11 = lerp(v(0, 1, 1), v(1, 1, 1), xf);
    return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf);
  }
  noise2(x, y) { return this.noise3(x, y, 0.5); }
  fbm3(x, y, z, oct = 4) {
    let sum = 0, amp = 0.5, f = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += amp * this.noise3(x * f, y * f, z * f);
      norm += amp; amp *= 0.5; f *= 2.03;
    }
    return sum / norm;
  }
  fbm(x, y, oct = 4) { return this.fbm3(x, y, 0.5, oct); }
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)];
}
export function rgba(hex, a) {
  const c = hexToRgb(hex);
  return `rgba(${c[0]},${c[1]},${c[2]},${a})`;
}
export function mixHex(h1, h2, t) {
  const a = hexToRgb(h1), b = hexToRgb(h2);
  return '#' + a.map((x, i) => Math.round(lerp(x, b[i], t)).toString(16).padStart(2, '0')).join('');
}
export const shade = (hex, amt) => (amt >= 0 ? mixHex(hex, '#ffffff', amt) : mixHex(hex, '#000000', -amt));

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.ceil(w));
  c.height = Math.max(1, Math.ceil(h));
  return c;
}
