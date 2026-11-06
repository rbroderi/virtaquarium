// Voxel grid helpers for the critter shape check: surface voxelisation of meshes and 6-connected
// flood fills.
import * as THREE from 'three';

export interface VoxelGrid {
  /** World position of cell (0, 0, 0)'s corner. */
  readonly o: THREE.Vector3;
  /** Cell size. */
  readonly h: number;
  readonly nx: number;
  readonly ny: number;
  readonly nz: number;
}

export type Cell3 = [number, number, number];

/** Surface samples per cell along a triangle's longest edge (dense, so the shell has no holes). */
const SAMPLES_PER_CELL = 3;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

export const cellIndex = (grid: VoxelGrid, x: number, y: number, z: number): number => x + grid.nx * (y + grid.ny * z);

export const cellOf = (grid: VoxelGrid, k: number): Cell3 => [k % grid.nx, Math.floor(k / grid.nx) % grid.ny, Math.floor(k / (grid.nx * grid.ny))];

/** The cell holding world point p. */
export const cellAt = (grid: VoxelGrid, p: THREE.Vector3): number =>
  Math.floor((p.x - grid.o.x) / grid.h) + grid.nx * (Math.floor((p.y - grid.o.y) / grid.h) + grid.ny * Math.floor((p.z - grid.o.z) / grid.h));

/** Voxelises a mesh's surface (in world space): every cell any triangle passes through. */
export function surfaceCells(mesh: THREE.Mesh, grid: VoxelGrid): Uint32Array {
  const { o, h, nx, ny } = grid;
  const g = mesh.geometry, pos = g.getAttribute('position'), ix = g.index, M = mesh.matrixWorld;
  const nt = (ix ? ix.count : pos.count) / 3, cells = new Set<number>();
  const vi = (k: number): number => (ix ? ix.getX(k) : k);
  for (let t = 0; t < nt; t++) {
    _a.fromBufferAttribute(pos, vi(3 * t)).applyMatrix4(M);
    _b.fromBufferAttribute(pos, vi(3 * t + 1)).applyMatrix4(M);
    _c.fromBufferAttribute(pos, vi(3 * t + 2)).applyMatrix4(M);
    const e = Math.max(_a.distanceTo(_b), _b.distanceTo(_c), _c.distanceTo(_a));
    const n = Math.max(1, Math.ceil(e / (h / SAMPLES_PER_CELL)));
    for (let i = 0; i <= n; i++) {
      for (let j = 0; j <= n - i; j++) {
        const u = i / n, v = j / n;
        const x = _a.x + (_b.x - _a.x) * u + (_c.x - _a.x) * v, y = _a.y + (_b.y - _a.y) * u + (_c.y - _a.y) * v, z = _a.z + (_b.z - _a.z) * u + (_c.z - _a.z) * v;
        cells.add(Math.floor((x - o.x) / h) + nx * (Math.floor((y - o.y) / h) + ny * Math.floor((z - o.z) / h)));
      }
    }
  }
  return Uint32Array.from(cells);
}

/**
 * Floods water in from the edges of the box [lo, hi) (6-connected) round the walls marked in `wall`;
 * returns the flooded cells (1).
 */
export function flood(grid: VoxelGrid, wall: Uint8Array, lo: Cell3, hi: Cell3): Uint8Array {
  const { nx, ny } = grid, out = new Uint8Array(wall.length), q = new Int32Array(wall.length);
  let qn = 0;
  const push = (x: number, y: number, z: number): void => {
    const k = x + nx * (y + ny * z);
    if (!wall[k] && !out[k]) { out[k] = 1; q[qn++] = k; }
  };
  const [x0, y0, z0] = lo, [x1, y1, z1] = hi;
  for (let z = z0; z < z1; z++) {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        if (x === x0 || y === y0 || z === z0 || x === x1 - 1 || y === y1 - 1 || z === z1 - 1) push(x, y, z);
      }
    }
  }
  for (let qi = 0; qi < qn; qi++) {
    const k = q[qi] ?? 0, x = k % nx, y = Math.floor(k / nx) % ny, z = Math.floor(k / (nx * ny));
    if (x > x0) push(x - 1, y, z);
    if (x < x1 - 1) push(x + 1, y, z);
    if (y > y0) push(x, y - 1, z);
    if (y < y1 - 1) push(x, y + 1, z);
    if (z > z0) push(x, y, z - 1);
    if (z < z1 - 1) push(x, y, z + 1);
  }
  return out;
}
