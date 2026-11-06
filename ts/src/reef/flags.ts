// Typed access to the per-object flags the reef keeps in three.js userData (an untyped bag).
//   noHeight  kept out of the height field (fish swim through or under it)
//   solid     in the rock field even though out of the height field (an overhang)
//   natural   a generated model's own proportions before it was fitted to a unit box
import * as THREE from 'three';

const UNIT_SIZE = new THREE.Vector3(1, 1, 1);

const flag = (o: THREE.Object3D, key: string): boolean => o.userData[key] === true;

/** Type guards with three's default type arguments (a bare instanceof would give Mesh<any, any>). */
export const isMesh = (o: THREE.Object3D): o is THREE.Mesh => o instanceof THREE.Mesh;
export const isInstancedMesh = (o: THREE.Object3D): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh;

export const isNoHeight = (o: THREE.Object3D): boolean => flag(o, 'noHeight');
export const isSolid = (o: THREE.Object3D): boolean => flag(o, 'solid');

export function markNoHeight(o: THREE.Object3D): void {
  o.userData['noHeight'] = true;
}

export function markSolid(o: THREE.Object3D): void {
  o.userData['solid'] = true;
}

/** True when the object or any ancestor is out of the height field. */
export function inNoHeightSubtree(o: THREE.Object3D): boolean {
  for (let p: THREE.Object3D | null = o; p; p = p.parent) if (isNoHeight(p)) return true;
  return false;
}

export function setNaturalSize(o: THREE.Object3D, size: THREE.Vector3): void {
  o.userData['natural'] = size;
}

const isXyz = (v: unknown): v is { x: number; y: number; z: number } =>
  typeof v === 'object' && v !== null && 'x' in v && 'y' in v && 'z' in v &&
  typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number';

/**
 * A generated model's own proportions, or a unit cube for one without them. (A clone's userData is a
 * JSON copy, so there the Vector3 has become a plain { x, y, z }.)
 */
export function naturalSize(o: THREE.Object3D): THREE.Vector3 {
  const n: unknown = o.userData['natural'];
  if (n instanceof THREE.Vector3) return n;
  return isXyz(n) ? new THREE.Vector3(n.x, n.y, n.z) : UNIT_SIZE;
}

/** True when a loaded material carries a parallax height in its normal map's alpha (tools/heightmaps). */
export function hasPomHeight(m: THREE.Material): boolean {
  const h: unknown = m.userData['pomHeight'];
  return Boolean(h);
}
