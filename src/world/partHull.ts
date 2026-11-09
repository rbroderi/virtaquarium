// A critter's body for collisions, as capsule pieces (each a core segment with a radius about it):
//   - each part it names (critter.hullParts: shell, head, mantle, flippers, fins, arms) is a capsule
//     fitted to that mesh's bounding box, followed live through the mesh's world matrix (a beating
//     flipper or a turning head carries its capsule with it). The core runs along the box's longest
//     side; across it the body is an ellipse with the other two half sides, and the core stops that
//     short of the box's ends, so the rounded ends reach them. A part whose vertices are rewritten on
//     the CPU each frame (critter.liveHullParts: the cuttlefish's fin skirt) has its box refitted.
//   - each limb chain it offers (critter.limbChains: the octopus's arms, points in the model's frame)
//     is a run of round capsules, one per link.
// CritterBody gathers them with a bounding sphere, so most pairs are ruled out at once.
import * as THREE from 'three';
import type { ContactInbox } from './contactInbox.js';

const _m = new THREE.Vector3(), _c = new THREE.Vector3(), _s = new THREE.Vector3();

/** One capsule: core p0-p1 (world) and the radius about it toward a direction. */
export interface BodyPiece {
  readonly p0: THREE.Vector3;
  readonly p1: THREE.Vector3;
  /** Midpoint of the core, and how far the piece reaches from it. */
  readonly centre: THREE.Vector3;
  readonly reach: number;
  /** The part it stands for (the mesh's name, or limbN for a chain). */
  readonly name: string;
  /** Its typical radius (for standing in spheres along the core). */
  readonly girth: number;
  /** A limb that bends round what it meets (an octopus arm) rather than shoving its critter. */
  readonly bends: boolean;
  update(): void;
  radiusToward(n: THREE.Vector3): number;
  /** Spheres that fill the piece out to its sides (stand-ins for the octopus's arms to keep off). */
  fill(add: (p: THREE.Vector3, r: number) => void): void;
}

/** At most this many rows of spheres across a flat piece. */
const FILL_ROWS = 3;
const _f = new THREE.Vector3();

/** Spheres of radius r about every radius along core p0-p1, each row offset across by `off`. */
function fillCore(p0: THREE.Vector3, p1: THREE.Vector3, r: number, add: (p: THREE.Vector3, r: number) => void, side?: THREE.Vector3, rows = 1, span = 0): void {
  const n = Math.min(12, Math.ceil(p0.distanceTo(p1) / Math.max(r, 1e-3)));
  for (let row = 0; row < rows; row++) {
    const off = rows > 1 ? (row / (rows - 1) * 2 - 1) * span : 0;
    for (let k = 0; k <= n; k++) {
      _f.lerpVectors(p0, p1, n ? k / n : 0);
      if (side && off) _f.addScaledVector(side, off);
      add(_f, r);
    }
  }
}

/** A limb as a chain of points in its critter model's frame, with its radius at each point. */
export interface LimbChain {
  readonly pts: readonly THREE.Vector3[];
  radiusAt(i: number): number;
  /** The first link that counts (those before it are inside the body). */
  readonly firstLink?: number;
  /** False when the limb can't bend round what it meets and shoves its owner instead (default true). */
  readonly bends?: boolean;
}

export class PartHull implements BodyPiece {
  readonly p0 = new THREE.Vector3();
  readonly p1 = new THREE.Vector3();
  readonly centre = new THREE.Vector3();
  reach = 0;
  readonly bends = false;
  get girth(): number { return (this.hu + this.hv) / 2; }
  get name(): string { return this.mesh.name; }
  /** The two cross-section axes (unit, world) and their half sides. */
  private readonly u = new THREE.Vector3();
  private readonly v = new THREE.Vector3();
  private hu = 0;
  private hv = 0;
  private readonly box: THREE.Box3;
  private readonly axes = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] as const;

  constructor(private readonly mesh: THREE.Mesh, private readonly live = false) {
    const g = mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    this.box = g.boundingBox?.clone() ?? new THREE.Box3(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  }

  /** Place the hull where the mesh now is. */
  update(): void {
    if (this.live) this.box.setFromBufferAttribute(this.mesh.geometry.getAttribute('position') as THREE.BufferAttribute);
    this.mesh.updateWorldMatrix(true, false);
    const e = this.mesh.matrixWorld.elements, b = this.box;
    const half = [(b.max.x - b.min.x) / 2, (b.max.y - b.min.y) / 2, (b.max.z - b.min.z) / 2];
    const sides: { axis: THREE.Vector3; h: number }[] = [];
    for (let k = 0; k < 3; k++) {
      const a = this.axes[k];
      if (!a) continue;
      a.set(e[k * 4] ?? 0, e[k * 4 + 1] ?? 0, e[k * 4 + 2] ?? 0);
      const s = a.length();
      a.multiplyScalar(s > 1e-9 ? 1 / s : 0);
      sides.push({ axis: a, h: (half[k] ?? 0) * s });
    }
    sides.sort((p, q) => q.h - p.h);
    const [l, a, c] = sides;
    if (!l || !a || !c) return;
    b.getCenter(_c);
    this.centre.copy(_c).applyMatrix4(this.mesh.matrixWorld);
    this.u.copy(a.axis); this.hu = Math.max(a.h, 1e-4);
    this.v.copy(c.axis); this.hv = Math.max(c.h, 1e-4);
    const core = Math.max(0, l.h - c.h);
    _m.copy(l.axis).multiplyScalar(core);
    this.p0.copy(this.centre).sub(_m);
    this.p1.copy(this.centre).add(_m);
    this.reach = core + a.h;
  }

  /** The body's radius from its core toward unit direction n (across the core: the cross-section ellipse). */
  radiusToward(n: THREE.Vector3): number {
    const cu = n.dot(this.u), cv = n.dot(this.v), across = cu * cu + cv * cv;
    if (across < 1e-9) return this.hv;
    return 1 / Math.sqrt((cu * cu) / (across * this.hu * this.hu) + (cv * cv) / (across * this.hv * this.hv));
  }

  /** Rows of spheres of its thin half-side across its wide one (a shell: out to its rim). */
  fill(add: (p: THREE.Vector3, r: number) => void): void {
    const rows = Math.min(FILL_ROWS, Math.max(1, Math.ceil(this.hu / this.hv)));
    const r = Math.max(this.hv, this.hu / rows);
    fillCore(this.p0, this.p1, r, add, this.u, rows, Math.max(0, this.hu - r));
  }
}

