// The crystal rock, worked into the aquarium as a clear glass sign. The Tripo model is a fused cluster
// of crystal points with one large flat cleavage face; that face becomes a frosted, laser-etched plaque
// facing the camera, and the rest of the cluster stays as a clear crystal frame around it.
//
// loadScenery() builds the crystal group (split into a flat face mesh and a body mesh, both transparent
// glass); ReefBuilder places and orients it; crystalText.ts drives the etched text on the face.
import * as THREE from 'three';
import { addCaustics } from '../water.js';
import { isMesh } from './flags.js';
import { DEFAULT_CRYSTAL_TEXT, DEFAULT_LABEL, renderMask } from './crystalMask.js';

/** How near a triangle's normal must be to the face's normal to belong to the face (dot product). */
const FACE_NORMAL_DOT = 0.93;
/** Etched-mask texture width in pixels (height follows the face's aspect). */
const FACE_TEXTURE_W = 1024;
/** Slight cyan tint of the glass (Beer-Lambert attenuation). */
const ATTENUATION_COLOR = new THREE.Color(0.72, 0.92, 1.0);

/** The flat face, in the group's local space, as plain numbers (userData must survive JSON cloning). */
export interface CrystalFaceInfo {
  readonly n: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
  readonly center: readonly [number, number, number];
  readonly extentU: number;
  readonly extentV: number;
}

const FACE_INFO_KEY = 'crystalFace';

// The single placed crystal: its shared face material (the clone reuses it) and the pieces ray casting
// (and the click handler) test against.
let faceMaterial: THREE.MeshPhysicalMaterial | null = null;
const pieces: THREE.Object3D[] = [];

/** The face material the text controller writes into (the builder's clone shares it). */
export function crystalFaceMaterial(): THREE.MeshPhysicalMaterial | null {
  return faceMaterial;
}

/** The placed crystal pieces (registered by the builder), for ray casting. */
export function crystalPieces(): readonly THREE.Object3D[] {
  return pieces;
}

export function registerCrystalPiece(obj: THREE.Object3D): void {
  pieces.push(obj);
}

export function readCrystalFace(obj: THREE.Object3D): CrystalFaceInfo | null {
  const v: unknown = obj.userData[FACE_INFO_KEY];
  return typeof v === 'object' && v !== null ? (v as CrystalFaceInfo) : null;
}

// ---------------------------------------------------------------------------
// Flat-face detection and mesh splitting

interface MergedGeometry {
  readonly pos: Float32Array;
  readonly nrm: Float32Array;
  readonly uv: Float32Array;
  readonly idx: Uint32Array;
}

/** Reads an attribute into a plain, de-interleaved Float32Array (getX/getY handle both attribute kinds). */
function readAttr(attr: THREE.BufferAttribute | THREE.InterleavedBufferAttribute | undefined, count: number, size: number): Float32Array {
  const out = new Float32Array(count * size);
  if (!attr) return out;
  for (let i = 0; i < count; i++) {
    if (size >= 1) out[i * size] = attr.getX(i);
    if (size >= 2) out[i * size + 1] = attr.getY(i);
    if (size >= 3) out[i * size + 2] = attr.getZ(i);
    if (size >= 4) out[i * size + 3] = attr.getW(i);
  }
  return out;
}

/** Concatenates every mesh geometry in the group into one indexed geometry (group-local space). */
function mergedGeometry(group: THREE.Object3D): MergedGeometry | null {
  const parts: { pos: Float32Array; nrm: Float32Array; uv: Float32Array; idx: Uint32Array }[] = [];
  let verts = 0, indices = 0;
  group.traverse((o) => {
    if (!isMesh(o)) return;
    const g = o.geometry;
    const pos = g.getAttribute('position');
    if (!pos) return;
    const n = pos.count;
    const idxAttr = g.index;
    const idxSrc = idxAttr ? idxAttr.array : null;
    const idxCount = idxSrc ? idxSrc.length : n;
    const idx = new Uint32Array(idxCount);
    if (idxSrc) for (let i = 0; i < idxCount; i++) idx[i] = idxSrc[i] ?? 0;
    else for (let i = 0; i < idxCount; i++) idx[i] = i;
    parts.push({
      pos: readAttr(pos, n, 3),
      nrm: readAttr(g.getAttribute('normal'), n, 3),
      uv: readAttr(g.getAttribute('uv'), n, 2),
      idx,
    });
    verts += n; indices += idxCount;
  });
  if (!parts.length) return null;
  const pos = new Float32Array(verts * 3), nrm = new Float32Array(verts * 3), uv = new Float32Array(verts * 2), idx = new Uint32Array(indices);
  let vo = 0, io = 0;
  for (const p of parts) {
    pos.set(p.pos, vo * 3); nrm.set(p.nrm, vo * 3); uv.set(p.uv, vo * 2);
    for (let i = 0; i < p.idx.length; i++) idx[io + i] = (p.idx[i] ?? 0) + vo;
    vo += p.pos.length / 3; io += p.idx.length;
  }
  return { pos, nrm, uv, idx };
}

