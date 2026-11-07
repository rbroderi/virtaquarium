// Procedural geometry for the reef's rock and corals. Each takes the reef's Rng and draws from it in a
// fixed order, so a seed always builds the same pieces.
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp, range, type Noise, type Rng } from '../util.js';
import { stdMat } from './materials.js';

export const UP = new THREE.Vector3(0, 1, 0);
export const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
export const color = (hex: string): THREE.Color => new THREE.Color(hex);

/** Scratch for composing instance matrices (module-private; never held across calls). */
export const scratch = {
  m: new THREE.Matrix4(),
  q: new THREE.Quaternion(),
  s: new THREE.Vector3(),
  p: new THREE.Vector3(),
};

/** Fills a per-vertex colour attribute with one colour. */
function solidColorAttribute(count: number, c: THREE.Color): THREE.BufferAttribute {
  const col = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) { col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b; }
  return new THREE.BufferAttribute(col, 3);
}

// ---------- rock ----------

const ROCK_COLORS = {
  base1: color('#5f564d'), base2: color('#90857a'), purple: color('#8d5aa3'), pink: color('#c27b98'),
  algae: color('#6c7a45'), tan: color('#b4a284'),
} as const;

/** A live-rock boulder of size sx x sy x sz: noise-displaced icosphere, flat base, coralline colours. */
export function rockGeometry(rng: Rng, noise: Noise, sx: number, sy: number, sz: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry = new THREE.IcosahedronGeometry(1, 5);
  g.deleteAttribute('uv');
  g = mergeVertices(g);
  const pos = g.attributes['position'];
  if (!pos) return g;
  const col = new Float32Array(pos.count * 3);
  const o = range(rng, 0, 100);
  const { base1, base2, purple, pink, algae, tan } = ROCK_COLORS;
  const c = new THREE.Color();
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

const STAGHORN_DEPTH = 4;
const STAGHORN_TRUNKS = 5;

/** Branching Acropora: five trunks, each forking recursively, tips paler than the base. */
export function staghorn(rng: Rng, scale: number): THREE.BufferGeometry {
  const geos: THREE.BufferGeometry[] = [];
  const tipCol = color('#f4d39c'), baseCol = color('#9c6634');
  const { m, q, s: unit, p } = scratch;
  const add = (a: THREE.Vector3, b: THREE.Vector3, ra: number, rb: number, depthFrac: number): void => {
    const dir = p.subVectors(b, a);
    const len = dir.length();
    const g = new THREE.CylinderGeometry(rb, ra, len, 7, 1, true);
    g.deleteAttribute('uv');
    q.setFromUnitVectors(UP, dir.clone().normalize());
    m.compose(a.clone().addScaledVector(dir, 0.5), q, unit.set(1, 1, 1));
    g.applyMatrix4(m);
    const sphere = new THREE.SphereGeometry(rb, 7, 5);
    sphere.deleteAttribute('uv');
    sphere.translate(b.x, b.y, b.z);
    const c = baseCol.clone().lerp(tipCol, depthFrac);
    for (const piece of [g, sphere]) {
      piece.setAttribute('color', solidColorAttribute(piece.getAttribute('position').count, c));
      geos.push(piece);
    }
  };
  const branch = (start: THREE.Vector3, dir: THREE.Vector3, len: number, rad: number, depth: number): void => {
    const end = start.clone().addScaledVector(dir, len);
    add(start, end, rad, rad * 0.78, 1 - depth / STAGHORN_DEPTH);
    if (depth === 0) return;
    const kids = depth >= 3 ? 3 : 2;
    for (let k = 0; k < kids; k++) {
      const d = dir.clone();
      d.x += range(rng, -0.9, 0.9); d.z += range(rng, -0.6, 0.6); d.y += range(rng, 0.0, 0.5);
      d.normalize();
      branch(end, d, len * range(rng, 0.7, 0.85), rad * 0.72, depth - 1);
    }
  };
  for (let t = 0; t < STAGHORN_TRUNKS; t++) {
    const a = (t / STAGHORN_TRUNKS) * Math.PI * 2 + rng();
    const d = new THREE.Vector3(Math.cos(a) * 0.7, 1, Math.sin(a) * 0.4).normalize();
    branch(new THREE.Vector3(0, 0, 0), d, 0.55 * scale, 0.11 * scale, STAGHORN_DEPTH);
  }
  return mergeGeometries(geos);
}

export type DomeShape = 'finger' | 'ball';

/** A dome of instanced polyps (fingers or beads) spread over a hemisphere by the golden angle. */
export function domeCluster(rng: Rng, radius: number, count: number, baseHex: string, varyHex: string, shape: DomeShape): THREE.InstancedMesh {
  const geo = shape === 'finger' ? new THREE.CapsuleGeometry(0.06, 0.18, 3, 8) : new THREE.SphereGeometry(0.09, 10, 8);
  geo.translate(0, shape === 'finger' ? 0.1 : 0, 0);
  const mat = stdMat({ color: 0xffffff, roughness: 0.75 });
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const base = color(baseHex), alt = color(varyHex), c = new THREE.Color(), n = new THREE.Vector3();
  const { m, q, s, p } = scratch;
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 0.95;
    const r = Math.sqrt(1 - y * y), th = GOLDEN_ANGLE * i + rng() * 0.3;
    n.set(Math.cos(th) * r, y, Math.sin(th) * r);
    q.setFromUnitVectors(UP, n);
    const size = range(rng, 0.7, 1.3) * radius;
    m.compose(p.copy(n).multiply(s.set(radius, radius * 0.75, radius)).multiplyScalar(range(rng, 0.85, 1.0)), q, s.set(size, size, size));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.copy(base).lerp(alt, rng() * 0.6));
  }
  mesh.castShadow = mesh.receiveShadow = true;
  return mesh;
}

