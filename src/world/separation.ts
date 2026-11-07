// Fish bodies don't pass through each other. The brain's personal space (brain/reflexes.ts) only steers,
// by centre distance, and a fish set on food, a chase or its shoal can steer straight on through
// another. So after every fish has moved, overlapping bodies are pushed apart: each body is its axis
// with an elliptical, tapering section (fish/bodyShape.ts), and a pair that interpenetrates is
// separated along the line between the closest points of their axes, the lighter fish moving more,
// and their closing speed along that line is taken out. The moray is an obstacle the others are
// pushed off (its chain carries its body; moving it here would fight the chain). A cleaner and the
// client posing for it touch on purpose.
import * as THREE from 'three';
import type { Fish } from '../fish.js';
import type { SwimWorld } from './ports.js';

type RockQuery = Pick<SwimWorld, 'rockDist' | 'rockNormal'>;
import { STEP_SLACK } from './stepLimit.js';
import { bodyDims, closestSegmentParams, radiusToward, type BodyDims } from '../fish/bodyShape.js';

/** Passes over all pairs (a push can make a new overlap with a third fish). */
const PASSES = 2;
/** A pair is pushed out to this share of its overlap per pass (the rest next pass, or next frame). */
const RELAX = 0.8;
/**
 * The most a pair is pushed apart in one step: the speed they were closing at (with the step limit's
 * slack) plus a slow crawl, in body lengths per second, so a deep overlap eases out over a few frames
 * instead of snapping (world/stepLimit.ts).
 */
const CRAWL_BL = 0.5;
/** The eel's radius against other fish: its half-depth, a little under (it is flattened behind). */
const EEL_RADIUS_SHARE = 0.9;

const _a0 = new THREE.Vector3(), _a1 = new THREE.Vector3(), _b0 = new THREE.Vector3(), _b1 = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Vector3();
const _st: [number, number] = [0, 0];

function touchingOnPurpose(a: Fish, b: Fish): boolean {
  const c = (x: Fish, y: Fish): boolean => (x.brain.mode === 'clean' && x.brain.focus === y) || (y.brain.posing && !!x.sp.brain.cleaner);
  return c(a, b) || c(b, a);
}

export class BodySeparation {
  /** Pairs pushed apart in the last step (diagnostic). */
  contacts = 0;
  private readonly dims = new Map<Fish, BodyDims>();
  private rock: RockQuery | null = null;

  private dimsOf(f: Fish): BodyDims {
    let d = this.dims.get(f);
    if (!d) { d = bodyDims(f); this.dims.set(f, d); }
    return d;
  }

  /** Push overlapping fish apart (world.ts then places the models: Fish.present). */
  step(fish: readonly Fish[], dt: number, rock: RockQuery): void {
    this.rock = rock;
    this.contacts = 0;
    const moved = new Set<Fish>();
    for (let pass = 0; pass < PASSES; pass++) {
      for (let i = 0; i < fish.length; i++) for (let j = i + 1; j < fish.length; j++) {
        const a = fish[i], b = fish[j];
        if (!a || !b || (a.spine && b.spine)) continue;
        if (this.resolve(a, b, moved, dt)) this.contacts++;
      }
    }
  }

  private reach(f: Fish, d: BodyDims): number {
    return f.spine ? f.size : Math.max(d.nose, -d.fin) + d.halfDepth;
  }

