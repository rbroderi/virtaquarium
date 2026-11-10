// The rock as drawn, for the motion check: every mesh the rock field rasterised (rockField.ts meshes),
// baked into one world-space geometry under a bounding volume hierarchy (three-mesh-bvh), with an exact
// signed distance. It measures how far the field strays from the real surface, and whether a fish is
// in the rock the viewer sees rather than in the field's idea of it.
//
// Distance is the exact distance to the nearest triangle. Its sign comes from casting rays upward and
// sideways (never down: rocks are open where they sit on the sand): the point is inside when most first
// hits are back faces. Overlapping rocks bury some surfaces inside others, so depths inside can read
// short (the buried surface is nearer), but outside distances and the sign are exact.
import * as THREE from 'three';
import { MeshBVH, type HitPointInfo } from 'three-mesh-bvh';
import { isInstancedMesh } from '../reef/flags.js';
import { baseIndexCount } from '../lod.js';

const SIGN_RAYS = [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0.62, 0.5, 0.6).normalize(), new THREE.Vector3(-0.7, 0.4, -0.59).normalize()] as const;

export class RockMesh {
  readonly triangles: number;
  readonly buildMs: number;
  private readonly bvh: MeshBVH;
  private readonly hit: HitPointInfo = { point: new THREE.Vector3(), distance: 0, faceIndex: 0 };
  private readonly ray = new THREE.Ray();

  constructor(meshes: readonly THREE.Mesh[]) {
    const t0 = performance.now();
    const out: number[] = [];
    const v = new THREE.Vector3(), m = new THREE.Matrix4();
    for (const o of meshes) {
      o.updateWorldMatrix(true, false);
      const g = o.geometry, pos = g.attributes['position'], idx = g.index;
      if (!pos) continue;
      const n = isInstancedMesh(o) ? o.count : 1;
      const corners = baseIndexCount(g);
      for (let inst = 0; inst < n; inst++) {
        if (isInstancedMesh(o)) { o.getMatrixAt(inst, m); m.premultiply(o.matrixWorld); } else m.copy(o.matrixWorld);
        // A mirroring transform flips the winding, and the sign test reads the winding.
        const flip = m.determinant() < 0;
        for (let c = 0; c < corners; c += 3) for (let k = 0; k < 3; k++) {
          const cc = c + (flip ? 2 - k : k);
          v.fromBufferAttribute(pos, idx ? idx.getX(cc) : cc).applyMatrix4(m);
          out.push(v.x, v.y, v.z);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
    this.triangles = out.length / 9;
    this.bvh = new MeshBVH(geo);
    this.buildMs = Math.round(performance.now() - t0);
  }

  /** True when p is inside the drawn rock (most sign rays first hit a back face). */
  inside(p: THREE.Vector3): boolean {
    let votes = 0;
    for (const d of SIGN_RAYS) {
      this.ray.set(p, d);
      const h = this.bvh.raycastFirst(this.ray, THREE.DoubleSide);
      if (h?.face && h.face.normal.dot(d) > 0) votes++;
    }
    return votes >= 2;
  }

  /** Signed distance to the drawn rock (negative inside), capped at +-max. */
  dist(p: THREE.Vector3, max: number): number {
    const h = this.bvh.closestPointToPoint(p, this.hit, 0, max);
    const d = h ? h.distance : max;
    return this.inside(p) ? -d : d;
  }
}
