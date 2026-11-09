// Fish bodies don't pass through each other. The brain's personal space (brain/reflexes.ts) only steers,
// by centre distance, and a fish set on food, a chase or its shoal can steer straight on through
// another. So after every fish has moved, overlapping bodies are pushed apart: each body is its axis
// with an elliptical, tapering section (fish/bodyShape.ts), and a pair that interpenetrates is
// separated along the line between the closest points of their axes, the lighter fish moving more,
// and their closing speed along that line is taken out. The moray is an obstacle the others are
// pushed off (its chain carries its body; moving it here would fight the chain). A cleaner and the
// client posing for it touch on purpose.
//
// The critters (turtle, cuttlefish, octopus) are bodies too: each part, flippers, fins and arms included,
// is a capsule (partHull.ts). A fish and a critter that overlap are pushed apart by their masses (the
// turtle barely gives to a chromis; a cuttlefish gives a big fish a good share), and a fish pinned
// against the rock leaves the rest to the critter. After the critters move (stepCritters), a critter is
// pushed off the eel, which stays put, and two critters push each other apart by their masses. An octopus's arms don't shove it: they bend round the eel and the other
// critters instead (it is handed them as spheres for its next step: Critter.keepLimbsOff). The jellies
// are solids the same way (bell and oral arms), against each other in their own tank.
//
// Pushing alone fights the steering: a fish pushed out swims straight back in. So every contact, and
// every near miss within a margin, also posts both creatures a message (world/contactInbox.ts): who
// the other is and which way is away from it. Their steering heeds it next step (the avoidance reflex),
// so most contacts are steered out of before the push is needed. A creature in its den (the octopus
// in its den, the eel lurking in its crevice, a fish in its shelter) has right of way: the other heeds
// it fully and takes the whole push, and it is neither told to move nor moved.
import * as THREE from 'three';
import type { Fish } from '../fish.js';
import { CritterBody, type BodyPiece, type Solid } from './partHull.js';
import type { SwimWorld } from './ports.js';
import { heedOf, type ContactInbox } from './contactInbox.js';

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
/** The most a critter is pushed in one step (units per second): it eases off rather than snapping. */
const CRITTER_PUSH_SPEED = 1.5;
/** A fish starts steering off another body this far before touching it (its body lengths). */
const CONTACT_MARGIN = 0.4;
/** Two solids (or a solid and the eel) start steering apart this far before touching (a share of the
 *  smaller one's bounding radius). */
const SOLID_MARGIN = 0.25;
/** A smaller creature looks out for a bigger one further off: its margin grows by up to this many
 *  times (a chromis by a turtle, nearly all of it; two of a size, none). */
const WARY = 2;
/** The widest margin, any pair: what the near-miss search looks within. */
const LOOKOUT = 1 + WARY;
/** The most spheres a critter's bending limbs are asked to keep clear of (the nearest). */
const LIMB_SPHERES = 24;

const _a0 = new THREE.Vector3(), _a1 = new THREE.Vector3(), _b0 = new THREE.Vector3(), _b1 = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Vector3(), _n = new THREE.Vector3(), _m = new THREE.Vector3();
const _st: [number, number] = [0, 0];
const _move = new THREE.Vector3(), _bn = new THREE.Vector3(), _away = new THREE.Vector3();

/** One side of a contact, for the share of the push and of the heed. */
interface Party { readonly inbox?: ContactInbox; readonly inDen?: boolean; readonly mass: number }

/** a's share of pushing a and b apart: the lighter moves more, and one in its den not at all. */
function shareOf(a: Party, b: Party): number {
  if (b.inDen && !a.inDen) return 1;
  if (a.inDen && !b.inDen) return 0;
  return b.mass / (a.mass + b.mass);
}

/** How much a heeds b's message: by mass, fully if b is in its den, and not at all if a is. */
function heedOfParty(a: Party, b: Party): number {
  if (b.inDen && !a.inDen) return 1;
  if (a.inDen && !b.inDen) return 0;
  return heedOf(a.mass, b.mass);
}

/** How much wider than the base margin a looks out for b: up to LOOKOUT for one much bigger. */
function lookoutOf(a: Party, b: Party): number {
  return 1 + WARY * Math.max(0, (b.mass - a.mass) / (a.mass + b.mass));
}

function touchingOnPurpose(a: Fish, b: Fish): boolean {
  const c = (x: Fish, y: Fish): boolean => (x.brain.mode === 'clean' && x.brain.focus === y) || (y.brain.posing && !!x.sp.brain.cleaner);
  return c(a, b) || c(b, a);
}

