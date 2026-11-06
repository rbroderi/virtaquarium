// Distance-field modelling for the soft bodies: a body is written
// as one signed distance function of ellipsoids, round cones and the like, joined with a smooth
// minimum (its k is the fillet radius, so a sac grows out of a head instead of meeting it at a seam),
// and meshed once by surface nets. tools/softbodies.ts runs this offline and writes the meshes to
// web/models/critters/*.glb; the page only loads them (critters.ts), and builds them here itself only
// when a file is missing. No three.js in here, so node runs it as is: plain typed arrays out.

/** A signed distance field: negative inside the solid. */
export type DistanceField = (x: number, y: number, z: number) => number;
/** A per-vertex scalar evaluated at each mesh vertex. */
export type VertexScalar = DistanceField;

export interface Box3Bounds { readonly x0: number; readonly x1: number; readonly y0: number; readonly y1: number; readonly z0: number; readonly z1: number }

export type IndexArray = Uint16Array | Uint32Array;

export interface SurfaceNetsMesh<K extends string> {
  readonly position: Float32Array;
  readonly normal: Float32Array;
  readonly index: IndexArray;
  readonly attrs: Readonly<Record<K, Float32Array>>;
  readonly grid: readonly [number, number, number];
}

/** One float attribute of a GLB mesh (size = components per vertex). */
export interface MeshAttribute { readonly array: Float32Array; readonly size: 1 | 2 | 3 | 4 }
export interface GlbMesh {
  readonly name: string;
  readonly attributes: Readonly<Record<string, MeshAttribute>>;
  readonly index: IndexArray;
}

const MAX_UINT16_VERTICES = 65536;
const val = (a: ArrayLike<number>, i: number): number => a[i] ?? 0;

// Polynomial smooth minimum; smix is its blend factor (0: all a, 1: all b), for per-part weights.
export const smin = (a: number, b: number, k: number): number => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export const smix = (a: number, b: number, k: number): number => Math.min(1, Math.max(0, 0.5 + 0.5 * (a - b) / k));
// Smooth subtraction of b from a.
export const ssub = (a: number, b: number, k: number): number => -smin(-a, b, k);

// Ellipsoid (the cheap bound: exact on the surface, close enough near it for meshing and fillets).
export function ellipsoid(px: number, py: number, pz: number, cx: number, cy: number, cz: number, rx: number, ry: number, rz: number): number {
  const x = (px - cx) / rx, y = (py - cy) / ry, z = (pz - cz) / rz;
  const k0 = Math.hypot(x, y, z), k1 = Math.hypot(x / rx, y / ry, z / rz);
  return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(rx, ry, rz);
}
// A cone with round ends, radius ra at a to rb at b (a capsule with a lerped radius).
export function roundCone(px: number, py: number, pz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ra: number, rb: number): number {
  const ex = bx - ax, ey = by - ay, ez = bz - az, l2 = ex * ex + ey * ey + ez * ez;
  const t = Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2));
  return Math.hypot(px - ax - ex * t, py - ay - ey * t, pz - az - ez * t) - (ra + (rb - ra) * t);
}

// Value noise 0..1 from an integer hash (Math.imul, not sin: the same bits in every JS engine, so the
// offline build and an in-browser fallback agree).
const HASH_X = 374761393, HASH_Y = 668265263, HASH_Z = 1274126177;
const UINT32_RANGE = 4294967296;
function hash3(x: number, y: number, z: number): number {
  let h = Math.imul(x, HASH_X) + Math.imul(y, HASH_Y) + Math.imul(z, HASH_Z);
  h = Math.imul(h ^ (h >>> 13), HASH_Z);
  return ((h ^ (h >>> 16)) >>> 0) / UINT32_RANGE;
}
export function vnoise(x: number, y: number, z: number): number {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let c = 0; c < 8; c++) { const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2; r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w); }
  return r;
}

const COARSE_FACTOR = 4;     // the narrow-band pre-pass grid is this many times coarser
const BAND_CELLS = 1.8;      // fine samples within this many coarse cells of the surface
const CUBE_EDGES: readonly (readonly [number, number])[] = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];

