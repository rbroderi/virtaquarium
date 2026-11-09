// Clearance for the crystal sign. The sign is glass: whatever sits inside it, or between it and the
// viewer, shows as a solid lump in the glass instead of the reef refracted behind it. The builder places
// the sign after the rock and corals, so it tests candidate spots against their surface points and takes
// the nearest spot where nothing pokes into the sign or stands in front of it; later plantings (grass,
// algae) then keep out of the sign's footprint and the strip of sand in front of it.
import * as THREE from 'three';
import { isMesh } from './flags.js';

/** Every Nth vertex of a mesh is tested (the scanned models are dense; a few cm between samples). */
const VERTEX_STRIDE = 3;
/** Points this close to the sand (world units) never count as occluders (sand ripples, flat shells). */
const OCCLUDER_MIN_Y = 0.1;

/** World-space sample points of the meshes under `roots` that fall inside `region`. */
export function surfacePoints(roots: readonly THREE.Object3D[], region: THREE.Box3, skip: (o: THREE.Object3D) => boolean): Float32Array {
  const out: number[] = [];
  const v = new THREE.Vector3(), m = new THREE.Matrix4(), sphere = new THREE.Sphere();
  const take = (pos: THREE.BufferAttribute | THREE.InterleavedBufferAttribute, matrix: THREE.Matrix4, bound: THREE.Sphere | null): void => {
    if (bound && !region.intersectsSphere(sphere.copy(bound).applyMatrix4(matrix))) return;
    for (let i = 0; i < pos.count; i += VERTEX_STRIDE) {
      v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      if (region.containsPoint(v)) out.push(v.x, v.y, v.z);
    }
  };
  for (const root of roots) {
    root.updateWorldMatrix(true, true);
    root.traverse((o) => {
      if (!isMesh(o) || skip(o)) return;
      const pos = o.geometry.getAttribute('position');
      if (!pos) return;
      if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere();
      const bound = o.geometry.boundingSphere;
      if (o instanceof THREE.InstancedMesh) {
        for (let n = 0; n < o.count; n++) {
          o.getMatrixAt(n, m);
          take(pos, m.premultiply(o.matrixWorld), bound);
        }
      } else {
        take(pos, o.matrixWorld, bound);
      }
    });
  }
  return new Float32Array(out);
}

/** The tight world box of an object's vertices (every VERTEX_STRIDE-th one). */
export function vertexBox(obj: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3(), v = new THREE.Vector3();
  obj.updateWorldMatrix(true, true);
  obj.traverse((o) => {
    if (!isMesh(o)) return;
    const pos = o.geometry.getAttribute('position');
    if (!pos) return;
    for (let i = 0; i < pos.count; i += VERTEX_STRIDE) box.expandByPoint(v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld));
  });
  return box;
}

/**
 * True when no point lies inside the sign's box (grown by `clearance`) or in front of it as seen from
 * `view`: a point occludes the sign when the sight line from the view through it goes on to hit the box.
 */
export function signClear(points: Float32Array, box: THREE.Box3, view: THREE.Vector3, clearance: number): boolean {
  const grown = box.clone().expandByScalar(clearance);
  const p = new THREE.Vector3(), hit = new THREE.Vector3();
  const ray = new THREE.Ray(view.clone(), new THREE.Vector3());
  const minY = box.min.y + OCCLUDER_MIN_Y;
  for (let i = 0; i < points.length; i += 3) {
    p.set(points[i] as number, points[i + 1] as number, points[i + 2] as number);
    if (grown.containsPoint(p)) return false;
    if (p.y < minY) continue;
    ray.direction.subVectors(p, view).normalize();
    if (ray.intersectBox(box, hit) && view.distanceToSquared(p) < view.distanceToSquared(hit)) return false;
  }
  return true;
}

/** The sand the sign keeps clear of later plantings: its footprint and a strip in front of it (x/z). */
export interface SignKeepOut {
  readonly x0: number;
  readonly x1: number;
  readonly z0: number;
  readonly z1: number;
}

/** The keep-out footprint for a placed sign box: grown by `margin`, and by `front` toward the viewer (+z). */
export function signKeepOut(box: THREE.Box3, margin: number, front: number): SignKeepOut {
  return { x0: box.min.x - margin, x1: box.max.x + margin, z0: box.min.z - margin, z1: box.max.z + front };
}

/** True when a circle of radius r at (x, z) reaches into the keep-out footprint. */
export function inKeepOut(k: SignKeepOut, x: number, z: number, r: number): boolean {
  const dx = Math.max(k.x0 - x, 0, x - k.x1), dz = Math.max(k.z0 - z, 0, z - k.z1);
  return dx * dx + dz * dz <= r * r;
}
