// Distance-field modelling for the soft bodies (docs/organic-modelling-plan.md 2.2): a body is written
// as one signed distance function of ellipsoids, round cones and the like, joined with a smooth
// minimum (its k is the fillet radius, so a sac grows out of a head instead of meeting it at a seam),
// and meshed once by surface nets. tools/softbodies.mjs runs this offline and writes the meshes to
// pc/models/critters/*.glb; the page only loads them (critters.js), and builds them here itself only
// when a file is missing. No three.js in here, so node runs it as is: plain typed arrays out.

// Polynomial smooth minimum; smix is its blend factor (0: all a, 1: all b), for per-part weights.
export const smin = (a, b, k) => { const h = Math.max(k - Math.abs(a - b), 0) / k; return Math.min(a, b) - h * h * k * 0.25; };
export const smix = (a, b, k) => Math.min(1, Math.max(0, 0.5 + 0.5 * (a - b) / k));
// Smooth subtraction of b from a.
export const ssub = (a, b, k) => -smin(-a, b, k);

// Ellipsoid (the cheap bound: exact on the surface, close enough near it for meshing and fillets).
export function ellipsoid(px, py, pz, cx, cy, cz, rx, ry, rz) {
  const x = (px - cx) / rx, y = (py - cy) / ry, z = (pz - cz) / rz;
  const k0 = Math.hypot(x, y, z), k1 = Math.hypot(x / rx, y / ry, z / rz);
  return k1 > 1e-9 ? k0 * (k0 - 1) / k1 : -Math.min(rx, ry, rz);
}
// A cone with round ends, radius ra at a to rb at b (a capsule with a lerped radius).
export function roundCone(px, py, pz, ax, ay, az, bx, by, bz, ra, rb) {
  const ex = bx - ax, ey = by - ay, ez = bz - az, l2 = ex * ex + ey * ey + ez * ez;
  const t = Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey + (pz - az) * ez) / l2));
  return Math.hypot(px - ax - ex * t, py - ay - ey * t, pz - az - ez * t) - (ra + (rb - ra) * t);
}

// Value noise 0..1 from an integer hash (Math.imul, not sin: the same bits in every JS engine, so the
// offline build and an in-browser fallback agree).
function hash3(x, y, z) {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
export function vnoise(x, y, z) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z), xf = x - xi, yf = y - yi, zf = z - zi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf), w = zf * zf * (3 - 2 * zf);
  let r = 0;
  for (let c = 0; c < 8; c++) { const dx = c & 1, dy = (c >> 1) & 1, dz = c >> 2; r += hash3(xi + dx, yi + dy, zi + dz) * (dx ? u : 1 - u) * (dy ? v : 1 - v) * (dz ? w : 1 - w); }
  return r;
}

