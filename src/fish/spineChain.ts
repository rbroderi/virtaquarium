// The moray's body as a path: the head lays down a trail and the body follows it (follow the leader),
// so a turn flows down the body through the same curve instead of swinging it like a stick, and the
// body passes over a ledge where the head did. An anguilliform travelling wave runs head to tail on top
// of the path. The body is drawn from stations spaced evenly along its length, each with its own frame
// (the swim shader's uPath / uPathUp), so it can take any curve, and each station as drawn is kept out
// of the rock.
//
// The trail: points about L/48 apart, newest first, behind the head. Swimming forward the head adds
// points and the tail end is trimmed to one body length; backing, points the head has passed back over
// are dropped and the tail end grows out behind (tail first, steered into the burrow when going home).
// Near the rock the trail settles onto it, so a slow eel lies along the contours. Lurking at home, the
// body behind the cave mouth is drawn into line along the burrow, leaving the head and neck free.
import * as THREE from 'three';
import { clamp } from '../util.js';
import type { SwimWorld } from '../world/ports.js';

/** Drawn stations, head (x = 0.5) to tail (x = -0.5): must match SWIM_GLSL's uPath. */
export const SPINE_NODES = 24;
const STEPS = SPINE_NODES - 1;
/** Trail points per body length. */
const TRAIL_PER_L = 48;
/** A head step longer than this many body lengths is a teleport: lay the body out straight again. */
const TELEPORT_BL = 0.4;

/**
 * Anguilliform wave (Tytell & Lauder 2004, American eel): wavelength ~0.6 L, so one to two bends show;
 * lateral amplitude small at the head (it stays steady) rising to ~0.1 L at the tail. Times uAmp.
 */
const WAVE_K = (2 * Math.PI) / 0.6;
const WAVE_HEAD = 0.012;
const WAVE_GROWTH = 0.088;
/**
 * Head lift (uLift) shape: x past this point of the body is raised, quadratically (lift 1 raises the
 * snout 0.4 L); from just behind the cave mouth, so the neck stays clear of the cave roof.
 */
const LIFT_START = 0.2;
const LIFT_GAIN = 0.4 / (0.5 - LIFT_START) ** 2;
/** Body radius kept off the rock: about half the body depth. */
const CLEARANCE_OF_DEPTH = 0.45;
/** Collision passes over the drawn stations. */
const COLLIDE_PASSES = 2;
/** The trail sinks onto rock or sand within this many units below it, at this rate (units/s). */
const DRAPE_REACH = 0.25;
const DRAPE_RATE = 0.12;
/** ... a floor being rock whose surface normal is at least this upright; not the neck, which the head carries. */
const DRAPE_FLOOR = 0.6;
const DRAPE_NECK = 0.1;
/** Lurking within this distance of home, the body behind the mouth is drawn into line along the burrow. */
const LURK_HOLD_RANGE = 0.6;
/** ... from the cave mouth (this far along the body, in body lengths from the head) back, at this rate (1/s); */
const LURK_NECK = 0.25;
const LURK_HOLD_RATE = 2;
/** ... and the neck ahead of it bends smoothly to the head, at this rate (1/s). */
const LURK_NECK_RATE = 4;
/** Backing home, the tail end steers into the burrow turning at most this much per unit grown (rad). */
const TAIL_STEER = 2.5;

/** What the path reads from the fish it belongs to. */
export interface SpineBody {
  readonly pos: THREE.Vector3;
  readonly dir: THREE.Vector3;
  readonly size: number;
  readonly sp: { readonly body: { readonly depth: number } };
  /** The head lift (uLift), in the shader's units. */
  readonly lift: number;
  inBurrow(p: THREE.Vector3): boolean;
  readonly brain: { readonly mode: string; readonly home: THREE.Vector3; readonly lurkDir: THREE.Vector3 | null };
}

/** The travelling wave this step: phase (rad) and amplitude (uAmp). */
export interface SpineWave { readonly phase: number; readonly amp: number }

type ChainWorld = Pick<SwimWorld, 'rockDist' | 'rockNormal' | 'bounds'>;

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3(), _n = new THREE.Vector3();
const _head = new THREE.Vector3();

/** Body radius the path keeps off the rock surface (rockField.ts), in units. */
export const spineClearance = (fish: SpineBody): number => CLEARANCE_OF_DEPTH * fish.sp.body.depth * fish.size;

/** Where station i sits along the body: 0.5 at the head .. -0.5 at the tail. */
export const stationX = (i: number): number => 0.5 - i / STEPS;

/** Head lift of a station at body position x, in body lengths: the front of the body raised out of the crevice. */
const liftAt = (lift: number, x: number): number => lift * Math.max(0, x - LIFT_START) ** 2 * LIFT_GAIN;

