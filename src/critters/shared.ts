// Helpers every critter uses: springs, reef-lit materials, steering, and reading the reef.
import * as THREE from 'three';
import { addCaustics } from '../water.js';
import { addTranslucency } from '../softSkin.js';
import { installReefLight } from '../reefLight/webgpu.js';
import { range, clamp, lerp, wrapAngle, type Rng } from '../util.js';
import { gpuActive, tsl, webgpu, type FloatUniformNode, type Vec3UniformNode, type Node, type Tsl } from '../webgpu/tsl.js';
import type { CritterNeighbour, CritterThreatFish, CritterWorld } from './types.js';
import { limitStep } from '../world/stepLimit.js';
import { ContactInbox, CHASE_HEED, MIN_HEED } from '../world/contactInbox.js';

/** How fast a critter may haul itself up or out (units/s) beyond its swimming speed (world/stepLimit.ts). */
export const CRITTER_CRAWL = 0.3;
const _prev = new THREE.Vector3();

export const UP = new THREE.Vector3(0, 1, 0);

/** A damped spring's state: position and velocity. */
export interface SpringState { x: number; v: number }

const SPRING_SUBSTEPS_PER_CYCLE = 8;

/** A damped spring, s = { x, v } pulled towards target (natural frequency hz, damping ratio zeta). */
export function spring(s: SpringState, target: number, hz: number, zeta: number, dt: number): number {
  const w = 2 * Math.PI * hz, n = Math.ceil(dt * hz * SPRING_SUBSTEPS_PER_CYCLE), h = dt / n;
  for (let i = 0; i < n; i++) { s.v += (w * w * (target - s.x) - 2 * zeta * w * s.v) * h; s.x += s.v * h; }
  return s.x;
}

const TEXTURE_ANISOTROPY = 8;

export function canvasTexture(c: HTMLCanvasElement, srgb = true): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = TEXTURE_ANISOTROPY;
  return t;
}

/** Light through soft tissue (softSkin.ts options: wrap, back, tint, thin). */
export interface TissueOptions {
  readonly wrap?: number;
  readonly back?: number;
  readonly tint?: [number, number, number];
  readonly thin?: number | 'attr';
}

export type ShaderHook = (shader: THREE.WebGLProgramParametersWithUniforms, renderer: THREE.WebGLRenderer) => void;

/** GLSL a soft body's hook splices in: declarations before each stage, and its begin_vertex and map_fragment. */
export interface SoftBodyPatch {
  readonly vertHead: string;
  readonly vertBegin: string;
  readonly fragHead: string;
  readonly fragMap: string;
}

/**
 * The WebGL hook of a blended soft body (octopus body, cuttlefish mantle): binds the critter's live
 * uniforms, deforms the vertices in begin_vertex and colours in map_fragment.
 */
export function softBodyHook(uniforms: Readonly<Record<string, THREE.IUniform>>, patch: SoftBodyPatch): ShaderHook {
  return (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = patch.vertHead + shader.vertexShader.replace('#include <begin_vertex>', patch.vertBegin);
    shader.fragmentShader = patch.fragHead + shader.fragmentShader.replace('#include <map_fragment>', patch.fragMap);
  };
}

/** The TSL counterpart of a ShaderHook: node-material slots a critter can set under WebGPU. */
export interface SkinNodes {
  positionNode?: Node | null;
  normalNode?: Node | null;
  colorNode?: Node | null;
}

export type NodeHook = (t: Tsl, mat: THREE.Material) => SkinNodes;

const uniformNodes = new WeakMap<THREE.IUniform, FloatUniformNode>();

/** A scalar uniform bridged to a TSL uniform node exactly once (critters write `u.value = x`). */
export function scalarNode(t: Tsl, entry: THREE.IUniform<number>): FloatUniformNode {
  const known = uniformNodes.get(entry);
  if (known) return known;
  const node = t.uniform(entry.value);
  Object.defineProperty(entry, 'value', {
    get: (): number => node.value,
    set: (v: number): void => { node.value = v; },
    configurable: true,
    enumerable: true,
  });
  uniformNodes.set(entry, node);
  return node;
}

/** A Vector3 uniform read by reference (critters mutate `u.value.set(...)` in place). */
export function vec3Node(t: Tsl, entry: THREE.IUniform<THREE.Vector3>): Vec3UniformNode {
  return t.uniform(entry.value, 'vec3') as Vec3UniformNode;
}

/**
 * A reef-lit material with an optional shader hook; key keeps three.js from sharing the program with
 * a plain material of the same parameters. sss: light through the skin for the soft bodies, null for
 * the turtle's horn and scales. Under WebGPU the GLSL hook is dead (WebGPURenderer never runs
 * onBeforeCompile), so the hook's TSL form (nodeHook) takes its place; the SSS goes through a
 * node-material lighting model (softSkin.ts) so the soft bodies keep their translucent glow.
 */
