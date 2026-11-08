// Scanned / generated scenery (Tripo3D GLBs, see tools/tripo.ts): loading the manifest, normalising
// each model to a unit box, and swapping generated corals in for procedural ones.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { isRecord } from '../util.js';
import { addParallax } from '../parallax.js';
import { addSway, firstMaterial, stdMat } from './materials.js';
import { hasPomHeight, isMesh, naturalSize, setNaturalSize } from './flags.js';
import { makeCrystal } from './crystal.js';
import { gpuActive, tsl } from '../webgpu/tsl.js';
import type { Node, ShaderNodeObject } from 'three/webgpu';
import type { Scenery } from './types.js';

export type SceneryKind = 'rock' | 'coral' | 'prop' | 'plant';

/** A colour grade for a model whose colours came out too strong: saturation scale, albedo gain. */
export interface ColourGrade {
  readonly sat?: number;
  readonly gain?: number;
}

/** One validated scenery.json entry. */
export interface SceneryEntry {
  readonly file: string;
  readonly kind: SceneryKind | undefined;
  readonly retired: boolean;
  readonly rotate: readonly [number, number, number] | null;
  readonly grade: ColourGrade | null;
  /** Soft corals: how far they flex with the current. */
  readonly sway: number;
  /** Plants: 0 (soft Caulerpa) .. 1 (calcified Halimeda). */
  readonly stiff: number | undefined;
  /** Re-materialled as clear crystal with an etched face (the crystal rock). */
  readonly glass: boolean;
}

const MIN_ROUGHNESS = 0.6;
const DEFAULT_ROUGHNESS = 0.9;
const NORMAL_SCALE = 1.2;
/** Deepest parallax pits on a generated model (world units; ~1.5 cm). */
const SCENERY_POM_DEPTH = 0.12;
const GRADE_DIGITS = 3;
const DEFAULT_STIFFNESS = 0.5;

const SWAY = {
  coral: { ax: 0.03, az: 0.025, hz: 0.6 },
  plant: { ax: 0.08, az: 0.06, hz: 0.8 },
} as const;

/** (Written as the JS original's (d * PI) / 180, so the result matches it bit for bit.) */
const degreesToRadians = (d: number): number => (d * Math.PI) / 180;

const KINDS: readonly SceneryKind[] = ['rock', 'coral', 'prop', 'plant'];
const isKind = (v: unknown): v is SceneryKind => typeof v === 'string' && (KINDS as readonly string[]).includes(v);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function parseRotate(v: unknown): readonly [number, number, number] | null {
  if (!Array.isArray(v) || v.length !== 3 || !v.every((d) => typeof d === 'number')) return null;
  const [x, y, z] = v as number[];
  return [x ?? 0, y ?? 0, z ?? 0];
}

function parseGrade(v: unknown): ColourGrade | null {
  if (!isRecord(v)) return null;
  const sat = num(v['sat']), gain = num(v['gain']);
  return { ...(sat !== undefined ? { sat } : {}), ...(gain !== undefined ? { gain } : {}) };
}

/** The anti-corruption layer for scenery.json: unknown JSON in, validated entries out. */
export function parseSceneryManifest(raw: unknown): [string, SceneryEntry][] {
  if (!isRecord(raw)) return [];
  const entries: [string, SceneryEntry][] = [];
  for (const [id, cfg] of Object.entries(raw)) {
    if (!isRecord(cfg) || typeof cfg['file'] !== 'string') continue;
    entries.push([id, {
      file: cfg['file'],
      kind: isKind(cfg['kind']) ? cfg['kind'] : undefined,
      retired: Boolean(cfg['retired']),
      rotate: parseRotate(cfg['rotate']),
      grade: parseGrade(cfg['grade']),
      sway: num(cfg['sway']) ?? 0,
      stiff: num(cfg['stiff']),
      glass: Boolean(cfg['glass']),
    }]);
  }
  return entries;
}

function textureProperty(m: THREE.Material, key: 'map' | 'normalMap' | 'roughnessMap'): THREE.Texture | null {
  const v: unknown = (m as unknown as Record<string, unknown>)[key];
  return v instanceof THREE.Texture ? v : null;
}

