// A critter part's collision capsule (world/partHull.ts): fitted to the mesh's box, followed through
// its world matrix.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PartHull, partHulls } from '../src/world/partHull.js';

describe('PartHull', () => {
  it('runs its core along the longest side and reaches the box ends', () => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 2));
    const h = new PartHull(mesh);
    h.update();
    // Core half length = 2 - 0.5 (the thinnest half side), along x.
    expect(h.p0.x).toBeCloseTo(-1.5); expect(h.p1.x).toBeCloseTo(1.5);
    expect(h.p0.y).toBeCloseTo(0); expect(h.p0.z).toBeCloseTo(0);
    // Across the core: the half sides up (0.5) and out (1).
    expect(h.radiusToward(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0.5);
    expect(h.radiusToward(new THREE.Vector3(0, 0, 1))).toBeCloseTo(1);
    expect(h.radiusToward(new THREE.Vector3(1, 0, 0))).toBeCloseTo(0.5);
  });

  it('follows the mesh as its parent moves, turns and scales', () => {
    const group = new THREE.Group(), mesh = new THREE.Mesh(new THREE.BoxGeometry(4, 1, 2));
    mesh.name = 'body';
    group.add(mesh);
    group.position.set(10, 2, 0);
    group.rotation.y = Math.PI / 2;   // local +x -> world -z
    group.scale.setScalar(2);
    const [h] = partHulls(group, ['body']);
    expect(h).toBeDefined();
    h?.update();
    expect(h?.centre.toArray().map((v) => +v.toFixed(6))).toEqual([10, 2, 0]);
    expect(Math.abs((h?.p1.z ?? 0) - (h?.p0.z ?? 0))).toBeCloseTo(6);   // 2 * (4 - 1)
    expect(h?.radiusToward(new THREE.Vector3(1, 0, 0))).toBeCloseTo(2);
  });
});