export class BodySeparation {
  /** Pairs pushed apart in the last step (diagnostic). */
  contacts = 0;
  /** Critter-on-eel and critter-on-critter pushes in the last step (diagnostic). */
  critterContacts = 0;
  private readonly dims = new Map<Fish, BodyDims>();
  private readonly bodies = new Map<Solid, CritterBody>();
  /** What the fish push each critter by in a pass, applied at the pass's end (capped). */
  private readonly gives = new Map<Solid, THREE.Vector3>();
  /** Each critter's velocity over its last step, and where it was (a fish it swims into must get out of its way). */
  private readonly critterVel = new Map<Solid, { last: THREE.Vector3; vel: THREE.Vector3 }>();
  private rock: RockQuery | null = null;
  /** Messages are posted in the first pass only (the later passes see the same contacts, nudged). */
  private posting = true;

  private dimsOf(f: Fish): BodyDims {
    let d = this.dims.get(f);
    if (!d) { d = bodyDims(f); this.dims.set(f, d); }
    return d;
  }

  private bodyOf(c: Solid): CritterBody {
    let b = this.bodies.get(c);
    if (!b) { b = new CritterBody(c); this.bodies.set(c, b); }
    return b;
  }

  /** Push overlapping fish apart, and off the critters where they stand (world.ts then places the
   *  models: Fish.present). */
  step(fish: readonly Fish[], dt: number, rock: RockQuery, critters: readonly Solid[] = []): void {
    this.rock = rock;
    this.contacts = 0;
    const moved = new Set<Fish>();
    const bodies = critters.map((c) => ({ c, b: this.bodyOf(c), vel: this.critterVel.get(c)?.vel ?? null }));
    for (const { b } of bodies) b.update();
    for (const f of fish) f.inbox.fade(dt);
    for (let pass = 0; pass < PASSES; pass++) {
      this.posting = pass === 0;
      for (let i = 0; i < fish.length; i++) for (let j = i + 1; j < fish.length; j++) {
        const a = fish[i], b = fish[j];
        if (!a || !b || (a.spine && b.spine)) continue;
        if (this.resolve(a, b, moved, dt)) this.contacts++;
      }
      for (const f of fish) {
        if (f.spine) continue;
        const r = this.reach(f, this.dimsOf(f));
        for (const { c, b, vel } of bodies) {
          if (f.pos.distanceToSquared(b.centre) > (r + b.radius + CONTACT_MARGIN * LOOKOUT * f.size) ** 2) continue;
          for (const h of b.pieces) if (this.offHull(f, c, h, vel, dt)) this.contacts++;
        }
      }
      // Each critter gives way once, by what all the fish on it pushed (those on either side cancel).
      for (const { c, b } of bodies) {
        const g = this.gives.get(c);
        if (!g || g.lengthSq() === 0) continue;
        g.clampLength(0, CRITTER_PUSH_SPEED * dt);
        this.shiftCritter(c, g, 1);
        g.set(0, 0, 0);
        b.update();
      }
    }
  }

  /**
   * A fish and a critter's part pushed apart, each moving by the other's share of their masses. What the
   * rock keeps the fish from moving (pinned between it and the critter), the critter moves instead.
   */
  private offHull(f: Fish, c: Solid, h: BodyPiece, critterVel: THREE.Vector3 | null, dt: number): boolean {
    const d = this.dimsOf(f), margin = CONTACT_MARGIN * f.size, wide = margin * LOOKOUT;
    if (f.pos.distanceToSquared(h.centre) > (this.reach(f, d) + h.reach + wide) ** 2) return false;
    _a0.copy(f.pos).addScaledVector(f.dir, d.nose);
    _a1.copy(f.pos).addScaledVector(f.dir, d.fin);
    closestSegmentParams(_a0, _a1, h.p0, h.p1, _st);
    _p.lerpVectors(_a0, _a1, _st[0]); _q.lerpVectors(h.p0, h.p1, _st[1]);
    const dist = _p.distanceTo(_q);
    if (dist < 1e-6) return false;
    _n.subVectors(_q, _p).multiplyScalar(1 / dist);   // fish -> critter
    const rA = radiusToward(f, d, d.nose + (d.fin - d.nose) * _st[0], _n);
    const rB = h.radiusToward(_n);
    const pen = rA + rB - dist;
    if (pen <= -wide) return false;
    if (this.posting) this.tellBoth(f, c, _n, pen, margin);
    if (pen <= 0) return false;
    const closing = Math.max(0, f.vel.dot(_n) - (critterVel ? critterVel.dot(_n) : 0));
    const push = Math.min(pen * RELAX, (CRAWL_BL * f.size + STEP_SLACK * closing) * dt);
    const shareF = shareOf(f, c);
    _bn.copy(_n);
    const moved = this.shift(f, _bn, -push * shareF);
    if (closing > 0) f.vel.addScaledVector(_bn, -Math.min(closing, Math.max(0, f.vel.dot(_bn))));
    const give = push - Math.max(0, moved);
    if (give > 0 && !c.inDen) {
      let g = this.gives.get(c);
      if (!g) { g = new THREE.Vector3(); this.gives.set(c, g); }
      g.addScaledVector(_bn, give);
    }
    return true;
  }

