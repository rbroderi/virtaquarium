// A 2D grid of the reef's top surface (the highest scenery point in each column), which the fish brains
// and critters use to stay above the rock. Grown by its neighbours for clearance, then optionally
// carved back down (cave floors).
import * as THREE from 'three';
import { lerp } from '../util.js';
import { isInstancedMesh, isMesh, isNoHeight } from './flags.js';

/** Cells either side a column is grown by in finish(), for clearance. */
const CLEARANCE_CELLS = 2;
/** Instanced meshes splat every n-th vertex (dense instances; the grid is coarse). */
const INSTANCE_VERTEX_STRIDE = 4;

export class HeightField {
  readonly x0: number;
  readonly z0: number;
  readonly step: number;
  readonly nx: number;
  readonly nz: number;
  private heights: Float32Array;

  constructor(x0: number, x1: number, z0: number, z1: number, step: number) {
    this.x0 = x0; this.z0 = z0; this.step = step;
    this.nx = Math.ceil((x1 - x0) / step) + 1;
    this.nz = Math.ceil((z1 - z0) / step) + 1;
    this.heights = new Float32Array(this.nx * this.nz);
  }

  private at(i: number): number {
    return this.heights[i] ?? 0;
  }

  splat(x: number, y: number, z: number): void {
    const i = Math.round((x - this.x0) / this.step), k = Math.round((z - this.z0) / this.step);
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return;
    const j = k * this.nx + i;
    if (y > this.at(j)) this.heights[j] = y;
  }

  /** Raise the field to every vertex of every mesh under obj (except those flagged noHeight). */
  splatObject(obj: THREE.Object3D): void {
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => {
      if (!isMesh(o) || isNoHeight(o)) return;
      const pos = o.geometry.attributes['position'];
      if (!pos) return;
      const v = new THREE.Vector3();
      if (isInstancedMesh(o)) {
        const im = new THREE.Matrix4();
        for (let n = 0; n < o.count; n++) {
          o.getMatrixAt(n, im);
          im.premultiply(o.matrixWorld);
          for (let i = 0; i < pos.count; i += INSTANCE_VERTEX_STRIDE) { v.fromBufferAttribute(pos, i).applyMatrix4(im); this.splat(v.x, v.y, v.z); }
        }
      } else {
        for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); this.splat(v.x, v.y, v.z); }
      }
    });
  }

  /** Grow each cell by its neighbours so fish keep a little clearance. */
  finish(): void {
    const { nx, nz } = this, src = this.heights.slice(), out = new Float32Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      let m = 0;
      for (let dk = -CLEARANCE_CELLS; dk <= CLEARANCE_CELLS; dk++) for (let di = -CLEARANCE_CELLS; di <= CLEARANCE_CELLS; di++) {
        const ii = i + di, kk = k + dk;
        if (ii >= 0 && kk >= 0 && ii < nx && kk < nz) m = Math.max(m, src[kk * nx + ii] ?? 0);
      }
      out[k * nx + i] = m;
    }
    this.heights = out;
  }

  /** Set every cell whose centre passes inside(x, z) down to at most y (run after finish()). */
  carve(inside: (x: number, z: number) => boolean, y: number): void {
    for (let k = 0; k < this.nz; k++) for (let i = 0; i < this.nx; i++) {
      const j = k * this.nx + i;
      if (inside(this.x0 + i * this.step, this.z0 + k * this.step)) this.heights[j] = Math.min(this.at(j), y);
    }
  }

  /** Bilinear height at (x, z); 0 outside the grid. */
  sample(x: number, z: number): number {
    const fx = (x - this.x0) / this.step, fz = (z - this.z0) / this.step;
    const i = Math.floor(fx), k = Math.floor(fz);
    if (i < 0 || k < 0 || i >= this.nx - 1 || k >= this.nz - 1) return 0;
    const tx = fx - i, tz = fz - k, n = this.nx;
    const row0 = lerp(this.at(k * n + i), this.at(k * n + i + 1), tx);
    const row1 = lerp(this.at((k + 1) * n + i), this.at((k + 1) * n + i + 1), tx);
    return lerp(row0, row1, tz);
  }
}
