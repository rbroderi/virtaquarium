// Levels of detail: simplified index lists over a mesh's own vertices, picked per draw by size on screen.
//
// A mesh drawn far smaller than it was modelled for spends triangles on detail no pixel can show (and
// the GPU shades in 2 x 2 blocks, so triangles under a few pixels cost far more than their area). Each
// level here is a second index list over the same vertices (meshoptimizer), so every vertex attribute
// (normals, texture coordinates, colours, a fish's jaw and gill weights) is exactly as before, and
// borders and seams are locked. Level k is used only while the mesh is at most LOD_PX[k] pixels across,
// and is simplified to an error of LOD_ERR_PX (a quarter pixel) at that size, in position and in each
// attribute weighted to the same units (see addLods). pickLod chooses per draw, for whichever pass is
// drawing (the view, a shadow map, the motion-blur velocity pass, the reef-light bake), from the mesh's
// bounding sphere, measured at its side nearest the camera, the projection and the target's height.
// ?lod=0 draws full detail everywhere.
import * as THREE from 'three';
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;
MeshoptSimplifier.useExperimentalFeatures = true;   // simplifyWithAttributes

const q = new URLSearchParams(globalThis.location?.search);
export const LOD_PX = [Infinity, 320, 140];
const LOD_ERR_PX = Number(q.get('loderr')) || 0.25;
let lodOn = q.get('lod') !== '0';
export function setLodEnabled(on) { lodOn = on; }   // perfCheck.js A/B

// World (object) units per unit of texture coordinate: the median over the mesh's edges, so a
// texture-coordinate error can be weighted as the same distance on the surface.
function uvScale(g) {
  const p = g.attributes.position, uv = g.attributes.uv, ix = g.index.array, r = [];
  for (let t = 0; t < ix.length; t += 3 * Math.max(1, Math.floor(ix.length / 3 / 4000))) {
    const a = ix[t], b = ix[t + 1];
    const dp = Math.hypot(p.getX(a) - p.getX(b), p.getY(a) - p.getY(b), p.getZ(a) - p.getZ(b));
    const du = Math.hypot(uv.getX(a) - uv.getX(b), uv.getY(a) - uv.getY(b));
    if (du > 1e-7 && dp > 1e-7) r.push(dp / du);
  }
  r.sort((x, y) => x - y);
  return r.length ? r[r.length >> 1] : 0;
}

// The simplifier's inputs for an indexed geometry: its index, positions, and the attributes it keeps
// the error of low, with weights. weights: { attributeName: weight per component } overriding the
// defaults, which put each attribute's error in the same units as the position's (relative to the
// mesh's largest extent): normals and colours 1 (a shading change of the error's size), texture
// coordinates by uvScale.
const GET = ['getX', 'getY', 'getZ', 'getW'];   // (plain or interleaved, denormalised)
function simplifierInput(g, weights) {
  if (!g.index) return null;
  const pa = g.attributes.position, n = pa.count, base = Uint32Array.from(g.index.array);
  const pos = { array: new Float32Array(n * 3) };
  for (let i = 0; i < n; i++) { pos.array[i * 3] = pa.getX(i); pos.array[i * 3 + 1] = pa.getY(i); pos.array[i * 3 + 2] = pa.getZ(i); }
  g.computeBoundingBox();
  const ext = g.boundingBox.getSize(new THREE.Vector3()), size = Math.max(ext.x, ext.y, ext.z) || 1;
  const names = Object.keys(g.attributes).filter((k) => k !== 'position' && g.attributes[k].itemSize <= 4);
  const uvW = g.attributes.uv ? uvScale(g) / size : 0;
  const defaults = { normal: 1, color: 1, uv: uvW, uv1: 0, tangent: 0 };
  const use = names.filter((k) => (weights[k] ?? defaults[k] ?? 1) > 0);
  const W = [];
  for (const k of use) {
    const w = weights[k] ?? defaults[k] ?? 1, s = g.attributes[k].itemSize;
    for (let c = 0; c < s; c++) W.push(Array.isArray(w) ? w[c] : w);
  }
  if (W.length > 32) return null;
  const S = W.length, attr = new Float32Array(n * S), A = use.map((k) => g.attributes[k]);
  for (let i = 0, o = 0; i < n; i++) for (const a of A) for (let c = 0; c < a.itemSize; c++) attr[o++] = a[GET[c]](i);
  // err: relative to the mesh's largest extent, which is at most its bounding-sphere diameter.
  return { base, simplify: (err) => MeshoptSimplifier.simplifyWithAttributes(base, pos.array, 3, attr, S, W, null, 0, err, ['LockBorder'])[0] };
}

const errorForPixels = (px) => LOD_ERR_PX / Math.max(px, 1);

// Add the levels to an indexed geometry (weights as simplifierInput). Returns each level's triangles.
export function addLods(g, weights = {}) {
  if (g.userData.lods) return g.userData.lods.map((l) => l[1] / 3);
  const s = simplifierInput(g, weights);
  if (!s) return null;
  const { base } = s, lists = [base];
  let prev = base;
  for (let k = 1; k < LOD_PX.length; k++) {
    // Each from the full mesh, so errors don't add up.
    const ix = s.simplify(errorForPixels(LOD_PX[k]));
    if (ix.length >= prev.length * 0.9) { lists.push(prev); continue; }   // little gained: reuse the last
    lists.push(ix); prev = ix;
  }
  // One index buffer holding every distinct level; each level is a draw range into it.
  const distinct = [...new Set(lists)], at = new Map();
  const all = new Uint32Array(distinct.reduce((s, l) => s + l.length, 0));
  let o = 0;
  for (const l of distinct) { all.set(l, o); at.set(l, o); o += l.length; }
  g.setIndex(new THREE.BufferAttribute(all, 1));
  g.userData.lods = lists.map((l) => [at.get(l), l.length]);
  g.setDrawRange(0, base.length);
  return lists.map((l) => l.length / 3);
}

// Set the level for the pass about to draw this mesh.
const _sz = new THREE.Vector2(), _c = new THREE.Vector3();
export function pickLod(renderer, mesh, camera, geo) {
  const L = geo.userData.lods;
  if (!L) return;
  let k = 0;
  if (lodOn) {
    const rt = renderer.getRenderTarget(), H = rt ? rt.height : renderer.getDrawingBufferSize(_sz).y;
    if (!geo.boundingSphere) geo.computeBoundingSphere();
    const r = geo.boundingSphere.radius * mesh.matrixWorld.getMaxScaleOnAxis(), P = camera.projectionMatrix.elements;
    let px = 2 * r * P[5] * H / 2;
    if (!camera.isOrthographicCamera) {
      const z = -_c.copy(geo.boundingSphere.center).applyMatrix4(mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
      px /= Math.max(z - r, camera.near);   // its nearest side: never coarser than any part of it needs
    }
    while (k + 1 < L.length && px <= LOD_PX[k + 1]) k++;
  }
  geo.setDrawRange(L[k][0], L[k][1]);
}

// Give a mesh its levels and pick them on every draw (view and shadow passes). Meshes sharing a
// geometry share its levels.
export function useLods(mesh, weights) {
  const tris = addLods(mesh.geometry, weights);
  if (!mesh.geometry.userData.lods) return null;
  const own = mesh.onBeforeRender;
  mesh.onBeforeRender = function (r, s, cam, geo, mat, grp) { pickLod(r, mesh, cam, geo); own.call(this, r, s, cam, geo, mat, grp); };
  mesh.onBeforeShadow = (r, o, cam, shadowCam, geo) => pickLod(r, mesh, shadowCam, geo);
  return tris;
}
