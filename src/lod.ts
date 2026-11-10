// Levels of detail: simplified index lists over a mesh's own vertices, picked per draw by size on screen.
//
// A mesh drawn far smaller than it was modelled for spends triangles on detail no pixel can show (and
// the GPU shades in 2 x 2 blocks, so triangles under a few pixels cost far more than their area). Each
// level here is a second index list over the same vertices (meshoptimizer), so every vertex attribute
// (normals, texture coordinates, colours, a fish's jaw and gill weights) is exactly as before, and
// borders and seams are locked. Level k is used only while the mesh is at most LOD_PX[k] pixels across,
// and is simplified to an error of a quarter pixel at that size, in position and in each attribute
// weighted to the same units (see addLods). pickLod chooses per draw, for whichever pass is drawing
// (the view, a shadow map, the motion-blur velocity pass, the reef-light bake), from the mesh's
// bounding sphere, measured at its side nearest the camera, the projection and the target's height.
// ?lod=0 draws full detail everywhere; ?loderr= sets the error in pixels.
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;

const query = new URLSearchParams(globalThis.location?.search);
/** Largest on-screen size (pixels) each level is used at. */
export const LOD_PX: readonly number[] = [Infinity, 320, 140];
const DEFAULT_ERROR_PX = 0.25;
const LOD_ERR_PX = Number(query.get('loderr')) || DEFAULT_ERROR_PX;
/** A level that keeps more than this fraction of the previous one's triangles isn't worth having. */
const MIN_REDUCTION = 0.9;
/** Edges sampled to measure the texture-coordinate scale. */
const UV_SAMPLE_EDGES = 4000;
/** meshoptimizer accepts at most this many attribute components. */
const MAX_ATTRIBUTE_COMPONENTS = 32;

/** Whether levels are used (perfCheck A/B toggles it). */
const settings = { enabled: query.get('lod') !== '0' };
export function setLodEnabled(on: boolean): void {
  settings.enabled = on;
}

/** Per-attribute error weights: one weight for every component, or one per component. */
export type LodWeights = Readonly<Record<string, number | readonly number[]>>;

/** [first index, index count] per level, kept on geometry.userData.lods. */
type LodRanges = readonly (readonly [number, number])[];

function lodRanges(g: THREE.BufferGeometry): LodRanges | null {
  const value: unknown = g.userData['lods'];
  return Array.isArray(value) ? (value as LodRanges) : null;
}

/**
 * World (object) units per unit of texture coordinate: the median over the mesh's edges, so a
 * texture-coordinate error can be weighted as the same distance on the surface.
 */
function uvScale(g: THREE.BufferGeometry, index: THREE.BufferAttribute): number {
  const p = g.getAttribute('position'), uv = g.getAttribute('uv'), ix = index.array, ratios: number[] = [];
  if (!uv) return 0;
  const stride = 3 * Math.max(1, Math.floor(ix.length / 3 / UV_SAMPLE_EDGES));
  for (let t = 0; t < ix.length; t += stride) {
    const a = ix[t] ?? 0, b = ix[t + 1] ?? 0;
    const dp = Math.hypot(p.getX(a) - p.getX(b), p.getY(a) - p.getY(b), p.getZ(a) - p.getZ(b));
    const du = Math.hypot(uv.getX(a) - uv.getX(b), uv.getY(a) - uv.getY(b));
    if (du > 1e-7 && dp > 1e-7) ratios.push(dp / du);
  }
  ratios.sort((x, y) => x - y);
  return ratios[ratios.length >> 1] ?? 0;
}

type ComponentGetter = (attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, i: number) => number;
const COMPONENT: readonly ComponentGetter[] = [(a, i) => a.getX(i), (a, i) => a.getY(i), (a, i) => a.getZ(i), (a, i) => a.getW(i)];

interface SimplifierInput {
  readonly base: Uint32Array;
  simplify(error: number): Uint32Array;
}

/**
 * The simplifier's inputs for an indexed geometry: its index, positions, and the attributes it keeps
 * the error of low, with weights. Defaults put each attribute's error in the same units as the
 * position's (relative to the mesh's largest extent): normals and colours 1, texture coordinates by
 * uvScale.
 */