/** Lateral wave offset at body position x, in body lengths. */
export const waveAt = (w: SpineWave, x: number): number => w.amp * (WAVE_HEAD + WAVE_GROWTH * (0.5 - x)) * Math.sin(w.phase + x * WAVE_K);

const finite = (p: THREE.Vector3): boolean => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);

function makeNodes(n: number): THREE.Vector3[] {
  return Array.from({ length: n }, () => new THREE.Vector3());
}

export class SpineChain {
  /** Trail behind the head, newest first. */
  private trail: THREE.Vector3[] = [];
  private readonly spare: THREE.Vector3[] = [];
  /** Arc length of each trail point from the head. */
  private arc: number[] = [];
  /** Stations: on the path (base), as drawn (wave, lift, collision), and each drawn station's up. */
  private readonly base = makeNodes(SPINE_NODES);
  private readonly drawnP = makeNodes(SPINE_NODES);
  private readonly ups = makeNodes(SPINE_NODES);
  private readonly lastHead = new THREE.Vector3();
  /** Scratch for the held body in the burrow. */
  private readonly held: THREE.Vector3[] = [];
  private ready = false;

  /** The body as drawn, head to tail, in world space (read-only view for checks). */
  get nodes(): readonly THREE.Vector3[] {
    return this.drawnP;
  }

  private st(a: readonly THREE.Vector3[], i: number): THREE.Vector3 {
    const n = a[i];
    if (!n) throw new RangeError(`spine station ${i}`);
    return n;
  }

  private point(): THREE.Vector3 {
    return this.spare.pop() ?? new THREE.Vector3();
  }

  update(dt: number, fish: SpineBody, world: ChainWorld, wave: SpineWave, up: THREE.Vector3): void {
    const L = fish.size, ds = L / TRAIL_PER_L;
    const head = _head.copy(fish.pos).addScaledVector(fish.dir, 0.5 * L);
    if (!this.ready || head.distanceTo(this.lastHead) > TELEPORT_BL * L) this.layOutStraight(head, fish.dir, ds, L);
    this.lastHead.copy(head);
    this.dropPassed(head, fish.dir);
    this.lead(head, ds);
    this.fitLength(head, fish, ds, L);
    this.settle(dt, head, fish, world);
    this.holdInBurrow(dt, head, fish);
    this.fitLength(head, fish, ds, L);
    this.sample(head, L);
    this.draw(fish, world, wave, up);
    // Never let a bad step (a NaN from anywhere) stick: lay the body out straight again next time.
    if (!this.drawnP.every(finite) || !this.trail.every(finite)) this.ready = false;
  }

  private layOutStraight(head: THREE.Vector3, dir: THREE.Vector3, ds: number, L: number): void {
    this.spare.push(...this.trail);
    this.trail = [];
    for (let k = 1; k * ds <= L + 1e-6; k++) this.trail.push(this.point().copy(head).addScaledVector(dir, -k * ds));
    this.ready = true;
  }

  /** Backing: trail points now ahead of the head (by its facing) are no longer behind it. */
  private dropPassed(head: THREE.Vector3, dir: THREE.Vector3): void {
    while (this.trail.length > 2) {
      const p = this.st(this.trail, 0);
      if (_t.subVectors(p, head).dot(dir) <= 0) break;
      this.spare.push(p);
      this.trail.shift();
    }
  }

  /** The head lays down trail points every ds behind it as it goes. */
  private lead(head: THREE.Vector3, ds: number): void {
    for (;;) {
      const p0 = this.st(this.trail, 0), d = head.distanceTo(p0);
      if (!(d > ds)) return;   // (NaN too)
      this.trail.unshift(this.point().copy(p0).addScaledVector(_t.subVectors(head, p0), ds / d));
    }
  }