// Surface nets over the box B = { x0, x1, y0, y1, z0, z1 } at cell h: one vertex per cell the surface
// crosses (the mean of its edge crossings, then one Newton step onto the surface), one quad per grid
// edge it crosses. Indexed and quad-dominant, smoother than marching cubes for the same cells. Narrow
// band: a grid 4x coarser is sampled first, and fine samples are taken only where it says the surface
// can be near. Normals are the field's gradient (smooth across the fillets). attrs: extra per-vertex
// scalars, name -> f(x, y, z), evaluated at each vertex.
export function surfaceNets<K extends string = never>(f: DistanceField, B: Box3Bounds, h: number, attrs: Readonly<Record<K, VertexScalar>> = {} as Record<K, VertexScalar>): SurfaceNetsMesh<K> {
  const nx = Math.ceil((B.x1 - B.x0) / h) + 1, ny = Math.ceil((B.y1 - B.y0) / h) + 1, nz = Math.ceil((B.z1 - B.z0) / h) + 1;
  const F = new Float32Array(nx * ny * nz);
  const C = COARSE_FACTOR, H = h * C, cx = Math.ceil(nx / C) + 1, cy = Math.ceil(ny / C) + 1, cz = Math.ceil(nz / C) + 1, CF = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) CF[i + cx * (j + cy * k)] = f(B.x0 + i * H, B.y0 + j * H, B.z0 + k * H);
  const band = H * BAND_CELLS;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = val(CF, Math.round(i / C) + cx * (Math.round(j / C) + cy * Math.round(k / C)));
    F[i + nx * (j + ny * k)] = Math.abs(c) > band ? c : f(B.x0 + i * h, B.y0 + j * h, B.z0 + k * h);
  }
  const at = (i: number, j: number, k: number): number => val(F, i + nx * (j + ny * k));
  const vid = new Int32Array(nx * ny * nz).fill(-1), pos: number[] = [];
  const v = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { const s = at(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2)); v[c] = s; if (s < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of CUBE_EDGES) {
      const va = val(v, a), vb = val(v, b);
      if ((va < 0) === (vb < 0)) continue;
      const t = va / (va - vb);
      sx += (a & 1) + ((b & 1) - (a & 1)) * t; sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t; sz += (a >> 2) + ((b >> 2) - (a >> 2)) * t; n++;
    }
    vid[i + nx * (j + ny * k)] = pos.length / 3;
    pos.push(B.x0 + (i + sx / n) * h, B.y0 + (j + sy / n) * h, B.z0 + (k + sz / n) * h);
  }
  const idx: number[] = [], V = (i: number, j: number, k: number): number => val(vid, i + nx * (j + ny * k));
  // Wound so the faces look out of the solid (front faces outward, as three's culling expects).
  const quad = (a: number, b: number, c: number, d: number, flip: boolean): void => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c); };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = at(i, j, k) < 0;
    if ((at(i + 1, j, k) < 0) !== a) quad(V(i, j - 1, k - 1), V(i, j, k - 1), V(i, j, k), V(i, j - 1, k), a);
    if ((at(i, j + 1, k) < 0) !== a) quad(V(i - 1, j, k - 1), V(i, j, k - 1), V(i, j, k), V(i - 1, j, k), !a);
    if ((at(i, j, k + 1) < 0) !== a) quad(V(i - 1, j - 1, k), V(i, j - 1, k), V(i, j, k), V(i - 1, j, k), a);
  }
  const nv = pos.length / 3, P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), e = h * 0.25;
  for (let p = 0; p < nv; p++) {
    let x = val(pos, 3 * p), y = val(pos, 3 * p + 1), z = val(pos, 3 * p + 2);
    for (let it = 0; it < 2; it++) {   // onto the surface (the mean of the crossings sits a little off it on curves)
      const d = f(x, y, z), gx = f(x + e, y, z) - f(x - e, y, z), gy = f(x, y + e, z) - f(x, y - e, z), gz = f(x, y, z + e) - f(x, y, z - e);
      const g2 = (gx * gx + gy * gy + gz * gz) / (4 * e * e);
      if (g2 < 1e-6) break;
      const s = Math.max(-h * 0.5, Math.min(h * 0.5, d / g2)) / (2 * e);   // a step held inside the cell
      x -= gx * s; y -= gy * s; z -= gz * s;
      if (it === 1) { const l = Math.hypot(gx, gy, gz) || 1; N[3 * p] = gx / l; N[3 * p + 1] = gy / l; N[3 * p + 2] = gz / l; }
    }
    P[3 * p] = x; P[3 * p + 1] = y; P[3 * p + 2] = z;
    if (!N[3 * p] && !N[3 * p + 1] && !N[3 * p + 2]) N[3 * p + 1] = 1;
  }
  const extra = {} as Record<K, Float32Array>;
  for (const name of Object.keys(attrs) as K[]) {
    const fn = attrs[name];
    const a = new Float32Array(nv);
    for (let p = 0; p < nv; p++) a[p] = fn(val(P, 3 * p), val(P, 3 * p + 1), val(P, 3 * p + 2));
    extra[name] = a;
  }
  return { position: P, normal: N, index: nv < MAX_UINT16_VERTICES ? Uint16Array.from(idx) : Uint32Array.from(idx), attrs: extra, grid: [nx, ny, nz] };
}