function simplifierInput(g: THREE.BufferGeometry, weights: LodWeights): SimplifierInput | null {
  const index = g.index;
  if (!index) return null;
  const pa = g.getAttribute('position'), n = pa.count, base = Uint32Array.from(index.array);
  const positions = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { positions[i * 3] = pa.getX(i); positions[i * 3 + 1] = pa.getY(i); positions[i * 3 + 2] = pa.getZ(i); }
  g.computeBoundingBox();
  const ext = (g.boundingBox ?? new THREE.Box3()).getSize(new THREE.Vector3()), size = Math.max(ext.x, ext.y, ext.z) || 1;
  const names = Object.keys(g.attributes).filter((k) => k !== 'position' && (g.attributes[k]?.itemSize ?? 5) <= 4);
  const defaults: Readonly<Record<string, number>> = { normal: 1, color: 1, uv: g.attributes['uv'] ? uvScale(g, index) / size : 0, uv1: 0, tangent: 0 };
  const weightOf = (k: string): number | readonly number[] => weights[k] ?? defaults[k] ?? 1;
  // An attribute takes part when any of its weights is positive. (The JS build tested `weight > 0`,
  // which is false for an array like uv [2, 6], so it silently left the body's UVs out.)
  const used = names.filter((k) => {
    const w = weightOf(k);
    return typeof w === 'number' ? w > 0 : w.some((c) => c > 0);
  });
  const W: number[] = [];
  const attrs = used.map((k) => g.attributes[k]).filter((a): a is THREE.BufferAttribute | THREE.InterleavedBufferAttribute => a !== undefined);
  used.forEach((k, j) => {
    const w = weightOf(k), s = attrs[j]?.itemSize ?? 0;
    for (let c = 0; c < s; c++) W.push(typeof w === 'number' ? w : (w[c] ?? 0));
  });
  if (W.length > MAX_ATTRIBUTE_COMPONENTS) return null;
  const S = W.length, attr = new Float32Array(n * S);
  for (let i = 0, o = 0; i < n; i++) {
    for (const a of attrs) for (let c = 0; c < a.itemSize; c++) attr[o++] = COMPONENT[c]?.(a, i) ?? 0;
  }
  // error: relative to the mesh's largest extent, which is at most its bounding-sphere diameter.
  return {
    base,
    simplify: (error) => MeshoptSimplifier.simplifyWithAttributes(base, positions, 3, attr, S, W, null, 0, error, ['LockBorder'])[0],
  };
}

/** Size limits per level: the geometry's own (userData.lodPx, scenery's coarser ones) or the default. */
function limitsOf(g: THREE.BufferGeometry): readonly number[] {
  const own: unknown = g.userData['lodPx'];
  return Array.isArray(own) ? (own as number[]) : LOD_PX;
}

const errorForPixels =(px: number, errorPx: number): number => errorPx / Math.max(px, 1);

/** Add the levels to an indexed geometry. Returns each level's triangle count, or null if it can't. */
export function addLods(g: THREE.BufferGeometry, weights: LodWeights = {}, errorPx = LOD_ERR_PX, limits: readonly number[] = LOD_PX): number[] | null {
  const existing = lodRanges(g);
  if (existing) return existing.map((l) => l[1] / 3);
  const s = simplifierInput(g, weights);
  if (!s) return null;
  const { base } = s, lists: Uint32Array[] = [base];
  let prev = base;
  for (let k = 1; k < limits.length; k++) {
    // Each from the full mesh, so errors don't add up.
    const ix = s.simplify(errorForPixels(limits[k] ?? 1, errorPx));
    if (ix.length >= prev.length * MIN_REDUCTION) { lists.push(prev); continue; }   // little gained: reuse the last
    lists.push(ix);
    prev = ix;
  }
  // One index buffer holding every distinct level; each level is a draw range into it.
  const distinct = [...new Set(lists)], at = new Map<Uint32Array, number>();
  const all = new Uint32Array(distinct.reduce((sum, l) => sum + l.length, 0));
  let offset = 0;
  for (const l of distinct) { all.set(l, offset); at.set(l, offset); offset += l.length; }
  g.setIndex(new THREE.BufferAttribute(all, 1));
  g.userData['lods'] = lists.map((l) => [at.get(l) ?? 0, l.length] as const);
  if (limits !== LOD_PX) g.userData['lodPx'] = [...limits];
  g.setDrawRange(0, base.length);
  return lists.map((l) => l.length / 3);
}