  /**
   * After the critters move: each is pushed off the eel's body (the eel stays put) and two critters
   * that overlap are pushed apart, the smaller moving more. The model moves with it at once.
   */
  stepCritters(critters: readonly Solid[], fish: readonly Fish[], dt: number, rock: RockQuery): void {
    this.rock = rock;
    this.critterContacts = 0;
    if (!critters.length) return;
    for (const c of critters) c.inbox?.fade(dt);
    for (const c of critters) {
      const v = this.critterVel.get(c);
      if (!v) this.critterVel.set(c, { last: c.pos.clone(), vel: new THREE.Vector3() });
      else if (dt > 0) { v.vel.subVectors(c.pos, v.last).multiplyScalar(1 / dt); v.last.copy(c.pos); }
    }
    const eels = fish.filter((f) => f.spine);
    for (let pass = 0; pass < PASSES; pass++) {
      this.posting = pass === 0;
      for (const c of critters) this.bodyOf(c).update();
      for (let i = 0; i < critters.length; i++) {
        const a = critters[i];
        if (!a) continue;
        for (const eel of eels) if (this.critterOffEel(a, eel, dt)) this.critterContacts++;
        for (let j = i + 1; j < critters.length; j++) {
          const b = critters[j];
          if (b && this.crittersApart(a, b, dt)) this.critterContacts++;
        }
      }
    }
    for (const c of critters) this.bodyOf(c).update();
    for (const c of critters) if (c.keepLimbsOff) c.keepLimbsOff(this.limbSpheres(c, critters, eels));
  }

  /** The spheres near c's bending limbs that stand in for the eel's chain and the other critters' parts. */
  private limbSpheres(c: Solid, critters: readonly Solid[], eels: readonly Fish[]): { c: THREE.Vector3; r: number }[] {
    const body = this.bodyOf(c), out: { c: THREE.Vector3; r: number; d: number }[] = [];
    const add = (p: THREE.Vector3, r: number): void => {
      const d = p.distanceTo(body.centre) - r;
      if (d < body.radius) out.push({ c: p.clone(), r, d });
    };
    // A core p0-p1 as spheres of radius r, one about every radius along it.
    const along = (p0: THREE.Vector3, p1: THREE.Vector3, r: number): void => {
      const n = Math.min(12, Math.ceil(p0.distanceTo(p1) / Math.max(r, 1e-3)));
      for (let k = 0; k <= n; k++) add(_p.lerpVectors(p0, p1, n ? k / n : 0), r);
    };
    for (const eel of eels) {
      const nodes = eel.spine?.nodes;
      if (!nodes) continue;
      const r = this.dimsOf(eel).halfDepth * EEL_RADIUS_SHARE;
      for (let k = 0; k + 1 < nodes.length; k++) {
        const p0 = nodes[k], p1 = nodes[k + 1];
        if (p0 && p1 && Math.min(p0.distanceTo(body.centre), p1.distanceTo(body.centre)) < body.radius + p0.distanceTo(p1) + r) along(p0, p1, r);
      }
    }
    for (const o of critters) {
      if (o === c) continue;
      const ob = this.bodyOf(o);
      if (ob.centre.distanceTo(body.centre) > ob.radius + body.radius) continue;
      for (const h of ob.pieces) if (!h.bends && h.centre.distanceTo(body.centre) < body.radius + h.reach) along(h.p0, h.p1, h.girth);
    }
    out.sort((a, b) => a.d - b.d);
    return out.slice(0, LIMB_SPHERES);
  }

  /** The deepest overlap between a's solid (non-bending) parts and segments q0-q1 of radius rq, into _n (a -> other). */
  private deepestOnHulls(a: Solid, q0: THREE.Vector3, q1: THREE.Vector3, rq: (n: THREE.Vector3) => number, best: number): number {
    for (const h of this.bodyOf(a).pieces) {
      if (h.bends) continue;
      closestSegmentParams(h.p0, h.p1, q0, q1, _st);
      _p.lerpVectors(h.p0, h.p1, _st[0]); _q.lerpVectors(q0, q1, _st[1]);
      const dist = _p.distanceTo(_q);
      if (dist < 1e-6) continue;
      _m.subVectors(_q, _p).multiplyScalar(1 / dist);
      const rA = h.radiusToward(_m);
      _m.negate();
      const rB = rq(_m);
      _m.negate();
      const pen = rA + rB - dist;
      if (pen > best) { best = pen; _n.copy(_m); }
    }
    return best;
  }

