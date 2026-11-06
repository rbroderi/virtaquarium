// Type guards for scene-graph traversal (Object3D.traverse hands out plain Object3D).
import * as THREE from 'three';

export const isMesh = (o: THREE.Object3D): o is THREE.Mesh => o instanceof THREE.Mesh;
export const isInstancedMesh = (o: THREE.Object3D): o is THREE.InstancedMesh => o instanceof THREE.InstancedMesh;
export const isPoints = (o: THREE.Object3D): o is THREE.Points => o instanceof THREE.Points;
export const isLine = (o: THREE.Object3D): o is THREE.Line => o instanceof THREE.Line;

/** Every material of a mesh, points or line (they can hold one or an array). */
export function materialsOf(o: THREE.Mesh | THREE.Points | THREE.Line): THREE.Material[] {
  const m: THREE.Material | THREE.Material[] = o.material;
  return Array.isArray(m) ? m : [m];
}
