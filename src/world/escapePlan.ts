// Local path finding for two creatures in collision. The plain avoidance message says "away from the
// other", which can send a fish into the rock, into a third creature, or straight back across the
// other's path. When two bodies touch, the separation (world/separation.ts) asks this planner instead:
// it tries a fan of short escape paths for each (straight away, swung either side, tilted up and down),
// scores every pairing by how far apart it leaves them, how clear of the rock and of the others each
// path stays, and how little it turns them, and hands each its best path's heading. A pairing only
// counts as resolving the collision if, after the paths, each back on its own course, they stay apart
// for the next AFTER seconds. A long body (the eel) is a chain of small spheres along it, moving as one. The one that gives
// way more travels further; one that does not give way at all (in its den) stays put.
import * as THREE from 'three';

/** Anyone else nearby, to keep the paths clear of (or one sphere of a long body). */
export interface PlanObstacle { readonly p: THREE.Vector3; readonly r: number }
/**
 * One of the two: where it is, how it moves, its sphere, and how far it gives way (0..1). A long body
 * gives its spheres as `parts` (the gaps are measured between those; p and r are its head's).
 */
export interface PlanBody {
  readonly p: THREE.Vector3; readonly v: THREE.Vector3; readonly r: number; readonly share: number
  readonly parts?: readonly PlanObstacle[] | null
}

/** How far ahead a path runs (s, at the creature's speed). */
const HORIZON = 0.8;
/** The slowest a path is planned at (its body radii per second): a creature at rest can still move off. */
const MIN_SPEED_R = 1.2;
/** Swings off straight away (radians, about the vertical), and tilts up or down. */
const SWINGS = [0, 0.6, -0.6, 1.2, -1.2, 1.9, -1.9] as const;
const TILTS = [0, 0.45, -0.45] as const;
/** Scoring weights: the gap they end with (per clearance), rock and others in the way (per radius
 *  of overlap), and turning off the present heading. */
const W_GAP = 3, W_ROCK = 4, W_OTHER = 3, W_TURN = 0.4;
/** After the path, each is assumed back on its own course (its present velocity): the pairing must keep
 *  them apart this long after (s). */
const AFTER = 3;
/** The gap wanted between them at the end (a share of the smaller radius): more scores no better. */
const CLEAR = 0.5;

const UP = new THREE.Vector3(0, 1, 0);
const _side = new THREE.Vector3(), _e = new THREE.Vector3(), _rel = new THREE.Vector3(), _rv = new THREE.Vector3();
const _ea = new THREE.Vector3(), _eb = new THREE.Vector3(), _ma = new THREE.Vector3(), _mb = new THREE.Vector3();

/**
 * The narrowest gap between a's spheres moved by offA and b's moved by offB; with rv (b's velocity
 * relative to a's), the narrowest over the AFTER seconds that follow.
 */
function narrowest(pa: readonly PlanObstacle[], offA: THREE.Vector3, pb: readonly PlanObstacle[], offB: THREE.Vector3, rv: THREE.Vector3 | null): number {
  let g = Infinity;
  for (const sa of pa) {
    for (const sb of pb) {
      _rel.copy(sb.p).add(offB).sub(sa.p).sub(offA);
      const d = rv ? nearestAfter(_rel, rv) : _rel.length();
      if (d - sa.r - sb.r < g) g = d - sa.r - sb.r;
    }
  }
  return g;
}

interface Option { readonly d: THREE.Vector3; cost: number }

