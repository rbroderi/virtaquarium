// The blended (distance-field) bodies, meshed offline by tools/softbodies.ts into
// models/critters/*.glb (shapes: softBodies.ts), loaded once here before any critter is made (a
// top-level await: main waits for it). A missing file is meshed in the page instead (slow, a second
// or so each), with a warning.
import * as THREE from 'three';
import { errorMessage, isRecord } from '../util.js';
import type { SoftBodyName } from '../softBodies.js';

type TypedArray = Float32Array | Uint16Array | Uint32Array;
interface ReadAttribute { readonly array: TypedArray; readonly size: number }
interface ReadMesh { readonly attributes: Readonly<Record<string, ReadAttribute>>; readonly index: TypedArray }

const GL_FLOAT = 5126, GL_UNSIGNED_SHORT = 5123;
const GLB_JSON_LENGTH_OFFSET = 12, GLB_JSON_START = 20, CHUNK_HEADER_BYTES = 8;
const COMPONENTS: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
const SOFT_BODY_NAMES: readonly SoftBodyName[] = ['octopus-body', 'cuttlefish-body'];

class GlbFormatError extends Error {}

function field(obj: unknown, key: string): unknown {
  if (!isRecord(obj)) throw new GlbFormatError(`expected an object with "${key}"`);
  return obj[key];
}
function num(value: unknown): number {
  if (typeof value !== 'number') throw new GlbFormatError('expected a number');
  return value;
}
function item(list: unknown, i: number): unknown {
  if (!Array.isArray(list)) throw new GlbFormatError('expected a list');
  return list[i];
}

/** One indexed mesh of float attributes, as sdfMesh.ts writeGLB writes it. */
export function readGLB(buf: ArrayBuffer): ReadMesh {
  const dv = new DataView(buf), jl = dv.getUint32(GLB_JSON_LENGTH_OFFSET, true);
  const json: unknown = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, GLB_JSON_START, jl)));
  const bin = GLB_JSON_START + jl + CHUNK_HEADER_BYTES;
  const get = (a: number): ReadAttribute => {
    const acc = item(field(json, 'accessors'), a), view = item(field(json, 'bufferViews'), num(field(acc, 'bufferView')));
    const size = COMPONENTS[String(field(acc, 'type'))] ?? 1, type = num(field(acc, 'componentType'));
    const start = bin + num(field(view, 'byteOffset')), bytes = buf.slice(start, start + num(field(view, 'byteLength')));
    const array = type === GL_FLOAT ? new Float32Array(bytes) : type === GL_UNSIGNED_SHORT ? new Uint16Array(bytes) : new Uint32Array(bytes);
    return { array, size };
  };
  const prim = item(field(item(field(json, 'meshes'), 0), 'primitives'), 0), attributes: Record<string, ReadAttribute> = {};
  const attrs = field(prim, 'attributes');
  if (!isRecord(attrs)) throw new GlbFormatError('primitive has no attributes');
  for (const [name, a] of Object.entries(attrs)) attributes[name] = get(num(a));
  return { attributes, index: get(num(field(prim, 'indices'))).array };
}

function requireAttribute(mesh: ReadMesh, name: string): ReadAttribute {
  const a = mesh.attributes[name];
  if (!a) throw new GlbFormatError(`soft body mesh lacks ${name}`);
  return a;
}

function toGeometry(m: ReadMesh): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry(), uv = m.attributes['TEXCOORD_0'];
  g.setAttribute('position', new THREE.BufferAttribute(requireAttribute(m, 'POSITION').array, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(requireAttribute(m, 'NORMAL').array, 3));
  if (uv) g.setAttribute('uv', new THREE.BufferAttribute(uv.array, 2));
  g.setAttribute('aWeight', new THREE.BufferAttribute(requireAttribute(m, '_WEIGHT').array, 1));
  g.setIndex(new THREE.BufferAttribute(m.index, 1));
  g.computeBoundingSphere();
  return g;
}

async function fetchMesh(name: SoftBodyName): Promise<ReadMesh> {
  try {
    const r = await fetch(new URL(`../models/critters/${name}.glb`, import.meta.url));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return readGLB(await r.arrayBuffer());
  } catch (e) {
    console.warn(`critters: models/critters/${name}.glb not loaded (${errorMessage(e)}); meshing it here instead (npm run softbodies writes it)`);
    return (await import('../softBodies.js')).SOFT_BODIES[name]();
  }
}

const geometries = new Map<SoftBodyName, THREE.BufferGeometry>();

async function loadSoftBodies(): Promise<void> {
  const t0 = performance.now();
  await Promise.all(SOFT_BODY_NAMES.map(async (name) => { geometries.set(name, toGeometry(await fetchMesh(name))); }));
  const summary = [...geometries].map(([k, g]) => `${k} ${(g.index?.count ?? 0) / 3} tris`).join(', ');
  console.info(`Soft bodies: ${summary}, ${(performance.now() - t0).toFixed(0)} ms`);
}

await loadSoftBodies();

/** The loaded geometry of a soft body (shared by every animal of its kind). */
export function softBodyGeometry(name: SoftBodyName): THREE.BufferGeometry {
  const g = geometries.get(name);
  if (!g) throw new Error(`soft body ${name} not loaded`);
  return g;
}
