// The moray's body as a chain of point masses (position-based dynamics): the head node is carried by
// the fish, the rest follow through distance constraints, resist bending (stiffer near the head),
// lose their momentum to the water, and lie on the rock. The shader bends the body through the chain's
// offsets from the straight body axis (uSpine), so the body traces the path the head took, swings
// wide out of a sharp turn, and drapes over a ledge.
import * as THREE from 'three';
import { clamp } from '../util.js';
import type { SwimWorld } from '../world/ports.js';

export const SPINE_NODES = 12;
const CONSTRAINT_ITERATIONS = 4;
/** Momentum the water takes from each node per second. */
const NODE_DRAG = 2.5;
/** Bending stiffness falls off this much from head to tail. */
const STIFFNESS_FALLOFF = 0.6;
/** Spine offsets the shader accepts, in body lengths (lateral, vertical). */
const MAX_LATERAL = 0.35;
const MAX_VERTICAL = 0.25;
/** Shader head lift shape: x past this point of the body is raised, quadratically. */
const LIFT_START = 0.1;
const LIFT_GAIN = 2.5;
/** Body radius kept off the rock: about half the body depth. */
const CLEARANCE_OF_DEPTH = 0.45;
/** Lurking within this distance of home, the body behind home is held along the burrow's axis. */
const LURK_HOLD_RANGE = 0.6;
/** Allowed distance off the burrow axis: scale * (base + growth * depth behind home / L), depth capped. */
const BURROW_HOLD = { scale: 0.6, base: 0.3, growth: 0.4, maxDepth: 0.55 } as const;

/** What the chain reads from the fish it belongs to. */
export interface SpineBody {
  readonly pos: THREE.Vector3;
  readonly dir: THREE.Vector3;
  readonly size: number;
  readonly sp: { readonly body: { readonly depth: number } };
  /** The shader's head lift (uLift). */
  readonly lift: number;
  inBurrow(p: THREE.Vector3): boolean;
  readonly brain: { readonly mode: string; readonly home: THREE.Vector3; readonly lurkDir: THREE.Vector3 | null };
}

type ChainWorld = Pick<SwimWorld, 'rockDist' | 'rockNormal' | 'bounds'>;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();

/** Body radius the chain keeps off the rock surface (rockField.ts), in units. */
export const spineClearance = (fish: SpineBody): number => CLEARANCE_OF_DEPTH * fish.sp.body.depth * fish.size;

/** Where node i sits along the body: 0.5 at the head .. -0.5 at the tail. */
const nodeX = (i: number): number => 0.5 - i / (SPINE_NODES - 1);

/** Shader head lift of a node at body position x, in units: the front of the body raised out of the crevice. */
const liftAt = (fish: SpineBody, x: number): number => fish.lift * Math.max(0, x - LIFT_START) ** 2 * LIFT_GAIN * fish.size;

const finiteOr0 = (v: number): number => (Number.isFinite(v) ? v : 0);

function makeNodes(): THREE.Vector3[] {
  return Array.from({ length: SPINE_NODES }, () => new THREE.Vector3());
}

export class SpineChain {
  private readonly p = makeNodes();
  private readonly prev = makeNodes();
  private ready = false;

  /** The chain's node positions, head to tail (read-only view for checks). */
  get nodes(): readonly THREE.Vector3[] {
    return this.p;
  }

  private node(i: number): THREE.Vector3 {
    const n = this.p[i];
    if (!n) throw new RangeError(`spine node ${i}`);
    return n;
  }

  /**
   * Move node i to where the shader draws it (write() below, the swim shader's spineAt): the point on
   * the straight body axis at its station, offset only across the body and up, each clamped as written
   * to uSpine. The chain's own position along the axis and any offset past the clamps are not drawn,
   * so the collision has to work on this point, or the body seen is somewhere it never tested.
   */
  private drawn(i: number, fish: SpineBody, up: THREE.Vector3, side: THREE.Vector3): void {
    const L = fish.size, n = this.node(i);
    _b.copy(fish.pos).addScaledVector(fish.dir, nodeX(i) * L);
    _c.subVectors(n, _b);
    const s = clamp(_c.dot(side) / L, -MAX_LATERAL, MAX_LATERAL), u = clamp(_c.dot(up) / L, -MAX_VERTICAL, MAX_VERTICAL);
    n.copy(_b).addScaledVector(side, finiteOr0(s) * L).addScaledVector(up, finiteOr0(u) * L);
  }

  update(dt: number, fish: SpineBody, world: ChainWorld, stiff: number, up: THREE.Vector3, side: THREE.Vector3): void {
    const seg = fish.size / (SPINE_NODES - 1);
    const head = _a.copy(fish.pos).addScaledVector(fish.dir, 0.5 * fish.size);
    if (!this.ready) this.layOutStraight(head, fish.dir, seg);
    this.carryMomentum(dt);
    this.node(0).copy(head);
    this.prev[0]?.copy(head);
    for (let it = 0; it < CONSTRAINT_ITERATIONS; it++) {
      for (let i = 1; i < SPINE_NODES; i++) this.relaxNode(i, fish, stiff, seg);
      for (let i = 1; i < SPINE_NODES; i++) this.collideNode(i, fish, world, up, side);
    }
    for (let i = 1; i < SPINE_NODES; i++) this.drawn(i, fish, up, side);
    this.holdInBurrow(fish);
    // Never let a bad step (a NaN from anywhere) stick in the chain: lay it out straight again next time.
    if (!this.p.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) this.ready = false;
  }

