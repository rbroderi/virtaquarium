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
/** The body lies over a ledge this far below the head at most. */
const FLOOR_SINK = 0.05;
const FLOOR_ABOVE_HEAD = 0.15;
/** Clearance kept from a cave roof, in body lengths. */
const ROOF_CLEARANCE = 0.05;
/** Spine offsets the shader accepts, in body lengths (lateral, vertical). */
const MAX_LATERAL = 0.35;
const MAX_VERTICAL = 0.25;
/** Shader head lift shape: x past this point of the body is raised, quadratically. */
const LIFT_START = 0.1;
const LIFT_GAIN = 2.5;
/** Body radius kept off the rock: about half the body depth. */
const CLEARANCE_OF_DEPTH = 0.45;

/** What the chain reads from the fish it belongs to. */
export interface SpineBody {
  readonly pos: THREE.Vector3;
  readonly dir: THREE.Vector3;
  readonly size: number;
  readonly sp: { readonly body: { readonly depth: number } };
  /** The shader's head lift (uLift). */
  readonly lift: number;
  inBurrow(p: THREE.Vector3): boolean;
}

type ChainWorld = Pick<SwimWorld, 'reefHeight' | 'rockDist' | 'rockNormal' | 'roofAt'>;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();

/** Body radius the chain keeps off the rock surface (rockField.ts), in units. */
export const spineClearance = (fish: SpineBody): number => CLEARANCE_OF_DEPTH * fish.sp.body.depth * fish.size;

/** Where node i sits along the body: 0.5 at the head .. -0.5 at the tail. */
const nodeX = (i: number): number => 0.5 - i / (SPINE_NODES - 1);

/** Shader head lift of a node at body position x, in units: the front of the body raised out of the crevice. */
const liftAt = (fish: SpineBody, x: number): number => fish.lift * Math.max(0, x - LIFT_START) ** 2 * LIFT_GAIN * fish.size;

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

  update(dt: number, fish: SpineBody, world: ChainWorld, stiff: number): void {
    const seg = fish.size / (SPINE_NODES - 1), P = this.p, prev = this.prev;
    const node = (i: number): THREE.Vector3 => P[i] ?? _t;
    const head = _a.copy(fish.pos).addScaledVector(fish.dir, 0.5 * fish.size);
    if (!this.ready) {
      for (let i = 0; i < SPINE_NODES; i++) {
        node(i).copy(head).addScaledVector(fish.dir, -seg * i);
        prev[i]?.copy(node(i));
      }
      this.ready = true;
    }
    const drag = Math.exp(-NODE_DRAG * dt);
    for (let i = 1; i < SPINE_NODES; i++) {
      const last = prev[i];
      if (!last) continue;
      _b.subVectors(node(i), last).multiplyScalar(drag);   // carried momentum, damped by the water
      last.copy(node(i));
      node(i).add(_b);
    }
    node(0).copy(head);
    prev[0]?.copy(head);
    const R = spineClearance(fish);
    for (let it = 0; it < CONSTRAINT_ITERATIONS; it++) {
      for (let i = 1; i < SPINE_NODES; i++) this.relaxNode(i, fish, world, stiff, seg, R);
    }
    this.keepToRoofs(fish, world);
  }

  private relaxNode(i: number, fish: SpineBody, world: ChainWorld, stiff: number, seg: number, R: number): void {
    const P = this.p;
    const cur = P[i], before = P[i - 1], head = P[0];
    if (!cur || !before || !head) return;
    // Bending stiffness: pull towards the straight continuation of the two nodes ahead.
    const twoBack = P[i - 2];
    const ahead = i === 1 || !twoBack ? _b.copy(head).addScaledVector(fish.dir, -seg) : _b.subVectors(before, twoBack).add(before);
    cur.lerp(ahead, stiff * (1 - (i / SPINE_NODES) * STIFFNESS_FALLOFF));
    // Length.
    _b.subVectors(cur, before);
    const d = _b.length() || 1e-6;
    cur.copy(before).addScaledVector(_b, seg / d);
    // Rock and sand: the body lies over a ledge a little below the head. Rock well above the head is
    // the crevice the eel is in (the height field is the rock's top), so that doesn't lift it. (Not in
    // its burrow: there the body runs on into the reef behind the cave, hidden in the rock.)
    if (fish.inBurrow(cur)) return;
    const floor = world.reefHeight(cur.x, cur.z) - FLOOR_SINK;
    if (cur.y < floor && floor < head.y + FLOOR_ABOVE_HEAD * fish.size) cur.y = floor;
    // The real rock surface in 3D: out along its normal, so the body that cuts a corner behind the head
    // slides round the rock instead of through it. Tested where the shader draws the node (with the lift).
    const up = liftAt(fish, nodeX(i)), dr = world.rockDist(_c.set(cur.x, cur.y + up, cur.z));
    if (dr < R) cur.addScaledVector(world.rockNormal(_c, _t), R - dr);
  }

  /**
   * Cave roofs (not in the height field): the body stays under one the head is below, or over one it
   * swims across. The shader's head lift raises the front further, so allow for it.
   */
  private keepToRoofs(fish: SpineBody, world: ChainWorld): void {
    const r = ROOF_CLEARANCE * fish.size;
    const head = this.p[0];
    if (!head) return;
    for (let i = 0; i < SPINE_NODES; i++) {
      const n = this.p[i];
      if (!n) continue;
      const roof = world.roofAt(n.x, n.z);
      if (!roof) continue;
      const up = liftAt(fish, nodeX(i));
      if (head.y < roof.y) n.y = Math.min(n.y, roof.y - r - up);
      else n.y = Math.max(n.y, roof.top + r - up);
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
      out[i * 2] = clamp(_a.dot(side) / L, -MAX_LATERAL, MAX_LATERAL);
      out[i * 2 + 1] = clamp(_a.dot(up) / L, -MAX_VERTICAL, MAX_VERTICAL);
    }
  }
}
