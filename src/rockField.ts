// A signed distance field of the reef's solid scenery (rock, coral, the cave roofs), for collision.
// The height field (reef/heightField.ts) holds only the top of each 0.2-unit column, grown by two cells
// for clearance: a fish touching the side of a rock read as being under its top and was pushed straight
// up. This field knows the real surface in 3D, so a fish is pushed out along the surface normal
// instead: off a wall sideways, off a ledge's underside downwards.
//
// Built once at load: the meshes' triangles are rasterised into a voxel grid, the open water is flood
// filled from the top (whatever it can't reach is rock interior), and two exact Euclidean distance
// transforms (Felzenszwalb & Huttenlocher) give the distance outside and inside the surface.
import * as THREE from 'three';
import { isInstancedMesh, isMesh } from './reef/flags.js';

const INF = 1e20;
const DEFAULT_CELL = 0.08;
/** Distance reported above the grid: open water. */
const OPEN_WATER_DISTANCE = 10;
/** Triangles are sampled at this fraction of a cell, so their voxels form a closed shell. */
const TRIANGLE_SAMPLE_FRACTION = 0.5;
const MIN_GRADIENT = 1e-6;
const ROCK_SHARE_DIGITS = 3;

export interface FieldBox {
  readonly x0: number; readonly x1: number;
  readonly y0: number; readonly y1: number;
  readonly z0: number; readonly z1: number;
}

export interface RockFieldInfo {
  readonly cells: readonly [number, number, number];
  readonly rockShare: number;
}

/** Signed-distance queries other modules (world, critters, fan worms) need from the rock. */
export interface SolidField {
  dist(x: number, y: number, z: number): number;
  normal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3;
}

/** 1D squared distance transform of f (0 at sources, INF elsewhere) into d. v, z: scratch. */
function edt1d(f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array): void {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  const fAt = (i: number): number => f[i] ?? INF;
  const cut = (q: number, p: number): number => ((fAt(q) + q * q) - (fAt(p) + p * p)) / (2 * q - 2 * p);
  for (let q = 1; q < n; q++) {
    let s = cut(q, v[k] ?? 0);
    while (s <= (z[k] ?? -INF)) { k--; s = cut(q, v[k] ?? 0); }   // z[0] = -INF stops it at k = 0
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? INF) < q) k++;
    const p = v[k] ?? 0;
    d[q] = (q - p) * (q - p) + fAt(p);
  }
}

/** Squared distance (in cells) from every cell to the nearest cell where src[i] is set. */
function edt3d(src: Uint8Array, nx: number, ny: number, nz: number): Float64Array {
  const total = nx * ny * nz, g = new Float64Array(total);
  for (let i = 0; i < total; i++) g[i] = src[i] ? 0 : INF;
  const m = Math.max(nx, ny, nz), f = new Float64Array(m), d = new Float64Array(m);
  const v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (n: number, stride: number, starts: readonly number[]): void => {
    for (const s of starts) {
      for (let q = 0; q < n; q++) f[q] = g[s + q * stride] ?? INF;
      edt1d(f, n, d, v, z);
      for (let q = 0; q < n; q++) g[s + q * stride] = d[q] ?? INF;
    }
  };
  const sx: number[] = [], sy: number[] = [], sz: number[] = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) sx.push(nx * (j + ny * k));
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sy.push(i + nx * ny * k);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sz.push(i + nx * j);
  pass(nx, 1, sx);
  pass(ny, nx, sy);
  pass(nz, nx * ny, sz);
  return g;
}

export class RockField implements SolidField {
  readonly cell: number;
  readonly x0: number;
  readonly y0: number;
  readonly z0: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
  /** Voxels hit by a triangle while building; dropped by finish(). */
  private solid: Uint8Array | null;
  /** Signed distances, set by finish(). */
  private distances: Float32Array = new Float32Array(0);
  /** The meshes rasterised into the field (the motion check tests fish against them exactly). */
  readonly meshes: THREE.Mesh[] = [];

  constructor(box: FieldBox, cell = DEFAULT_CELL) {
    this.cell = cell;
    this.x0 = box.x0; this.y0 = box.y0; this.z0 = box.z0;
    this.nx = Math.ceil((box.x1 - box.x0) / cell) + 1;
    this.ny = Math.ceil((box.y1 - box.y0) / cell) + 1;
    this.nz = Math.ceil((box.z1 - box.z0) / cell) + 1;
    this.solid = new Uint8Array(this.nx * this.ny * this.nz);
  }