  /**
   * One body length of trail: the tail end trimmed, or grown out behind along its own heading (backing
   * home, turned towards the far end of the burrow so the tail leads the body in).
   */
  private fitLength(head: THREE.Vector3, fish: SpineBody, ds: number, L: number): void {
    const tr = this.trail, arc = this.arc;
    arc.length = tr.length;
    let s = 0, prev = head;
    for (let k = 0; k < tr.length; k++) {
      const p = this.st(tr, k);
      s += p.distanceTo(prev);
      arc[k] = s;
      prev = p;
      if (s >= L && k >= 1) {
        // Cut here: this point moves back to exactly L, the rest go.
        const before = k ? this.st(tr, k - 1) : head, sb = k ? (arc[k - 1] ?? 0) : 0;
        p.lerpVectors(before, p, (L - sb) / Math.max(s - sb, 1e-9));
        arc[k] = L;
        this.spare.push(...tr.splice(k + 1));
        arc.length = tr.length;
        return;
      }
    }
    // Short: grow the tail end.
    const b = fish.brain, homing = b.mode === 'lurk' && b.lurkDir;
    const end = this.st(tr, tr.length - 1), pen = tr.length > 1 ? this.st(tr, tr.length - 2) : head;
    const heading = _a.subVectors(end, pen).normalize();
    if (heading.lengthSq() < 0.5) heading.copy(fish.dir).negate();
    while (s < L - 1e-6) {
      const step = Math.min(ds, L - s), last = this.st(tr, tr.length - 1);
      if (homing && b.lurkDir) {
        _b.copy(b.home).addScaledVector(b.lurkDir, -0.5 * L).sub(last).normalize();
        const ang = Math.acos(clamp(heading.dot(_b), -1, 1)), turn = Math.min(1, (TAIL_STEER * step) / Math.max(ang, 1e-6));
        if (ang > 1e-4) heading.lerp(_b, turn).normalize();
      }
      tr.push(this.point().copy(last).addScaledVector(heading, step));
      s += step;
      arc.push(s);
    }
  }

  /**
   * The trail keeps a body radius off the rock and sand, and near them sinks onto them (a moray is
   * slightly heavier than water and lies along the reef). Not in its burrow, where it may lie in the rock.
   */
  private settle(dt: number, head: THREE.Vector3, fish: SpineBody, world: ChainWorld): void {
    const R = spineClearance(fish), sand = world.bounds.y0 + R;
    const lurking = fish.brain.mode === 'lurk';
    for (const p of this.trail) {
      if (fish.inBurrow(p)) continue;
      let d = world.rockDist(p);
      // Only onto a floor (rock whose surface faces up, or the sand) close below: not down a wall.
      const onFloor = (d < R + DRAPE_REACH && d > R * 1.05 && world.rockNormal(p, _n).y > DRAPE_FLOOR) || (p.y < sand + DRAPE_REACH && p.y > sand + 0.05 * R);
      if (!lurking && onFloor && p.distanceTo(head) > DRAPE_NECK * fish.size) {
        p.y -= DRAPE_RATE * dt;
        d = world.rockDist(p);
      }
      if (d < R) p.addScaledVector(world.rockNormal(p, _n), R - d);
      if (p.y < sand) p.y = sand;
    }
  }

  /**
   * Lurking at home, the body behind the cave mouth lies along its burrow (inBurrow), straight back from
   * home, so the tail stays hidden in the rock instead of snaking out of it. The neck stays free, so the
   * head sways on it.
   */
  private holdInBurrow(dt: number, head: THREE.Vector3, fish: SpineBody): void {
    const b = fish.brain, L = fish.size;
    if (!b.lurkDir || b.mode !== 'lurk' || fish.pos.distanceTo(b.home) >= LURK_HOLD_RANGE) return;
    // Level along the floor of the cave, under its roof; the neck does the rising.
    const axis = _n.set(b.lurkDir.x, 0, b.lurkDir.z).normalize();
    const kBody = 1 - Math.exp(-LURK_HOLD_RATE * dt), kNeck = 1 - Math.exp(-LURK_NECK_RATE * dt);
    // The neck: a smooth bend (cubic Hermite) from the head, along its heading, to where the body leaves
    // the burrow's axis inside the cave. The head's sway bends it as a whole, rather than leaving the
    // path it swept in the neck.
    const sa = LURK_NECK * L;
    const anchor = _c.copy(b.home).addScaledVector(axis, 0.5 * L - sa);
    const m0 = _a.copy(fish.dir).multiplyScalar(-sa), m1 = _b.copy(axis).multiplyScalar(-sa);
    // Resampled by length along the body, so the head's sway doesn't feed trail down into the body
    // (each point is held at its place along the body, not carried back as the head lays new ones).
    const ds = L / TRAIL_PER_L, n = TRAIL_PER_L, held = this.held;
    for (let j = 0; j < n; j++) {
      const s = (j + 1) * ds, p = held[j] ?? (held[j] = new THREE.Vector3());
      this.at(head, s, p);
      if (s >= sa) {
        p.lerp(_t.copy(b.home).addScaledVector(axis, 0.5 * L - s), kBody);
        continue;
      }
      const t = s / sa, t2 = t * t, t3 = t2 * t;
      _t.copy(head).multiplyScalar(2 * t3 - 3 * t2 + 1).addScaledVector(m0, t3 - 2 * t2 + t)
        .addScaledVector(anchor, -2 * t3 + 3 * t2).addScaledVector(m1, t3 - t2);
      p.lerp(_t, kNeck);
    }
    this.spare.push(...this.trail);
    this.trail = held.slice(0, n).map((p) => this.point().copy(p));
  }

