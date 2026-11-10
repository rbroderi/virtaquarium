// The open reef: the reef tank's reef and fish with no glass, standing in an endless reef that is
// cheap to draw. Around the tank's own sand a seabed runs out to the horizon (one mesh, coarser with
// distance, joined to the reef's sand without a crack), and on it sit outcrops: low-detail copies of the
// scenery models, rocks with corals on them, drawn as one instanced mesh per model and detail level.
// The water is murkier past FAR_WATER (medium.ts), so it all fades into the open-water background
// well inside the camera's far plane, and the background drops its darker-below grade so the faded
// seabed and the background meet without a seam.
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { mulberry32, range, pick, type Rng } from './core/rng.js';
import { Noise } from './core/noise.js';
import { clamp, smooth, TAU } from './core/math.js';
import { stdMat } from './reef/materials.js';
import { setGpuOpenWater } from './water/webgpuMedium.js';
import type { Scenery, TankScene } from './reef/types.js';
import type { WaterBackdrop } from './water/backdrop.js';

await MeshoptSimplifier.ready;

/** Turbidity past FAR_WATER (fog.density): the far reef is gone well before the backdrop's radius. */
export const OPEN_WATER_DENSITY = 4;
/** The water surface's width and depth (units) in the open reef, centred on the tank. */
const OPEN_SURFACE_SIZE = 170;
/** How far the seabed reaches (units from the tank's centre). */
const SEABED_REACH = 110;
/** The band (units) over which the reef's sand blends into the open seabed. */
const SKIRT = 6;
const SKIRT_ROWS = [0, 0.4, 1.0, 1.9, 3.2, 4.6, 6] as const;
/** The coarse seabed's spacing inside the skirt's span, and its first step and growth beyond it. */
const COARSE_INNER_STEP = 3;
const COARSE_FIRST_STEP = 1.6;
const COARSE_GROWTH = 1.13;
/** The reef sand's back is shaded (behind the back wall); in open water it brightens again further back. */
const BACK_SAND = { from: -6, to: -10, shade: 0.75 } as const;
/** Outcrops: a jittered grid, finer and more detailed near the tank. */
const NEAR_RING = { reach: 34, cell: 6.5, fill: 0.75 } as const;
const FAR_RING = { reach: 88, cell: 10, fill: 0.7 } as const;
/** Triangle budgets per model at each detail level. */
const NEAR_TRIS = { rock: 520, coral: 320 } as const;
const FAR_TRIS = { rock: 130, coral: 90 } as const;
/** Keep clear of the reef's own rockwork (beyond its footprint, units). */
const REEF_CLEARANCE = 3;
/** Behind the reef's back wall (builder.ts addBackWall, z about -5.2 .. -3.6) outcrops may stand anywhere. */
const REEF_BACK = -8;
/** The default camera sits at z = 15 looking at the reef: nothing tall in its view in front. */
const FRONT_CAMERA_Z = 15;
/** Seed stream for the open reef (independent of the reef's streams). */
const STREAM = 977;
/** The far seabed's undulation: amplitude, scale and the distance over which it grows in. */
const DUNES = { amp: 1.4, freq: 0.03, growIn: 25 } as const;
/** The reef sand's front slope (builder.ts addSand), levelling out further out. */
const FRONT_SLOPE = { from: 3, per: 0.08, levelAt: 19 } as const;

export interface OpenReef {
  /** Everything added to the scene: the seabed and the outcrops (not part of the reef's light bake). */
  readonly group: THREE.Group;
  readonly triangles: number;
  readonly instances: number;
}

export interface OpenReefParams {
  readonly scene: THREE.Scene;
  readonly reef: TankScene;
  readonly scenery: Scenery;
  readonly tankWidth: number;
  readonly seed: number;
}

interface SandGrid {
  readonly mesh: THREE.Mesh;
  readonly halfX: number;
  readonly halfZ: number;
  readonly segX: number;
  readonly segZ: number;
}

/** The reef's sand plane (builder.ts addSand) and its grid, which the seabed's skirt follows exactly. */
function sandGrid(reef: TankScene): SandGrid | null {
  const mesh = reef.group.getObjectByName('sand');
  if (!(mesh instanceof THREE.Mesh) || !(mesh.geometry instanceof THREE.PlaneGeometry)) return null;
  const { width, height, widthSegments, heightSegments } = mesh.geometry.parameters;
  return { mesh, halfX: width / 2, halfZ: height / 2, segX: widthSegments, segZ: heightSegments };
}