/** A meandering-ridged hemisphere (the noise is the reef's; no rng draws). */
export function brainCoral(noise: Noise): THREE.BufferGeometry {
  const g = new THREE.SphereGeometry(1, 140, 70, 0, Math.PI * 2, 0, Math.PI / 2);
  const pos = g.getAttribute('position'), col = new Float32Array(pos.count * 3);
  const v = new THREE.Vector3(), light = color('#c9a77a'), groove = color('#6e5236'), c = new THREE.Color();
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

/** Indexed geometry from flat position / colour lists. */
function indexedGeometry(pos: readonly number[], col: readonly number[], idx: readonly number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex([...idx]);
  g.computeVertexNormals();
  return g;
}

/** The leather toadstool's ruffled cap: a polar grid, domed and fluted towards the rim. */
export function leatherPlate(rng: Rng): THREE.BufferGeometry {
  const RINGS = 18, SPOKES = 90;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const inner = color('#c4e09a'), outer = color('#4f8f42'), c = new THREE.Color();
  const ph = rng() * 6;
  for (let i = 0; i <= RINGS; i++) {
    const r = i / RINGS;
    for (let a = 0; a < SPOKES; a++) {
      const th = (a / SPOKES) * Math.PI * 2;
      // Folds of unequal size and spacing (the lobes drift in phase and height round the rim), and a
      // rim that wanders in and out, not a ruled circle. (Only ph is drawn, as before.)
      const lobe = 1 + 0.35 * Math.sin(th * 3 + ph * 1.7), drift = th * 7 + ph + 0.5 * Math.sin(th * 2 + ph * 3);
      const ruffle = Math.sin(drift) * 0.12 * lobe * r * r * r + Math.sin(th * 13 + ph * 5 + 1.3 * Math.sin(th * 4 + ph)) * 0.04 * (1.4 - 0.4 * lobe) * r * r;
      const y = 0.18 * (1 - r * r) + ruffle - 0.15 * r * r;
      const rim = r * (1 + (i === RINGS ? 0.07 * Math.sin(th * 5 + ph * 2) + 0.05 * Math.sin(th * 11 + ph * 7) : 0) * r);
      pos.push(Math.cos(th) * rim, y, Math.sin(th) * rim * 0.85);
      c.copy(inner).lerp(outer, r * r * (1 + 0.25 * Math.sin(th * 5 + ph * 4) * r));
      if (rng() < 0.2) c.multiplyScalar(1.1);
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < RINGS; i++) for (let a = 0; a < SPOKES; a++) {
    const a1 = (a + 1) % SPOKES, p0 = i * SPOKES + a, p1 = i * SPOKES + a1, p2 = (i + 1) * SPOKES + a, p3 = (i + 1) * SPOKES + a1;
    idx.push(p0, p2, p1, p1, p2, p3);
  }
  return indexedGeometry(pos, col, idx);
}

/** A fluted half-disc shell (no rng draws). */
export function ruffledFan(): THREE.BufferGeometry {
  const RINGS = 12, SPOKES = 60;
  const pos: number[] = [], col: number[] = [], idx: number[] = [];
  const light = color('#e2c0d2'), dark = color('#8c5f7a'), c = new THREE.Color();
  for (let i = 0; i <= RINGS; i++) {
    const r = 0.05 + (i / RINGS) * 0.95;
    for (let a = 0; a <= SPOKES; a++) {
      const th = (a / SPOKES) * Math.PI;
      // Flutes of uneven spacing and depth, and a rim that wanders (no rng: fixed phases).
      const flute = Math.sin(th * 14 + 1.1 * Math.sin(th * 3 + 0.6) + 0.5 * Math.sin(th * 7)), deep = 1 + 0.3 * Math.sin(th * 5 + 2.0);
      const rr = r * (1 + (i === RINGS ? 0.06 * Math.sin(th * 6 + 1.0) + 0.04 * Math.sin(th * 13 + 0.3) : 0) * r);
      pos.push(Math.cos(th) * rr, Math.sin(th) * rr * 0.8, flute * 0.07 * deep * r + r * r * 0.25);
      c.copy(dark).lerp(light, clamp(0.5 + flute * 0.5 + 0.12 * Math.sin(th * 9 + r * 4), 0, 1));
      col.push(c.r, c.g, c.b);
    }
  }
  for (let i = 0; i < RINGS; i++) for (let a = 0; a < SPOKES; a++) {
    const p0 = i * (SPOKES + 1) + a, p1 = p0 + 1, p2 = p0 + SPOKES + 1, p3 = p2 + 1;
    idx.push(p0, p1, p2, p1, p3, p2);
  }
  return indexedGeometry(pos, col, idx);
}

/** A lathe of an (r, y) profile with per-vertex colours from colorAt(y). */
export function lathe(profile: readonly (readonly [number, number])[], segments: number, colorAt: (y: number, out: THREE.Color) => void): THREE.LatheGeometry {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(r, y)), segments);
  g.deleteAttribute('uv');
  const pos = g.getAttribute('position'), n = pos.count, col = new Float32Array(n * 3), c = new THREE.Color();
  for (let i = 0; i < n; i++) { colorAt(pos.getY(i), c); col.set([c.r, c.g, c.b], i * 3); }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
