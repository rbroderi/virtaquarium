// Juvenile green turtle.
//
// Carapace 2.0 units (25 cm). An oval, gently domed carapace with five vertebral, four pairs of costal
// and the marginal scutes, each with the radiating orange-brown streaks of a juvenile; a pale plastron;
// head and flippers dark with pale seams between the scales. The long front flippers fly (a
// dorsoventral stroke with feathering, then a glide), the rear flippers steer.
//
// Its brain (critterBrain.ts) runs on four drives: air (it comes up to breathe every few minutes),
// hunger (it grazes the turtle grass, browses algae off the rock, and goes for food in the water),
// fatigue (it settles on a sponge or the sand) and restlessness (it gets up and cruises the tank).
import * as THREE from 'three';
import { range, clamp, lerp, type Rng } from '../util.js';
import { skin, randomTarget, Swimmer } from './shared.js';
import { carapaceTex, scaleTex, paddle } from './turtleParts.js';
import { CritterBrain, type DriveInfo } from './critterBrain.js';
import type { InspectPanel } from '../inspect.js';
import type { Critter, CritterFood, CritterSpecies, CritterWorld, JoinRule } from './types.js';

export type TurtleMode = 'cruise' | 'rest' | 'graze' | 'browse' | 'perch' | 'feed' | 'breathe';
type TurtleDrive = 'air' | 'hunger' | 'fatigue' | 'restless';

interface Flipper { readonly front: THREE.Group; readonly rear: THREE.Group; readonly s: number }

const STROKE_HZ = 0.55;
const CRUISE_SPEED = 0.45;
const SURFACE_MARGIN = 0.4;
const SPOT_TRIES = 30;
const SAND_HEIGHT = 0.25;     // rest where the reef is lower than this ...
const ROCK_HEIGHT = 0.8;      // ... graze where it is higher than this

/** Food further than this (units) goes unnoticed. */
const FOOD_RANGE = 8;
/** Modes that end settled on the bottom (it stops swimming once there). */
const SETTLING: ReadonlySet<TurtleMode> = new Set(['rest', 'graze', 'browse', 'perch']);
/** Seconds a fresh choice is kept before the brain reconsiders, and between reconsiderations after. */
const COMMIT: Readonly<Record<TurtleMode, readonly [number, number]>> = {
  cruise: [8, 16], rest: [20, 35], graze: [15, 25], browse: [12, 20], perch: [20, 35], feed: [6, 6], breathe: [1e3, 1e3],
};
const RETHINK_SECONDS = 3;
/** Drive time scales (s): air fills over a breath interval; the rest over these. */
const HUNGER_SECONDS = 360, GRAZE_SECONDS = 45, BROWSE_SECONDS = 70, FOOD_BITE = 0.12;
const TIRE_SECONDS = 300, REST_SECONDS = 50;
const FIDGET_SECONDS = 80, CRUISE_CALM_SECONDS = 40;

const DRIVES: Readonly<Record<TurtleDrive, DriveInfo>> = {
  air: { label: 'Air need', cls: 'social' },
  hunger: { label: 'Hunger', cls: 'hunger' },
  fatigue: { label: 'Tiredness', cls: 'energy' },
  restless: { label: 'Restlessness', cls: 'boredom' },
};

/** Personality: appetite (food and grazing), activity (cruising), calm (resting, perching), grazer (grass over rock). */
type TurtleTrait = 'appetite' | 'activity' | 'calm' | 'grazer';
const TRAITS: Readonly<Record<TurtleTrait, string>> = { appetite: 'Appetite', activity: 'Activity', calm: 'Calm', grazer: 'Grass lover' };

const MODE_NOTES: Readonly<Record<Exclude<TurtleMode, 'perch'>, string>> = {
  cruise: 'Cruising, flying with its long front flippers',
  rest: 'Resting on the sand',
  graze: 'Grazing on the turtle grass',
  browse: 'Browsing algae off the rock',
  feed: 'Going for the food',
  breathe: 'Coming up to the surface for air',
};

/** A shell half: a half-ellipsoid with a slightly pointed tail end and a broader front. */
const taperAt = (x: number): number => (x < 0 ? 1 - 0.12 * x * x : 1);