// Surface nets over the box B = { x0, x1, y0, y1, z0, z1 } at cell h: one vertex per cell the surface
// crosses (the mean of its edge crossings, then one Newton step onto the surface), one quad per grid
// edge it crosses. Indexed and quad-dominant, smoother than marching cubes for the same cells. Narrow
// band: a grid 4x coarser is sampled first, and fine samples are taken only where it says the surface
// can be near. Normals are the field's gradient (smooth across the fillets). attrs: extra per-vertex
// scalars, name -> f(x, y, z), evaluated at each vertex.
export function surfaceNets(f, B, h, attrs = {}) {
  const nx = Math.ceil((B.x1 - B.x0) / h) + 1, ny = Math.ceil((B.y1 - B.y0) / h) + 1, nz = Math.ceil((B.z1 - B.z0) / h) + 1;
  const F = new Float32Array(nx * ny * nz);
  const C = 4, H = h * C, cx = Math.ceil(nx / C) + 1, cy = Math.ceil(ny / C) + 1, cz = Math.ceil(nz / C) + 1, CF = new Float32Array(cx * cy * cz);
  for (let k = 0; k < cz; k++) for (let j = 0; j < cy; j++) for (let i = 0; i < cx; i++) CF[i + cx * (j + cy * k)] = f(B.x0 + i * H, B.y0 + j * H, B.z0 + k * H);
  const band = H * 1.8;
  for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = CF[Math.round(i / C) + cx * (Math.round(j / C) + cy * Math.round(k / C))];
    F[i + nx * (j + ny * k)] = Math.abs(c) > band ? c : f(B.x0 + i * h, B.y0 + j * h, B.z0 + k * h);
  }
  const at = (i, j, k) => F[i + nx * (j + ny * k)];
  const vid = new Int32Array(nx * ny * nz).fill(-1), pos = [];
  const E = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]], v = new Float64Array(8);
  for (let k = 0; k < nz - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    let mask = 0;
    for (let c = 0; c < 8; c++) { v[c] = at(i + (c & 1), j + ((c >> 1) & 1), k + (c >> 2)); if (v[c] < 0) mask |= 1 << c; }
    if (mask === 0 || mask === 255) continue;
    let sx = 0, sy = 0, sz = 0, n = 0;
    for (const [a, b] of E) {
      if ((v[a] < 0) === (v[b] < 0)) continue;
      const t = v[a] / (v[a] - v[b]);
      sx += (a & 1) + ((b & 1) - (a & 1)) * t; sy += ((a >> 1) & 1) + (((b >> 1) & 1) - ((a >> 1) & 1)) * t; sz += (a >> 2) + ((b >> 2) - (a >> 2)) * t; n++;
    }
    vid[i + nx * (j + ny * k)] = pos.length / 3;
    pos.push(B.x0 + (i + sx / n) * h, B.y0 + (j + sy / n) * h, B.z0 + (k + sz / n) * h);
  }
  const idx = [], V = (i, j, k) => vid[i + nx * (j + ny * k)];
  // Wound so the faces look out of the solid (front faces outward, as three's culling expects).
  const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) idx.push(a, b, c, a, c, d); else idx.push(a, c, b, a, d, c); };
  for (let k = 1; k < nz - 1; k++) for (let j = 1; j < ny - 1; j++) for (let i = 1; i < nx - 1; i++) {
    const a = at(i, j, k) < 0;
    if ((at(i + 1, j, k) < 0) !== a) quad(V(i, j - 1, k - 1), V(i, j, k - 1), V(i, j, k), V(i, j - 1, k), a);
    if ((at(i, j + 1, k) < 0) !== a) quad(V(i - 1, j, k - 1), V(i, j, k - 1), V(i, j, k), V(i - 1, j, k), !a);
    if ((at(i, j, k + 1) < 0) !== a) quad(V(i - 1, j - 1, k), V(i, j - 1, k), V(i, j, k), V(i - 1, j, k), a);
  }
  const nv = pos.length / 3, P = new Float32Array(nv * 3), N = new Float32Array(nv * 3), e = h * 0.25;
  for (let p = 0; p < nv; p++) {
    let x = pos[3 * p], y = pos[3 * p + 1], z = pos[3 * p + 2];
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
  const extra = {};
  for (const [name, fn] of Object.entries(attrs)) {
    const a = new Float32Array(nv);
    for (let p = 0; p < nv; p++) a[p] = fn(P[3 * p], P[3 * p + 1], P[3 * p + 2]);
    extra[name] = a;
  }
  return { position: P, normal: N, index: nv < 65536 ? Uint16Array.from(idx) : Uint32Array.from(idx), attrs: extra, grid: [nx, ny, nz] };
}

// ---------- GLB (glTF 2.0 binary) ----------
// Just enough to write one indexed triangle mesh with float attributes: POSITION, NORMAL,
// TEXCOORD_0 and custom ones (glTF wants those named with a leading underscore, e.g. _WEIGHT). three's
// GLTFExporter needs FileReader, which node lacks, and the reader keeps custom names exactly.
const GL_FLOAT = 5126, TYPES = { 1: 'SCALAR', 2: 'VEC2', 3: 'VEC3', 4: 'VEC4' };
export function writeGLB(mesh) {   // mesh: { attributes: { NAME: { array: Float32Array, size } }, index, name }
  const views = [], accessors = [], chunks = [], attributes = {};
  let off = 0;
  const add = (arr, target) => { const pad = (4 - (arr.byteLength % 4)) % 4; views.push({ buffer: 0, byteOffset: off, byteLength: arr.byteLength, target }); chunks.push(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength), new Uint8Array(pad)); off += arr.byteLength + pad; return views.length - 1; };
  for (const [name, { array, size }] of Object.entries(mesh.attributes)) {
    const acc = { bufferView: add(array, 34962), componentType: GL_FLOAT, count: array.length / size, type: TYPES[size] };
    if (name === 'POSITION') {
      const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < array.length; i++) { mn[i % 3] = Math.min(mn[i % 3], array[i]); mx[i % 3] = Math.max(mx[i % 3], array[i]); }
      acc.min = mn; acc.max = mx;
    }
    accessors.push(acc); attributes[name] = accessors.length - 1;
  }
  const ix = mesh.index;
  accessors.push({ bufferView: add(ix, 34963), componentType: ix instanceof Uint16Array ? 5123 : 5125, count: ix.length, type: 'SCALAR' });
  const json = {
    asset: { version: '2.0', generator: 'virtaquarium tools/softbodies.mjs' },
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: mesh.name }],
    meshes: [{ name: mesh.name, primitives: [{ attributes, indices: accessors.length - 1, mode: 4 }] }],
    buffers: [{ byteLength: off }], bufferViews: views, accessors,
  };
  let js = new TextEncoder().encode(JSON.stringify(json));
  const jpad = (4 - (js.length % 4)) % 4;
  js = Uint8Array.from([...js, ...new Array(jpad).fill(0x20)]);
  const total = 12 + 8 + js.length + 8 + off, out = new Uint8Array(total), dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, js.length, true); dv.setUint32(16, 0x4e4f534a, true); out.set(js, 20);
  let p = 20 + js.length;
  dv.setUint32(p, off, true); dv.setUint32(p + 4, 0x004e4942, true); p += 8;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
// (the reader is critters.js readGLB: the page needn't load the mesher)