function colourProperty(m: THREE.Material): THREE.Color | number {
  const v: unknown = (m as unknown as Record<string, unknown>)['color'];
  return v instanceof THREE.Color ? v : 0xffffff;
}

function roughnessProperty(m: THREE.Material): number {
  const v: unknown = (m as unknown as Record<string, unknown>)['roughness'];
  return typeof v === 'number' ? v : DEFAULT_ROUGHNESS;
}

/** Applies a saturation / gain grade to the albedo (after the colour map; parallax may have replaced map_fragment). */
function applyGrade(mat: THREE.Material, grade: ColourGrade): void {
  const sat = grade.sat ?? 1, gain = grade.gain ?? 1;
  if (gpuActive()) {
    // The WebGL patch grades material.color * map (after map_fragment, before color_fragment), which is
    // exactly materialColor in TSL. Parallax may already have replaced the map with a shifted one via
    // colorNode, so grade that instead when present (parallax runs first).
    const t = tsl();
    const existing = (mat as unknown as { colorNode: Node | null }).colorNode;
    const c = (existing ?? t.materialColor) as unknown as ShaderNodeObject<Node>;
    const l = c.rgb.dot(t.vec3(0.2126, 0.7152, 0.0722));
    // sat/gain are uniforms so graded models share one program instead of one per grade value.
    const uSat = t.uniform(sat, 'float');
    const uGain = t.uniform(gain, 'float');
    (mat as unknown as { colorNode: Node | null }).colorNode = t.mix(t.vec3(l), c.rgb, uSat).mul(uGain);
    return;
  }
  const prev = mat.onBeforeCompile.bind(mat), prevKey = mat.customProgramCacheKey.bind(mat);
  const f = (x: number): string => x.toFixed(GRADE_DIGITS);
  mat.onBeforeCompile = (s, r) => {
    prev(s, r);
    s.fragmentShader = s.fragmentShader.replace('#include <color_fragment>', `
          { float l = dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722));
            diffuseColor.rgb = mix(vec3(l), diffuseColor.rgb, ${f(sat)}) * ${f(gain)}; }
          #include <color_fragment>`);
  };
  mat.customProgramCacheKey = () => prevKey() + `-grade${sat}_${gain}`;
}

/**
 * Bakes the model centred on x/z with its base at y = 0 and scaled to a unit bounding box (per axis,
 * or uniformly by its largest side), re-materialled as non-metallic reef surface keeping the model's
 * albedo, normal and roughness maps.
 */
function normaliseScenery(root: THREE.Object3D, uniform: boolean, grade: ColourGrade | null): THREE.Group {
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(root), size = box.getSize(new THREE.Vector3());
  const sc = uniform ? new THREE.Vector3().setScalar(1 / Math.max(size.x, size.y, size.z)) : new THREE.Vector3(1 / size.x, 1 / size.y, 1 / size.z);
  const m = new THREE.Matrix4().makeScale(sc.x, sc.y, sc.z)
    .multiply(new THREE.Matrix4().makeTranslation(-(box.min.x + box.max.x) / 2, -box.min.y, -(box.min.z + box.max.z) / 2));
  const group = new THREE.Group();
  root.traverse((o) => {
    if (!isMesh(o)) return;
    const src = firstMaterial(o);
    if (!src) return;
    const geo = o.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(m, o.matrixWorld));
    geo.computeBoundingBox(); geo.computeBoundingSphere();
    const mat = stdMat({
      map: textureProperty(src, 'map'), normalMap: textureProperty(src, 'normalMap'), roughnessMap: textureProperty(src, 'roughnessMap'),
      color: colourProperty(src), roughness: Math.max(MIN_ROUGHNESS, roughnessProperty(src)), metalness: 0,
    }) as THREE.MeshStandardMaterial;   // (the node material also carries these maps)
    if (mat.normalMap) mat.normalScale.set(NORMAL_SCALE, NORMAL_SCALE);
    // Parallax from the height that tools/heightmaps.ts put in the normal map's alpha.
    if (mat.normalMap && hasPomHeight(src)) addParallax(mat, SCENERY_POM_DEPTH, { source: 'normalAlpha' });
    if (grade) applyGrade(mat, grade);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = mesh.receiveShadow = true;
    group.add(mesh);
  });
  group.name = root.name;
  setNaturalSize(group, size.clone());   // the model's own proportions (rocks are stretched to fit slots)
  return group;
}

