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
import * as THREE from 'three';
import { lerp, mulberry32, makeCanvas, context2d } from '../util.js';
import type { Species } from '../species/types.js';
import { cellHash, gillU, smooth01, type Profile } from './profile.js';

export type DetailKind = 'velvet' | 'mucus' | 'ctenoid' | 'cycloid';

/** A species' detail tile and how it maps over the body. */
export interface SkinDetail {
  kind: DetailKind;
  tex: THREE.CanvasTexture;
  rep: THREE.Vector2;
  str: number;
}

const TILE = 256;
/** Scale counts from this up are minute (velvet). */
const VELVET_SCALES = 100;
const DETAIL_STRENGTH: Readonly<Record<DetailKind, number>> = { velvet: 1.0, mucus: 0.6, ctenoid: 0.22, cycloid: 0.25 };   // (ctenoid at 0.35 chalked white skin)

interface LatticeHit { hn: number; bt: number; bd: number; da: number; db: number }

const detailTiles = new Map<DetailKind, THREE.CanvasTexture>();

function detailTile(kind: DetailKind): THREE.CanvasTexture {
  const cached = detailTiles.get(kind);
  if (cached) return cached;
  const S = TILE, h = new Float32Array(S * S), rng = mulberry32(kind.length * 977 + 3);
  // Periodic value noise with P cells across the tile (so the tile wraps seamlessly).
  const noise = (P: number): ((x: number, y: number) => number) => {
    const gv = Float32Array.from({ length: P * P }, () => rng());
    return (x, y) => {
      const fx = x * P, fy = y * P, i = Math.floor(fx), j = Math.floor(fy), tx = smooth01(fx - i), ty = smooth01(fy - j);
      const at = (a: number, b: number): number => gv[(((b % P) + P) % P) * P + (((a % P) + P) % P)] ?? 0;
      return lerp(lerp(at(i, j), at(i + 1, j), tx), lerp(at(i, j + 1), at(i + 1, j + 1), tx), ty);
    };
  };
  // An imbricated lattice of nc columns x 2nc rows (row spacing half a scale) wrapping on the tile, as on
  // the body: returns { hn (height of the exposed field), bt, bd, da, db } at (x, y).
  const lattice = (nc: number) => (x: number, y: number): LatticeHit => {
    const a = x * nc, b = y * nc * 2, jr = Math.round(b);
    let best = Infinity, out: LatticeHit | null = null;
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
  let amp: number;   // relief in texels at height 1
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
  const img = new ImageData(S, S), d = img.data, H = (x: number, y: number): number => h[((y + S) % S) * S + ((x + S) % S)] ?? 0;
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const nx = -(H(x + 1, y) - H(x - 1, y)) * 0.5 * amp, ny = (H(x, y + 1) - H(x, y - 1)) * 0.5 * amp;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + 1), o = (y * S + x) * 4;
    d[o] = (nx * inv * 0.5 + 0.5) * 255; d[o + 1] = (ny * inv * 0.5 + 0.5) * 255; d[o + 2] = (inv * 0.5 + 0.5) * 255; d[o + 3] = 255;
  }
  const c = makeCanvas(S, S); context2d(c).putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 16;
  detailTiles.set(kind, t);
  return t;
}

// Which tile a species gets, how often it repeats over the body UV (u: nose to tail, v: back to belly,
// kept square in physical size), and how strongly it bends the normal.
export function detailFor(sp: Species, prof: Profile): SkinDetail {
  const sc = sp.body.scales ?? NaN, g0 = gillU(sp), len = sp.body.len;
  const kind: DetailKind = sc === 0 ? 'mucus' : sc >= VELVET_SCALES ? 'velvet' : (sp.body.scaleType ?? 'ctenoid');
  let ref = 0, n = 0;
  for (let u = Math.max(0.05, g0); u < 0.85; u += 0.02) { ref += prof.half(u) * 1.15; n++; }
  ref /= Math.max(1, n);
  const repU = kind === 'mucus' ? 24 : kind === 'velvet' ? sc / (8 * (1 - g0)) : sc / (2 * (1 - g0));
  return { kind, tex: detailTile(kind), rep: new THREE.Vector2(repU, (repU * 2 * ref) / len), str: DETAIL_STRENGTH[kind] };
}