export function skin(opts: THREE.MeshStandardMaterialParameters, key: string, hook: ShaderHook | null = null, sss: TissueOptions | null = null, nodeHook: NodeHook | null = null): THREE.Material {
  if (gpuActive()) {
    const t = tsl();
    const wg = webgpu();
    let m: THREE.Material = new wg.MeshStandardNodeMaterial(opts);
    if (nodeHook) {
      const n = nodeHook(t, m);
      const nodeMat = m as unknown as { positionNode: Node | null; normalNode: Node | null; colorNode: Node | null };
      if (n.positionNode) nodeMat.positionNode = n.positionNode;
      if (n.normalNode) nodeMat.normalNode = n.normalNode;
      if (n.colorNode) nodeMat.colorNode = n.colorNode;
    }
    if (sss) m = addTranslucency(m, sss);
    return installReefLight(m);
  }
  const m = new THREE.MeshStandardMaterial(opts);
  if (hook) m.onBeforeCompile = hook;
  m.customProgramCacheKey = () => key;
  addCaustics(m);
  if (sss) addTranslucency(m, sss);
  return m;
}

/** Red-brown cephalopod tissue. */
export const CEPH_SSS: TissueOptions = { wrap: 0.45, back: 0.7, tint: [1.0, 0.45, 0.35], thin: 0.15 };

export interface SteerOptions {
  readonly turn: number;
  readonly speed: number;
  readonly accel: number;
  readonly clearance: number;
  readonly look?: number;
  readonly reverse?: boolean;
  /** Going for food: the avoidance reflex is heeded less. */
  readonly chase?: boolean;
  /** In no hurry (settling onto a spot): it stops for whatever is in its path, however small. */
  readonly yieldTo?: boolean;
}

/** How far the avoidance reflex bends a critter's course (target distances, at full urgency). */
const AVOID_TURN = 1.2;
/** Something in its path: it eases off by up to this share of its speed per unit of urgency... */
export const AVOID_EASE = 1.2;
/** ...but never below this share. */
export const MIN_EASED = 0.4;
/** Yielding, something this far into its path (dot with its heading) stops it fully. */
const YIELD_PATH = 0.5;
/** Yielding, it slows at this rate (per s), not its swimming acceleration. */
const YIELD_BRAKE = 4;
const _away = new THREE.Vector3();

const _v = new THREE.Vector3();
const _e = new THREE.Euler(0, 0, 0, 'YZX');
const STEER_GAIN = 1.5;
const MAX_STEER_PITCH = 0.45;
const CLIMB_PITCH = 0.35;
const MIN_FLAT_DISTANCE = 0.3;

/**
 * Shared steering for animals that swim freely: turn-rate-limited yaw and pitch towards a target,
 * climbing over reef that lies ahead, kept inside the tank.
 */
export class Swimmer {
  readonly pos: THREE.Vector3;
  yaw: number;
  pitch = 0;
  roll = 0;
  speed = 0;
  readonly dir: THREE.Vector3;
  /** The avoidance reflex's messages (world/contactInbox.ts). */
  readonly inbox = new ContactInbox();

  constructor(pos: THREE.Vector3, yaw: number) {
    this.pos = pos; this.yaw = yaw;
    this.dir = new THREE.Vector3(Math.cos(yaw), 0, Math.sin(yaw));
  }

