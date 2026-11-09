import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { planApart } from '../src/world/escapePlan.js';

const V = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z);

describe('planApart', () => {
  it('sends two head-on swimmers to opposite sides, clear of each other afterwards', () => {
    const a = { p: V(0, 1, 0), v: V(1, 0, 0), r: 0.2, share: 0.5 };
    const b = { p: V(0.35, 1, 0), v: V(-1, 0, 0), r: 0.2, share: 0.5 };
    const dA = new THREE.Vector3(), dB = new THREE.Vector3();
    planApart(a, b, V(1, 0, 0), [], null, dA, dB);
    expect(dA.length()).toBeCloseTo(1);
    expect(dB.length()).toBeCloseTo(1);
    // Each turns off the line between them, to opposite sides.
    const side = V(0, 0, 1);
    expect(Math.sign(dA.dot(side)) * Math.sign(dB.dot(side)) + Math.sign(dA.y) * Math.sign(dB.y)).toBeLessThan(0);
  });

  it('leaves one in its den where it is, and steers the other past the rock', () => {
    const a = { p: V(0, 1, 0), v: V(0.5, 0, 0), r: 0.2, share: 1 };
    const den = { p: V(0.35, 1, 0), v: V(0, 0, 0), r: 0.3, share: 0 };
    const dA = new THREE.Vector3(), dB = new THREE.Vector3();
    // Rock below y = 0.9, and a wall behind a (x < -0.2).
    const rock = (p: THREE.Vector3): number => Math.min(p.y - 0.9, p.x + 0.2);
    planApart(a, den, V(1, 0, 0), [], rock, dA, dB);
    expect(dB.lengthSq()).toBe(0);
    expect(dA.length()).toBeCloseTo(1);
    expect(dA.y).toBeGreaterThanOrEqual(0);   // not down into the rock
  });

  it('measures a long body along its chain of spheres, not from its head', () => {
    // An eel lying along x, head at the origin; a fish touching it halfway down, swimming along it.
    const parts = [0, 0.3, 0.6, 0.9, 1.2, 1.5].map((x) => ({ p: V(x, 1, 0), r: 0.1 }));
    const eel = { p: V(0, 1, 0), v: V(0, 0, 0), r: 0.1, share: 0, parts };
    const fish = { p: V(0.9, 1, 0.18), v: V(0.6, 0, 0), r: 0.1, share: 1 };
    const dE = new THREE.Vector3(), dF = new THREE.Vector3();
    planApart(eel, fish, V(0, 0, 1), [], null, dE, dF);
    expect(dE.lengthSq()).toBe(0);
    // From halfway along its path (0.6 here; it starts touching) and for 3 s after, back on its course,
    // it stays clear of every sphere.
    const at = new THREE.Vector3();
    for (let s = 0.5; s <= 1; s += 0.1) {
      at.copy(fish.p).addScaledVector(dF, 0.6 * s);
      for (const q of parts) expect(at.distanceTo(q.p)).toBeGreaterThan(0.2);
    }
    for (let t = 0; t <= 3; t += 0.1) {
      at.copy(fish.p).addScaledVector(dF, 0.6).addScaledVector(fish.v, t);
      for (const q of parts) expect(at.distanceTo(q.p)).toBeGreaterThan(0.2);
    }
  });
});