  /** The point s along the body (head, then the trail), by the arc lengths fitLength measured. */
  private at(head: THREE.Vector3, s: number, out: THREE.Vector3): THREE.Vector3 {
    const tr = this.trail, arc = this.arc;
    let k = 0;
    while (k < tr.length - 1 && (arc[k] ?? 0) < s) k++;
    const a = k ? this.st(tr, k - 1) : head, sa = k ? (arc[k - 1] ?? 0) : 0, sb = arc[k] ?? sa;
    return out.lerpVectors(a, this.st(tr, k), sb > sa ? clamp((s - sa) / (sb - sa), 0, 1) : 1);
  }

  /** Stations evenly along the path (head, then the trail), by arc length. */
  private sample(head: THREE.Vector3, L: number): void {
    for (let i = 0; i < SPINE_NODES; i++) this.at(head, (i / STEPS) * L, this.st(this.base, i));
  }

  /** Frames carried down the body from the head's up (parallel transport), so they never flip. */
  private transport(pts: readonly THREE.Vector3[], up: THREE.Vector3): void {
    let prevUp: THREE.Vector3 = up;
    for (let i = 0; i < SPINE_NODES; i++) {
      const T = this.tangent(pts, i, _t), u = this.st(this.ups, i);
      u.copy(prevUp).addScaledVector(T, -prevUp.dot(T));
      if (u.lengthSq() < 1e-8) u.copy(prevUp);
      u.normalize();
      prevUp = u;
    }
  }

  /** Unit tangent at station i, pointing towards the head. */
  private tangent(pts: readonly THREE.Vector3[], i: number, out: THREE.Vector3): THREE.Vector3 {
    const a = this.st(pts, Math.max(0, i - 1)), b = this.st(pts, Math.min(STEPS, i + 1));
    out.subVectors(a, b);
    const l = out.length();
    return l > 1e-9 ? out.multiplyScalar(1 / l) : out.set(1, 0, 0);
  }

  /**
   * The stations as drawn: the travelling wave across each station's frame and the head lift, then each
   * kept off the rock by the same field the other fish use (which holds every rock and cave roof in 3D):
   * pushed out along the surface normal to the body's radius, and off the sand. In its burrow (the
   * crevice behind the cave, where the body runs on into the reef) the body may be in the rock, but
   * wholly: a station within a body radius of the surface goes to whichever side is nearer, fully in or
   * fully out, so the tail never straddles the surface and shows through it.
   */
  private draw(fish: SpineBody, world: ChainWorld, wave: SpineWave, up: THREE.Vector3): void {
    const L = fish.size, R = spineClearance(fish), sand = world.bounds.y0 + R;
    this.transport(this.base, up);
    for (let i = 0; i < SPINE_NODES; i++) {
      const x = stationX(i), T = this.tangent(this.base, i, _t), U = this.st(this.ups, i);
      const side = _a.crossVectors(T, U);
      const p = this.st(this.drawnP, i).copy(this.st(this.base, i))
        .addScaledVector(side, waveAt(wave, x) * L).addScaledVector(up, liftAt(fish.lift, x) * L);
      for (let pass = 0; pass < COLLIDE_PASSES; pass++) {
        const d = world.rockDist(p);
        if (fish.inBurrow(p)) {
          if (Math.abs(d) < R) p.addScaledVector(world.rockNormal(p, _n), (d < 0 ? -R : R) - d);
          break;
        }
        if (d < R) p.addScaledVector(world.rockNormal(p, _n), R - d);
        else break;
      }
      if (!fish.inBurrow(p) && p.y < sand) p.y = sand;
    }
    this.transport(this.drawnP, up);
  }

  /**
   * The drawn stations and their ups in the fish's own frame (the model's: x along dir, y up, z side,
   * in body lengths), for uPath and uPathUp.
   */
  write(path: Float32Array, ups: Float32Array, fish: SpineBody, up: THREE.Vector3, side: THREE.Vector3): void {
    const L = fish.size, dir = fish.dir;
    for (let i = 0; i < SPINE_NODES; i++) {
      _b.subVectors(this.st(this.drawnP, i), fish.pos);
      const u = this.st(this.ups, i);
      // (A NaN in a uniform array breaks three's upload: write the straight body instead.)
      const ok = finite(_b) && finite(u);
      path[i * 3] = ok ? _b.dot(dir) / L : stationX(i);
      path[i * 3 + 1] = ok ? _b.dot(up) / L : 0;
      path[i * 3 + 2] = ok ? _b.dot(side) / L : 0;
      ups[i * 3] = ok ? u.dot(dir) : 0;
      ups[i * 3 + 1] = ok ? u.dot(up) : 1;
      ups[i * 3 + 2] = ok ? u.dot(side) : 0;
    }
  }
}
