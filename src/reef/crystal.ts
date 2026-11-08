// The crystal rock, worked into the aquarium as a clear glass sign. The Tripo model is a fused cluster
// of crystal points with one large, smooth cleavage face, authored facing up (crystal_rock_flat_up.glb);
// that face becomes a frosted, laser-etched plaque
// facing the camera, and the rest of the cluster stays as a clear crystal frame around it.
//
// The etched text is a planar projection, not a per-facet UV: one text plane (centred on the face,
// normal = the face normal, up = world-up projected onto the plane) is defined in the crystal's local
// space, and the whole rock's shader projects each fragment's local position onto it. Letters therefore
// continue across facet borders as if etched into the rock from the front, instead of vanishing where
// the flat face's triangles end.
//
// loadScenery() builds the crystal group (split into a flat face mesh and a body mesh, both transparent
// glass); ReefBuilder places and orients it; crystalText.ts drives the etched text.
import * as THREE from 'three';
import { addCaustics } from '../water.js';
import { gpuActive, tsl } from '../webgpu/tsl.js';
import { gpuCrystalMaterial, type GpuCrystalOptions } from './crystalGpu.js';
import { isMesh } from './flags.js';
import { DEFAULT_CRYSTAL_TEXT, DEFAULT_LABEL, renderMask } from './crystalMask.js';
import { crystalBgUniforms } from './crystalBg.js';

/** Triangles whose normal's up component exceeds this seed the face direction (the model's face is up). */
const FACE_UP_DOT = 0.8;
/** How near a triangle's normal must be to the face's normal to belong to the face (dot product). */
const FACE_NORMAL_DOT = 0.93;
/** The text is sized to facets whose normal stays at least this near the face normal, so the shader's
 *  facing gate never fades the outermost letters near the rock's sides. */
const FACE_STRONG_DOT = 0.8;
/** Etched-mask texture width in pixels (height follows the strong-facing region's projected aspect). */
const FACE_TEXTURE_W = 2048;
/** Slight cyan tint of the glass (Beer-Lambert attenuation). */
const ATTENUATION_COLOR = new THREE.Color(0.72, 0.92, 1.0);
/** Fresnel F0 for crystal glass (IOR 1.54): near-normal faces stay clear, grazing edges turn mirror. */
const CRYSTAL_F0 = 0.045;
/** Fraction of the refracted background the body shows straight through (the rest is absorbed). */
const BODY_TRANSMISSION = 0.9;
/** Fraction of the refracted background the clear face plaque shows straight through. */
const FACE_TRANSMISSION = 0.92;
/** Frosted letters keep this fraction of the refracted background, so they stay translucent. */
const FACE_ETCH_TRANSMISSION = 0.5;
/** Strength of the faint darker inner edge on the frosted letters (0 none .. 1 heavy). */
const FACE_DARK = 0.5;
/** The frosted letters' soft ice-white scatter, added over the refracted background. */
const FROST_COLOR = new THREE.Color(0.36, 0.44, 0.54);
/** The frame's etched letters mix toward this roughness (frosted), while the clear frame keeps its own. */
const FROST_ROUGH = 0.85;
/** Recessed groove depth (local units): drives the engraved normal tilt and the cheap parallax. */
const GROOVE_DEPTH = 0.05;
/** Blur tap spacing on the etched mask's red channel (text UVs), turning the glyph edge into a groove
 *  slope. Kept well under a stroke width: wider taps show as offset copies of each letter. */
const GROOVE_BLUR = 0.003;
/** The frosted letter floor is this much brighter than the surrounding clear glass. */
const GROOVE_BRIGHT = 1.07;
/** Max refraction displacement along the face normal, world units (the cluster's real depth is ~1). */
const BODY_THICKNESS_MAX = 0.34;

/** The flat face, in the group's local space, as plain numbers (userData must survive JSON cloning). */
export interface CrystalFaceInfo {
  readonly n: readonly [number, number, number];
  readonly u: readonly [number, number, number];
  readonly v: readonly [number, number, number];
  readonly center: readonly [number, number, number];
  /** The face's own width along u (used to scale the placed sign to a target face width). */
  readonly extentU: number;
  /** The whole rock's projected silhouette on the text plane, around the face's centre: [u0, v0] is the
   *  lower bound and silExtentU/V the 2D size, so u = (p·u - centre·u - silU0) / silExtentU maps 0..1. */
  readonly silU0: number;
  readonly silV0: number;
  readonly silExtentU: number;
  readonly silExtentV: number;
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
 * face's triangles plus the rest, with a text plane: centred on the face, normal = the face normal,
 * up = world-up projected onto the plane, and the whole rock's projected silhouette for the text size.
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

