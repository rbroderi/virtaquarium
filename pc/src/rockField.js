// A signed distance field of the reef's solid scenery (rock, coral, the cave roofs), for collision.
// The height field (reef.js) holds only the top of each 0.2-unit column, grown by two cells for
// clearance: a fish touching the side of a rock read as being under its top and was pushed straight up.
// This field knows the real surface in 3D, so a fish is pushed out along the surface normal instead:
// off a wall sideways, off a ledge's underside downwards.
//
// Built once at load: the meshes' triangles are rasterised into a voxel grid, the open water is flood
// filled from the top (whatever it can't reach is rock interior), and two exact Euclidean distance
// transforms (Felzenszwalb & Huttenlocher) give the distance outside and inside the surface.
import * as THREE from 'three';

const INF = 1e20;

// 1D squared distance transform of f (0 at sources, INF elsewhere) into d. v, z: scratch.
function edt1d(f, n, d, v, z) {
  let k = 0;
  v[0] = 0; z[0] = -INF; z[1] = INF;
  const cut = (q, p) => ((f[q] + q * q) - (f[p] + p * p)) / (2 * q - 2 * p);
  for (let q = 1; q < n; q++) {
    let s = cut(q, v[k]);
    while (s <= z[k]) { k--; s = cut(q, v[k]); }   // z[0] = -INF stops it at k = 0
    k++; v[k] = q; z[k] = s; z[k + 1] = INF;
  }
  k = 0;
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++;
    const p = v[k];
    d[q] = (q - p) * (q - p) + f[p];
  }
}

// Squared distance (in cells) from every cell to the nearest cell where src[i] is true.
function edt3d(src, nx, ny, nz) {
  const N = nx * ny * nz, g = new Float64Array(N);
  for (let i = 0; i < N; i++) g[i] = src[i] ? 0 : INF;
  const m = Math.max(nx, ny, nz), f = new Float64Array(m), d = new Float64Array(m);
  const v = new Int32Array(m), z = new Float64Array(m + 1);
  const pass = (n, stride, starts) => {
    for (const s of starts) {
      for (let q = 0; q < n; q++) f[q] = g[s + q * stride];
      edt1d(f, n, d, v, z);
      for (let q = 0; q < n; q++) g[s + q * stride] = d[q];
    }
  };
  const sx = [], sy = [], sz = [];
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) sx.push(nx * (j + ny * k));
  for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) sy.push(i + nx * ny * k);
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) sz.push(i + nx * j);
  pass(nx, 1, sx);
  pass(ny, nx, sy);
  pass(nz, nx * ny, sz);
  return g;
}

export class RockField {
  // box: { x0, x1, y0, y1, z0, z1 } in world units; cell: voxel size.
  constructor(box, cell = 0.08) {
    this.cell = cell;
    this.x0 = box.x0; this.y0 = box.y0; this.z0 = box.z0;
    this.nx = Math.ceil((box.x1 - box.x0) / cell) + 1;
    this.ny = Math.ceil((box.y1 - box.y0) / cell) + 1;
    this.nz = Math.ceil((box.z1 - box.z0) / cell) + 1;
    this.solid = new Uint8Array(this.nx * this.ny * this.nz);
    this.d = null;
  }