  private mark(solid: Uint8Array, x: number, y: number, z: number): void {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell), k = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return;
    solid[i + this.nx * (j + this.ny * k)] = 1;
  }

  /** Rasterise the triangles of every mesh under obj (skipping those flagged by skip(mesh)). */
  add(obj: THREE.Object3D, skip: (mesh: THREE.Mesh) => boolean = () => false): void {
    const solid = this.solid;
    if (!solid) throw new Error('RockField.add after finish');
    obj.updateWorldMatrix(true, true);
    const v = new THREE.Vector3(), im = new THREE.Matrix4();
    obj.traverse((o) => {
      if (!isMesh(o) || skip(o)) return;
      const g = o.geometry, pos = g.attributes['position'], idx = g.index;
      if (!pos) return;
      this.meshes.push(o);
      const instanced = isInstancedMesh(o);
      const n = instanced ? o.count : 1;
      const world = new Float32Array(pos.count * 3);
      const w = (i: number): number => world[i] ?? 0;
      const corner = (i: number): number => 3 * (idx ? idx.getX(i) : i);
      for (let inst = 0; inst < n; inst++) {
        if (instanced) { o.getMatrixAt(inst, im); im.premultiply(o.matrixWorld); } else im.copy(o.matrixWorld);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(im);
          world[3 * i] = v.x; world[3 * i + 1] = v.y; world[3 * i + 2] = v.z;
        }
        const triangles = idx ? idx.count / 3 : pos.count / 3;
        for (let t = 0; t < triangles; t++) {
          const a = corner(3 * t), b = corner(3 * t + 1), c = corner(3 * t + 2);
          this.triangle(solid, w(a), w(a + 1), w(a + 2), w(b), w(b + 1), w(b + 2), w(c), w(c + 1), w(c + 2));
        }
      }
    });
  }

  /** Sample the triangle densely enough (half a cell) that its voxels form a closed shell. */
  private triangle(solid: Uint8Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void {
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - bx, cy - by, cz - bz), Math.hypot(ax - cx, ay - cy, az - cz));
    const n = Math.max(1, Math.ceil(e / (this.cell * TRIANGLE_SAMPLE_FRACTION)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, s = 1 - u - w;
      this.mark(solid, ax * s + bx * u + cx * w, ay * s + by * u + cy * w, az * s + bz * u + cz * w);
    }
  }

  /** Flood the open water from the top layer; then signed distances (negative inside rock). */
  finish(): RockFieldInfo {
    const solid = this.solid;
    if (!solid) throw new Error('RockField.finish called twice');
    const { nx, ny, nz } = this, total = nx * ny * nz;
    const open = this.floodOpenWater(solid);
    const rock = new Uint8Array(total);
    for (let i = 0; i < total; i++) rock[i] = open[i] ? 0 : 1;
    const dOut = edt3d(rock, nx, ny, nz), dIn = edt3d(open, nx, ny, nz);
    const d = new Float32Array(total), halfCell = this.cell * 0.5;
    for (let i = 0; i < total; i++) {
      d[i] = open[i] ? Math.sqrt(dOut[i] ?? 0) * this.cell - halfCell : -(Math.sqrt(dIn[i] ?? 0) * this.cell - halfCell);
    }
    this.distances = d;
    this.solid = null;
    let rockCells = 0;
    for (let i = 0; i < total; i++) rockCells += rock[i] ?? 0;
    return { cells: [nx, ny, nz], rockShare: +(rockCells / total).toFixed(ROCK_SHARE_DIGITS) };
  }

  /** Breadth-first flood of the cells the top layer's water can reach. */
  private floodOpenWater(solid: Uint8Array): Uint8Array {
    const { nx, ny, nz } = this, total = nx * ny * nz, layer = nx * ny;
    const open = new Uint8Array(total), queue = new Int32Array(total);
    let head = 0, tail = 0;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = i + nx * (ny - 1 + ny * k);
      if (!solid[c]) { open[c] = 1; queue[tail++] = c; }
    }
    const push = (n: number): void => { if (!open[n] && !solid[n]) { open[n] = 1; queue[tail++] = n; } };
    while (head < tail) {
      const c = queue[head++] ?? 0, i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / layer);
      if (i > 0) push(c - 1);
      if (i < nx - 1) push(c + 1);
      if (j > 0) push(c - nx);
      if (j < ny - 1) push(c + nx);
      if (k > 0) push(c - layer);
      if (k < nz - 1) push(c + layer);
    }
    return open;
  }

  /** Signed distance to the rock surface at (x, y, z), trilinear; open water outside the grid. */
  dist(x: number, y: number, z: number): number {
    const c = this.cell, fx = (x - this.x0) / c - 0.5, fy = (y - this.y0) / c - 0.5, fz = (z - this.z0) / c - 0.5;
    const { nx, ny, nz, distances: d } = this;
    let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) {
      if (fy >= ny - 1) return OPEN_WATER_DISTANCE;
      i = Math.min(Math.max(i, 0), nx - 2); j = Math.min(Math.max(j, 0), ny - 2); k = Math.min(Math.max(k, 0), nz - 2);
    }
    const tx = Math.min(Math.max(fx - i, 0), 1), ty = Math.min(Math.max(fy - j, 0), 1), tz = Math.min(Math.max(fz - k, 0), 1);
    const plane = nx * ny, o = i + nx * (j + ny * k);
    const at = (n: number): number => d[n] ?? OPEN_WATER_DISTANCE;
    const l = (a: number, b: number, t: number): number => a + (b - a) * t;
    const c00 = l(at(o), at(o + 1), tx), c10 = l(at(o + nx), at(o + nx + 1), tx);
    const c01 = l(at(o + plane), at(o + plane + 1), tx), c11 = l(at(o + plane + nx), at(o + plane + nx + 1), tx);
    return l(l(c00, c10, ty), l(c01, c11, ty), tz);
  }

  /** Outward surface normal (the distance gradient) at (x, y, z) into out. */
  normal(x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 {
    const h = this.cell;
    out.set(this.dist(x + h, y, z) - this.dist(x - h, y, z), this.dist(x, y + h, z) - this.dist(x, y - h, z), this.dist(x, y, z + h) - this.dist(x, y, z - h));
    const n = out.length();
    return n > MIN_GRADIENT ? out.multiplyScalar(1 / n) : out.set(0, 1, 0);
  }
}
