// Body contacts for the motion check (motionCheck.ts):
//   - FishOverlapTally: pairs of fish whose bodies interpenetrate, each body its axis with an
//     elliptical, tapering section (fish/bodyShape.ts), the eel its spine chain;
//   - CritterOverlapTally: the critters' solid parts (world/partHull.ts) into a fish, the eel or each other;
//   - RockTruthTally: points along every body (snout, middle, peduncle) tested against the rock as
//     drawn (checks/rockMesh.ts), and the rock field's error against it at the same points, so a clip
//     can be told apart as the field's fault (resolution, interpolation) or the fish's (response).
import * as THREE from 'three';
import type { Fish } from '../fish.js';
import type { World } from '../world.js';
import { CritterBody, type BodyPiece, type Solid } from '../world/partHull.js';
import { bodyDims, closestSegmentParams, radiusToward, type BodyDims } from '../fish/bodyShape.js';
import { RockMesh } from './rockMesh.js';
import { spineNodes } from './motionStats.js';

/** An overlap counts once the bodies are this share of their summed radii into each other. */
const OVERLAP_SHARE = 0.1;
/** An axis point this far (units) inside the drawn rock is clipping. */
const IN_ROCK_TOL = 0.03;
/** Field error is measured at points this near the drawn surface (units). */
const ERROR_BAND = 0.5;
const ERROR_BIN = 0.005;
const ERROR_BINS = 200;
/** The eel's radius against other fish: its half-depth, a little under (it is flattened behind). */
const EEL_RADIUS_SHARE = 0.9;
/** Body stations sampled against the rock, as shares from the snout (0) to the peduncle (1). */
const STATIONS = [0.05, 0.5, 1] as const;
const STATION_NAMES = ['nose', 'mid', 'tail'] as const;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3(), _n = new THREE.Vector3();
const _p = new THREE.Vector3(), _q = new THREE.Vector3();
const _st: [number, number] = [0, 0];

/** A cleaner and the client it is servicing touch on purpose. */
function cleaningPair(a: Fish, b: Fish): boolean {
  const c = (x: Fish, y: Fish): boolean => (x.brain.mode === 'clean' && x.brain.focus === y) || (y.brain.posing && !!x.sp.brain.cleaner);
  return c(a, b) || c(b, a);
}

interface Seg { readonly f: Fish; readonly d: BodyDims; readonly eel: boolean; readonly reach: number }

/** Interpenetrating pairs, per frame. */
export class FishOverlapTally {
  pairFrames = 0;
  fishFrames = 0;
  deepest = 0;
  readonly bySpecies: Record<string, number> = {};
  private readonly segs: Seg[];
  private readonly hit = new Set<Fish>();

  constructor(fish: readonly Fish[]) {
    this.segs = fish.map((f) => {
      const d = bodyDims(f);
      return { f, d, eel: !!f.spine, reach: f.spine ? f.size : Math.max(d.nose, -d.fin) + d.halfDepth };
    });
  }