function carapaceGeometry(L: number): THREE.SphereGeometry {
  // Carapace: an upper half-ellipsoid. Mapped by angle from the top of the dome (not flat from above),
  // so the costal scutes reach down the steep sides and the marginals stay a narrow rim.
  const cg = new THREE.SphereGeometry(1, 56, 28, 0, Math.PI * 2, 0, Math.PI / 2);
  const cp = cg.getAttribute('position'), cuv = cg.getAttribute('uv');
  for (let i = 0; i < cp.count; i++) {
    const x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i);
    cp.setXYZ(i, x * L * 0.5, Math.pow(y, 0.85) * L * 0.24 * (1 + 0.12 * x), z * L * 0.4 * taperAt(x));   // domed highest over the front third (bourjon_immature.jpg)
    const rr = (Math.acos(clamp(y, -1, 1)) / (Math.PI / 2)) * 0.5, hz = Math.hypot(x, z) || 1;
    cuv.setXY(i, 0.5 + (x / hz) * rr, 0.5 + (z / hz) * rr);
  }
  cg.computeVertexNormals();
  return cg;
}

function plastronGeometry(L: number): THREE.SphereGeometry {
  // Plastron: a shallow lower dome on the carapace's own rim, closing the shell.
  const pg = new THREE.SphereGeometry(1, 56, 10, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), pp = pg.getAttribute('position');
  for (let i = 0; i < pp.count; i++) {
    const x = pp.getX(i), y = pp.getY(i), z = pp.getZ(i);
    pp.setXYZ(i, x * L * 0.5, y * L * 0.05, z * L * 0.4 * taperAt(x));
  }
  pg.computeVertexNormals();
  return pg;
}

export class Turtle implements Critter {
  readonly kind = 'turtle' as const;
  readonly sp: CritterSpecies;
  readonly radius: number;
  /** Carapace length (units). */
  readonly L: number;
  /** Click-proxy radius for the inspection overlay. */
  readonly pickRadius: number;
  readonly model = new THREE.Group();
  readonly head = new THREE.Group();
  readonly buildMs = 0;
  // Where parts are attached (and may run into each other): critterCheck.ts.
  readonly joins: readonly JoinRule[] = [['shell', 'plastron'], ['head', 'neck'], ['eye*', 'head'], ['neck', 'collar'], ['neck', 'shell'], ['neck', 'plastron'], ['collar', 'shell'], ['collar', 'plastron'],
    ['shoulder*', 'shell'], ['shoulder*', 'plastron'], ['shoulder*', 'collar'], ['flipper*', 'shoulder*'], ['hip*', 'shell'], ['hip*', 'plastron'], ['rearflipper*', 'hip*']];
  readonly body: Swimmer;
  readonly pos: THREE.Vector3;
  mode: TurtleMode = 'cruise';
  modeT: number;
  target: THREE.Vector3;
  private readonly rng: Rng;
  private readonly flip: Flipper[] = [];
  readonly brain: CritterBrain<TurtleDrive, TurtleMode, TurtleTrait>;
  /** Seconds between breaths (air need fills over this). */
  private readonly breathEvery: number;
  /** The food it is going for, and the sponge it settled on. */
  private food: CritterFood | null = null;
  private perchName = '';
  private stroke = 0;
  private t = 0;

  constructor(sp: CritterSpecies, rng: Rng, world: CritterWorld) {
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
    const L = this.L = range(rng, 1.8, 2.1);
    this.pickRadius = 0.8 * L;
    const shell = new THREE.Mesh(carapaceGeometry(L), skin({ map: carapaceTex(rng), roughness: 0.42, metalness: 0 }, 'turtle-shell'));
    shell.castShadow = true;
    const plast = new THREE.Mesh(plastronGeometry(L), skin({ color: 0xe8d8a8, roughness: 0.6 }, 'turtle-plastron'));
    shell.name = 'shell'; plast.name = 'plastron';
    this.model.add(shell, plast);
    const fleshMat = skin({ map: scaleTex(rng), roughness: 0.55 }, 'turtle-flesh');
    this.addHead(L, fleshMat);
    this.addSoftSkin(L, fleshMat);
    this.addFlippers(L, fleshMat);
    for (const m of this.model.children) m.castShadow = true;

    const B = world.bounds;
    this.body = new Swimmer(new THREE.Vector3(range(rng, B.x0 + 3, B.x1 - 3), range(rng, 4, 7), range(rng, -0.5, 1.2)), rng() < 0.5 ? 0 : Math.PI);
    this.pos = this.body.pos;
    this.modeT = range(rng, 15, 30); this.target = randomTarget(rng, world, 3, 7);
    this.breathEvery = range(rng, 150, 300);
    this.brain = new CritterBrain(DRIVES,
      { air: range(rng, 0, 0.6), hunger: range(rng, 0.2, 0.6), fatigue: range(rng, 0.1, 0.4), restless: range(rng, 0, 0.3) },
      { appetite: rng(), activity: rng(), calm: rng(), grazer: rng() }, TRAITS);
  }