  // The model is authored with its smooth cleavage face on top (crystal_rock_flat_up.glb), so the face
  // is the up-facing side: the mean normal of the triangles facing up.
  let mn = new THREE.Vector3();
  for (let t = 0; t < tris; t++) {
    if ((ny[t] as number) > FACE_UP_DOT) mn.add(new THREE.Vector3(nx[t] as number, ny[t] as number, nz[t] as number));
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
  // Up = world-up projected onto the plane (falls back to world Z when the plane is near-horizontal,
  // so the "up" axis never degenerates; orientCrystal then maps this v to world-up in the tank).
  const ref = Math.abs(fn.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const fu = new THREE.Vector3().crossVectors(ref, fn).normalize();
  const fv = new THREE.Vector3().crossVectors(fn, fu).normalize();

  // Centre and width of the face's vertices in the plane.
  const centre = new THREE.Vector3();
  let verts = 0;
  let minU = Infinity, maxU = -Infinity;
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
      const u = p0.dot(fu);
      if (u < minU) minU = u; if (u > maxU) maxU = u;
    }
  }
  if (!verts) return null;
  centre.multiplyScalar(1 / verts);

  // The text is sized to the region whose facets face the text direction strongly enough that the
  // shader's facing gate stays at full strength (dot >= FACE_STRONG_DOT), so the outermost letters
  // don't fade near the rock's sides. Measured around the face's centre.
  const strong = new Uint8Array(pos.length / 3);
  for (let t = 0; t < tris; t++) {
    const d = (nx[t] ?? 0) * fn.x + (ny[t] ?? 0) * fn.y + (nz[t] ?? 0) * fn.z;
    if (d >= FACE_STRONG_DOT) {
      strong[idx[t * 3] as number] = 1;
      strong[idx[t * 3 + 1] as number] = 1;
      strong[idx[t * 3 + 2] as number] = 1;
    }
  }
  let silU0 = Infinity, silU1 = -Infinity, silV0 = Infinity, silV1 = -Infinity;
  let anyStrong = false;
  for (let i = 0; i < pos.length / 3; i++) {
    if (!strong[i]) continue;
    anyStrong = true;
    p0.fromArray(pos, i * 3);
    const du = p0.dot(fu) - centre.dot(fu);
    const dv = p0.dot(fv) - centre.dot(fv);
    if (du < silU0) silU0 = du; if (du > silU1) silU1 = du;
    if (dv < silV0) silV0 = dv; if (dv > silV1) silV1 = dv;
  }
  if (!anyStrong) {
    // Degenerate: no strongly-facing facets; fall back to the whole rock so the text still has a box.
    silU0 = -0.5; silU1 = 0.5; silV0 = -0.5; silV1 = 0.5;
    for (let i = 0; i < pos.length / 3; i++) {
      p0.fromArray(pos, i * 3);
      const du = p0.dot(fu) - centre.dot(fu);
      const dv = p0.dot(fv) - centre.dot(fv);
      if (du < silU0) silU0 = du; if (du > silU1) silU1 = du;
      if (dv < silV0) silV0 = dv; if (dv > silV1) silV1 = dv;
    }
  }

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
      center: [centre.x, centre.y, centre.z],
      extentU: maxU - minU,
      silU0, silV0, silExtentU: silU1 - silU0, silExtentV: silV1 - silV0,
    },
  };
}

// ---------------------------------------------------------------------------
// Materials
//
// The crystal fakes three.js transmission: the material is opaque (transmission = 0, so the renderer
// never runs its expensive full-screen transmission pass) and its shader mixes in a small sub-frustum
// render of the reef behind it (crystalBg.ts). Flat shading, a little iridescence and a tight specular
// read as a mineral crystal rather than a smooth water blob.

/** The etched text plane and shared mask/fade the face and body materials both use. */
interface CrystalEtch {
  readonly mask: THREE.CanvasTexture;
  readonly fade: { value: number };
  /** The shared TSL fade uniform (WebGPU): CrystalSign mutates fade.value, which drives this node. */
  readonly fadeNode: { value: number } | null;
}