/** Distance from (x, z) to the rectangle |x| <= hx, |z| <= hz (0 inside). */
const rectDistance = (x: number, z: number, hx: number, hz: number): number =>
  Math.hypot(Math.max(0, Math.abs(x) - hx), Math.max(0, Math.abs(z) - hz));

/**
 * The seabed's height and shade. Inside the sand plane it is the sand (bilinear over its grid); across
 * the skirt it blends to the open seabed: low dunes growing in with distance, the sand's front slope
 * levelling out.
 */
class SeabedShape {
  private readonly pos: THREE.BufferAttribute;
  private readonly col: THREE.BufferAttribute | null;
  constructor(private readonly sand: SandGrid, private readonly noise: Noise) {
    this.pos = sand.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = sand.mesh.geometry.getAttribute('color');
    this.col = col instanceof THREE.BufferAttribute ? col : null;
  }

  get skirtX(): number { return this.sand.halfX + SKIRT; }
  get skirtZ(): number { return this.sand.halfZ + SKIRT; }

  /** The open seabed, ignoring the sand. */
  far(x: number, z: number): number {
    const { noise, sand } = this;
    const d = rectDistance(x, z, sand.halfX, sand.halfZ);
    const front = -FRONT_SLOPE.per * clamp(z - FRONT_SLOPE.from, 0, FRONT_SLOPE.levelAt - FRONT_SLOPE.from);
    const grow = smooth(clamp(d / DUNES.growIn, 0, 1));
    const dunes = (noise.fbm(x * DUNES.freq, z * DUNES.freq, 3) - 0.5) * DUNES.amp * grow;
    const ripple = (noise.fbm(x * 0.15, z * 0.2, 3) - 0.5) * 0.5;
    return front + dunes + ripple;
  }

  /** The sand's vertex value at grid (ix, iz), with the grid's own layout (PlaneGeometry rows from -z). */
  private sandAt(attr: THREE.BufferAttribute, ix: number, iz: number, c: 0 | 1): number {
    const i = clamp(iz, 0, this.sand.segZ) * (this.sand.segX + 1) + clamp(ix, 0, this.sand.segX);
    return c === 1 ? attr.getY(i) : attr.getX(i);
  }

  /** Bilinear sample of a sand attribute at (x, z), clamped to the plane. */
  private sandSample(attr: THREE.BufferAttribute, x: number, z: number, c: 0 | 1): number {
    const { halfX, halfZ, segX, segZ } = this.sand;
    const gx = (clamp(x, -halfX, halfX) + halfX) / (2 * halfX) * segX;
    const gz = (clamp(z, -halfZ, halfZ) + halfZ) / (2 * halfZ) * segZ;
    const ix = Math.min(Math.floor(gx), segX - 1), iz = Math.min(Math.floor(gz), segZ - 1);
    const fx = gx - ix, fz = gz - iz;
    const a = this.sandAt(attr, ix, iz, c), b = this.sandAt(attr, ix + 1, iz, c);
    const d = this.sandAt(attr, ix, iz + 1, c), e = this.sandAt(attr, ix + 1, iz + 1, c);
    return (a * (1 - fx) + b * fx) * (1 - fz) + (d * (1 - fx) + e * fx) * fz;
  }

  private blend(x: number, z: number): number {
    return smooth(clamp(rectDistance(x, z, this.sand.halfX, this.sand.halfZ) / SKIRT, 0, 1));
  }

  height(x: number, z: number): number {
    const w = this.blend(x, z);
    if (w >= 1) return this.far(x, z);
    return this.sandSample(this.pos, x, z, 1) * (1 - w) + this.far(x, z) * w;
  }

  /** Vertex shade: the sand's own shade blending to patchy open sand. */
  shade(x: number, z: number): number {
    const open = 0.8 + (this.noise.fbm(x * 0.05 + 40, z * 0.05, 3) - 0.5) * 0.45;
    if (!this.col) return open;
    const w = this.blend(x, z);
    return this.sandSample(this.col, x, z, 0) * (1 - w) + open * w;
  }
}