  /** Head on a short neck; the neck runs from the head back under the front of the carapace. */
  private addHead(L: number, fleshMat: THREE.Material): void {
    const head = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 18), fleshMat);
    head.scale.set(L * 0.13, L * 0.085, L * 0.09);
    head.position.x = L * 0.07;
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(L * 0.062, L * 0.085, L * 0.26, 16), fleshMat);
    neck.rotation.z = Math.PI / 2;
    neck.position.x = -L * 0.07;
    const eyeMat = new THREE.MeshStandardMaterial({ color: 0x080706, roughness: 0.1 });
    for (const s of [1, -1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(L * 0.03, 12, 10), eyeMat);
      eye.position.set(L * 0.125, L * 0.035, s * L * 0.062);
      eye.name = `eye${s > 0 ? 0 : 1}`;
      this.head.add(eye);
    }
    head.name = 'head'; neck.name = 'neck';
    this.head.add(head, neck);
    this.head.position.set(L * 0.52, -L * 0.01, 0);
    this.model.add(this.head);
  }

  /**
   * Soft skin filling the shell's openings: a collar round the neck at the front, shoulders at the
   * front flipper roots and a pad over the hips.
   */
  private addSoftSkin(L: number, fleshMat: THREE.Material): void {
    const collar = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 14), fleshMat);
    collar.scale.set(L * 0.1, L * 0.065, L * 0.17);
    collar.position.set(L * 0.38, -L * 0.015, 0);
    collar.name = 'collar';
    this.model.add(collar);
    for (const s of [1, -1]) {
      const sh = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), fleshMat);
      sh.scale.set(L * 0.1, L * 0.05, L * 0.08);
      sh.position.set(L * 0.22, -L * 0.025, s * L * 0.28);
      const hip = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), fleshMat);
      hip.scale.set(L * 0.08, L * 0.04, L * 0.07);
      hip.position.set(-L * 0.38, -L * 0.03, s * L * 0.16);
      sh.name = `shoulder${s > 0 ? 0 : 1}`; hip.name = `hip${s > 0 ? 0 : 1}`;
      this.model.add(sh, hip);
    }
  }

  /** Flippers: flattened, tapering paddles pivoting at the shoulder / hip. */
  private addFlippers(L: number, fleshMat: THREE.Material): void {
    for (const s of [1, -1]) {
      const front = new THREE.Group(), fm = new THREE.Mesh(paddle(L * 0.6, L * 0.075, L * 0.16), fleshMat);
      fm.scale.z = s; front.add(fm);
      front.position.set(L * 0.22, -L * 0.02, s * L * 0.3);
      const rear = new THREE.Group(), rm = new THREE.Mesh(paddle(L * 0.2, L * 0.08, L * 0.03), fleshMat);
      rm.scale.z = s; rear.add(rm);
      rear.position.set(-L * 0.4, -L * 0.045, s * L * 0.18);   // just under the plastron, clear of it as it turns
      rear.rotation.y = s * 0.9;
      fm.name = `flipper${s > 0 ? 0 : 1}`; rm.name = `rearflipper${s > 0 ? 0 : 1}`;
      this.model.add(front, rear);
      this.flip.push({ front, rear, s });
    }
  }

  /** The click panel, laid out as the fish panel. */
  inspect(): InspectPanel {
    return this.brain.panel(this.sp, this.mode, this.mode === 'perch' ? `Settled on ${this.perchName}` : MODE_NOTES[this.mode]);
  }

  update(dt: number, world: CritterWorld): void {
    this.t += dt; this.modeT -= dt;
    const b = this.body;
    let d = this.pos.distanceTo(this.target);
    const settled = SETTLING.has(this.mode) && d < 0.5;
    this.feelDrives(dt, settled);
    if (this.mode === 'breathe' && this.pos.y > world.bounds.y1 - SURFACE_MARGIN) { this.brain.drives.air = 0; this.decide(world, true); }
    else if (this.modeT <= 0 || (this.brain.drives.air >= 1 && this.mode !== 'breathe')) this.decide(world, false);
    if (this.mode === 'feed') this.chaseFood();
    d = this.pos.distanceTo(this.target);
    if (this.mode === 'cruise' && d < 1) this.target = randomTarget(this.rng, world, 2, 7);
    const speed = settled ? 0 : this.mode === 'breathe' ? 0.6 : this.mode === 'feed' ? 0.5 : (this.mode === 'cruise' ? CRUISE_SPEED : 0.3) * clamp(d, 0.3, 1);
    b.steer(dt, world, this.target, { turn: 0.45, speed, accel: 0.6, clearance: this.L * 0.14, look: this.L * 1.2 });
    if (settled) { b.pitch = lerp(b.pitch, 0, dt); b.roll = lerp(b.roll, 0, dt); }
    this.stroke += dt * STROKE_HZ * Math.PI * 2 * (settled ? 0 : clamp(Math.abs(b.speed) / CRUISE_SPEED, 0.25, 1.2));
    this.beatFlippers(settled);
    this.moveHead(settled);
    b.place(this.model);
  }

  /** Drives move with what it is doing: air fills always, the rest by swimming, grazing and resting. */
  private feelDrives(dt: number, settled: boolean): void {
    const br = this.brain, swimming = !settled, effort = clamp(Math.abs(this.body.speed) / CRUISE_SPEED, 0.3, 1.5);
    br.add('air', dt / this.breathEvery);
    const eating = settled && (this.mode === 'graze' || this.mode === 'browse');
    br.add('hunger', eating ? -dt / (this.mode === 'graze' ? GRAZE_SECONDS : BROWSE_SECONDS) : dt / HUNGER_SECONDS);
    br.add('fatigue', swimming ? (dt / TIRE_SECONDS) * effort : settled && (this.mode === 'rest' || this.mode === 'perch') ? -dt / REST_SECONDS : -dt / (REST_SECONDS * 4));
    br.add('restless', settled ? dt / FIDGET_SECONDS : this.mode === 'cruise' ? -dt / CRUISE_CALM_SECONDS : -dt / (CRUISE_CALM_SECONDS * 3));
  }

  /** Score every option from the drives and take the best (sticking with the current one unless beaten). */
  private decide(world: CritterWorld, fresh: boolean): void {
    const br = this.brain, { air, hunger, fatigue, restless } = br.drives, reef = world.reef;
    const food = this.nearestFood(world), appetite = br.weight('appetite'), calm = br.weight('calm'), grass = br.weight('grazer');
    const scores: Partial<Record<TurtleMode, number>> = {
      breathe: air > 0.75 ? 0.6 + (air - 0.75) * 8 : air * 0.3,
      browse: hunger * 0.85 * appetite * (2 - grass),
      rest: fatigue * 0.95 * calm,
      cruise: (0.25 + restless * 0.8) * br.weight('activity'),
    };
    if (reef.grassBeds?.length) scores.graze = hunger * 1.3 * appetite * grass;
    if (reef.perches?.length) scores.perch = fatigue * 1.2 * calm;
    if (food) scores.feed = (0.3 + hunger * 1.2) * appetite;
    const next = this.brain.choose(fresh || this.mode === 'breathe' ? null : this.mode, scores);
    if (next === this.mode && !fresh) { this.modeT = RETHINK_SECONDS; return; }
    this.go(next, world, food);
  }

  /** Start a behaviour: where it goes for it, and how long before it reconsiders. */
  private go(mode: TurtleMode, world: CritterWorld, food: CritterFood | null): void {
    const rng = this.rng, B = world.bounds;
    let target: THREE.Vector3 | null = null;
    if (mode === 'cruise') target = randomTarget(rng, world, 2, 7);
    else if (mode === 'breathe') target = new THREE.Vector3(clamp(this.pos.x + range(rng, -2, 2), B.x0 + 1, B.x1 - 1), B.y1, this.pos.z);
    else if (mode === 'feed' && food) { this.food = food; target = food.pos.clone(); }
    else if (mode === 'graze') target = this.grassSpot(world);
    else if (mode === 'perch') target = this.perchSpot(world);
    else if (mode === 'rest' || mode === 'browse') target = this.findSpot(world, mode === 'rest');
    if (!target) { mode = 'cruise'; target = randomTarget(rng, world, 2, 7); }
    this.mode = mode;
    this.target = target;
    const [lo, hi] = COMMIT[mode];
    this.modeT = range(rng, lo, hi);
  }

  private nearestFood(world: CritterWorld): CritterFood | null {
    let best: CritterFood | null = null, bestD = FOOD_RANGE;
    for (const f of world.food) if (!f.eaten) { const d = f.pos.distanceTo(this.pos); if (d < bestD) { bestD = d; best = f; } }
    return best;
  }

  /** Follow the flake as it sinks; take it when the head reaches it. */
  private chaseFood(): void {
    const f = this.food;
    if (!f || f.eaten) { this.food = null; this.modeT = 0; return; }
    this.target.copy(f.pos);
    if (this.pos.distanceTo(f.pos) < this.L * 0.55) { f.eaten = true; this.food = null; this.brain.add('hunger', -FOOD_BITE); this.modeT = 0; }
  }

  /** A spot in one of the turtle-grass beds, settled on the sand among the blades. */
  private grassSpot(world: CritterWorld): THREE.Vector3 | null {
    const beds = world.reef.grassBeds;
    if (!beds?.length) return null;
    const bed = beds[Math.floor(this.rng() * beds.length)] ?? beds[0];
    if (!bed) return null;
    const a = this.rng() * Math.PI * 2, r = Math.sqrt(this.rng()) * bed.r * 0.6;
    const x = bed.x + Math.cos(a) * r, z = bed.z + Math.sin(a) * r;
    return new THREE.Vector3(x, Math.max(world.reefHeight(x, z), 0) + this.L * 0.12, z);
  }

  /** The top of a sponge (the highest of the sponge's top under the shell), to settle on. */
  private perchSpot(world: CritterWorld): THREE.Vector3 | null {
    const perches = world.reef.perches;
    if (!perches?.length) return null;
    const p = perches[Math.floor(this.rng() * perches.length)] ?? perches[0];
    if (!p) return null;
    const B = world.bounds, x = clamp(p.pos.x, B.x0 + 1, B.x1 - 1), z = clamp(p.pos.z, B.z0 + 0.3, B.z1 - 0.3);
    let top = p.pos.y;
    for (let i = 0; i < 6; i++) top = Math.max(top, world.reefHeight(x + Math.cos(i) * p.r * 0.5, z + Math.sin(i) * p.r * 0.5));
    this.perchName = p.name;
    return new THREE.Vector3(x, top + this.L * 0.1, z);
  }

  private findSpot(world: CritterWorld, onSand: boolean): THREE.Vector3 | null {
    for (let k = 0; k < SPOT_TRIES; k++) {
      const t = randomTarget(this.rng, world, 0, 0), h = world.reefHeight(t.x, t.z);
      if (onSand ? h < SAND_HEIGHT : h > ROCK_HEIGHT) { t.y = Math.max(h, 0) + this.L * 0.12; return t; }
    }
    return null;
  }

  /** Front flippers: a power stroke down and back, recovery up, then a glide when slow; feathered. */
  private beatFlippers(settled: boolean): void {
    const ph = this.stroke, flap = Math.sin(ph), feather = Math.cos(ph);
    for (const f of this.flip) {
      const s = f.s, amp = settled ? 0.05 : 0.55;
      f.front.rotation.set(s * (flap * amp - 0.15), s * (0.55 + 0.15 * feather), -0.25 * feather * (settled ? 0 : 1), 'YXZ');
      f.rear.rotation.x = s * (0.1 + 0.15 * Math.sin(ph * 0.5 + 1) * (settled ? 0.2 : 1));
    }
  }

  /** Head: looks about, bobs down to graze. */
  private moveHead(settled: boolean): void {
    const grazing = (this.mode === 'graze' || this.mode === 'browse') && settled;
    this.head.rotation.y = Math.sin(this.t * 0.3) * 0.25;
    this.head.rotation.z = grazing ? -0.35 + 0.15 * Math.max(0, Math.sin(this.t * 3)) : Math.sin(this.t * 0.4) * 0.06;
  }
}
