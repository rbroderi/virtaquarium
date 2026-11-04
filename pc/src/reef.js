// Procedural reef: sand bed, live-rock piles, corals, a host anemone.
// Everything is seeded so the PC scene and the exported Roku backdrop match.
// Also produces a heightfield (top of reef at any x,z) that the fish brains use.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { Noise, mulberry32, range, clamp, makeCanvas, lerp } from './util.js';
import { addCaustics, waterUniforms } from './water.js';

const C = (hex) => new THREE.Color(hex);
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// ---------- textures ----------

function grainTexture(rng, size, base, spread, repeat) {
  const c = makeCanvas(size, size), g = c.getContext('2d');
  const img = g.createImageData(size, size);
  const [r0, g0, b0] = base;
  for (let i = 0; i < size * size; i++) {
    const k = (rng() - 0.5) * spread + (rng() < 0.03 ? -60 : 0) + (rng() < 0.02 ? 50 : 0);
    img.data[i * 4] = clamp(r0 + k, 0, 255);
    img.data[i * 4 + 1] = clamp(g0 + k * 0.95, 0, 255);
    img.data[i * 4 + 2] = clamp(b0 + k * 0.9, 0, 255);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeat, repeat);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function poreTexture(rng) {
  const s = 512, c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#909090'; g.fillRect(0, 0, s, s);
  for (let i = 0; i < 2600; i++) {
    const x = rng() * s, y = rng() * s, r = Math.pow(rng(), 3) * 9 + 0.8;
    g.fillStyle = `rgba(20,20,20,${0.3 + rng() * 0.5})`;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    g.fillStyle = 'rgba(230,230,230,0.25)';
    g.beginPath(); g.arc(x - r * 0.3, y - r * 0.3, r * 0.6, 0, Math.PI * 2); g.fill();
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  return t;
}

// High-frequency surface detail for live rock: pores, coralline crust, encrusting algae, sponge flecks.
function rockDetailTexture(rng) {
  const s = 1024, c = makeCanvas(s, s), g = c.getContext('2d');
  g.fillStyle = '#d8d2c8'; g.fillRect(0, 0, s, s);
  const blot = (n, rMin, rMax, cols, a) => {
    for (let i = 0; i < n; i++) {
      const x = rng() * s, y = rng() * s, r = rMin + Math.pow(rng(), 2) * (rMax - rMin);
      g.fillStyle = cols[Math.floor(rng() * cols.length)];
      g.globalAlpha = a * (0.5 + rng() * 0.5);
      g.beginPath();
      for (let k = 0; k < 9; k++) { const t = (k / 9) * Math.PI * 2, rr = r * (0.6 + rng() * 0.6); g.lineTo(x + Math.cos(t) * rr, y + Math.sin(t) * rr); }
      g.fill();
    }
  };
  blot(500, 6, 40, ['#b58fb4', '#c99ab0', '#9c7aa8'], 0.35);    // coralline algae crust
  blot(300, 4, 22, ['#a7a37a', '#8f9a6a'], 0.3);                // turf / encrusting algae
  blot(2500, 1, 5, ['#3a3029', '#2a221e'], 0.55);             // pores
  blot(800, 1, 3, ['#f2ece0', '#e8c9a8'], 0.5);               // sponge / calcareous flecks
  blot(80, 3, 9, ['#d8573a', '#e0a030'], 0.45);               // small sponges
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(3, 2);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- materials ----------

function stdMat(opts, caustic = 0.7) {
  return addCaustics(new THREE.MeshStandardMaterial(opts), caustic);
}

// ---------- rock ----------

function rockGeometry(rng, noise, sx, sy, sz) {
  let g = new THREE.IcosahedronGeometry(1, 5);
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  const o = range(rng, 0, 100);
  const base1 = C('#5f564d'), base2 = C('#90857a'), purple = C('#8d5aa3'), pink = C('#c27b98'),
    algae = C('#6c7a45'), tan = C('#b4a284'), c = new THREE.Color();
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const big = noise.fbm3(v.x * 1.2 + o, v.y * 1.2, v.z * 1.2, 4);
    const ridge = 1 - Math.abs(2 * noise.noise3(v.x * 4 + o, v.y * 4, v.z * 4) - 1);
    const pore = noise.noise3(v.x * 11 + o, v.y * 11, v.z * 11);
    const fine = noise.noise3(v.x * 22 + o, v.y * 22, v.z * 22);
    let r = 1 + (big - 0.5) * 0.9 + ridge * 0.2 + (fine - 0.5) * 0.06;
    if (pore < 0.35) r -= (0.35 - pore) * 0.7;
    const x = v.x * r * sx, z = v.z * r * sz;
    let y = v.y * r * sy;
    if (y < -0.25 * sy) y = -0.25 * sy + (y + 0.25 * sy) * 0.15;   // flat-ish base on the sand
    pos.setXYZ(i, x, y, z);
    // Colour: weathered rock + coralline algae + cavities darker.
    c.copy(base1).lerp(base2, noise.noise3(v.x * 3 + o, v.y * 3, v.z * 3));
    const cor = noise.noise3(v.x * 2.6 + 20 + o, v.y * 2.6, v.z * 2.6);
    if (cor > 0.6) c.lerp(cor > 0.68 ? pink : purple, clamp((cor - 0.6) * 4, 0, 0.7));
    const alg = noise.noise3(v.x * 2.2 + 40 + o, v.y * 2.2, v.z * 2.2);
    if (alg > 0.62 && v.y > 0) c.lerp(algae, clamp((alg - 0.62) * 4, 0, 0.6));
    if (v.y > 0.55) c.lerp(tan, (v.y - 0.55) * 0.8);
    const cav = clamp(0.4 + (r - 0.75) * 1.3, 0.35, 1.05);
    c.multiplyScalar(cav);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  // Spherical UVs for the pore bump map.
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).normalize();
    uv[i * 2] = 0.5 + Math.atan2(v.z, v.x) / (2 * Math.PI);
    uv[i * 2 + 1] = 0.5 + Math.asin(clamp(v.y, -1, 1)) / Math.PI;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

// ---------- corals ----------

function staghorn(rng, scale) {
  const geos = [];
  const tipCol = C('#f4d39c'), baseCol = C('#9c6634');
  const add = (a, b, ra, rb, depthFrac) => {
    const dir = _p.subVectors(b, a);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(rb, ra, len, 7, 1, true);
    g.deleteAttribute('uv');
    _q.setFromUnitVectors(UP, dir.clone().normalize());
    _m.compose(a.clone().addScaledVector(dir, 0.5), _q, _s.set(1, 1, 1));
    g.applyMatrix4(_m);
    const s = new THREE.SphereGeometry(rb, 7, 5);
    s.deleteAttribute('uv');
    s.translate(b.x, b.y, b.z);
    for (const gg of [g, s]) {
      const n = gg.attributes.position.count, col = new Float32Array(n * 3), c = baseCol.clone().lerp(tipCol, depthFrac);
      for (let i = 0; i < n; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
      gg.setAttribute('color', new THREE.BufferAttribute(col, 3));
      geos.push(gg);
    }
  };
  const MAXD = 4;
  const branch = (p, dir, len, rad, depth) => {
    const end = p.clone().addScaledVector(dir, len);
    add(p, end, rad, rad * 0.78, 1 - depth / MAXD);
    if (depth === 0) return;
    const kids = depth >= 3 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const d = dir.clone();
      d.x += range(rng, -0.9, 0.9); d.z += range(rng, -0.6, 0.6); d.y += range(rng, 0.0, 0.5);
      d.normalize();
      branch(end, d, len * range(rng, 0.7, 0.85), rad * 0.72, depth - 1);
    }
  };
  for (let t = 0; t < 5; t++) {
    const a = (t / 5) * Math.PI * 2 + rng();
    const d = new THREE.Vector3(Math.cos(a) * 0.7, 1, Math.sin(a) * 0.4).normalize();
    branch(new THREE.Vector3(0, 0, 0), d, 0.55 * scale, 0.11 * scale, MAXD);
  }
  return mergeGeometries(geos);
}

function domeCluster(rng, radius, count, color, varyColor, shape) {
  const geo = shape === 'finger' ? new THREE.CapsuleGeometry(0.06, 0.18, 3, 8) : new THREE.SphereGeometry(0.09, 10, 8);
  geo.translate(0, shape === 'finger' ? 0.1 : 0, 0);
  const mat = stdMat({ color: 0xffffff, roughness: 0.75 }, 0.8);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const base = C(color), alt = C(varyColor), c = new THREE.Color(), n = new THREE.Vector3();
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 0.95;
    const r = Math.sqrt(1 - y * y), th = golden * i + rng() * 0.3;
    n.set(Math.cos(th) * r, y, Math.sin(th) * r);
    _q.setFromUnitVectors(UP, n);
    const s = range(rng, 0.7, 1.3) * radius;
    _m.compose(_p.copy(n).multiply(_s.set(radius, radius * 0.75, radius)).multiplyScalar(range(rng, 0.85, 1.0)), _q, _s.set(s, s, s));
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, c.copy(base).lerp(alt, rng() * 0.6));
  }
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

function brainCoral(rng, noise) {
  const g = new THREE.SphereGeometry(1, 140, 70, 0, Math.PI * 2, 0, Math.PI / 2);
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3(), light = C('#c9a77a'), groove = C('#6e5236'), c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const w = noise.fbm3(v.x * 2, v.y * 2, v.z * 2, 2) * 6;
    const rid = Math.abs(Math.sin((v.x * 9 + v.z * 7) + w * 2.5));
    const d = 1 + rid * 0.035;
    pos.setXYZ(i, v.x * d, v.y * d * 0.75, v.z * d);
    c.copy(groove).lerp(light, rid);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  return g;
}

function leatherPlate(rng) {
  const NR = 18, NA = 90, pos = [], col = [], idx = [];
  const inner = C('#c4e09a'), outer = C('#4f8f42'), c = new THREE.Color();
  const ph = rng() * 6;
  for (let i = 0; i <= NR; i++) {
    const r = i / NR;
    for (let a = 0; a < NA; a++) {
      const th = (a / NA) * Math.PI * 2;
      const ruffle = Math.sin(th * 7 + ph) * 0.12 * r * r * r + Math.sin(th * 13) * 0.04 * r * r;
      const y = 0.18 * (1 - r * r) + ruffle - 0.15 * r * r;
      pos.push(Math.cos(th) * r, y, Math.sin(th) * r * 0.85);
      c.copy(inner).lerp(outer, r * r);
      if (rng() < 0.2) c.multiplyScalar(1.1);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NR; i++) for (let a = 0; a < NA; a++) {
    const a1 = (a + 1) % NA, p0 = i * NA + a, p1 = i * NA + a1, p2 = (i + 1) * NA + a, p3 = (i + 1) * NA + a1;
    idx.push(p0, p2, p1, p1, p2, p3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function ruffledFan(rng) {
  const NR = 12, NA = 60, pos = [], col = [], idx = [];
  const light = C('#e2c0d2'), dark = C('#8c5f7a'), c = new THREE.Color();
  for (let i = 0; i <= NR; i++) {
    const r = 0.05 + (i / NR) * 0.95;
    for (let a = 0; a <= NA; a++) {
      const th = (a / NA) * Math.PI;
      const flute = Math.sin(th * 14);
      pos.push(Math.cos(th) * r, Math.sin(th) * r * 0.8, flute * 0.07 * r + r * r * 0.25);
      c.copy(dark).lerp(light, 0.5 + flute * 0.5);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < NR; i++) for (let a = 0; a < NA; a++) {
    const p0 = i * (NA + 1) + a, p1 = p0 + 1, p2 = p0 + NA + 1, p3 = p2 + 1;
    idx.push(p0, p1, p2, p1, p3, p2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function seaFanTexture(rng) {
  const W = 512, H = 512, c = makeCanvas(W, H), g = c.getContext('2d');
  g.lineCap = 'round';
  const branch = (x, y, a, len, w, d) => {
    const x2 = x + Math.cos(a) * len, y2 = y + Math.sin(a) * len;
    g.strokeStyle = `rgba(${200 + d * 6},${95 + d * 10},${55 + d * 5},0.95)`;
    g.lineWidth = w;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x2, y2); g.stroke();
    if (d <= 0 || y2 < 10) return;
    branch(x2, y2, a + range(rng, -0.5, -0.1), len * 0.82, w * 0.75, d - 1);
    branch(x2, y2, a + range(rng, 0.1, 0.5), len * 0.82, w * 0.75, d - 1);
  };
  branch(W / 2, H, -Math.PI / 2, 90, 12, 8);
  // Mesh-like cross links
  g.strokeStyle = 'rgba(210,110,70,0.35)'; g.lineWidth = 1;
  for (let i = 0; i < 400; i++) {
    const x = rng() * W, y = rng() * H * 0.85;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + range(rng, -14, 14), y + range(rng, -14, 14)); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Bubble-tip anemone: a column plus swaying instanced tentacles.
function anemone(rng) {
  const group = new THREE.Group();
  const column = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.5, 0.35, 24), stdMat({ color: 0x9a7050, roughness: 0.8 }));
  column.position.y = 0.15;
  group.add(column);
  const tg = new THREE.CapsuleGeometry(0.026, 0.36, 4, 8);
  tg.translate(0, 0.21, 0);
  const n = tg.attributes.position.count, col = new Float32Array(n * 3);
  const stem = C('#7f8a4a'), tip = C('#e07aa2'), c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const h = tg.attributes.position.getY(i) / 0.42;
    c.copy(stem).lerp(tip, clamp((h - 0.8) * 5, 0, 1));
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  tg.setAttribute('color', new THREE.BufferAttribute(col, 3));
  const mat = stdMat({ vertexColors: true, roughness: 0.55 }, 0.5);
  const prevCompile = mat.onBeforeCompile;
  mat.onBeforeCompile = (shader, r) => {
    prevCompile(shader, r);
    shader.vertexShader = 'uniform float uTime;\n' + shader.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      #ifdef USE_INSTANCING
      {
        vec3 ip = instanceMatrix[3].xyz;
        float h = clamp(position.y / 0.42, 0.0, 1.0);
        transformed.x += sin(uTime * 1.2 + ip.x * 7.0 + ip.z * 5.0) * 0.09 * h * h;
        transformed.z += cos(uTime * 0.9 + ip.x * 4.0 - ip.z * 3.0) * 0.07 * h * h;
      }
      #endif`);
  };
  mat.customProgramCacheKey = () => 'anemone';
  const count = 320;
  const tent = new THREE.InstancedMesh(tg, mat, count);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const r = Math.sqrt(i / count) * 0.62, th = i * golden;
    const out = new THREE.Vector3(Math.cos(th) * r * 1.4, 1, Math.sin(th) * r * 1.4).normalize();
    _q.setFromUnitVectors(UP, out);
    const s = range(rng, 0.8, 1.2);
    _m.compose(_p.set(Math.cos(th) * r, 0.32, Math.sin(th) * r), _q, _s.set(s, s * range(rng, 0.85, 1.15), s));
    tent.setMatrixAt(i, _m);
  }
  tent.castShadow = true;
  group.add(tent);
  return group;
}

// ---------- heightfield ----------

class HeightField {
  constructor(x0, x1, z0, z1, step) {
    this.x0 = x0; this.z0 = z0; this.step = step;
    this.nx = Math.ceil((x1 - x0) / step) + 1;
    this.nz = Math.ceil((z1 - z0) / step) + 1;
    this.h = new Float32Array(this.nx * this.nz);
  }
  splat(x, y, z) {
    const i = Math.round((x - this.x0) / this.step), k = Math.round((z - this.z0) / this.step);
    if (i < 0 || k < 0 || i >= this.nx || k >= this.nz) return;
    const j = k * this.nx + i;
    if (y > this.h[j]) this.h[j] = y;
  }
  splatObject(obj) {
    obj.updateWorldMatrix(true, true);
    obj.traverse((o) => {
      if (!o.isMesh || o.userData.noHeight) return;
      const pos = o.geometry.attributes.position, v = new THREE.Vector3();
      if (o.isInstancedMesh) {
        const im = new THREE.Matrix4();
        for (let n = 0; n < o.count; n++) {
          o.getMatrixAt(n, im);
          im.premultiply(o.matrixWorld);
          for (let i = 0; i < pos.count; i += 4) { v.fromBufferAttribute(pos, i).applyMatrix4(im); this.splat(v.x, v.y, v.z); }
        }
      } else {
        for (let i = 0; i < pos.count; i++) { v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld); this.splat(v.x, v.y, v.z); }
      }
    });
  }
  // Grow each cell by its neighbours so fish keep a little clearance, then smooth.
  finish() {
    const { nx, nz } = this, src = this.h.slice(), out = new Float32Array(nx * nz);
    for (let k = 0; k < nz; k++) for (let i = 0; i < nx; i++) {
      let m = 0;
      for (let dk = -2; dk <= 2; dk++) for (let di = -2; di <= 2; di++) {
        const ii = i + di, kk = k + dk;
        if (ii >= 0 && kk >= 0 && ii < nx && kk < nz) m = Math.max(m, src[kk * nx + ii]);
      }
      out[k * nx + i] = m;
    }
    this.h = out;
  }
  sample(x, z) {
    const fx = (x - this.x0) / this.step, fz = (z - this.z0) / this.step;
    const i = Math.floor(fx), k = Math.floor(fz);
    if (i < 0 || k < 0 || i >= this.nx - 1 || k >= this.nz - 1) return 0;
    const tx = fx - i, tz = fz - k, n = this.nx, h = this.h;
    return lerp(lerp(h[k * n + i], h[k * n + i + 1], tx), lerp(h[(k + 1) * n + i], h[(k + 1) * n + i + 1], tx), tz);
  }
}

// ---------- scanned / generated scenery (Tripo3D GLBs, see tools/tripo.mjs) ----------

// Loads pc/models/scenery.json. Each model is centred on x/z with its base at y=0 and scaled to a
// unit bounding box (rocks per axis, corals uniformly by their largest side), so the layout code can fit it to a footprint. Returns { rocks: [], coral: {} }.
export async function loadScenery(base = './models/') {
  const out = { rocks: [], coral: {} };
  let manifest;
  try {
    const r = await fetch(base + 'scenery.json', { cache: 'no-cache' });
    if (!r.ok) return out;
    manifest = await r.json();
  } catch { return out; }
  const loader = new GLTFLoader();
  await Promise.all(Object.entries(manifest).map(async ([id, cfg]) => {
    try {
      const gltf = await loader.loadAsync(base + cfg.file);
      const obj = cfg.kind === 'rock' ? normaliseScenery(gltf.scene, 0.7, false) : normaliseScenery(gltf.scene, 0.9, true);
      if (cfg.kind === 'rock') out.rocks.push(obj);
      else out.coral[id.replace(/^coral_/, '')] = obj;
    } catch (e) {
      console.warn(`Scenery ${id} failed to load, using procedural`, e);
    }
  }));
  out.rocks.sort((a, b) => a.name.localeCompare(b.name));   // stable order so seeded layouts repeat
  return out;
}

function normaliseScenery(root, caustic, uniform) {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  const sc = uniform ? new THREE.Vector3().setScalar(1 / Math.max(size.x, size.y, size.z)) : new THREE.Vector3(1 / size.x, 1 / size.y, 1 / size.z);
  const m = new THREE.Matrix4().makeScale(sc.x, sc.y, sc.z)
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  const group = new THREE.Group();
  root.traverse((o) => {
    if (!o.isMesh) return;
    const geo = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, o.matrixWorld));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    // Reef surfaces are non-metallic, rough mineral or tissue; keep Tripo's albedo, normal and roughness maps.
    const src = o.material, mat = stdMat({
      map: src.map || null, normalMap: src.normalMap || null, roughnessMap: src.roughnessMap || null,
      color: src.color || 0xffffff, roughness: Math.max(0.6, src.roughness ?? 0.9), metalness: 0,
    }, caustic);
    if (mat.normalMap) mat.normalScale.set(1.2, 1.2);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  });
  group.name = root.name;
  return group;
}

// Replace a procedural coral with a generated model fitted to the same bounding box and pose.
function swapCoral(parent, proc, model) {
  if (!model) return proc;
  const pos = proc.position.clone(), rot = proc.rotation.clone(), scl = proc.scale.clone();
  proc.position.set(0, 0, 0); proc.rotation.set(0, 0, 0); proc.scale.set(1, 1, 1);
  proc.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(proc), size = box.getSize(new THREE.Vector3());
  // Uniform scale (corals keep their proportions): the largest side matches the procedural one.
  const k = Math.max(size.x, size.y, size.z);
  const g = new THREE.Group(), inner = model.clone();
  inner.scale.setScalar(k);
  inner.position.set((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2);
  g.add(inner);
  g.position.copy(pos); g.rotation.copy(rot); g.scale.copy(scl);
  parent.remove(proc);
  parent.add(g);
  return g;
}

// ---------- assembly ----------

// scenery: optional { rocks, coral } from loadScenery(); generated models replace procedural ones.
export function buildReef(scene, width, seed = 7, scenery = { rocks: [], coral: {} }) {
  const rng = mulberry32(seed);
  const noise = new Noise(mulberry32(seed + 1));
  const sx = width / 16;   // layout scales with the tank width
  const reef = new THREE.Group();
  scene.add(reef);
  const hf = new HeightField(-width / 2 - 2, width / 2 + 2, -6, 6, 0.2);

  // Sand
  {
    const sandTex = grainTexture(rng, 512, [188, 178, 158], 80, 10);
    const geo = new THREE.PlaneGeometry(width * 2.4, 22, 220, 110);
    geo.rotateX(-Math.PI / 2);
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const y = (noise.fbm(x * 0.15, z * 0.2, 3) - 0.5) * 0.5 + Math.sin(x * 2.2 + noise.noise2(x * 0.3, z * 0.3) * 6) * 0.025 - Math.max(0, z - 3) * 0.08;
      p.setY(i, y);
    }
    geo.computeVertexNormals();
    const sand = new THREE.Mesh(geo, stdMat({ map: sandTex, bumpMap: sandTex, bumpScale: 1.5, roughness: 1 }, 0.55));
    sand.receiveShadow = true;
    sand.userData.noHeight = true;
    sand.name = 'sand';
    reef.add(sand);
  }

  const pores = poreTexture(rng);
  const rockMat = stdMat({ vertexColors: true, map: rockDetailTexture(rng), roughness: 0.95, bumpMap: pores, bumpScale: 3.0 }, 0.7);
  const rocks = new THREE.Group();
  reef.add(rocks);
  const addRock = (x, z, w, h, d, sink = 0) => {
    const ground = Math.max(hf.sample(x, z), 0);
    let m;
    if (scenery.rocks.length) {
      // Generated rock stretched to the footprint, base slightly buried in the sand.
      m = scenery.rocks[Math.floor(rng() * scenery.rocks.length)].clone();
      // Scanned rocks fill less of their bounding box than the procedural blobs, so enlarge them
      // to keep the piles continuous.
      m.scale.set(w * 1.45, h * 1.3, d * 1.45);
      m.position.set(x, ground - sink - h * 0.15, z);
    } else {
      m = new THREE.Mesh(rockGeometry(rng, noise, w, h, d), rockMat);
      m.position.set(x, ground + h * 0.55 - sink, z);
    }
    m.rotation.y = rng() * Math.PI * 2;
    m.castShadow = m.receiveShadow = true;
    rocks.add(m);
    hf.splatObject(m);
    return m;
  };

  // Distant back wall of rock: gives depth and fills the frame edges.
  for (let x = -width * 0.75; x <= width * 0.75; x += range(rng, 1.6, 2.4)) {
    addRock(x, range(rng, -5.2, -4.2), range(rng, 1.3, 2.1), range(rng, 1.2, 2.6), range(rng, 1.0, 1.6));
  }
  // Main piles: [x, z, base width, height levels]
  const piles = [
    { x: -5.6, z: -1.0, levels: [[2.2, 1.3], [1.6, 1.1], [1.1, 0.9]] },
    { x: -0.6, z: -1.6, levels: [[2.4, 1.4], [1.9, 1.3], [1.4, 1.1], [0.9, 0.8]] },
    { x: 5.0, z: -1.2, levels: [[2.1, 1.2], [1.6, 1.0], [1.1, 0.8]] },
    { x: -2.9, z: -2.4, levels: [[1.6, 1.2], [1.2, 1.0]] },
    { x: 2.6, z: -2.6, levels: [[1.8, 1.3], [1.2, 1.0]] },
  ];
  for (const pile of piles) {
    const px = pile.x * sx;
    for (const [w, h] of pile.levels) {
      const n = w > 1.8 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        addRock(px + range(rng, -w * 0.5, w * 0.5), pile.z + range(rng, -0.6, 0.6), w * range(rng, 0.8, 1.1), h, w * range(rng, 0.6, 0.85), h * 0.35);
      }
    }
  }
  // Foreground rubble and small rocks
  for (const x of [-6.8, -3.6, 2.0, 3.3, 6.6]) addRock(x * sx + range(rng, -0.5, 0.5), range(rng, 1.4, 2.4), range(rng, 0.6, 1.0), range(rng, 0.4, 0.8), range(rng, 0.5, 0.8), 0.15);

  const corals = new THREE.Group();
  reef.add(corals);
  // Corals stand on the actual rock or sand surface straight below them. (The heightfield is a
  // 0.2-unit grid: next to a steep rock face it reports the cliff top, which left stalks floating.)
  reef.updateMatrixWorld(true);
  const groundRay = new THREE.Raycaster(), DOWN = new THREE.Vector3(0, -1, 0), sandMesh = reef.getObjectByName('sand');
  const groundAt = (x, z) => {
    groundRay.set(new THREE.Vector3(x, 30, z), DOWN);
    const hit = groundRay.intersectObjects([rocks, sandMesh], true)[0];
    return hit ? hit.point.y : hf.sample(x, z);
  };
  // r: footprint radius. A colony settles to the lowest point under its base, so where it overhangs
  // a rock edge its base reaches down into the rock instead of hanging over the drop.
  const top = (x, z, r = 0) => {
    let y = groundAt(x, z);
    for (let i = 0; r > 0 && i < 8; i++) y = Math.min(y, groundAt(x + Math.cos(i * Math.PI / 4) * r, z + Math.sin(i * Math.PI / 4) * r));
    return y;
  };

  // Staghorn on the central pile
  {
    const mat = stdMat({ vertexColors: true, roughness: 0.7, bumpMap: pores, bumpScale: 1.0 }, 0.9);
    for (const [x, z, s] of [[-0.6, -1.4, 1.25], [4.6, -1.3, 0.7], [-6.0, -2.6, 0.6]]) {
      const m = new THREE.Mesh(staghorn(rng, s), mat);
      m.position.set(x * sx, top(x * sx, z, 0.3 * s) - 0.15, z);
      m.rotation.y = rng() * 6;
      m.castShadow = m.receiveShadow = true;
      corals.add(m);
      swapCoral(corals, m, scenery.coral.staghorn);
    }
  }
  // White finger dome (left) and lavender cauliflower
  {
    const d1 = domeCluster(rng, 1.0, 520, '#eee8dc', '#c9c2b0', 'finger');
    d1.position.set(-5.5 * sx, top(-5.5 * sx, -0.9, 0.6) - 0.1, -0.9);
    corals.add(d1);
    swapCoral(corals, d1, scenery.coral.finger);
    const d2 = domeCluster(rng, 0.75, 650, '#c9a4dc', '#9e78b8', 'ball');
    d2.position.set(-2.4 * sx, top(-2.4 * sx, -0.3, 0.45) - 0.05, -0.3);
    corals.add(d2);
    swapCoral(corals, d2, scenery.coral.cauliflower);
    const d3 = domeCluster(rng, 0.55, 300, '#3b52d1', '#6070e8', 'finger');
    d3.position.set(1.4 * sx, Math.max(0, top(1.4 * sx, 1.6, 0.3)) - 0.05, 1.6);
    corals.add(d3);
    const d4 = domeCluster(rng, 0.45, 240, '#a8c45c', '#d8e070', 'finger');
    d4.position.set(-1.0 * sx, top(-1.0 * sx, 0.4, 0.25) - 0.05, 0.4);
    corals.add(d4);
  }
  // Brain coral on the sand, front-left of centre
  {
    const m = new THREE.Mesh(brainCoral(rng, noise), stdMat({ vertexColors: true, roughness: 0.8 }, 0.9));
    m.scale.setScalar(0.8);
    m.position.set(-1.6 * sx, Math.max(0, top(-1.6 * sx, 1.2, 0.4)) - 0.05, 1.2);
    m.castShadow = m.receiveShadow = true;
    corals.add(m);
    swapCoral(corals, m, scenery.coral.brain);
  }
  // Green leather toadstool
  {
    const stalk = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.32, 0.6, 16), stdMat({ color: 0xc8bf86, roughness: 0.8 }));
    const cap = new THREE.Mesh(leatherPlate(rng), stdMat({ vertexColors: true, roughness: 0.65, side: THREE.DoubleSide }, 0.9));
    const g = new THREE.Group();
    stalk.position.y = 0.3; cap.position.y = 0.55; cap.scale.setScalar(1.15);
    cap.rotation.z = 0.15;
    stalk.castShadow = cap.castShadow = true; cap.receiveShadow = true;
    g.add(stalk, cap);
    g.position.set(-4.0 * sx, top(-4.0 * sx, 1.5, 0.3) - 0.1, 1.5);
    corals.add(g);
    swapCoral(corals, g, scenery.coral.leather);
  }
  // Ruffled shells on the right
  {
    const mat = stdMat({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }, 0.9);
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(ruffledFan(rng), mat);
      const x = (5.4 + range(rng, -1.0, 1.2)) * sx, z = range(rng, -0.6, 0.6);
      m.position.set(x, top(x, z, 0.2) - 0.15, z);
      m.rotation.set(range(rng, -0.4, -0.1), range(rng, -0.6, 0.6), 0);
      m.scale.setScalar(range(rng, 0.6, 0.9));
      m.castShadow = true;
      corals.add(m);
      swapCoral(corals, m, scenery.coral.fan);
    }
  }
  // Sea fan, back left
  {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 2.8), stdMat({ map: seaFanTexture(rng), transparent: true, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 0.8 }, 0.5));
    m.position.set(-6.8 * sx, top(-6.8 * sx, -3.0) + 1.2, -3.0);
    m.rotation.y = 0.35;
    m.userData.noHeight = true;
    corals.add(m);
  }
  // Zoanthid polyp patches
  {
    const geo = new THREE.CylinderGeometry(0.03, 0.022, 0.025, 10);
    const mesh = new THREE.InstancedMesh(geo, stdMat({ color: 0xffffff, roughness: 0.5, emissive: 0x112222 }, 0.5), 420);
    const cols = ['#33d1b5', '#ff8a3a', '#9ae35b', '#e05bb0'].map(C);
    let n = 0;
    for (let patch = 0; patch < 7; patch++) {
      const cx = range(rng, -6, 6) * sx, cz = range(rng, -1, 1.8), col = cols[patch % cols.length];
      for (let i = 0; i < 60; i++, n++) {
        const x = cx + range(rng, -0.25, 0.25), z = cz + range(rng, -0.2, 0.2);
        // 420 polyps: the heightfield grid is close enough (and far cheaper than raycasting).
        _m.compose(_p.set(x, hf.sample(x, z) - 0.12, z), _q.identity(), _s.setScalar(range(rng, 0.8, 1.3)));
        mesh.setMatrixAt(n, _m);
        mesh.setColorAt(n, col);
      }
    }
    mesh.userData.noHeight = true;
    corals.add(mesh);
  }

  // Host anemone on a low front rock
  const anemoneSpot = new THREE.Vector3(2.9 * sx, 0, 1.3);
  addRock(anemoneSpot.x, anemoneSpot.z, 1.1, 0.7, 0.9, 0.1);
  anemoneSpot.y = top(anemoneSpot.x, anemoneSpot.z, 0.15) - 0.12;
  const an = anemone(rng);
  an.position.copy(anemoneSpot);
  an.traverse((o) => (o.userData.noHeight = true));
  corals.add(an);

  hf.splatObject(corals);
  hf.finish();

  // Resting spots: points just above the reef surface spread across the tank.
  const homes = [];
  for (let i = 0; i < 40; i++) {
    const x = range(rng, -width * 0.42, width * 0.42), z = range(rng, -2.2, 2.0);
    homes.push(new THREE.Vector3(x, hf.sample(x, z) + 0.35, z));
  }

  return {
    group: reef,
    heightAt: (x, z) => hf.sample(x, z),
    heightField: hf,
    anemones: [{ pos: new THREE.Vector3(anemoneSpot.x, anemoneSpot.y + 0.35, anemoneSpot.z), radius: 0.75 }],
    bubbler: new THREE.Vector3(6.3 * sx, 0.6, -3.4),
    homes,
  };
}

export { waterUniforms };