/** Grid lines across [-reach, reach]: every `inner` step inside +-span, then growing steps outside. */
function axisLines(span: number, reach: number): number[] {
  const n = Math.max(1, Math.ceil((2 * span) / COARSE_INNER_STEP));
  const lines: number[] = [];
  for (let i = 0; i <= n; i++) lines.push(-span + (2 * span * i) / n);
  for (let c = span, step = COARSE_FIRST_STEP; c < reach; step *= COARSE_GROWTH) {
    c = Math.min(reach, c + step);
    lines.push(c, -c);
  }
  return lines.sort((a, b) => a - b);
}

/** Linear interpolation of f along sorted lines at v (the coarse grid's edge, so the skirt meets it exactly). */
function alongLines(lines: readonly number[], v: number, f: (at: number) => number): number {
  let i = 1;
  while (i < lines.length - 1 && (lines[i] ?? 0) < v) i++;
  const a = lines[i - 1] ?? v, b = lines[i] ?? v;
  const t = b > a ? clamp((v - a) / (b - a), 0, 1) : 0;
  return f(a) * (1 - t) + f(b) * t;
}

class MeshBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly uv: number[] = [];
  readonly index: number[] = [];

  constructor(private readonly uvAt: (x: number, z: number) => [number, number]) {}

  /** A tensor grid over xs x zs; skip(cx, cz) leaves a cell out. */
  grid(xs: readonly number[], zs: readonly number[], y: (x: number, z: number) => number, shade: (x: number, z: number) => number, skip: (cx: number, cz: number) => boolean): void {
    const base = this.pos.length / 3, nx = xs.length;
    for (const z of zs) {
      for (const x of xs) {
        this.pos.push(x, y(x, z), z);
        const k = shade(x, z);
        this.col.push(k, k, k);
        this.uv.push(...this.uvAt(x, z));
      }
    }
    for (let j = 0; j < zs.length - 1; j++) {
      for (let i = 0; i < nx - 1; i++) {
        const cx = ((xs[i] ?? 0) + (xs[i + 1] ?? 0)) / 2, cz = ((zs[j] ?? 0) + (zs[j + 1] ?? 0)) / 2;
        if (skip(cx, cz)) continue;
        const a = base + j * nx + i, b = a + 1, c = a + nx, d = c + 1;
        this.index.push(a, c, b, b, c, d);
      }
    }
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    g.setIndex(this.index);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** In open water the sand behind the back wall isn't in the tank's shadow: brighten it back out. */
function brightenBackSand(sand: SandGrid): void {
  const g = sand.mesh.geometry, p = g.getAttribute('position'), c = g.getAttribute('color');
  if (!(c instanceof THREE.BufferAttribute)) return;
  for (let i = 0; i < p.count; i++) {
    const t = smooth(clamp((BACK_SAND.from - p.getZ(i)) / (BACK_SAND.from - BACK_SAND.to), 0, 1));
    const k = c.getX(i) + (BACK_SAND.shade - c.getX(i)) * t;
    c.setXYZ(i, k, k, k);
  }
  c.needsUpdate = true;
}

/**
 * The seabed out to SEABED_REACH: a skirt around the sand that shares its grid lines (so the join has no
 * crack), and a coarse grid beyond whose inner edge the skirt's outer row follows exactly.
 */
function buildSeabed(sand: SandGrid, shape: SeabedShape): THREE.Mesh {
  const { halfX, halfZ, segX, segZ } = sand;
  const X1 = shape.skirtX, Z1 = shape.skirtZ;
  const xsCoarse = axisLines(X1, SEABED_REACH), zsCoarse = axisLines(Z1, SEABED_REACH);
  // The sand's texture mapping (PlaneGeometry: u across x, v = 1 at the back), continued outwards.
  const b = new MeshBuilder((x, z) => [(x + halfX) / (2 * halfX), (halfZ - z) / (2 * halfZ)]);
  const shade = (x: number, z: number): number => shape.shade(x, z);
  const coarseEdge = (x: number, z: number): number | null => {
    if (Math.abs(Math.abs(z) - Z1) < 1e-6) return alongLines(xsCoarse, x, (at) => shape.far(at, z));
    if (Math.abs(Math.abs(x) - X1) < 1e-6) return alongLines(zsCoarse, z, (at) => shape.far(x, at));
    return null;
  };
  const skirtY = (x: number, z: number): number => coarseEdge(x, z) ?? shape.height(x, z);
  const sandXs = Array.from({ length: segX + 1 }, (_, i) => -halfX + (2 * halfX * i) / segX);
  const sandZs = Array.from({ length: segZ + 1 }, (_, i) => -halfZ + (2 * halfZ * i) / segZ);
  const out = (h: number, sign: 1 | -1): number[] => SKIRT_ROWS.map((r) => sign * (h + r));
  const sorted = (v: number[]): number[] => v.sort((p, q) => p - q);
  const never = (): boolean => false;
  for (const s of [1, -1] as const) {
    b.grid(sandXs, sorted(out(halfZ, s)), skirtY, shade, never);   // front and back bands
    b.grid(sorted(out(halfX, s)), sandZs, skirtY, shade, never);   // side bands
    for (const t of [1, -1] as const) b.grid(sorted(out(halfX, s)), sorted(out(halfZ, t)), skirtY, shade, never);   // corners
  }
  b.grid(xsCoarse, zsCoarse, (x, z) => shape.far(x, z), shade, (cx, cz) => Math.abs(cx) < X1 && Math.abs(cz) < Z1);
  const mesh = new THREE.Mesh(b.geometry(), sand.mesh.material);
  mesh.name = 'open-seabed';
  return mesh;
}

/** One model reduced to a triangle budget (its own vertices, a shorter index list). */
function simplified(source: THREE.BufferGeometry, tris: number): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const a = source.getAttribute(name);
    if (a) g.setAttribute(name, a);
  }
  const p = source.getAttribute('position');
  const index = source.index ? Uint32Array.from(source.index.array) : Uint32Array.from({ length: p.count }, (_, i) => i);
  const target = Math.min(index.length, tris * 3);
  let ix: Uint32Array = index;
  if (target < index.length) {
    const positions = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { positions[i * 3] = p.getX(i); positions[i * 3 + 1] = p.getY(i); positions[i * 3 + 2] = p.getZ(i); }
    ix = MeshoptSimplifier.simplify(index, positions, 3, target, 1, ['Prune'])[0];
    // UV seams stop the topology-preserving pass short: then collapse regardless of topology.
    if (ix.length > target * 1.5) ix = MeshoptSimplifier.simplifySloppy(index, positions, 3, null, target, 1)[0];
  }
  g.setIndex(new THREE.BufferAttribute(ix, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

interface Model {
  readonly kind: 'rock' | 'coral';
  readonly near: THREE.BufferGeometry;
  readonly far: THREE.BufferGeometry;
  readonly material: THREE.Material;
  readonly nearAt: THREE.Matrix4[];
  readonly farAt: THREE.Matrix4[];
  readonly nearTint: THREE.Color[];
  readonly farTint: THREE.Color[];
}

/** A scenery model's low-detail versions with a plain textured material (no sway, no parallax). */
function modelFrom(group: THREE.Object3D, kind: Model['kind']): Model | null {
  let mesh: THREE.Mesh | null = null;
  group.traverse((o) => { if (!mesh && o instanceof THREE.Mesh) mesh = o; });
  const m = mesh as THREE.Mesh | null;
  if (!m) return null;
  const src = (Array.isArray(m.material) ? m.material[0] : m.material) as THREE.MeshStandardMaterial | undefined;
  const budget = kind === 'rock' ? [NEAR_TRIS.rock, FAR_TRIS.rock] : [NEAR_TRIS.coral, FAR_TRIS.coral];
  const material = stdMat({ map: src?.map ?? null, color: src?.color?.clone() ?? new THREE.Color(1, 1, 1), roughness: 1, metalness: 0 });
  return {
    kind, material,
    near: simplified(m.geometry, budget[0] ?? 0), far: simplified(m.geometry, budget[1] ?? 0),
    nearAt: [], farAt: [], nearTint: [], farTint: [],
  };
}

/** Without the generated scenery (?tripo=0): lumpy procedural rocks and coral heads. */
function proceduralModels(rng: Rng): Model[] {
  const noise = new Noise(rng);
  const lump = (detail: number, seed: number, squash: number): THREE.BufferGeometry => {
    const ico = new THREE.IcosahedronGeometry(0.5, detail);
    ico.deleteAttribute('uv');
    ico.deleteAttribute('normal');
    const g = mergeVertices(ico);   // shared corners: smooth normals, one displacement per point
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) {
      const v = new THREE.Vector3().fromBufferAttribute(p, i);
      const k = 0.75 + 0.5 * noise.fbm3(v.x * 2.5 + seed, v.y * 2.5, v.z * 2.5, 3);
      v.multiplyScalar(k);
      v.y = Math.max(v.y, -0.2) * squash;
      p.setXYZ(i, v.x, v.y, v.z);
    }
    g.translate(0, 0.2 * squash, 0);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  };
  const make = (kind: Model['kind'], geo: THREE.BufferGeometry, far: THREE.BufferGeometry, color: number): Model => ({
    kind, near: geo, far, material: stdMat({ color, roughness: 1, metalness: 0 }),
    nearAt: [], farAt: [], nearTint: [], farTint: [],
  });
  return [
    make('rock', lump(3, 0, 0.8), lump(1, 0, 0.8), 0x8a7f72),
    make('rock', lump(3, 7, 1.0), lump(1, 7, 1.0), 0x7d7468),
    make('coral', lump(2, 13, 0.6), lump(1, 13, 0.6), 0xb98a7a),
    make('coral', lump(2, 21, 1.2), lump(1, 21, 1.2), 0x9aa07a),
  ];
}

/** The scenery's rocks and corals as outcrop models (soft corals with sway and the crystal left out). */
function sceneryModels(scenery: Scenery): Model[] {
  const models: Model[] = [];
  for (const rock of scenery.rocks) {
    const m = modelFrom(rock, 'rock');
    if (m) models.push(m);
  }
  for (const [id, coral] of Object.entries(scenery.coral)) {
    if (id.includes('crystal') || id === 'leather') continue;
    const m = modelFrom(coral, 'coral');
    if (m) models.push(m);
  }
  return models;
}

/**
 * Where outcrops may stand: behind the back wall, behind the default camera, or to the sides clear of
 * the reef's rockwork (the strip between keeps the default view of the reef unobstructed).
 */
function outcropAllowed(x: number, z: number, reefHalfX: number): boolean {
  return z < REEF_BACK || z > FRONT_CAMERA_Z || Math.abs(x) > reefHalfX + REEF_CLEARANCE;
}

const scratch = { q: new THREE.Quaternion(), s: new THREE.Vector3(), p: new THREE.Vector3(), up: new THREE.Vector3(0, 1, 0) };

function place(model: Model, near: boolean, x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw: number, tint: THREE.Color): void {
  const m = new THREE.Matrix4().compose(scratch.p.set(x, y, z), scratch.q.setFromAxisAngle(scratch.up, yaw), scratch.s.set(sx, sy, sz));
  (near ? model.nearAt : model.farAt).push(m);
  (near ? model.nearTint : model.farTint).push(tint);
}

/** Scatter outcrops over the rings: a rock with corals on and around it, now and then a lone coral head. */
function scatter(models: readonly Model[], shape: SeabedShape, reefHalfX: number, rng: Rng): void {
  const rocks = models.filter((m) => m.kind === 'rock'), corals = models.filter((m) => m.kind === 'coral');
  if (!rocks.length) return;
  const tint = (): THREE.Color => new THREE.Color().setHSL(range(rng, 0.02, 0.12), range(rng, 0, 0.25), 0.5).multiplyScalar(range(rng, 1.4, 2.0));
  for (const ring of [NEAR_RING, FAR_RING]) {
    const near = ring === NEAR_RING, inner = near ? 0 : NEAR_RING.reach;
    const n = Math.ceil(ring.reach / ring.cell);
    for (let i = -n; i <= n; i++) {
      for (let j = -n; j <= n; j++) {
        const x = (i + range(rng, -0.4, 0.4)) * ring.cell, z = (j + range(rng, -0.4, 0.4)) * ring.cell;
        const r = Math.hypot(x, z);
        if (rng() > ring.fill || r >= ring.reach || r < inner || !outcropAllowed(x, z, reefHalfX)) continue;
        const ground = shape.height(x, z);
        const size = range(rng, 0.6, 1.0) * ring.cell * 0.6;
        const sx = size * range(rng, 0.7, 1.2), sz = size * range(rng, 0.7, 1.2), sy = range(rng, 0.25, 0.55) * size;
        place(pick(rng, rocks), near, x, ground - 0.15 * sy, z, sx, sy, sz, rng() * TAU, tint());
        if (!corals.length) continue;
        const heads = 1 + Math.floor(rng() * 3);
        for (let k = 0; k < heads; k++) {
          const onTop = rng() < 0.6, a = rng() * TAU;
          const reach = onTop ? range(rng, 0, 0.3) : range(rng, 0.55, 0.8);
          const cx = x + Math.cos(a) * sx * reach, cz = z + Math.sin(a) * sz * reach;
          const cy = onTop ? ground + sy * 0.7 : shape.height(cx, cz) - 0.05;
          const s = range(rng, 0.25, 0.5) * size;
          place(pick(rng, corals), near, cx, cy, cz, s, s, s, rng() * TAU, new THREE.Color().setHSL(rng(), range(rng, 0.1, 0.4), 0.5).multiplyScalar(range(rng, 1.5, 2.0)));
        }
      }
    }
  }
}

function instanced(model: Model, near: boolean): THREE.InstancedMesh | null {
  const at = near ? model.nearAt : model.farAt, tints = near ? model.nearTint : model.farTint;
  if (!at.length) return null;
  const mesh = new THREE.InstancedMesh(near ? model.near : model.far, model.material, at.length);
  at.forEach((m, i) => mesh.setMatrixAt(i, m));
  tints.forEach((c, i) => mesh.setColorAt(i, c));
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  mesh.castShadow = mesh.receiveShadow = false;
  mesh.name = `open-${model.kind}-${near ? 'near' : 'far'}`;
  return mesh;
}

/** Builds the endless reef around the tank and adds it to the scene (outside the reef's group). */
export function buildOpenReef({ scene, reef, scenery, tankWidth, seed }: OpenReefParams): OpenReef {
  const group = new THREE.Group();
  group.name = 'open-reef';
  const rng = mulberry32(seed * 31 + STREAM);
  const sand = sandGrid(reef);
  let triangles = 0, instances = 0;
  if (!sand) {
    console.warn('Open reef: no reef sand to join; no seabed');
    scene.add(group);
    return { group, triangles, instances };
  }
  brightenBackSand(sand);
  const shape = new SeabedShape(sand, new Noise(rng));
  const seabed = buildSeabed(sand, shape);
  group.add(seabed);
  triangles += (seabed.geometry.index?.count ?? 0) / 3;
  const fromScenery = sceneryModels(scenery);
  const models = fromScenery.length ? fromScenery : proceduralModels(rng);
  scatter(models, shape, tankWidth * 0.75, rng);
  for (const model of models) {
    for (const near of [true, false]) {
      const mesh = instanced(model, near);
      if (!mesh) continue;
      group.add(mesh);
      instances += mesh.count;
      triangles += mesh.count * ((mesh.geometry.index?.count ?? 0) / 3);
    }
  }
  scene.add(group);
  console.info(`Open reef: ${instances} outcrop pieces, ${Math.round(triangles / 1000)}k triangles if all in view`);
  return { group, triangles, instances };
}

export interface OpenWaterParts {
  readonly gpu: boolean;
  readonly fog: THREE.FogExp2;
  readonly backdrop: WaterBackdrop | null;
  readonly surface: THREE.Object3D | null;
}

/**
 * The open reef's water: murkier with distance (fog.density, or the WebGPU medium's uniform), the
 * background without its darker-below grade, a surface reaching the horizon, and no glass vignette.
 */
export function openTheWater({ gpu, fog, backdrop, surface }: OpenWaterParts): void {
  if (gpu) setGpuOpenWater({ density: OPEN_WATER_DENSITY, open: 1 });
  else fog.density = OPEN_WATER_DENSITY;
  if (backdrop) backdrop.backdropUniforms.uFlat.value = 1;
  if (surface instanceof THREE.Mesh && surface.geometry instanceof THREE.PlaneGeometry) {
    const { width, height } = surface.geometry.parameters;
    surface.scale.set(OPEN_SURFACE_SIZE / width, OPEN_SURFACE_SIZE / height, 1);
    surface.position.z = 0;
  }
  document.getElementById('glass')?.style.setProperty('display', 'none');
}