interface CrystalShaderOptions {
  readonly transmission: number;
  readonly thickness: number;
  readonly tint: THREE.Color;
  readonly f0: number;
  readonly etchTrans: number;
  readonly frost: THREE.Color;
  readonly dark: number;
  /** How the etched letters read against the clear glass: the plaque polishes its clear area, while
   *  the frame keeps its clear glass and only frosts the letters. */
  readonly frostMode: 'plaque' | 'frame';
  readonly plane: CrystalFaceInfo;
}

/** The faceted crystal body, caustic-lit like the rest of the reef, etched by planar projection. */
function bodyMaterial(thickness: number, etch: CrystalEtch, plane: CrystalFaceInfo): THREE.MeshPhysicalMaterial {
  const options = {
    transmission: BODY_TRANSMISSION, thickness: Math.min(BODY_THICKNESS_MAX, thickness),
    tint: ATTENUATION_COLOR.clone(), f0: CRYSTAL_F0, etchTrans: FACE_ETCH_TRANSMISSION, frost: FROST_COLOR.clone(), dark: FACE_DARK,
    frostMode: 'frame', plane,
  } as const;
  if (gpuActive()) {
    const mat = gpuCrystalMaterial({
      color: 0xffffff, roughness: 0.15, metalness: 0,
      flatShading: true,
      iridescence: 0.18, iridescenceIOR: 1.54, iridescenceThicknessMinimum: 100, iridescenceThicknessMaximum: 400,
      specularIntensity: 0.8, specularColor: new THREE.Color(1, 1, 1),
      envMapIntensity: 0.35,
    }, gpuOptions(options, etch), etch.fadeNode);
    mat.userData['crystalMask'] = etch.mask;
    mat.userData['crystalFade'] = etch.fade;
    return mat;
  }
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.15, metalness: 0,
    flatShading: true,
    iridescence: 0.18, iridescenceIOR: 1.54, iridescenceThicknessMinimum: 100, iridescenceThicknessMaximum: 400,
    specularIntensity: 0.8, specularColor: new THREE.Color(1, 1, 1),
    envMapIntensity: 0.35,
  });
  mat.userData['crystalMask'] = etch.mask;
  mat.userData['crystalFade'] = etch.fade;
  return addCrystalShader(addCaustics(mat), options);
}

/** The etched face plaque: the same clear glass, with the frosted letters shared with the body. */
function makeFaceMaterial(etch: CrystalEtch, plane: CrystalFaceInfo): THREE.MeshPhysicalMaterial {
  const options = {
    transmission: FACE_TRANSMISSION, thickness: 0, tint: new THREE.Color(1, 1, 1),
    f0: CRYSTAL_F0, etchTrans: FACE_ETCH_TRANSMISSION, frost: FROST_COLOR.clone(), dark: FACE_DARK,
    frostMode: 'plaque', plane,
  } as const;
  if (gpuActive()) {
    const mat = gpuCrystalMaterial({
      color: 0xffffff, roughness: 0.8, metalness: 0,
      specularIntensity: 0.6, specularColor: new THREE.Color(1, 1, 1),
      envMapIntensity: 0.25,
    }, gpuOptions(options, etch), etch.fadeNode);
    mat.userData['crystalMask'] = etch.mask;
    mat.userData['crystalFade'] = etch.fade;
    return mat;
  }
  const mat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff, roughness: 0.8, metalness: 0,
    specularIntensity: 0.6, specularColor: new THREE.Color(1, 1, 1),
    envMapIntensity: 0.25,
  });
  mat.userData['crystalMask'] = etch.mask;
  mat.userData['crystalFade'] = etch.fade;
  return addCrystalShader(addCaustics(mat), options);
}

/** The GPU material options (the WebGL path reads the same numbers from the shader options). */
function gpuOptions(options: CrystalShaderOptions, etch: CrystalEtch): GpuCrystalOptions {
  return {
    transmission: options.transmission, thickness: options.thickness, tint: options.tint, f0: options.f0,
    etchTrans: options.etchTrans, frost: options.frost, dark: options.dark, frostMode: options.frostMode,
    mask: etch.mask,
    textN: new THREE.Vector3(...options.plane.n), textU: new THREE.Vector3(...options.plane.u), textV: new THREE.Vector3(...options.plane.v),
    textCenter: new THREE.Vector3(...options.plane.center),
    silU0: options.plane.silU0, silV0: options.plane.silV0, silExtentU: options.plane.silExtentU, silExtentV: options.plane.silExtentV,
    groove: GROOVE_DEPTH, grooveBlur: GROOVE_BLUR, grooveBright: GROOVE_BRIGHT,
  };
}

