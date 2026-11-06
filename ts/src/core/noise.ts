// 2D/3D value noise with a fractal (fBm) sum, seeded from an Rng.
import { lerp, smooth } from './math.js';
import type { Rng } from './rng.js';

const LATTICE = 256;
const LATTICE_MASK = LATTICE - 1;
const PLANE_Z = 0.5;               // the z slice 2D noise samples
const DEFAULT_OCTAVES = 4;
const OCTAVE_GAIN = 0.5;
const OCTAVE_LACUNARITY = 2.03;    // slightly off 2 so octave lattices don't line up

export class Noise {
  private readonly values = new Float32Array(LATTICE);
  private readonly perm = new Uint8Array(LATTICE * 2);

  constructor(rng: Rng) {
    const order: number[] = [];
    for (let i = 0; i < LATTICE; i++) {
      this.values[i] = rng();
      order.push(i);
    }
    for (let i = LATTICE_MASK; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const a = order[i] ?? 0;
      order[i] = order[j] ?? 0;
      order[j] = a;
    }
    for (let i = 0; i < LATTICE * 2; i++) this.perm[i] = order[i & LATTICE_MASK] ?? 0;
  }

  private lattice(x: number, y: number, z: number): number {
    const p = this.perm;
    const iz = p[z & LATTICE_MASK] ?? 0;
    const iy = p[(y & LATTICE_MASK) + iz] ?? 0;
    return this.values[p[(x & LATTICE_MASK) + iy] ?? 0] ?? 0;
  }

  noise3(x: number, y: number, z: number): number {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = smooth(x - xi), yf = smooth(y - yi), zf = smooth(z - zi);
    const v = (a: number, b: number, c: number): number => this.lattice(xi + a, yi + b, zi + c);
    const x00 = lerp(v(0, 0, 0), v(1, 0, 0), xf), x10 = lerp(v(0, 1, 0), v(1, 1, 0), xf);
    const x01 = lerp(v(0, 0, 1), v(1, 0, 1), xf), x11 = lerp(v(0, 1, 1), v(1, 1, 1), xf);
    return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf);
  }

  noise2(x: number, y: number): number {
    return this.noise3(x, y, PLANE_Z);
  }

  fbm3(x: number, y: number, z: number, octaves = DEFAULT_OCTAVES): number {
    let sum = 0, amp = OCTAVE_GAIN, freq = 1, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= OCTAVE_GAIN;
      freq *= OCTAVE_LACUNARITY;
    }
    return sum / norm;
  }

  fbm(x: number, y: number, octaves = DEFAULT_OCTAVES): number {
    return this.fbm3(x, y, PLANE_Z, octaves);
  }
}