/** Key for an undirected triangle edge (two vertex indices). */
const edge = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

interface FaceSplit {
  readonly faceIdx: Uint32Array;
  readonly bodyIdx: Uint32Array;
  readonly info: CrystalFaceInfo;
}

/**
 * Finds the largest near-planar, connected cluster of triangles (the cleavage face), and returns that
 * face's triangles plus the rest, with a plane basis and extents for the etched text.
 */
function splitFace(geo: MergedGeometry): FaceSplit | null {
  const { pos, idx } = geo;
  const tris = idx.length / 3;
  const nx = new Float32Array(tris), ny = new Float32Array(tris), nz = new Float32Array(tris);
  const p0 = new THREE.Vector3(), p1 = new THREE.Vector3(), p2 = new THREE.Vector3();
  const e1 = new THREE.Vector3(), e2 = new THREE.Vector3(), cn = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const a = idx[t * 3] as number, b = idx[t * 3 + 1] as number, c = idx[t * 3 + 2] as number;
    p0.fromArray(pos, a * 3); p1.fromArray(pos, b * 3); p2.fromArray(pos, c * 3);
    e1.subVectors(p1, p0); e2.subVectors(p2, p0);
    cn.crossVectors(e1, e2);
    const len = cn.length() || 1;
    nx[t] = cn.x / len; ny[t] = cn.y / len; nz[t] = cn.z / len;
  }

  // Dominant direction from a histogram of the normals' largest components.
  const counts = new Map<string, number>();
  for (let t = 0; t < tris; t++) {
    const x = nx[t] as number, y = ny[t] as number, z = nz[t] as number;
    const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    const key = m === Math.abs(x) ? (x >= 0 ? 'x+' : 'x-') : m === Math.abs(y) ? (y >= 0 ? 'y+' : 'y-') : (z >= 0 ? 'z+' : 'z-');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let dominant = 'y+', best = 0;
  for (const [k, v] of counts) if (v > best) { best = v; dominant = k; }

  // Mean normal of triangles near the dominant direction.
  const sign = dominant.endsWith('+') ? 1 : -1;
  const axis = dominant.startsWith('x') ? 0 : dominant.startsWith('y') ? 1 : 2;
  let mn = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    const comp = axis === 0 ? nx[t] as number : axis === 1 ? ny[t] as number : nz[t] as number;
    if (comp * sign > 0.8) mn.add(new THREE.Vector3(nx[t] as number, ny[t] as number, nz[t] as number));
  }
  if (mn.lengthSq() < 1e-9) return null;
  mn.normalize();

  // Triangles whose normal is near the mean, then the largest connected component among them.
  const near = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) {
    const d = (nx[t] ?? 0) * mn.x + (ny[t] ?? 0) * mn.y + (nz[t] ?? 0) * mn.z;
    if (d >= FACE_NORMAL_DOT) near[t] = 1;
  }
  const edgeTris = new Map<string, number[]>();
  for (let t = 0; t < tris; t++) {
    if (!near[t]) continue;
    const a = idx[t * 3] as number, b = idx[t * 3 + 1] as number, c = idx[t * 3 + 2] as number;
    for (const key of [edge(a, b), edge(b, c), edge(c, a)]) {
      const list = edgeTris.get(key);
      if (list) list.push(t); else edgeTris.set(key, [t]);
    }
  }
  const componentId = new Int32Array(tris).fill(-1);
  const stack: number[] = [];
  let largestId = -1, largestSize = 0;
  for (let t = 0; t < tris; t++) {
    if (!near[t] || (componentId[t] ?? 0) >= 0) continue;
    const id = largestId + 1;
    let size = 0;
    stack.length = 0; stack.push(t); componentId[t] = id;
    while (stack.length) {
      const cur = stack.pop() as number; size++;
      const a = idx[cur * 3] as number, b = idx[cur * 3 + 1] as number, c = idx[cur * 3 + 2] as number;
      for (const key of [edge(a, b), edge(b, c), edge(c, a)]) {
        for (const other of edgeTris.get(key) ?? []) if ((componentId[other] ?? 0) < 0) { componentId[other] = id; stack.push(other); }
      }
    }
    if (size > largestSize) { largestSize = size; largestId = id; }
  }
  if (largestId < 0) return null;
  const face = new Uint8Array(tris);
  for (let t = 0; t < tris; t++) if ((componentId[t] ?? -1) === largestId) face[t] = 1;

  // Plane basis from the face triangles' area-weighted normals.
  let fn = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    if (!face[t]) continue;
    const a = idx[t * 3] as number, b = idx[t * 3 + 1] as number, c = idx[t * 3 + 2] as number;
    p0.fromArray(pos, a * 3); p1.fromArray(pos, b * 3); p2.fromArray(pos, c * 3);
    e1.subVectors(p1, p0); e2.subVectors(p2, p0);
    cn.crossVectors(e1, e2);
    fn.add(cn);
  }
  if (fn.lengthSq() < 1e-9) return null;
  fn.normalize();
  const ref = Math.abs(fn.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const fu = new THREE.Vector3().crossVectors(ref, fn).normalize();
  const fv = new THREE.Vector3().crossVectors(fn, fu).normalize();

  // Extents and centre of the face's vertices in the plane.
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  const centre = new THREE.Vector3();
  let verts = 0;
  const seen = new Set<number>();
  for (let t = 0; t < tris; t++) {
    if (!face[t]) continue;
    for (let k = 0; k < 3; k++) {
      const vi = idx[t * 3 + k] as number;
      if (seen.has(vi)) continue;
      seen.add(vi);
      p0.fromArray(pos, vi * 3);
      centre.add(p0);
      verts++;
      const u = p0.dot(fu), v = p0.dot(fv);
      if (u < minU) minU = u; if (u > maxU) maxU = u;
      if (v < minV) minV = v; if (v > maxV) maxV = v;
    }
  }
  if (!verts) return null;
  centre.multiplyScalar(1 / verts);

  const faceIdx = new Uint32Array(face.reduce((a, b) => a + b, 0) * 3);
  const bodyIdx = new Uint32Array((tris - face.reduce((a, b) => a + b, 0)) * 3);
  let fi = 0, bi = 0;
  for (let t = 0; t < tris; t++) {
    if (face[t]) { faceIdx[fi++] = idx[t * 3] as number; faceIdx[fi++] = idx[t * 3 + 1] as number; faceIdx[fi++] = idx[t * 3 + 2] as number; }
    else { bodyIdx[bi++] = idx[t * 3] as number; bodyIdx[bi++] = idx[t * 3 + 1] as number; bodyIdx[bi++] = idx[t * 3 + 2] as number; }
  }

  return {
    faceIdx, bodyIdx,
    info: {
      n: [fn.x, fn.y, fn.z], u: [fu.x, fu.y, fu.z], v: [fv.x, fv.y, fv.z],
      center: [centre.x, centre.y, centre.z], extentU: maxU - minU, extentV: maxV - minV,
    },
  };
}