/** The fan of headings for one body, round `away`, each with its cost (rock, others, turning). */
function fan(b: PlanBody, away: THREE.Vector3, len: number, others: readonly PlanObstacle[], rockDist: ((p: THREE.Vector3) => number) | null, out: Option[]): number {
  let k = 0;
  const speed = b.v.length();
  for (const sw of SWINGS) {
    for (const tl of TILTS) {
      const o = out[k] ?? (out[k] = { d: new THREE.Vector3(), cost: 0 });
      o.d.copy(away).applyAxisAngle(UP, sw);
      if (tl !== 0) {
        _side.crossVectors(o.d, UP);
        if (_side.lengthSq() > 1e-8) o.d.applyAxisAngle(_side.normalize(), tl);
      }
      o.d.normalize();
      let cost = speed > 1e-4 ? W_TURN * (1 - o.d.dot(b.v) / speed) : 0;
      for (const f of [0.5, 1]) {
        _e.copy(b.p).addScaledVector(o.d, len * f);
        if (rockDist) { const rd = rockDist(_e); if (rd < b.r) cost += W_ROCK * (b.r - rd) / b.r; }
        for (const ob of others) {
          const over = ob.r + b.r - _e.distanceTo(ob.p);
          if (over > 0) cost += W_OTHER * over / b.r;
        }
      }
      o.cost = cost;
      k++;
    }
  }
  return k;
}

/** The nearest b comes to a from relative position rel, moving at relative velocity rv, in AFTER seconds. */
function nearestAfter(rel: THREE.Vector3, rv: THREE.Vector3): number {
  const vv = rv.lengthSq();
  const t = vv > 1e-8 ? Math.min(AFTER, Math.max(0, -rel.dot(rv) / vv)) : 0;
  return rel.addScaledVector(rv, t).length();
}

const _fa: Option[] = [], _fb: Option[] = [];
const _awayA = new THREE.Vector3(), _awayB = new THREE.Vector3();

/**
 * The escape headings for a and b (into outA and outB, unit; zero for one that stays put). `n` points
 * from a to b. `others` are everyone else near enough to matter.
 */
export function planApart(a: PlanBody, b: PlanBody, n: THREE.Vector3, others: readonly PlanObstacle[], rockDist: ((p: THREE.Vector3) => number) | null, outA: THREE.Vector3, outB: THREE.Vector3): void {
  outA.set(0, 0, 0); outB.set(0, 0, 0);
  const lenOf = (x: PlanBody): number => x.share <= 0 ? 0 : Math.max(x.v.length(), MIN_SPEED_R * x.r) * HORIZON * (0.25 + x.share);
  const la = lenOf(a), lb = lenOf(b);
  _awayA.copy(n).negate(); _awayB.copy(n);
  const ka = la > 0 ? fan(a, _awayA, la, others, rockDist, _fa) : 0;
  const kb = lb > 0 ? fan(b, _awayB, lb, others, rockDist, _fb) : 0;
  _rv.subVectors(b.v, a.v);
  const clear = CLEAR * Math.min(a.r, b.r), partsA = a.parts ?? [a], partsB = b.parts ?? [b];
  let best = -Infinity, ia = -1, ib = -1;
  for (let i = 0; i < Math.max(ka, 1); i++) {
    const oa = ka ? _fa[i] : null;
    for (let j = 0; j < Math.max(kb, 1); j++) {
      const ob = kb ? _fb[j] : null;
      if (!oa && !ob) return;
      // How far each has moved halfway along its path and at its end.
      _ea.set(0, 0, 0); _eb.set(0, 0, 0); _ma.set(0, 0, 0); _mb.set(0, 0, 0);
      if (oa) { _ea.addScaledVector(oa.d, la); _ma.addScaledVector(oa.d, la / 2); }
      if (ob) { _eb.addScaledVector(ob.d, lb); _mb.addScaledVector(ob.d, lb / 2); }
      // The narrowest gap: halfway (the paths must not cross), at the end, and over the AFTER seconds
      // that follow, each back on its own course.
      const gap = Math.min(narrowest(partsA, _ma, partsB, _mb, null), narrowest(partsA, _ea, partsB, _eb, _rv));
      const score = W_GAP * Math.min(gap, clear) / clear - (oa ? oa.cost : 0) - (ob ? ob.cost : 0);
      if (score > best) { best = score; ia = i; ib = j; }
    }
  }
  const oa = ka ? _fa[ia] : null, ob = kb ? _fb[ib] : null;
  if (oa) outA.copy(oa.d); else outA.set(0, 0, 0);
  if (ob) outB.copy(ob.d); else outB.set(0, 0, 0);
}