  _mark(x, y, z) {
    const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell), k = Math.floor((z - this.z0) / this.cell);
    if (i < 0 || j < 0 || k < 0 || i >= this.nx || j >= this.ny || k >= this.nz) return;
    this.solid[i + this.nx * (j + this.ny * k)] = 1;
  }

  // Rasterise the triangles of every mesh under obj (skipping those flagged by skip(mesh)).
  add(obj, skip = () => false) {
    obj.updateWorldMatrix(true, true);
    const v = new THREE.Vector3(), im = new THREE.Matrix4();
    obj.traverse((o) => {
      if (!o.isMesh || skip(o)) return;
      const g = o.geometry, pos = g.attributes.position, idx = g.index;
      const n = o.isInstancedMesh ? o.count : 1;
      const W = new Float32Array(pos.count * 3);
      for (let inst = 0; inst < n; inst++) {
        if (o.isInstancedMesh) { o.getMatrixAt(inst, im); im.premultiply(o.matrixWorld); } else im.copy(o.matrixWorld);
        for (let i = 0; i < pos.count; i++) {
          v.fromBufferAttribute(pos, i).applyMatrix4(im);
          W[3 * i] = v.x; W[3 * i + 1] = v.y; W[3 * i + 2] = v.z;
        }
        const T = idx ? idx.count / 3 : pos.count / 3;
        for (let t = 0; t < T; t++) {
          const a = 3 * (idx ? idx.getX(3 * t) : 3 * t), b = 3 * (idx ? idx.getX(3 * t + 1) : 3 * t + 1), c = 3 * (idx ? idx.getX(3 * t + 2) : 3 * t + 2);
          this._tri(W[a], W[a + 1], W[a + 2], W[b], W[b + 1], W[b + 2], W[c], W[c + 1], W[c + 2]);
        }
      }
    });
  }

  // Sample the triangle densely enough (half a cell) that its voxels form a closed shell.
  _tri(ax, ay, az, bx, by, bz, cx, cy, cz) {
    const e = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - bx, cy - by, cz - bz), Math.hypot(ax - cx, ay - cy, az - cz));
    const n = Math.max(1, Math.ceil(e / (this.cell * 0.5)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, w = j / n, s = 1 - u - w;
      this._mark(ax * s + bx * u + cx * w, ay * s + by * u + cy * w, az * s + bz * u + cz * w);
    }
  }

  // Flood the open water from the top layer; then signed distances (negative inside rock).
  finish() {
    const { nx, ny, nz, solid } = this, N = nx * ny * nz, layer = nx * ny;
    const open = new Uint8Array(N), q = new Int32Array(N);
    let h = 0, t = 0;
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      const c = i + nx * (ny - 1 + ny * k);
      if (!solid[c]) { open[c] = 1; q[t++] = c; }
    }
    while (h < t) {
      const c = q[h++], i = c % nx, j = Math.floor(c / nx) % ny, k = Math.floor(c / layer);
      const push = (n) => { if (!open[n] && !solid[n]) { open[n] = 1; q[t++] = n; } };
      if (i > 0) push(c - 1); if (i < nx - 1) push(c + 1);
      if (j > 0) push(c - nx); if (j < ny - 1) push(c + nx);
      if (k > 0) push(c - layer); if (k < nz - 1) push(c + layer);
    }
    const rock = new Uint8Array(N);
    for (let i = 0; i < N; i++) rock[i] = open[i] ? 0 : 1;
    const dOut = edt3d(rock, nx, ny, nz), dIn = edt3d(open, nx, ny, nz);
    const d = new Float32Array(N), hc = this.cell * 0.5;
    for (let i = 0; i < N; i++) d[i] = open[i] ? Math.sqrt(dOut[i]) * this.cell - hc : -(Math.sqrt(dIn[i]) * this.cell - hc);
    this.d = d;
    this.solid = null;
    let n = 0; for (let i = 0; i < N; i++) n += rock[i];
    return { cells: [nx, ny, nz], rockShare: +(n / N).toFixed(3) };
  }

  // Signed distance to the rock surface at (x, y, z), trilinear; open water outside the grid.
  dist(x, y, z) {
    const c = this.cell, fx = (x - this.x0) / c - 0.5, fy = (y - this.y0) / c - 0.5, fz = (z - this.z0) / c - 0.5;
    const { nx, ny, nz, d } = this;
    let i = Math.floor(fx), j = Math.floor(fy), k = Math.floor(fz);
    if (i < 0 || j < 0 || k < 0 || i >= nx - 1 || j >= ny - 1 || k >= nz - 1) {
      if (fy >= ny - 1) return 10;   // above the grid: open water
      i = Math.min(Math.max(i, 0), nx - 2); j = Math.min(Math.max(j, 0), ny - 2); k = Math.min(Math.max(k, 0), nz - 2);
    }
    const tx = Math.min(Math.max(fx - i, 0), 1), ty = Math.min(Math.max(fy - j, 0), 1), tz = Math.min(Math.max(fz - k, 0), 1);
    const L = nx * ny, o = i + nx * (j + ny * k);
    const l = (a, b, t) => a + (b - a) * t;
    const c00 = l(d[o], d[o + 1], tx), c10 = l(d[o + nx], d[o + nx + 1], tx);
    const c01 = l(d[o + L], d[o + L + 1], tx), c11 = l(d[o + L + nx], d[o + L + nx + 1], tx);
    return l(l(c00, c10, ty), l(c01, c11, ty), tz);
  }

  // Outward surface normal (the distance gradient) at (x, y, z) into out.
  normal(x, y, z, out) {
    const h = this.cell;
    out.set(this.dist(x + h, y, z) - this.dist(x - h, y, z), this.dist(x, y + h, z) - this.dist(x, y - h, z), this.dist(x, y, z + h) - this.dist(x, y, z - h));
    const n = out.length();
    return n > 1e-6 ? out.multiplyScalar(1 / n) : out.set(0, 1, 0);
  }
}