// ---------------------------------------------------------------------------
// Materials

/** A clear glass body material, caustic-lit like the rest of the reef. */
function bodyMaterial(thickness: number): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.12, metalness: 0,
    transmission: 1, ior: 1.54, thickness,
    attenuationColor: ATTENUATION_COLOR.clone(), attenuationDistance: 4,
    specularIntensity: 1, specularColor: new THREE.Color(1, 1, 1),
    envMapIntensity: 0.6,
  });
  return addCaustics(mat);
}

/** The etched face: the same glass, with the etched mask fading in via uCrystalFade. */
function makeFaceMaterial(aspect: number): THREE.MeshPhysicalMaterial {
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.9, metalness: 0,
    transmission: 1, ior: 1.54, thickness: 0,   // the clear face is a window: no refraction offset
    attenuationColor: new THREE.Color(1, 1, 1), attenuationDistance: Infinity,
    specularIntensity: 1, specularColor: new THREE.Color(1, 1, 1),
    envMapIntensity: 0.6,
  });
  const canvas = document.createElement('canvas');
  canvas.width = FACE_TEXTURE_W;
  canvas.height = Math.max(1, Math.round(FACE_TEXTURE_W / Math.max(0.1, aspect)));
  const mask = new THREE.CanvasTexture(canvas);
  mask.colorSpace = THREE.NoColorSpace;
  mask.minFilter = THREE.LinearFilter;
  mask.magFilter = THREE.LinearFilter;
  mask.generateMipmaps = false;
  mask.wrapS = mask.wrapT = THREE.ClampToEdgeWrapping;
  renderMask(canvas, DEFAULT_CRYSTAL_TEXT, DEFAULT_LABEL);
  mat.transmissionMap = mask;
  mat.roughnessMap = mask;
  mat.userData['crystalMask'] = mask;
  mat.userData['crystalAspect'] = aspect;
  mat.userData['crystalFade'] = { value: 1 };
  return addCrystalFade(addCaustics(mat));
}

