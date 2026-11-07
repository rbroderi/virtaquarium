// The collision body (fish/bodyShape.ts): closest points between axes, and the section's radius.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { bodyDims, closestSegmentParams, radiusToward } from '../src/fish/bodyShape.js';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

describe('closestSegmentParams', () => {
  it('crossing segments meet in their middles', () => {
    const st: [number, number] = [0, 0];
    closestSegmentParams(V(-1, 0, 0), V(1, 0, 0), V(0, 1, -1), V(0, 1, 1), st);
    expect(st[0]).toBeCloseTo(0.5);
    expect(st[1]).toBeCloseTo(0.5);
  });

  it('parallel offset segments clamp to their overlap', () => {
    const st: [number, number] = [0, 0];
    closestSegmentParams(V(0, 0, 0), V(1, 0, 0), V(2, 1, 0), V(3, 1, 0), st);
    expect(st[0]).toBeCloseTo(1);
    expect(st[1]).toBeCloseTo(0);
  });
});

describe('radiusToward', () => {
  const fish = { pos: V(0, 0, 0), dir: V(1, 0, 0), size: 1, sp: { body: { len: 0.8, depth: 0.5, width: 0.4 } } };
  const d = bodyDims(fish);

  it('is the half-depth up and the half-width across, at the middle of the axis', () => {
    const mid = (d.nose + d.tail) / 2;
    expect(radiusToward(fish, d, mid, V(0, 1, 0))).toBeCloseTo(d.halfDepth);
    expect(radiusToward(fish, d, mid, V(0, 0, 1))).toBeCloseTo(d.halfWidth);
    expect(d.halfWidth).toBeLessThan(d.halfDepth);
  });

  it('tapers towards the snout', () => {
    const mid = (d.nose + d.tail) / 2;
    expect(radiusToward(fish, d, d.nose, V(0, 1, 0))).toBeLessThan(0.5 * radiusToward(fish, d, mid, V(0, 1, 0)));
  });
});