  step(): void {
    this.hit.clear();
    const S = this.segs;
    for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
      const A = S[i], B = S[j];
      if (!A || !B) continue;
      if (A.f.pos.distanceTo(B.f.pos) > A.reach + B.reach) continue;
      if (cleaningPair(A.f, B.f)) continue;
      const pen = this.penetration(A, B);
      if (pen <= 0) continue;
      this.pairFrames++;
      this.deepest = Math.max(this.deepest, pen);
      this.hit.add(A.f); this.hit.add(B.f);
      const key = [A.f.sp.id, B.f.sp.id].sort().join('+');
      this.bySpecies[key] = (this.bySpecies[key] ?? 0) + 1;
    }
    this.fishFrames += this.hit.size;
  }

  /** How far (as a share of the summed radii) A and B are into each other, or <= 0 apart. */
  private penetration(A: Seg, B: Seg): number {
    let best = -Infinity;
    for (const [a0, a1, sa0, sa1] of this.pieces(A, _a, _b)) {
      for (const [b0, b1, sb0, sb1] of this.pieces(B, _c, _d)) {
        closestSegmentParams(a0, a1, b0, b1, _st);
        _p.lerpVectors(a0, a1, _st[0]); _q.lerpVectors(b0, b1, _st[1]);
        const dist = _p.distanceTo(_q);
        _n.subVectors(_q, _p);
        if (dist > 1e-6) _n.multiplyScalar(1 / dist); else _n.set(0, 1, 0);
        const ra = this.radius(A, sa0 + (sa1 - sa0) * _st[0], _n);
        _n.negate();
        const rb = this.radius(B, sb0 + (sb1 - sb0) * _st[1], _n);
        const pen = (ra + rb - dist) / (ra + rb);
        if (pen > best) best = pen;
      }
    }
    return best > OVERLAP_SHARE ? best : 0;
  }

  private radius(S: Seg, s: number, n: THREE.Vector3): number {
    return S.eel ? S.d.halfDepth * EEL_RADIUS_SHARE : radiusToward(S.f, S.d, s, n);
  }

  /** The body as segments (copies, since both bodies' pieces are live at once), with axis offsets. */
  private pieces(S: Seg, x: THREE.Vector3, y: THREE.Vector3): [THREE.Vector3, THREE.Vector3, number, number][] {
    const f = S.f;
    if (!S.eel) {
      x.copy(f.pos).addScaledVector(f.dir, S.d.nose); y.copy(f.pos).addScaledVector(f.dir, S.d.fin);
      return [[x, y, S.d.nose, S.d.fin]];
    }
    const nodes = spineNodes(f) ?? [];
    const out: [THREE.Vector3, THREE.Vector3, number, number][] = [];
    for (let k = 0; k + 1 < nodes.length; k++) {
      const p = nodes[k], q = nodes[k + 1];
      if (p && q) out.push([p.clone(), q.clone(), 0, 0]);
    }
    return out;
  }

  summary(minutes: number): Record<string, unknown> {
    return { pairFrames: this.pairFrames, fishFrames: this.fishFrames, perMin: +(this.pairFrames / minutes).toFixed(1), deepestShare: +this.deepest.toFixed(2), bySpecies: this.bySpecies };
  }
}

/** A critter's parts into a fish, the eel or another critter, per frame (a share of the summed radii). */
export class CritterOverlapTally {
  pairFrames = 0;
  deepest = 0;
  readonly byPair: Record<string, number> = {};
  /** The same frames by the critter's part that went deepest (critter.part). */
  readonly byPart: Record<string, number> = {};
  private deepestPart = '';
  private readonly hulls: { c: Solid; b: CritterBody; h: BodyPiece[] }[];
  private readonly segs: Seg[];

  constructor(critters: readonly Solid[], fish: readonly Fish[]) {
    this.hulls = critters.map((c) => { const b = new CritterBody(c); return { c, b, h: b.pieces }; });
    this.segs = fish.map((f) => {
      const d = bodyDims(f);
      return { f, d, eel: !!f.spine, reach: f.spine ? f.size : Math.max(d.nose, -d.fin) + d.halfDepth };
    });
  }