/**
 * Patches the material to mix in the sub-frustum transmission background (uCrystalBg), and etch the
 * frosted letters by planar projection: project the fragment's local position onto the text plane,
 * sample the shared mask, and fade the etch by how near the fragment's normal is to the face normal.
 */
function addCrystalShader(mat: THREE.MeshPhysicalMaterial, options: CrystalShaderOptions): THREE.MeshPhysicalMaterial {
  const fade = mat.userData['crystalFade'] as { value: number } | undefined;
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    Object.assign(shader.uniforms, crystalBgUniforms, {
      uCrystalFade: fade ?? { value: 1 },
      uCrystalTransmission: { value: options.transmission },
      uCrystalIor: { value: 1.54 },
      uCrystalThickness: { value: options.thickness },
      uCrystalTint: { value: options.tint },
      uCrystalF0: { value: options.f0 },
      uCrystalEtchTrans: { value: options.etchTrans },
      uCrystalFrost: { value: options.frost },
      uCrystalDark: { value: options.dark },
      uTextN: { value: new THREE.Vector3(...options.plane.n) },
      uTextU: { value: new THREE.Vector3(...options.plane.u) },
      uTextV: { value: new THREE.Vector3(...options.plane.v) },
      uTextCenter: { value: new THREE.Vector3(...options.plane.center) },
      uTextU0: { value: options.plane.silU0 },
      uTextV0: { value: options.plane.silV0 },
      uTextInvExtU: { value: 1 / Math.max(1e-6, options.plane.silExtentU) },
      uTextInvExtV: { value: 1 / Math.max(1e-6, options.plane.silExtentV) },
      uCrystalGroove: { value: GROOVE_DEPTH },
      uCrystalGrooveBlur: { value: GROOVE_BLUR },
      uCrystalBright: { value: GROOVE_BRIGHT },
      uEtchTex: { value: mat.userData['crystalMask'] as THREE.Texture },
    });
    shader.vertexShader = 'varying vec3 vCrystalLocal;\n' + shader.vertexShader;
    shader.vertexShader = shader.vertexShader.replace('#include <project_vertex>', 'vCrystalLocal = transformed.xyz;\n#include <project_vertex>');

    const head = `
uniform sampler2D uCrystalBg;
uniform vec2 uCrystalBgSize;
uniform mat4 uCrystalBgProj;
uniform float uCrystalFade;
uniform float uCrystalTransmission;
uniform float uCrystalIor;
uniform float uCrystalThickness;
uniform float uCrystalF0;
uniform float uCrystalEtchTrans;
uniform float uCrystalDark;
uniform vec3 uCrystalTint;
uniform vec3 uCrystalFrost;
uniform sampler2D uEtchTex;
uniform vec3 uTextN;
uniform vec3 uTextU;
uniform vec3 uTextV;
uniform vec3 uTextCenter;
uniform float uTextU0;
uniform float uTextV0;
uniform float uTextInvExtU;
uniform float uTextInvExtV;
uniform float uCrystalGroove;
uniform float uCrystalGrooveBlur;
uniform float uCrystalBright;
uniform mat4 modelMatrix;
varying vec3 vCrystalLocal;
`;
    shader.fragmentShader = head + shader.fragmentShader;

    shader.fragmentShader = shader.fragmentShader.replace('void main() {',
      `void main() {
    vec3 crystalNLocal = normalize( cross( dFdx( vCrystalLocal ), dFdy( vCrystalLocal ) ) );
    float crystalFacing = smoothstep( 0.3, 0.5, dot( crystalNLocal, uTextN ) );
    vec2 crystalTextUv = vec2(
      ( dot( vCrystalLocal - uTextCenter, uTextU ) - uTextU0 ) * uTextInvExtU,
      ( dot( vCrystalLocal - uTextCenter, uTextV ) - uTextV0 ) * uTextInvExtV );
    vec4 crystalMask = texture2D( uEtchTex, crystalTextUv );
    // Blur the clarity channel (3x3 box, a fraction of a stroke wide) into a groove height (0 outside,
    // 1 inside) for the wall normal and the parallax only; the frost itself uses the sharp glyph, so
    // the blur's taps never show as shifted copies of the letters.
    float crystalBlurR = 0.0;
    for ( int crystalI = -1; crystalI <= 1; crystalI++ ) {
      for ( int crystalJ = -1; crystalJ <= 1; crystalJ++ ) {
        crystalBlurR += texture2D( uEtchTex, crystalTextUv + vec2( float( crystalI ), float( crystalJ ) ) * uCrystalGrooveBlur ).r;
      }
    }
    float crystalLetter = 1.0 - crystalBlurR / 9.0;
    // The groove height's gradient in the text plane, from screen derivatives of the letter mask and
    // the projected plane coordinates (du, dv).
    float crystalDu = dot( vCrystalLocal - uTextCenter, uTextU );
    float crystalDv = dot( vCrystalLocal - uTextCenter, uTextV );
    float crystalLdx = dFdx( crystalLetter ), crystalLdy = dFdy( crystalLetter );
    float crystalDudx = dFdx( crystalDu ), crystalDudy = dFdy( crystalDu );
    float crystalDvdx = dFdx( crystalDv ), crystalDvdy = dFdy( crystalDv );
    float crystalDet = crystalDudx * crystalDvdy - crystalDvdx * crystalDudy;
    float crystalDletterdu = ( crystalLdx * crystalDvdy - crystalLdy * crystalDvdx ) / crystalDet;
    float crystalDletterdv = ( crystalDudx * crystalLdy - crystalDudy * crystalLdx ) / crystalDet;
    vec3 crystalPerturbW = ( modelMatrix * vec4( uTextU * crystalDletterdu + uTextV * crystalDletterdv, 0.0 ) ).xyz;
    float crystalEtch = ( 1.0 - crystalMask.r ) * crystalFacing * uCrystalFade;
    float crystalDark = crystalMask.b * crystalFacing * uCrystalFade;`);

    const roughness = THREE.ShaderChunk['roughnessmap_fragment'];
    if (roughness.includes('roughnessFactor *= texelRoughness.g;')) {
      const frost = options.frostMode === 'plaque'
        ? 'roughnessFactor *= mix( 1.0, crystalMask.g, uCrystalFade );'
        : `roughnessFactor = mix( roughnessFactor, ${FROST_ROUGH.toFixed(3)}, crystalEtch );`;
      shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>',
        roughness.replace('float roughnessFactor = roughness;', `float roughnessFactor = roughness;\n\t${frost}`));
    } else {
      console.warn('crystal: three.js roughness chunk changed; frost off');
    }

    const mixCode = `
  {
    vec3 crystalV = normalize( cameraPosition - vCW );
    vec3 crystalN = normalize( inverseTransformDirection( normal, viewMatrix ) );
    // The etched groove perturbs the flat normal toward the letter walls, so the cut walls catch
    // light and refract differently from the facet around them.
    vec3 crystalNEngraved = normalize( crystalN + crystalPerturbW * uCrystalGroove );
    vec3 crystalR = refract( -crystalV, crystalNEngraved, 1.0 / uCrystalIor );
    // Cheap parallax: the letter floor is recessed, so it looks through a little less glass.
    float crystalThick = max( 0.0, uCrystalThickness - crystalLetter * uCrystalGroove );
    vec3 crystalExit = vCW + crystalR * crystalThick;
    vec4 crystalNdc = uCrystalBgProj * vec4( crystalExit, 1.0 );
    vec2 crystalUv = crystalNdc.xy / max( 1e-5, crystalNdc.w ) * 0.5 + 0.5;
    crystalUv = clamp( crystalUv, vec2( 0.0 ), vec2( 1.0 ) );
    vec3 crystalTransmitted = texture2D( uCrystalBg, crystalUv ).rgb * uCrystalTint * uCrystalTransmission;
    crystalTransmitted = mix( crystalTransmitted, crystalTransmitted * uCrystalEtchTrans + uCrystalFrost, crystalEtch );
    // The frosted floor reads a touch brighter than the surrounding clear glass.
    crystalTransmitted *= mix( 1.0, uCrystalBright, crystalEtch );
    // Fresnel with the engraved normal: one wall grazes (bright reflection), the other stays clear.
    float crystalCosT = max( dot( crystalNEngraved, crystalV ), 0.0 );
    float crystalF = uCrystalF0 + ( 1.0 - uCrystalF0 ) * pow( 1.0 - crystalCosT, 5.0 );
    outgoingLight = mix( crystalTransmitted, outgoingLight, crystalF );
    outgoingLight *= ( 1.0 - crystalDark * uCrystalDark );
  }
`;
    shader.fragmentShader = shader.fragmentShader.replace('#include <opaque_fragment>', mixCode + '#include <opaque_fragment>');
  };
  mat.customProgramCacheKey = () => prevKey() + (options.frostMode === 'plaque' ? '|crystalplaque' : '|crystalframe');
  return mat;
}