/** Height of the top relative to the largest side, for the sway's full-bend height. */
const swayTop = (obj: THREE.Object3D): number => {
  const n = naturalSize(obj);
  return n.y / Math.max(n.x, n.y, n.z);
};

function swayMeshes(obj: THREE.Object3D, key: string, ax: number, az: number, hz: number): void {
  const hTop = swayTop(obj);
  obj.traverse((o) => {
    const mat = isMesh(o) ? firstMaterial(o) : undefined;
    if (mat) addSway(mat, key, { ax, az, hz, hTop });
  });
}

interface MutableScenery {
  rocks: THREE.Group[];
  coral: Record<string, THREE.Group>;
  props: Record<string, THREE.Group>;
  plants: Record<string, THREE.Group>;
}

/** Files a loaded model under its kind (soft corals and plants get their sway here). */
function fileModel(out: MutableScenery, id: string, cfg: SceneryEntry, obj: THREE.Group): void {
  if (cfg.kind === 'rock') out.rocks.push(obj);
  else if (cfg.kind === 'prop') out.props[id] = obj;
  else if (cfg.kind === 'coral' && cfg.sway) {
    // Soft corals (leather) flex a little with the current; stony ones don't.
    swayMeshes(obj, 'coral-' + id, SWAY.coral.ax * cfg.sway, SWAY.coral.az * cfg.sway, SWAY.coral.hz);
    out.coral[id.replace(/^coral_/, '')] = obj;
  } else if (cfg.kind === 'plant') {
    // Macroalgae bend with the current; calcified Halimeda much less than soft Caulerpa.
    const give = 1 - (cfg.stiff ?? DEFAULT_STIFFNESS);
    swayMeshes(obj, 'plant-' + id, SWAY.plant.ax * give, SWAY.plant.az * give, SWAY.plant.hz);
    out.plants[id.replace(/^plant_/, '')] = obj;
  } else out.coral[id.replace(/^coral_/, '')] = obj;
}

async function fetchManifest(url: string): Promise<unknown> {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    return r.ok ? ((await r.json()) as unknown) : null;
  } catch {
    return null;
  }
}

/**
 * Loads <base>scenery.json. `rotate` ([x, y, z] degrees) stands a model up first, for one built in
 * another pose. Retired entries stay on disk and in the manifest, out of the tank.
 */
export async function loadScenery(base = './models/'): Promise<Scenery> {
  const out: MutableScenery = { rocks: [], coral: {}, props: {}, plants: {} };
  const manifest = await fetchManifest(base + 'scenery.json');
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  await Promise.all(parseSceneryManifest(manifest).map(async ([id, cfg]) => {
    if (cfg.retired) return;
    try {
      const gltf = await loader.loadAsync(base + cfg.file);
      if (cfg.rotate) {
        const [x, y, z] = cfg.rotate.map(degreesToRadians);
        gltf.scene.rotation.set(x ?? 0, y ?? 0, z ?? 0);
      }
      const obj = normaliseScenery(gltf.scene, cfg.kind !== 'rock', cfg.grade);
      obj.name = id;   // GLB scene names repeat ("Scene"), so sort by the manifest id below
      fileModel(out, id, cfg, cfg.glass ? makeCrystal(obj) : obj);
    } catch (e) {
      console.warn(`Scenery ${id} failed to load, using procedural`, e);
    }
  }));
  out.rocks.sort((a, b) => a.name.localeCompare(b.name));   // stable order so seeded layouts repeat
  return out;
}

/** Replace a procedural coral with a generated model fitted to the same bounding box and pose. */
export function swapCoral(parent: THREE.Object3D, proc: THREE.Object3D, model: THREE.Object3D | undefined): THREE.Object3D {
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