  step(dt = 1 / 30): void {
    for (const { b } of this.hulls) b.update();
    const H = this.hulls;
    const touching = new Map<string, [Solid, Solid | Fish, number]>();
    for (let i = 0; i < H.length; i++) {
      const A = H[i];
      if (!A) continue;
      for (let k = 0; k < this.segs.length; k++) {
        const S = this.segs[k];
        if (!S) continue;
        if (!S.eel && S.f.pos.distanceTo(A.b.centre) > A.b.radius + S.reach) continue;
        const pen = this.intoFish(A.h, S);
        if (pen > 0) {
          this.count(A.c.kind, S.eel ? 'eel' : S.f.sp.id, pen, `${A.c.kind}.${this.deepestPart}`);
          touching.set(`${i}:f${k}`, [A.c, S.f, pen]);
        }
      }
      for (let j = i + 1; j < H.length; j++) {
        const B = H[j];
        if (!B || A.b.centre.distanceTo(B.b.centre) > A.b.radius + B.b.radius) continue;
        let best = 0;
        let part = '';
        for (const hb of B.h) {
          const got = this.deepest_(A.h, hb.p0, hb.p1, (n) => hb.radiusToward(n));
          if (got > best) { best = got; part = `${A.c.kind}.${this.deepestPart}/${B.c.kind}.${hb.name}`; }
        }
        if (best > OVERLAP_SHARE) {
          this.count(A.c.kind, B.c.kind, best, part);
          touching.set(`${i}:c${j}`, [A.c, B.c, best]);
        }
      }
    }
    this.episodeStep(touching, dt);
  }

  /**
   * Contact episodes: a run of overlapping frames for one pair (gaps of up to EP_GAP frames bridged),
   * with each side's mode, speed and closing speed at the start, and through it whether the separation
   * had an escape plan for them and how urgently each was told to move off the other.
   */
  private frame = 0;
  private readonly open = new Map<string, Episode>();
  private readonly episodes: Episode[] = [];
  private readonly prev = new Map<Solid, THREE.Vector3>();
  private sep: { hasPlan(a: object, b: object): boolean } | null = null;

  watch(sep: { hasPlan(a: object, b: object): boolean }): this { this.sep = sep; return this; }

  /** After the overlap tests of a frame: open, extend or close the episodes. */
  private episodeStep(touching: Map<string, [Solid, Solid | Fish, number]>, dt: number): void {
    for (const [key, [a, b, pen]] of touching) {
      let ep = this.open.get(key);
      if (!ep) {
        ep = { key: [a.kind, kindOf(b)].sort().join('+'), start: this.frame, frames: 0, gap: 0, deepest: 0, planFrames: 0, msgA: 0, msgB: 0, a: this.snap(a, b, dt), b: this.snap(b, a, dt), speedA: 0, speedB: 0 };
        this.open.set(key, ep);
      }
      ep.frames++; ep.gap = 0;
      ep.deepest = Math.max(ep.deepest, pen);
      if (this.sep?.hasPlan(a, b)) ep.planFrames++;
      ep.msgA = Math.max(ep.msgA, a.inbox?.urgencyFrom(b) ?? 0);
      ep.msgB = Math.max(ep.msgB, ('inbox' in b ? b.inbox?.urgencyFrom(a) : 0) ?? 0);
      ep.speedA += this.speedOf(a, dt); ep.speedB += this.speedOf(b, dt);
    }
    for (const [key, ep] of this.open) {
      if (touching.has(key)) continue;
      if (++ep.gap > EP_GAP) { this.open.delete(key); this.episodes.push(ep); }
    }
    for (const { c } of this.hulls) (this.prev.get(c) ?? this.prev.set(c, new THREE.Vector3()).get(c))?.copy(c.pos);
    this.frame++;
  }

  private speedOf(x: Solid | Fish, dt: number): number {
    if (isFish(x)) return x.vel.length();
    const p = this.prev.get(x);
    return p ? p.distanceTo(x.pos) / dt : 0;
  }

  private velOf(x: Solid | Fish, dt: number, out: THREE.Vector3): THREE.Vector3 {
    if (isFish(x)) return out.copy(x.vel);
    const p = this.prev.get(x);
    return p ? out.subVectors(x.pos, p).multiplyScalar(1 / dt) : out.set(0, 0, 0);
  }

  /** One side at the start of an episode: its speed and how much of it goes into the other. */
  private snap(x: Solid | Fish, other: Solid | Fish, dt: number): Snap {
    const v = this.velOf(x, dt, _c);
    _d.subVectors(other.pos, x.pos).normalize();
    const mode = isFish(x) ? x.brain.mode : String(Reflect.get(x, 'mode') ?? '-');
    return { mode, speed: +v.length().toFixed(2), into: +v.dot(_d).toFixed(2), den: !!x.inDen };
  }