const _size = new THREE.Vector2(), _centre = new THREE.Vector3();
/** Projection matrix element [5]: the vertical focal scale. */
const FOCAL_Y = 5;

/** Set the level for the pass about to draw this mesh. */
export function pickLod(renderer: THREE.WebGLRenderer, mesh: THREE.Object3D, camera: THREE.Camera, geo: THREE.BufferGeometry): void {
  const ranges = lodRanges(geo);
  if (!ranges) return;
  let k = 0;
  if (settings.enabled) {
    const rt = renderer.getRenderTarget(), H = rt ? rt.height : renderer.getDrawingBufferSize(_size).y;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const sphere = geo.boundingSphere ?? new THREE.Sphere();
    const r = sphere.radius * mesh.matrixWorld.getMaxScaleOnAxis(), focal = camera.projectionMatrix.elements[FOCAL_Y] ?? 1;
    let px = 2 * r * focal * H / 2;
    if (!(camera instanceof THREE.OrthographicCamera)) {
      const z = -_centre.copy(sphere.center).applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
      const near = camera instanceof THREE.PerspectiveCamera ? camera.near : 0;
      px /= Math.max(z - r, near);   // its nearest side: never coarser than any part of it needs
    }
    while (k + 1 < ranges.length && px <= (limitsOf(geo)[k + 1] ?? 0)) k++;
  }
  const range = ranges[k];
  if (range) geo.setDrawRange(range[0], range[1]);
}

/** Index count of the full-detail level: all of the index for a plain mesh, level 0's range with levels. */
export function baseIndexCount(g: THREE.BufferGeometry): number {
  return lodRanges(g)?.[0]?.[1] ?? g.index?.count ?? g.getAttribute('position').count;
}

/**
 * For a mesh whose geometry arrived with its levels precomputed (userData.lods, from the GLB; see
 * tools/optimize-scenery.ts): draw only level 0 until pickLod says otherwise, and pick on every draw.
 * Object3D.clone does not copy the render callbacks, so the mesh's clone() is overridden to hook each
 * clone too (the clones share the geometry and its levels). Does nothing for a geometry without levels.
 */
export function useBakedLods(mesh: THREE.Mesh): boolean {
  const ranges = lodRanges(mesh.geometry);
  if (!ranges) return false;
  mesh.geometry.setDrawRange(0, ranges[0]?.[1] ?? Infinity);
  const own = mesh.onBeforeRender, clone = mesh.clone;
  mesh.onBeforeRender = function onBeforeRender(r, s, cam, geo, mat, grp) {
    pickLod(r, this as THREE.Mesh, cam, geo);
    own.call(this, r, s, cam, geo, mat, grp);
  };
  mesh.onBeforeShadow = (r, o, _cam, shadowCam, geo) => pickLod(r, o, shadowCam, geo);
  mesh.clone = function cloneWithLods(this: THREE.Mesh, recursive?: boolean): THREE.Mesh {
    const copy = clone.call(this, recursive) as THREE.Mesh;
    useBakedLods(copy);
    return copy;
  };
  return true;
}

/** Give a mesh its levels and pick them on every draw (view and shadow passes). Meshes sharing a geometry share its levels. */
export function useLods(mesh: THREE.Mesh, weights: LodWeights): number[] | null {
  const triangles = addLods(mesh.geometry, weights);
  if (!lodRanges(mesh.geometry)) return null;
  const own = mesh.onBeforeRender;
  mesh.onBeforeRender = function onBeforeRender(r, s, cam, geo, mat, grp) {
    pickLod(r, mesh, cam, geo);
    own.call(this, r, s, cam, geo, mat, grp);
  };
  mesh.onBeforeShadow = (r, _o, _cam, shadowCam, geo) => pickLod(r, mesh, shadowCam, geo);
  return triangles;
}