  /** Returns the horizontal distance to the target. */
  steer(dt: number, world: CritterWorld, target: THREE.Vector3, { turn, speed, accel, clearance, look = 1.5, reverse = false, chase = false, yieldTo = false }: SteerOptions): number {
    _v.subVectors(target, this.pos);
    const toTarget = Math.hypot(_v.x, _v.z);
    // The avoidance reflex bends the course off whatever it is touching or about to.
    // Whatever is in its path (the way it is moving), it also swerves harder from and eases off for, so
    // it does not plough through a school of small fish that are trying to get out of its way.
    const u = this.inbox.read(_away, null, chase ? CHASE_HEED : 1);
    const s = Math.sign(this.speed || 1);
    const inPath = u > 0 ? Math.max(0, -this.dir.dot(_away) * s) : 0;
    if (u > 0) _v.addScaledVector(_away, u * AVOID_TURN * (1 + inPath) * Math.max(_v.length(), 1));
    // Yielding (in no hurry: settling onto a spot), it heeds them fully and stops for them altogether.
    // Something even half in its path stops it, and it brakes at once rather than coasting in.
    const ease = yieldTo ? Math.min(1, u / MIN_HEED) : u;
    const blocked = yieldTo ? Math.min(1, inPath / YIELD_PATH) : inPath;
    const eased = speed * Math.max(yieldTo ? 0 : MIN_EASED, 1 - AVOID_EASE * ease * blocked);
    if (yieldTo && eased < this.speed) accel = Math.max(accel, YIELD_BRAKE);
    const flat = Math.hypot(_v.x, _v.z);
    let yawT = Math.atan2(_v.z, _v.x);
    if (reverse) yawT = wrapAngle(yawT + Math.PI);   // back towards the target (cuttlefish swim backwards)
    let pitchT = clamp(Math.atan2(_v.y, Math.max(flat, MIN_FLAT_DISTANCE)) * (reverse ? -1 : 1), -MAX_STEER_PITCH, MAX_STEER_PITCH);
    const ahead = world.reefHeight(this.pos.x + this.dir.x * look * s, this.pos.z + this.dir.z * look * s) + clearance;
    if (this.pos.y < ahead) pitchT = Math.max(pitchT, CLIMB_PITCH * s);
    const dy = wrapAngle(yawT - this.yaw);
    const rate = clamp(dy * STEER_GAIN, -turn, turn);
    this.yaw = wrapAngle(this.yaw + rate * dt);
    this.roll = lerp(this.roll, -rate * 0.25, Math.min(1, dt * 2));
    this.pitch = lerp(this.pitch, pitchT, Math.min(1, dt * 1.2));
    this.speed = lerp(this.speed, eased, Math.min(1, dt * accel));
    const cp = Math.cos(this.pitch);
    this.dir.set(Math.cos(this.yaw) * cp, Math.sin(this.pitch), Math.sin(this.yaw) * cp);
    _prev.copy(this.pos);
    this.pos.addScaledVector(this.dir, this.speed * dt);
    const B = world.bounds;
    this.pos.x = clamp(this.pos.x, B.x0, B.x1);
    this.pos.z = clamp(this.pos.z, B.z0, B.z1);
    // Over a rock edge the floor steps up: climb onto it at swimming pace, not in one jump.
    const floor = Math.max(B.y0, world.reefHeight(this.pos.x, this.pos.z) + clearance * 0.6);
    if (this.pos.y < floor) this.pos.y = Math.min(floor, this.pos.y + (Math.abs(this.speed) + CRITTER_CRAWL) * dt);
    this.pos.y = Math.min(this.pos.y, B.y1);
    limitStep(_prev, this.pos, this.speed, CRITTER_CRAWL, dt);
    return toTarget;
  }

  place(model: THREE.Object3D): void {
    model.position.copy(this.pos);
    model.rotation.copy(_e.set(this.roll, -this.yaw, this.pitch, 'YZX'));
  }
}

/** A random point in the tank, at least lo above the reef (and lo..hi above the sand). */
export function randomTarget(rng: Rng, world: CritterWorld, lo: number, hi: number): THREE.Vector3 {
  const B = world.bounds, x = range(rng, B.x0 + 1.5, B.x1 - 1.5), z = range(rng, B.z0 + 0.6, B.z1 - 0.8);
  return new THREE.Vector3(x, Math.max(world.reefHeight(x, z) + lo, range(rng, lo, hi)), z);
}

/**
 * Underside of a cave roof over (x, z), or Infinity in the open (roofs overhang, so the height field
 * doesn't hold them: see reef.ts caves[].roof).
 */
export function ceilingAt(world: CritterWorld, x: number, z: number): number {
  const r = world.roofAt(x, z);
  return r ? r.y : Infinity;
}

const MOUTH_BEHIND = 0.15;    // the overhang's edge band, cave-local z past the roof's front ...
const MOUTH_AHEAD = 0.8;      // ... to this far out of the mouth

/**
 * Floor for things lying on the bottom. The height field holds the cave roof's top, dilated for the
 * fishes' clearance, so just outside the mouth (open sand under the overhang's edge) it reads as rock;
 * there the floor is the cave's own ground.
 */
export function floorAt(world: CritterWorld, x: number, z: number): number {
  for (const c of world.reef.caves ?? []) {
    const r = c.roof;
    if (!r) continue;
    const dx = x - c.x, dz = z - c.z, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
    const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
    if (Math.abs(lx) < r.hx && lz > r.z1 - MOUTH_BEHIND && lz < r.z1 + MOUTH_AHEAD) return Math.min(world.reefHeight(x, z), c.ground);
  }
  return world.reefHeight(x, z);
}

const BIG_FISH_SIZE = 1.0;
const FAST_FISH_BODY_LENGTHS = 0.6;

/** A big, fast animal close by (the turtle, a lionfish, a chasing fish) startles the cephalopods. */
export function threatNear(me: CritterNeighbour, world: CritterWorld, r: number): CritterNeighbour | CritterThreatFish | null {
  for (const o of world.critters) if (o !== me && !o.sp.predator && o.pos.distanceTo(me.pos) < r + o.radius) return o;
  for (const f of world.fish) if (f.size > BIG_FISH_SIZE && f.speed > f.size * FAST_FISH_BODY_LENGTHS && f.pos.distanceTo(me.pos) < r) return f;
  return null;
}