  private count(a: string, b: string, pen: number, part: string): void {
    this.byPart[part] = (this.byPart[part] ?? 0) + 1;
    this.pairFrames++;
    this.deepest = Math.max(this.deepest, pen);
    const key = [a, b].sort().join('+');
    this.byPair[key] = (this.byPair[key] ?? 0) + 1;
  }

  private intoFish(hulls: BodyPiece[], S: Seg): number {
    const f = S.f;
    let best = 0;
    if (S.eel) {
      const nodes = spineNodes(f) ?? [], r = S.d.halfDepth * EEL_RADIUS_SHARE;
      for (let k = 0; k + 1 < nodes.length; k++) {
        const p = nodes[k], q = nodes[k + 1];
        if (p && q) best = Math.max(best, this.deepest_(hulls, _a.copy(p), _b.copy(q), () => r));
      }
    } else {
      _a.copy(f.pos).addScaledVector(f.dir, S.d.nose); _b.copy(f.pos).addScaledVector(f.dir, S.d.fin);
      best = this.deepest_(hulls, _a, _b, (n) => radiusToward(f, S.d, (S.d.nose + S.d.fin) / 2, n));
    }
    return best > OVERLAP_SHARE ? best : 0;
  }

  /** The deepest share any hull reaches into segment q0-q1 of radius rq(n), n pointing at the hull. */
  private deepest_(hulls: BodyPiece[], q0: THREE.Vector3, q1: THREE.Vector3, rq: (n: THREE.Vector3) => number): number {
    let best = 0;
    for (const h of hulls) {
      closestSegmentParams(h.p0, h.p1, q0, q1, _st);
      _p.lerpVectors(h.p0, h.p1, _st[0]); _q.lerpVectors(q0, q1, _st[1]);
      const dist = _p.distanceTo(_q);
      _n.subVectors(_q, _p);
      if (dist > 1e-6) _n.multiplyScalar(1 / dist); else _n.set(0, 1, 0);
      const ra = h.radiusToward(_n);
      _n.negate();
      const rb = rq(_n);
      const share = (ra + rb - dist) / (ra + rb);
      if (share > best) { best = share; this.deepestPart = h.name; }
    }
    return best;
  }

  summary(minutes: number): Record<string, unknown> {
    const eps = [...this.episodes, ...this.open.values()];
    return { pairFrames: this.pairFrames, perMin: +(this.pairFrames / minutes).toFixed(1), deepestShare: +this.deepest.toFixed(2), byPair: this.byPair, byPart: this.byPart,
      episodes: eps.map((e) => ({
        pair: e.key, t: +(e.start / 30).toFixed(1), frames: e.frames, deep: +e.deepest.toFixed(2), plan: +(e.planFrames / e.frames).toFixed(2),
        msgA: +e.msgA.toFixed(2), msgB: +e.msgB.toFixed(2), vA: +(e.speedA / e.frames).toFixed(2), vB: +(e.speedB / e.frames).toFixed(2), a: e.a, b: e.b,
      })) };
  }
}

/** Overlapping frames this far apart still count as one contact episode. */
const EP_GAP = 3;
interface Snap { mode: string; speed: number; into: number; den: boolean }
interface Episode {
  key: string; start: number; frames: number; gap: number; deepest: number; planFrames: number;
  msgA: number; msgB: number; speedA: number; speedB: number; a: Snap; b: Snap;
}
const isFish = (x: Solid | Fish): x is Fish => x.kind === 'fish';
const kindOf = (x: Solid | Fish): string => isFish(x) ? (x.spine ? 'eel' : x.sp.id) : x.kind;