// ---------- GLB (glTF 2.0 binary) ----------
// Just enough to write one indexed triangle mesh with float attributes: POSITION, NORMAL,
// TEXCOORD_0 and custom ones (glTF wants those named with a leading underscore, e.g. _WEIGHT). three's
// GLTFExporter needs FileReader, which node lacks, and the reader keeps custom names exactly.
const GL_FLOAT = 5126, GL_UNSIGNED_SHORT = 5123, GL_UNSIGNED_INT = 5125;
const GL_ARRAY_BUFFER = 34962, GL_ELEMENT_ARRAY_BUFFER = 34963, GL_TRIANGLES = 4;
const GLB_MAGIC = 0x46546c67, GLB_VERSION = 2, CHUNK_JSON = 0x4e4f534a, CHUNK_BIN = 0x004e4942;
const GLB_HEADER_BYTES = 12, CHUNK_HEADER_BYTES = 8, JSON_PAD = 0x20;
const ACCESSOR_TYPES = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' } as const;

interface BufferViewJson { buffer: number; byteOffset: number; byteLength: number; target: number }
interface AccessorJson { bufferView: number; componentType: number; count: number; type: string; min?: number[]; max?: number[] }

const pad4 = (n: number): number => (4 - (n % 4)) % 4;

export function writeGLB(mesh: GlbMesh): Uint8Array {
  const views: BufferViewJson[] = [], accessors: AccessorJson[] = [], chunks: Uint8Array[] = [], attributes: Record<string, number> = {};
  let off = 0;
  const add = (arr: Float32Array | IndexArray, target: number): number => {
    const pad = pad4(arr.byteLength);
    views.push({ buffer: 0, byteOffset: off, byteLength: arr.byteLength, target });
    chunks.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), new Uint8Array(pad));
    off += arr.byteLength + pad;
    return views.length - 1;
  };
  for (const [name, { array, size }] of Object.entries(mesh.attributes)) {
    const acc: AccessorJson = { bufferView: add(array, GL_ARRAY_BUFFER), componentType: GL_FLOAT, count: array.length / size, type: ACCESSOR_TYPES[size] };
    if (name === 'POSITION') {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < array.length; i++) { mn[i % 3] = Math.min(val(mn, i % 3), val(array, i)); mx[i % 3] = Math.max(val(mx, i % 3), val(array, i)); }
      acc.min = mn; acc.max = mx;
    }
    accessors.push(acc); attributes[name] = accessors.length - 1;
  }
  const ix = mesh.index;
  accessors.push({ bufferView: add(ix, GL_ELEMENT_ARRAY_BUFFER), componentType: ix instanceof Uint16Array ? GL_UNSIGNED_SHORT : GL_UNSIGNED_INT, count: ix.length, type: 'SCALAR' });
  const json = {
    asset: { version: '2.0', generator: 'virtaquarium tools/softbodies.ts' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: mesh.name }],
    meshes: [{ name: mesh.name, primitives: [{ attributes, indices: accessors.length - 1, mode: GL_TRIANGLES }] }],
    buffers: [{ byteLength: off }], bufferViews: views, accessors,
  };
  const encoded = new TextEncoder().encode(JSON.stringify(json));
  const js = Uint8Array.from([...encoded, ...new Array<number>(pad4(encoded.length)).fill(JSON_PAD)]);
  const total = GLB_HEADER_BYTES + CHUNK_HEADER_BYTES + js.length + CHUNK_HEADER_BYTES + off, out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, GLB_MAGIC, true); dv.setUint32(4, GLB_VERSION, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, CHUNK_JSON, true); out.set(js, 20);
  let p = 20 + js.length;
  dv.setUint32(p, off, true); dv.setUint32(p + 4, CHUNK_BIN, true); p += 8;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
// (the reader is critters/glb.ts readGLB: the page needn't load the mesher)
