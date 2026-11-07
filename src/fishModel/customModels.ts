// ---------- external models (e.g. generated with Tripo3D) ----------
//
// models/models.json maps species id -> { file, flip?, rotate?: [deg x, y, z], finFrac? }.
// Each model is normalised into fish space: longest axis -> x, nose towards +x, centred,
// length 1. The transform is baked into the geometry so the swim shader (which bends along
// object-space x) animates even an unrigged static mesh.
import * as THREE from 'three';
import { isRecord } from '../util.js';
import type { Species } from '../species/types.js';
import { IN_WATER_IOR, makeSwimMaterial, swimUniforms } from './swimShader.js';
import { FishModel } from './model.js';

/** One models.json entry. */
export interface ModelConfig {
  file?: string;
  flip?: boolean;
  /** Extra rotation before normalising, degrees about x, y, z. */
  rotate?: [number, number, number];
  /** Where the fins start, as a share of the model's height. */
  finFrac?: number;
}

/** A model normalised into fish space. */
export interface NormalisedModel {
  parts: { g: THREE.BufferGeometry; mat: THREE.Material | THREE.Material[] }[];
  finH: number;
}

const DEFAULT_FIN_FRACTION = 0.3;
const CUSTOM_PEDUNCLE_X = -0.3;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The typed gate for a models.json entry: unknown fields are ignored, bad ones dropped. */
export function parseModelConfig(raw: unknown): ModelConfig {
  if (!isRecord(raw)) return {};
  const cfg: ModelConfig = {};
  const { file, flip, rotate, finFrac } = raw;
  if (typeof file === 'string') cfg.file = file;
  if (typeof flip === 'boolean') cfg.flip = flip;
  if (Array.isArray(rotate) && rotate.length === 3) {
    const [x, y, z] = rotate as unknown[];
    if (isNumber(x) && isNumber(y) && isNumber(z)) cfg.rotate = [x, y, z];
  }
  if (isNumber(finFrac)) cfg.finFrac = finFrac;
  return cfg;
}

const custom = new Map<string, NormalisedModel>();

export const customModelFor = (id: string): NormalisedModel | undefined => custom.get(id);

export async function loadCustomModels(species: readonly Species[], base = './models/'): Promise<string[]> {
  let manifest: unknown;
  try {
    const r = await fetch(base + 'models.json', { cache: 'no-cache' });
    if (!r.ok) return [];
    manifest = await r.json();
  } catch { return []; }
  if (!isRecord(manifest)) return [];
  const entries = manifest;
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const loaded: string[] = [];
  await Promise.all(species.map(async (sp) => {
    const cfg = parseModelConfig(entries[sp.id]);
    if (!cfg.file) return;
    try {
      const gltf = await loader.loadAsync(base + cfg.file);
      custom.set(sp.id, normaliseModel(gltf.scene, cfg));
      loaded.push(sp.id);
    } catch (e) {
      console.warn(`Model for ${sp.id} failed to load, using procedural fish`, e);
    }
  }));
  return loaded;
}

function normaliseModel(root: THREE.Object3D, cfg: ModelConfig): NormalisedModel {
  root.updateMatrixWorld(true);
  const [rx, ry, rz] = (cfg.rotate || [0, 0, 0]).map(THREE.MathUtils.degToRad);
  const pre = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz));
  // Gather meshes with their world transforms (plus the manual rotation).
  const parts: NormalisedModel['parts'] = [];
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const geometry: THREE.BufferGeometry = o.geometry;
    const g = geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(pre, o.matrixWorld));
    const mat: THREE.Material | THREE.Material[] = o.material;
    parts.push({ g, mat });
  });
  const box = new THREE.Box3();
  for (const p of parts) { p.g.computeBoundingBox(); if (p.g.boundingBox) box.union(p.g.boundingBox); }
  const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
  // Longest horizontal axis is the body; rotate it onto x if it lies along z.
  const m = new THREE.Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z);
  let len = size.x;
  const height = size.y;
  if (size.z > size.x) { m.premultiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)); len = size.z; }
  if (cfg.flip) m.premultiply(new THREE.Matrix4().makeRotationY(Math.PI));
  m.premultiply(new THREE.Matrix4().makeScale(1 / len, 1 / len, 1 / len));
  for (const p of parts) { p.g.applyMatrix4(m); p.g.computeVertexNormals(); }
  return { parts, finH: (height / len) * (cfg.finFrac ?? DEFAULT_FIN_FRACTION) };
}

/** A swim material for one of a model's own materials: in-water Fresnel, no clearcoat or sheen. */
function submerged(src: THREE.Material, uniforms: ReturnType<typeof swimUniforms>): THREE.Material {
  const mat = src.clone();
  if (mat instanceof THREE.MeshStandardMaterial) {
    const phys = mat instanceof THREE.MeshPhysicalMaterial ? mat : new THREE.MeshPhysicalMaterial();
    if (phys !== mat) THREE.MeshStandardMaterial.prototype.copy.call(phys, mat);
    phys.ior = IN_WATER_IOR; phys.clearcoat = 0; phys.sheen = 0;
    return makeSwimMaterial(phys, uniforms);
  }
  return makeSwimMaterial(mat, uniforms);
}

export function buildCustomModel(_sp: Species, model: NormalisedModel): FishModel {
  const uniforms = swimUniforms({ uFinH: { value: model.finH }, uXPed: { value: CUSTOM_PEDUNCLE_X } });
  const group = new FishModel({ uniforms, pects: [], fan: false, custom: true });
  for (const p of model.parts) {
    const mats = (Array.isArray(p.mat) ? p.mat : [p.mat]).map((src) => submerged(src, uniforms));
    const single = mats.length === 1 ? mats[0] : undefined;
    group.add(new THREE.Mesh(p.g, single ?? mats));
  }
  return group;
}

// Load one GLB outside models.json (e.g. models/fish/<id>.glb) for side-by-side comparison.
export async function loadFishModel(url: string, cfg: ModelConfig = {}): Promise<NormalisedModel> {
  const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
    import('three/addons/loaders/GLTFLoader.js'),
    import('three/addons/libs/meshopt_decoder.module.js'),
  ]);
  return normaliseModel((await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(url)).scene, cfg);
}
