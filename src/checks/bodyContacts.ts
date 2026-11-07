// Body contacts for the motion check (motionCheck.ts):
//   - FishOverlapTally: pairs of fish whose bodies interpenetrate, each body its axis with an
//     elliptical, tapering section (fish/bodyShape.ts), the eel its spine chain;
//   - RockTruthTally: points along every body (snout, middle, peduncle) tested against the rock as
//     drawn (checks/rockMesh.ts), and the rock field's error against it at the same points, so a clip
//     can be told apart as the field's fault (resolution, interpolation) or the fish's (response).
import * as THREE from 'three';
import type { Fish } from '../fish.js';
import type { World } from '../world.js';
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