  private critterOffEel(c: Solid, eel: Fish, dt: number): boolean {
    const nodes = eel.spine?.nodes;
    if (!nodes) return false;
    const r = this.dimsOf(eel).halfDepth * EEL_RADIUS_SHARE;
    const body = this.bodyOf(c), margin = SOLID_MARGIN * body.radius, wide = margin * LOOKOUT;
    let best = -wide;
    for (let k = 0; k + 1 < nodes.length; k++) {
      const p0 = nodes[k], p1 = nodes[k + 1];
      if (!p0 || !p1 || p0.distanceTo(body.centre) > body.radius + p0.distanceTo(p1) + r + wide) continue;
      best = this.deepestOnHulls(c, _b0.copy(p0), _b1.copy(p1), () => r, best);
    }
    if (best <= -wide) return false;
    if (this.posting) this.tellBoth(c, eel, _n, best, margin);
    if (best <= 0) return false;
    this.shiftCritter(c, _n, -Math.min(best * RELAX, CRITTER_PUSH_SPEED * dt));
    return true;
  }

  private crittersApart(a: Solid, b: Solid, dt: number): boolean {
    const A = this.bodyOf(a), B = this.bodyOf(b), margin = SOLID_MARGIN * Math.min(A.radius, B.radius);
    const wide = margin * LOOKOUT;
    if (A.centre.distanceTo(B.centre) > A.radius + B.radius + wide) return false;
    let best = -wide;
    for (const hb of B.pieces) {
      if (hb.bends) continue;
      const got = this.deepestOnHulls(a, _b0.copy(hb.p0), _b1.copy(hb.p1), (n) => hb.radiusToward(n), best);
      if (got > best) { best = got; _bn.copy(_n); }
    }
    if (best <= -wide) return false;
    if (this.posting) this.tellBoth(a, b, _bn, best, margin);
    if (best <= 0) return false;
    const push = Math.min(best * RELAX, CRITTER_PUSH_SPEED * dt);
    const shareA = shareOf(a, b);
    this.shiftCritter(a, _bn, -push * shareA);
    this.shiftCritter(b, _bn, push * (1 - shareA));
    return true;
  }

  /**
   * The avoidance reflex: a and b overlap by pen (negative: the gap between them), n pointing from a
   * to b. Each within its margin of the other is told to steer away from it, the more urgently the
   * closer (touching: fully), heeding it by the other's share of their masses (one in its den is
   * heeded fully, and heeds nothing). The smaller one's margin is the wider (lookoutOf).
   */
  private tellBoth(a: Party, b: Party, n: THREE.Vector3, pen: number, margin: number): void {
    const ma = margin * lookoutOf(a, b), mb = margin * lookoutOf(b, a);
    if (pen > -ma) a.inbox?.post(b, _away.copy(n).negate(), Math.min(1, (pen + ma) / ma) * heedOfParty(a, b));
    if (pen > -mb) b.inbox?.post(a, n, Math.min(1, (pen + mb) / mb) * heedOfParty(b, a));
  }

  /** Move a critter (and its model, already placed this step) by n * by, sliding along the rock. */
  private shiftCritter(c: Solid, n: THREE.Vector3, by: number): void {
    const move = _move.copy(n).multiplyScalar(by);
    const rock = this.rock;
    if (rock && rock.rockDist(_p.copy(c.pos).add(move)) < 0) {
      rock.rockNormal(c.pos, _q);
      const into = move.dot(_q);
      if (into < 0) move.addScaledVector(_q, -into);
    }
    c.pos.add(move);
    c.model.position.add(move);
    c.model.updateMatrix();
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
    // The deepest contact between fishA's axis and the other body (the eel's chain: each link). Against
    // the eel, near misses count too (the fish is told to steer off it; fish steer off each other
    // already, by their body shapes: brain/reflexes.ts).
    const margin = eel ? CONTACT_MARGIN * fishA.size : 0, wide = margin * LOOKOUT;
    let best = -wide;
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
    if (eel && this.posting && best > -wide) this.tellBoth(fishA, eel, _n, best, margin);
    if (best <= 0) return false;
    // _n points from fishA towards the other body. The lighter fish takes the larger share (one in its
    // shelter, none).
    const shareA = fishB ? shareOf(fishA, fishB) : 1;
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
   * it, the rock pushed them back, and they shuddered between the two.) Returns how far it moved in the
   * push's direction.
   */
  private shift(f: Fish, n: THREE.Vector3, by: number): number {
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
    return by ? _m.dot(n) / by * Math.abs(by) : 0;   // how far it moved along the push
  }
}