// ---------------------------------------------------------------------------
// Group construction

/**
 * Rebuilds a normalised crystal scenery group as two glass meshes: the flat face and the body, both
 * etched by planar projection so letters continue across the facet borders. Registers the shared face
 * material for crystalText.ts.
 */
export function makeCrystal(group: THREE.Group): THREE.Group {
  const original = group.children.slice();
  for (const child of original) group.remove(child);

  const geo = mergedGeometryFrom(original);
  let built = false;
  if (geo) {
    const split = splitFace(geo);
    if (split) {
      const fn = new THREE.Vector3(...split.info.n);

      // The etched mask covers the strongly-facing region's projection on the text plane.
      const silAspect = split.info.silExtentV > 1e-6 ? split.info.silExtentU / split.info.silExtentV : 1;
      const canvas = document.createElement('canvas');
      canvas.width = FACE_TEXTURE_W;
      canvas.height = Math.max(1, Math.round(FACE_TEXTURE_W / Math.max(0.1, silAspect)));
      const mask = new THREE.CanvasTexture(canvas);
      mask.colorSpace = THREE.NoColorSpace;
      mask.minFilter = THREE.LinearMipmapLinearFilter;
      mask.magFilter = THREE.LinearFilter;
      mask.generateMipmaps = true;
      mask.wrapS = mask.wrapT = THREE.ClampToEdgeWrapping;
      renderMask(canvas, DEFAULT_CRYSTAL_TEXT, DEFAULT_LABEL);

      // One fade value drives both materials; on WebGPU it wraps one shared TSL uniform node.
      const fade = { value: 1 };
      let fadeNode: { value: number } | null = null;
      if (gpuActive()) {
        const node = tsl().uniform(fade.value) as unknown as { value: number };
        fadeNode = node;
        Object.defineProperty(fade, 'value', {
          get: (): number => node.value,
          set: (v: number): void => { node.value = v; },
          configurable: true,
          enumerable: true,
        });
      }
      const etch: CrystalEtch = { mask, fade, fadeNode };

      // Face geometry: flat normals plus a projected uv (the etch itself is sampled by planar
      // projection in the shader, but a uv attribute keeps TSL from warning about the missing one).
      const fu = new THREE.Vector3(...split.info.u), fv = new THREE.Vector3(...split.info.v);
      const centre = new THREE.Vector3(...split.info.center);
      const remap = new Int32Array(geo.pos.length / 3).fill(-1);
      const fpos: number[] = [], fnrm: number[] = [], fuv: number[] = [];
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
          fuv.push((p.dot(fu) - centre.dot(fu) - split.info.silU0) / split.info.silExtentU,
                   (p.dot(fv) - centre.dot(fv) - split.info.silV0) / split.info.silExtentV);
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
      const faceMat = makeFaceMaterial(etch, split.info);
      faceMaterial = faceMat;
      const body = new THREE.Mesh(bodyGeo, bodyMaterial(Math.max(0.02, maxN - minN), etch, split.info));
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
    const fallback = bodyMaterial(0.2, { mask: blankEtchMask(), fade: { value: 1 }, fadeNode: null }, {
      n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], center: [0, 0, 0], extentU: 1, silU0: -0.5, silV0: -0.5, silExtentU: 1, silExtentV: 1,
    });
    for (const child of original) group.add(child);
    group.traverse((o) => { if (isMesh(o)) o.material = fallback; });
  } else {
    for (const child of original) {
      child.traverse((o) => { if (isMesh(o)) o.geometry.dispose(); });
    }
  }
  return group;
}

/** A blank 2x2 etch mask for the fallback body (all clear, no etched text). */
function blankEtchMask(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 2;
  const g = canvas.getContext('2d');
  if (g) { g.fillStyle = 'rgb(255,16,0)'; g.fillRect(0, 0, 2, 2); }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  return tex;
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