  private layOutStraight(head: THREE.Vector3, dir: THREE.Vector3, seg: number): void {
    for (let i = 0; i < SPINE_NODES; i++) {
      this.node(i).copy(head).addScaledVector(dir, -seg * i);
      this.prev[i]?.copy(this.node(i));
    }
    this.ready = true;
  }

  private carryMomentum(dt: number): void {
    const drag = Math.exp(-NODE_DRAG * dt);
    for (let i = 1; i < SPINE_NODES; i++) {
      const last = this.prev[i];
      if (!last) continue;
      _b.subVectors(this.node(i), last).multiplyScalar(drag);   // carried momentum, damped by the water
      last.copy(this.node(i));
      this.node(i).add(_b);
    }
  }

  /** Bending stiffness (towards the straight continuation of the two nodes ahead), then length. */
  private relaxNode(i: number, fish: SpineBody, stiff: number, seg: number): void {
    const cur = this.node(i), before = this.node(i - 1);
    const twoBack = this.p[i - 2];
    const ahead = i === 1 || !twoBack ? _b.copy(this.node(0)).addScaledVector(fish.dir, -seg) : _b.subVectors(before, twoBack).add(before);
    cur.lerp(ahead, stiff * (1 - (i / SPINE_NODES) * STIFFNESS_FALLOFF));
    _b.subVectors(cur, before);
    const d = _b.length() || 1e-6;
    cur.copy(before).addScaledVector(_b, seg / d);
  }

  /**
   * The body as drawn, kept off the rock by the same field the other fish use (which holds every rock
   * and cave roof in 3D): each drawn node, with the shader's head lift, is pushed out along the surface
   * normal to the body's radius, and off the sand. In its burrow (the crevice behind the cave, where
   * the body runs on into the reef) the body may be in the rock, but wholly: a node within a body radius
   * of the surface goes to whichever side is nearer, fully in or fully out, so the tail never straddles
   * the surface and shows through it.
   */
  private collideNode(i: number, fish: SpineBody, world: ChainWorld, up: THREE.Vector3, side: THREE.Vector3): void {
    const R = spineClearance(fish), sand = world.bounds.y0;
    this.drawn(i, fish, up, side);
    const n = this.node(i);
    _c.copy(n).addScaledVector(up, liftAt(fish, nodeX(i)));
    const dr = world.rockDist(_c);
    if (fish.inBurrow(_c)) {
      if (Math.abs(dr) < R) n.addScaledVector(world.rockNormal(_c, _t), (dr < 0 ? -R : R) - dr);
      return;
    }
    if (dr < R) n.addScaledVector(world.rockNormal(_c, _t), R - dr);
    if (_c.y < sand + R) n.y += sand + R - _c.y;
  }

  /**
   * Lurking at home, the body behind home lies along its burrow (inBurrow): held near the burrow's
   * axis, so the tail stays straight and hidden in the rock instead of snaking out of it.
   */
  private holdInBurrow(fish: SpineBody): void {
    const b = fish.brain, axis = b.lurkDir, L = fish.size;
    if (!axis || b.mode !== 'lurk' || fish.pos.distanceTo(b.home) >= LURK_HOLD_RANGE) return;
    for (let i = 1; i < SPINE_NODES; i++) {
      const n = this.node(i);
      _t.subVectors(n, b.home);
      const s = _t.dot(axis);
      if (s >= 0) continue;
      _t.addScaledVector(axis, -s);   // off the axis
      const lim = BURROW_HOLD.scale * (BURROW_HOLD.base + (BURROW_HOLD.growth * Math.min(-s, BURROW_HOLD.maxDepth * L)) / L), off = _t.length();
      if (off > lim) n.addScaledVector(_t, lim / off - 1);
    }
  }

  /** Offsets from the straight body axis in the fish's own frame, in body lengths. */
  write(out: Float32Array, fish: SpineBody, up: THREE.Vector3, side: THREE.Vector3): void {
    const L = fish.size;
    for (let i = 0; i < SPINE_NODES; i++) {
      const n = this.p[i];
      if (!n) continue;
      _b.copy(fish.pos).addScaledVector(fish.dir, nodeX(i) * L);
      _a.subVectors(n, _b);
      // (A NaN in a vec2[] uniform breaks three's upload, which tests only element 0: write 0 instead.)
      out[i * 2] = finiteOr0(clamp(_a.dot(side) / L, -MAX_LATERAL, MAX_LATERAL));
      out[i * 2 + 1] = finiteOr0(clamp(_a.dot(up) / L, -MAX_VERTICAL, MAX_VERTICAL));
    }
  }
}