/** One link of a limb chain: a round capsule between two of its points. */
class LinkPiece implements BodyPiece {
  readonly p0 = new THREE.Vector3();
  readonly p1 = new THREE.Vector3();
  readonly centre = new THREE.Vector3();
  reach = 0;
  readonly bends: boolean;
  private r = 0;
  get girth(): number { return this.r; }

  constructor(private readonly model: THREE.Object3D, private readonly chain: LimbChain, private readonly i: number, readonly name: string) {
    this.bends = chain.bends ?? true;
  }

  update(): void {
    const a = this.chain.pts[this.i], b = this.chain.pts[this.i + 1];
    if (!a || !b) return;
    const m = this.model.matrixWorld;
    this.p0.copy(a).applyMatrix4(m); this.p1.copy(b).applyMatrix4(m);
    this.centre.lerpVectors(this.p0, this.p1, 0.5);
    _s.setFromMatrixScale(m);
    this.r = ((this.chain.radiusAt(this.i) + this.chain.radiusAt(this.i + 1)) / 2) * Math.max(_s.x, _s.y, _s.z);
    this.reach = this.p0.distanceTo(this.p1) / 2 + this.r;
  }

  radiusToward(): number { return this.r; }

  fill(add: (p: THREE.Vector3, r: number) => void): void { fillCore(this.p0, this.p1, this.r, add); }
}

/** What a critter offers for its collision body (the Critter contract's part of it). */
export interface HullSource {
  readonly model: THREE.Object3D;
  readonly hullParts: readonly string[];
  readonly liveHullParts?: readonly string[];
  readonly limbChains?: readonly LimbChain[];
}

/** A body the separation keeps others out of: a critter or a jelly. */
export interface Solid extends HullSource {
  readonly kind: string;
  readonly pos: THREE.Vector3;
  /** Its bulk against a fish's (Fish.mass, length cubed). */
  readonly mass: number;
  /** In its den: it has right of way (the others steer off it and take the whole push). */
  readonly inDen?: boolean;
  /** The avoidance reflex's messages (world/contactInbox.ts), for those that steer by them. */
  readonly inbox?: ContactInbox;
  /** Spheres (world) its bending limbs keep clear of next step. */
  keepLimbsOff?(spheres: readonly { readonly c: THREE.Vector3; readonly r: number }[]): void;
}

/** The hulls of the named parts of a model (each mesh whose name is listed). */
export function partHulls(model: THREE.Object3D, names: readonly string[], live: readonly string[] = []): PartHull[] {
  const out: PartHull[] = [];
  model.traverse((o) => { if (o instanceof THREE.Mesh && names.includes(o.name)) out.push(new PartHull(o, live.includes(o.name))); });
  return out;
}

/** A critter's whole collision body: its pieces, and a sphere round them all. */
export class CritterBody {
  readonly pieces: BodyPiece[];
  readonly centre = new THREE.Vector3();
  radius = 0;

  constructor(src: HullSource) {
    this.pieces = [...partHulls(src.model, src.hullParts, src.liveHullParts)];
    (src.limbChains ?? []).forEach((chain, c) => { for (let i = chain.firstLink ?? 0; i + 1 < chain.pts.length; i++) this.pieces.push(new LinkPiece(src.model, chain, i, `limb${c}`)); });
    this.model = src.model;
  }

  private readonly model: THREE.Object3D;

  update(): void {
    this.model.updateWorldMatrix(true, false);
    let n = 0;
    this.centre.set(0, 0, 0);
    for (const p of this.pieces) { p.update(); this.centre.add(p.centre); n++; }
    if (n) this.centre.multiplyScalar(1 / n);
    let r = 0;
    for (const p of this.pieces) r = Math.max(r, p.centre.distanceTo(this.centre) + p.reach);
    this.radius = r;
  }
}