/**
 * Fades the etched mask in and out (uCrystalFade: 0 = fully clear, 1 = etched). Patches the transmission
 * and roughness lookups, which are still #include directives when onBeforeCompile runs.
 */
function addCrystalFade(mat: THREE.MeshPhysicalMaterial): THREE.MeshPhysicalMaterial {
  const fade = mat.userData['crystalFade'] as { value: number };
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey.bind(mat);
  const chunksMatch = (): boolean =>
    THREE.ShaderChunk['transmission_fragment'].includes('material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;') &&
    THREE.ShaderChunk['roughnessmap_fragment'].includes('roughnessFactor *= texelRoughness.g;');
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms['uCrystalFade'] = fade;
    if (!chunksMatch()) {
      console.warn('crystal: three.js chunks changed; etched text fade off');
      return;
    }
    shader.fragmentShader = 'uniform float uCrystalFade;\n' + shader.fragmentShader
      .replace('#include <transmission_fragment>',
        THREE.ShaderChunk['transmission_fragment'].replace(
          'material.transmission *= texture2D( transmissionMap, vTransmissionMapUv ).r;',
          'material.transmission *= mix( 1.0, texture2D( transmissionMap, vTransmissionMapUv ).r, uCrystalFade );'))
      .replace('#include <roughnessmap_fragment>',
        THREE.ShaderChunk['roughnessmap_fragment'].replace(
          'roughnessFactor *= texelRoughness.g;',
          'roughnessFactor *= mix( 1.0, texelRoughness.g, uCrystalFade );'));
  };
  mat.customProgramCacheKey = () => prevKey() + '|crystalfade';
  return mat;
}

// ---------------------------------------------------------------------------
// Group construction

/**
 * Rebuilds a normalised crystal scenery group as two glass meshes: the flat face (which carries the
 * etched text) and the body. Registers the shared face material for crystalText.ts.
 */