/** Fish against the rock as drawn, and the field's error there. */
export class RockTruthTally {
  readonly mesh: RockMesh | null;
  /** Fish-frames with any station inside the drawn rock, and per station. */
  meshFrames = 0;
  readonly meshByStation = [0, 0, 0];
  /** The same, by the rock field at the same stations. */
  fieldFrames = 0;
  readonly fieldByStation = [0, 0, 0];
  /** Stations in the drawn rock that the field calls open water, and the reverse. */
  fieldMissed = 0;
  fieldFalse = 0;
  deepest = 0;
  private readonly bins = new Uint32Array(ERROR_BINS + 1);
  private errSum = 0;
  private errN = 0;
  private errMax = 0;
  /** Signed error (field - mesh) sum: positive means the field reads the rock further than it is. */
  private biasSum = 0;
  readonly modes: Record<string, number> = {};

  constructor(world: World) {
    const field = world.reef.rockField;
    this.mesh = field ? new RockMesh(field.meshes) : null;
    if (this.mesh) console.log('Rock mesh BVH', JSON.stringify({ triangles: this.mesh.triangles, ms: this.mesh.buildMs }));
  }

  step(world: World): void {
    const mesh = this.mesh;
    if (!mesh) return;
    for (const f of world.fish) {
      if (f.spine) continue;   // the eel's chain has its own tally (EelTally)
      const d = bodyDims(f);
      let inMesh = false, inField = false;
      STATIONS.forEach((k, i) => {
        _p.copy(f.pos).addScaledVector(f.dir, d.nose + (d.fin - d.nose) * k);
        const fd = world.rockDist(_p);
        if (fd > ERROR_BAND + 0.3) return;   // far out in open water by the field: no surface near
        const md = mesh.dist(_p, ERROR_BAND + 0.3);
        if (Math.abs(md) < ERROR_BAND) {
          const e = Math.abs(fd - md);
          this.errSum += e; this.errN++; this.biasSum += fd - md;
          this.errMax = Math.max(this.errMax, e);
          this.bins[Math.min(ERROR_BINS, Math.floor(e / ERROR_BIN))]! += 1;
        }
        if (md < -IN_ROCK_TOL) {
          inMesh = true; this.meshByStation[i]! += 1;
          this.deepest = Math.max(this.deepest, -md);
          if (fd >= 0) this.fieldMissed++;
        } else if (md >= 0 && fd < -IN_ROCK_TOL) this.fieldFalse++;
        if (fd < -IN_ROCK_TOL) { inField = true; this.fieldByStation[i]! += 1; }
      });
      if (inMesh) { this.meshFrames++; this.modes[f.brain.mode] = (this.modes[f.brain.mode] ?? 0) + 1; }
      if (inField) this.fieldFrames++;
    }
  }

  private percentile(q: number): number {
    let acc = 0;
    for (let i = 0; i <= ERROR_BINS; i++) {
      acc += this.bins[i] ?? 0;
      if (acc >= q * this.errN) return +((i + 1) * ERROR_BIN).toFixed(3);
    }
    return Infinity;
  }

  summary(): Record<string, unknown> {
    const by = (a: readonly number[]): Record<string, number> => Object.fromEntries(STATION_NAMES.map((n, i) => [n, a[i] ?? 0]));
    return {
      meshInRockFrames: this.meshFrames, meshByStation: by(this.meshByStation), deepest: +this.deepest.toFixed(3), modes: this.modes,
      fieldInRockFrames: this.fieldFrames, fieldByStation: by(this.fieldByStation), fieldMissed: this.fieldMissed, fieldFalse: this.fieldFalse,
      fieldErr: { samples: this.errN, mean: +(this.errSum / Math.max(1, this.errN)).toFixed(4), bias: +(this.biasSum / Math.max(1, this.errN)).toFixed(4), p95: this.percentile(0.95), p99: this.percentile(0.99), max: +this.errMax.toFixed(3) },
    };
  }
}