  /** One pair: true when it overlapped. The eel, if one of them, stays put. */
  private resolve(a: Fish, b: Fish, moved: Set<Fish>, dt: number): boolean {
    const da = this.dimsOf(a), db = this.dimsOf(b);
    if (a.pos.distanceToSquared(b.pos) > (this.reach(a, da) + this.reach(b, db)) ** 2) return false;
    if (touchingOnPurpose(a, b)) return false;
    const eel = a.spine ? a : b.spine ? b : null;
    const fishA = eel === a ? b : a, fishB = eel ? null : b;
    const dA = this.dimsOf(fishA);
    _a0.copy(fishA.pos).addScaledVector(fishA.dir, dA.nose);
    _a1.copy(fishA.pos).addScaledVector(fishA.dir, dA.fin);
    // The deepest contact between fishA's axis and the other body (the eel's chain: each link).
    let best = 0;
    const consider = (b0: THREE.Vector3, b1: THREE.Vector3, rOf: (t: number, n: THREE.Vector3) => number): void => {
      closestSegmentParams(_a0, _a1, b0, b1, _st);
      _p.lerpVectors(_a0, _a1, _st[0]); _q.lerpVectors(b0, b1, _st[1]);
      const dist = _p.distanceTo(_q);
      const n = dist > 1e-6 ? _q.sub(_p).multiplyScalar(1 / dist) : _q.copy(fishA.dir).cross(THREE.Object3D.DEFAULT_UP).normalize();
      const s = dA.nose + (dA.fin - dA.nose) * _st[0];
      const rA = radiusToward(fishA, dA, s, n);
      const rB = rOf(_st[1], n.negate());
      n.negate();
      const pen = rA + rB - dist;
      if (pen > best) { best = pen; _n.copy(n); }
    };
    if (fishB) {
      const dB = this.dimsOf(fishB);
      _b0.copy(fishB.pos).addScaledVector(fishB.dir, dB.nose);
      _b1.copy(fishB.pos).addScaledVector(fishB.dir, dB.fin);
      consider(_b0, _b1, (t, n) => radiusToward(fishB, dB, dB.nose + (dB.fin - dB.nose) * t, n));
    } else if (eel?.spine) {
      const nodes = eel.spine.nodes, r = this.dimsOf(eel).halfDepth * EEL_RADIUS_SHARE;
      for (let k = 0; k + 1 < nodes.length; k++) {
        const p0 = nodes[k], p1 = nodes[k + 1];
        if (p0 && p1) consider(_b0.copy(p0), _b1.copy(p1), () => r);
      }
    }
    if (best <= 0) return false;
    // _n points from fishA towards the other body. The lighter fish takes the larger share.
    const mA = fishA.mass, mB = fishB ? fishB.mass : Infinity;
    const shareA = fishB ? mB / (mA + mB) : 1;
    // Inelastic: no closing speed along the contact normal.
    const vA = fishA.vel.dot(_n), vB = fishB ? fishB.vel.dot(_n) : 0;
    const closing = vA - vB;
    const L = fishB ? Math.min(fishA.size, fishB.size) : fishA.size;
    const push = Math.min(best * RELAX, (CRAWL_BL * L + STEP_SLACK * Math.max(0, closing)) * dt);
    this.shift(fishA, _n, -push * shareA);
    if (fishB) this.shift(fishB, _n, push * (1 - shareA));
    if (closing > 0) {
      fishA.vel.addScaledVector(_n, -closing * shareA);
      fishB?.vel.addScaledVector(_n, closing * (1 - shareA));
    }
    moved.add(fishA);
    if (fishB) moved.add(fishB);
    return true;
  }

  /**
   * Move f by n * by, but not into the rock: near it, the part of the move into the rock is dropped
   * and the fish slides along the surface. (Fish packed into a shelter otherwise shoved each other into
   * it, the rock pushed them back, and they shuddered between the two.)
   */
  private shift(f: Fish, n: THREE.Vector3, by: number): void {
    _m.copy(n).multiplyScalar(by);
    const rock = this.rock;
    if (rock) {
      const clear = this.dimsOf(f).halfDepth;
      _p.copy(f.pos).add(_m);
      if (rock.rockDist(_p) < clear) {
        rock.rockNormal(f.pos, _q);
        const into = _m.dot(_q);
        if (into < 0) _m.addScaledVector(_q, -into);
      }
    }
    f.pos.add(_m);
  }
}