export function makeCrystal(group: THREE.Group): THREE.Group {
  const original = group.children.slice();
  for (const child of original) group.remove(child);

  const geo = mergedGeometryFrom(original);
  let built = false;
  if (geo) {
    const split = splitFace(geo);
    if (split) {
      const aspect = split.info.extentV > 1e-6 ? split.info.extentU / split.info.extentV : 1;
      const fn = new THREE.Vector3(...split.info.n), fu = new THREE.Vector3(...split.info.u), fv = new THREE.Vector3(...split.info.v);
      const cx = split.info.center[0], cy = split.info.center[1], cz = split.info.center[2];
      const margin = 0.06;

      // Face geometry: planar UVs over the face rectangle, flat normals.
      const remap = new Int32Array(geo.pos.length / 3).fill(-1);
      const fpos: number[] = [], fuv: number[] = [], fnrm: number[] = [];
      const faceIdx = new Uint32Array(split.faceIdx.length);
      for (let i = 0; i < split.faceIdx.length; i++) {
        const vi = split.faceIdx[i] as number;
        let mapped = remap[vi] ?? -1;
        if (mapped < 0) {
          mapped = fpos.length / 3;
          remap[vi] = mapped;
          const p = new THREE.Vector3(geo.pos[vi * 3] as number, geo.pos[vi * 3 + 1] as number, geo.pos[vi * 3 + 2] as number);
          fpos.push(p.x, p.y, p.z);
          fnrm.push(fn.x, fn.y, fn.z);
          const u = (p.dot(fu) - (cx * fu.x + cy * fu.y + cz * fu.z)) / split.info.extentU + 0.5;
          const v = (p.dot(fv) - (cx * fv.x + cy * fv.y + cz * fv.z)) / split.info.extentV + 0.5;
          fuv.push(margin + (1 - 2 * margin) * Math.min(1, Math.max(0, u)), margin + (1 - 2 * margin) * Math.min(1, Math.max(0, v)));
        }
        faceIdx[i] = mapped;
      }
      const faceGeo = new THREE.BufferGeometry();
      faceGeo.setAttribute('position', new THREE.Float32BufferAttribute(fpos, 3));
      faceGeo.setAttribute('normal', new THREE.Float32BufferAttribute(fnrm, 3));
      faceGeo.setAttribute('uv', new THREE.Float32BufferAttribute(fuv, 2));
      faceGeo.setIndex(new THREE.BufferAttribute(faceIdx, 1));
      faceGeo.computeBoundingBox(); faceGeo.computeBoundingSphere();

      // Body geometry: the rest, original attributes.
      const bodyGeo = new THREE.BufferGeometry();
      bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(geo.pos.slice(), 3));
      bodyGeo.setAttribute('normal', new THREE.Float32BufferAttribute(geo.nrm.slice(), 3));
      bodyGeo.setAttribute('uv', new THREE.Float32BufferAttribute(geo.uv.slice(), 2));
      bodyGeo.setIndex(new THREE.BufferAttribute(split.bodyIdx, 1));
      bodyGeo.computeBoundingBox(); bodyGeo.computeBoundingSphere();

      // Thickness along the face normal, for the body's refraction.
      let minN = Infinity, maxN = -Infinity;
      for (let i = 0; i < geo.pos.length; i += 3) {
        const p = new THREE.Vector3(geo.pos[i] as number, geo.pos[i + 1] as number, geo.pos[i + 2] as number);
        const d = p.dot(fn);
        if (d < minN) minN = d; if (d > maxN) maxN = d;
      }

      group.userData[FACE_INFO_KEY] = split.info;
      // The crystal is a transparent object: on the Roku it is baked into the backdrop (behind the
      // fish sprites), not the transparent foreground layer, where its transmission would bake black.
      group.userData['backdropOnly'] = true;
      const faceMat = makeFaceMaterial(aspect);
      faceMaterial = faceMat;
      const body = new THREE.Mesh(bodyGeo, bodyMaterial(Math.max(0.02, maxN - minN)));
      body.name = 'crystal-body';
      body.castShadow = body.receiveShadow = true;
      const face = new THREE.Mesh(faceGeo, faceMat);
      face.name = 'crystal-face';
      face.castShadow = face.receiveShadow = true;
      group.add(body, face);
      built = true;
    }
  }

  // Fallback (no detectable flat face): keep the original meshes, re-materialled as plain glass.
  if (!built) {
    const fallback = bodyMaterial(0.2);
    for (const child of original) group.add(child);
    group.traverse((o) => { if (isMesh(o)) o.material = fallback; });
  } else {
    for (const child of original) {
      child.traverse((o) => { if (isMesh(o)) o.geometry.dispose(); });
    }
  }
  return group;
}

/** The merged geometry of a list of objects (their meshes are expected to be group-local). */
function mergedGeometryFrom(objects: readonly THREE.Object3D[]): MergedGeometry | null {
  const group = new THREE.Group();
  for (const o of objects) group.add(o);
  return mergedGeometry(group);
}

/**
 * Rotates a crystal group so its flat face points at `target` (the camera), upright: the face's height
 * axis (v) maps to world up as closely as its facing allows.
 */
export function orientCrystal(group: THREE.Object3D, info: CrystalFaceInfo, target: THREE.Vector3): void {
  const n = new THREE.Vector3(...info.n), u = new THREE.Vector3(...info.u), v = new THREE.Vector3(...info.v);
  const nw = target.clone().sub(group.position).normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const vw = up.clone().addScaledVector(nw, -up.dot(nw));
  if (vw.lengthSq() < 1e-8) vw.set(0, 0, 1).addScaledVector(nw, -nw.z);
  vw.normalize();
  const uw = new THREE.Vector3().crossVectors(vw, nw).normalize();
  const m = new THREE.Matrix3().set(u.x, v.x, n.x, u.y, v.y, n.y, u.z, v.z, n.z);
  const w = new THREE.Matrix3().set(uw.x, vw.x, nw.x, uw.y, vw.y, nw.y, uw.z, vw.z, nw.z);
  const r = w.multiply(m.transpose());
  group.quaternion.setFromRotationMatrix(new THREE.Matrix4().setFromMatrix3(r));
}
