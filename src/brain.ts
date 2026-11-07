// Each fish owns a Brain: a personality (traits), internal drives that rise and fall over time,
// perception of its surroundings, and utility-based action selection. The behaviours themselves are
// Strategies (brain/behaviours/, ordered by brain/registry.ts): each scores the mode and, while it is
// active, steers. The chosen behaviour produces a steering goal that the body (fish.ts) turns into
// actual swimming.
import * as THREE from 'three';
import { clamp, range, type Rng } from './util.js';
import { CAVE_RANGE, newCaveClock, tickCaveClock, type CaveClock } from './brain/caveClock.js';
import type { Fish } from './fish.js';
import type { Shelter } from './reef/types.js';
import type { SwimWorld } from './world/ports.js';
import type { Food, Threat } from './world/types.js';
import type { DecisionContext, Steering, SteerContext } from './brain/behaviour.js';
import { BEHAVIOURS, behaviourFor } from './brain/registry.js';
import { applyReflexes } from './brain/reflexes.js';
import { MODES, type Drives, type Mode, type ModeScores, type Personality } from './brain/types.js';

export { MODES, isMode, type Mode, type Drives, type Personality, type ModeScores } from './brain/types.js';
export type { Behaviour, DecisionContext, SteerContext, Steering } from './brain/behaviour.js';
export { BEHAVIOURS, behaviourFor } from './brain/registry.js';

/** Seconds between decisions (5 Hz). */
const THINK_INTERVAL = 0.2;
/** Individual variation of each inherited trait. */
const TRAIT_JITTER = 0.3;
/** Decision noise amplitude, and the bonus for staying in the current mode (hysteresis). */
const DECISION_NOISE = 0.08;
const STAY_BONUS = 0.15;
/** The share of its pace a fish keeps when touching the fish ahead of it. */
const CROWD_SLOW = 0.35;
/** A fish's own spot in a shelter: this share of its radius from the centre, plus up to SPREAD more. */
const OWN_SPOT_NEAR = 0.25;
const OWN_SPOT_SPREAD = 0.5;
/** Room from the rock (body lengths) a spot needs, or the fish takes the centre. */
const OWN_SPOT_ROOM = 0.4;
/** A mode is held at least this long unless the new one is urgent (flee, feed). */
const MIN_MODE_SECONDS = 1.5;

/** Perception reach (units): fish further than this are not considered at all. */
const PERCEPTION_RANGE = 8;
/** Shoalmates within this distance, the nearest few of them. */
const SHOAL_RANGE = 3.0;
const MAX_NEIGHBOURS = 4;
/** Fear contagion: hops before a flight stops spreading, and the refractory time after catching one. */
const MAX_HOPS = 3;
const CONTAGION_REFRACTORY = 8;
/** A fear jump bigger than this is a new scare (counted in the stats). */
const NEW_SCARE = 0.15;
const PREDATOR_WARY_RANGE = 3.5;
const PATROL_THREAT_RANGE = 2.5;
const CRITTER_THREAT_RANGE = 3;
const VIEWER_THREAT_RANGE = 3;
/** Food is noticed only above this hunger. */
const HUNGER_TO_NOTICE_FOOD = 0.08;
/** Fear below this is forgotten (and the threat with it). */
const FEAR_FORGOTTEN = 0.05;

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

/** The strongest scare found while perceiving, and whether it was second-hand (its hop count). */
interface Scare {
  stim: number;
  threat: Threat | null;
  /** > 0: the threat is a neighbour's flight (its hop count), not something seen first-hand. */
  social: number;
}

export class Brain {
  readonly fish: Fish;
  readonly rng: Rng;
  readonly traits: Personality;
  readonly drives: Drives;
  mode: Mode = 'cruise';
  modeTime = 0;
  thinkClock: number;
  readonly target = new THREE.Vector3();
  targetTimer = 0;
  pecking = 0;
  inspectDone = false;
  readonly home = new THREE.Vector3();
  threat: Threat | null = null;
  /** The fish being chased, cleaned or stalked. */
  focus: Fish | null = null;
  focusFood: Food | null = null;
  readonly neighbors: Fish[] = [];
  intruder: Fish | null = null;
  readonly scores: ModeScores = {};
  thought: string = MODES.cruise;
  orbit: number;
  /** Territorial disputes wear off; rivals settle into a truce. */
  chaseFatigue = 0;
  /** Habituation to the viewer (0..1). */
  habit = 0;
  /** Fish that have beaten this one, and how often. */
  lostTo: Map<Fish, number> | undefined = undefined;
  /** Shelter the fish knows near home (main assigns it), and the one it is in now. */
  shelter: Shelter | null = null;
  sheltered: Shelter | null = null;
  /** An eel's cave direction (unit, facing out), or null. */
  lurkDir: THREE.Vector3 | null = null;
  /** How close the nearest body ahead is (reflexes avoidBody): 0 clear, 1 touching. The fish slows. */
  crowding = 0;
  /** Reverse swimming speed (units/s), set while an eel backs into its cave. */
  backing = 0;
  /** An eel's cave clock: when it should be in its cave and when out on a foray (brain/caveClock.ts). */
  readonly cave: CaveClock | null;
  /** Remembered reef top ahead (reflexes). */
  reefSeen: number | undefined = undefined;
  /** The rock-avoidance turn, smoothed over time (reflexes), so a flipping surface normal can't jerk the fish. */
  readonly rockSteer = new THREE.Vector3();
  /** Client posing at the cleaning station. */
  posing = false;
  /** Lionfish: seconds left of a lunge, and of the rest after one. */
  striking = 0;
  strikeCool = 0;
  /** Cleaner: seconds to the next pick. */
  peckT = 0;
  /** Fear contagion: hops from the first-hand witness, and when this fish last caught a flight. */
  hop = 0;
  caught: number | undefined = undefined;
  /** Stats the motion check reports. */
  strikes = 0;
  contagions = 0;
  firstHand = 0;

  private readonly near: [number, Fish][] = [];
  private readonly shelterTarget = new THREE.Vector3();
  private readonly steering: Steering = { speed: 0, clearance: 0 };

  constructor(fish: Fish, rng: Rng) {
    this.fish = fish;
    this.rng = rng;
    const b = fish.sp.brain;
    const jitter = (v: number): number => clamp(v + (rng() - 0.5) * TRAIT_JITTER, 0, 1);
    this.traits = {
      boldness: jitter(b.boldness),
      curiosity: jitter(b.curiosity),
      activity: jitter(b.activity),
      sociability: jitter(b.school || 0),
      aggression: jitter(b.territorial || 0),
      appetite: jitter(0.5),
    };
    this.drives = {
      hunger: range(rng, 0.1, 0.5),
      energy: range(rng, 0.6, 1.0),
      fear: 0,
      social: 0.5,
      boredom: rng() * 0.5,
      parasites: b.client ? range(rng, 0, 0.6) : 0,
    };
    this.thinkClock = rng() * THINK_INTERVAL;
    this.orbit = rng() * Math.PI * 2;
    this.cave = b.lurker ? newCaveClock(rng) : null;
  }

  /** Something scary happened nearby (a chase, a predator, a sudden splash). */
  startle(source: Threat, amount: number): void {
    const f = amount * (1 - 0.6 * this.traits.boldness);
    if (f > this.drives.fear) {
      this.drives.fear = clamp(f, 0, 1);
      this.threat = source;
    }
  }

  update(dt: number, world: SwimWorld): void {
    this.updateDrives(dt, world);
    this.modeTime += dt;
    if (this.cave) tickCaveClock(this.cave, dt, 1 - world.light, this.fish.pos.distanceTo(this.home) < CAVE_RANGE, this.rng);
    this.thinkClock -= dt;
    if (this.thinkClock <= 0) {
      this.thinkClock = THINK_INTERVAL;
      this.perceive(world);
      this.decide(world);
    }
  }

  private updateDrives(dt: number, world: SwimWorld): void {
    const d = this.drives, t = this.traits, sp = this.fish.sp.brain;
    const dark = 1 - world.light;
    const effort = this.fish.speed / sp.maxSpeed;
    d.hunger = clamp(d.hunger + dt * 0.005 * (0.6 + t.appetite), 0, 1);
    if (this.mode === 'rest' || this.mode === 'hover') d.energy += dt * 0.025;
    else d.energy -= dt * (0.0015 + 0.004 * effort);
    // Diurnal fish tire at night; nocturnal ones in daylight.
    d.energy -= dt * 0.004 * (sp.nocturnal ? world.light : dark);
    d.energy = clamp(d.energy, 0, 1);
    d.fear *= Math.exp(-dt * 0.45);
    if (d.fear < FEAR_FORGOTTEN) this.threat = null;
    if (sp.school > 0) {
      const alone = this.neighbors.length === 0;
      d.social = clamp(d.social + dt * (alone ? 0.06 : -0.03), 0, 1);
    }
    d.boredom = clamp(d.boredom + dt * 0.012 * (0.5 + t.curiosity), 0, 1);
    if (sp.client) d.parasites = clamp(d.parasites + dt * 0.003, 0, 1);   // ~5 min from clean to itching
    this.chaseFatigue = clamp(this.chaseFatigue + (this.mode === 'patrol' && this.focus ? dt / 12 : -dt / 45), 0, 1);
    if (this.strikeCool > 0) this.strikeCool -= dt;
    // Habituation to the viewer: builds while watching it, fades over a few minutes.
    const watching = this.mode === 'inspect' && (world.viewer?.activity ?? 0) > 0.2;
    this.habit = clamp(this.habit + (watching ? dt / 40 : -dt / 200), 0, 1);
  }

  /**
   * Perception. Vision covers all round but a blind cone behind (reef fish see ~330 degrees), reaches
   * further for bigger targets and shrinks in the dark, and is blocked by rock. The lateral line senses
   * anything moving within about a body length whatever the light or the rock (Partridge & Pitcher
   * 1980: blinded saithe still school by it), so shoals loosen but hold together at night.
   */
  senses(o: Fish, dist: number, world: SwimWorld): boolean {
    const me = this.fish;
    if (dist < 1.2 * me.size + 0.5 * o.size) return true;   // lateral line
    const reach = (2.5 + 4 * me.size) * (0.25 + 0.75 * world.light) * clamp(o.size / 0.6, 0.6, 1.8);
    if (dist > reach) return false;
    _v.subVectors(o.pos, me.pos);
    if (_v.dot(me.dir) < -0.85 * dist) return false;   // directly behind
    return world.lineOfSight(me.pos, o.pos);
  }

  private perceive(world: SwimWorld): void {
    const me = this.fish, sp = me.sp.brain;
    this.neighbors.length = 0;
    this.intruder = null;
    const scare: Scare = { stim: 0, threat: null, social: 0 };
    this.near.length = 0;
    for (const o of world.fish) {
      if (o === me) continue;
      const dist = o.pos.distanceTo(me.pos);
      if (dist > PERCEPTION_RANGE || !this.senses(o, dist, world)) continue;
      // Shoalmates: the nearest few that can be sensed (topological, not every fish in a radius: Katz et
      // al. 2011, Herbert-Read et al. 2011).
      if (o.sp === me.sp && dist < SHOAL_RANGE) this.near.push([dist, o]);
      this.catchFear(o, dist, world, scare);
      this.watchForPredator(o, dist, scare);
      if (o.brain.mode === 'patrol' && o.brain.focus === me && dist < PATROL_THREAT_RANGE) {
        consider(scare, 1 - dist / PATROL_THREAT_RANGE, o, 0);
      }
      this.noticeIntruder(o, dist);
    }
    // The cuttlefish and octopus eat small fish.
    if (sp.prey) for (const o of world.critters) {
      const dist = o.pos.distanceTo(me.pos);
      if (o.sp.predator && dist < CRITTER_THREAT_RANGE && (dist < 1.2 * me.size + o.radius || world.lineOfSight(me.pos, o.pos))) {
        consider(scare, (1 - dist / CRITTER_THREAT_RANGE) * 0.8, o, 0);
      }
    }
    // Shy fish back off from movement at the glass.
    const vw = world.viewer;
    const shy = sp.shy || 0;
    if (vw && vw.activity > 0.3 && shy > 0.5) {
      const dist = vw.pos.distanceTo(me.pos);
      if (dist < VIEWER_THREAT_RANGE) consider(scare, 0.4 * vw.activity * shy * (1 - dist / VIEWER_THREAT_RANGE), vw, 0);
    }
    if (scare.threat) this.reactToScare(scare, world);
    this.near.sort((a, b) => a[0] - b[0]);
    for (let i = 0; i < Math.min(MAX_NEIGHBOURS, this.near.length); i++) {
      const entry = this.near[i];
      if (entry) this.neighbors.push(entry[1]);
    }
    this.focusFood = this.spotFood(world);
  }

  /**
   * Fear is contagious: a fish that sees a neighbour bolt bolts too, away from what scared it, so a
   * startle runs through a shoal as a wave (Rosenthal et al. 2015), limited by who can see whom. Only
   * the first second of a flight passes it on, and a fish caught by one ignores others for a few
   * seconds, so it doesn't ping-pong. A flight only passes on as a dash beyond the fish's sustainable
   * speed, weakens with each fish it passes through (hop), and dies out after three.
   */
  private catchFear(o: Fish, dist: number, world: SwimWorld, scare: Scare): void {
    const me = this.fish, ob = o.brain;
    if (ob.mode !== 'flee' || ob.modeTime >= 1 || ob.hop >= MAX_HOPS) return;
    if (!(o.speed > 1.1 * o.sp.swim.maxBL * o.size) || !(world.time - (this.caught ?? -99) > CONTAGION_REFRACTORY)) return;
    const reach = 3 * me.size + 1, kin = o.sp === me.sp ? 1 : 0.55;
    if (dist >= reach) return;
    const s = 0.6 * (1 - dist / reach) * kin * (me.sp.brain.prey ? 1 : 0.6) * 0.6 ** ob.hop;
    if (s > scare.stim) {
      scare.stim = s;
      scare.threat = ob.threat ?? { pos: o.pos.clone().addScaledVector(o.dir, -2) };
      scare.social = ob.hop + 1;
    }
  }

  /**
   * Small prey species are wary of the lionfish and of anything chasing them. A predator that is just
   * there is watched and kept at a distance; one closing in is fled from.
   */
  private watchForPredator(o: Fish, dist: number, scare: Scare): void {
    const me = this.fish;
    if (!me.sp.brain.prey || !o.sp.brain.predator || dist >= PREDATOR_WARY_RANGE) return;
    _w.subVectors(me.pos, o.pos);
    const closing = clamp(o.vel.dot(_w) / Math.max(dist, 1e-3) / (0.5 * me.size), 0, 1);
    consider(scare, (1 - dist / PREDATOR_WARY_RANGE) * 0.9 * (0.3 + 0.7 * closing), o, 0);
  }

  /** Territorial fish notice intruders near home, mostly their own kind or similar-sized fish. */
  private noticeIntruder(o: Fish, dist: number): void {
    const me = this.fish;
    if (this.traits.aggression <= 0.3 || o.sp.brain.predator) return;
    const nearHome = o.pos.distanceTo(this.home) < 2.0;
    const rival = o.sp === me.sp || Math.abs(o.sp.size - me.sp.size) < 0.3;
    if (nearHome && rival && (!this.intruder || dist < this.intruder.pos.distanceTo(me.pos))) this.intruder = o;
  }

  private reactToScare(scare: Scare, world: SwimWorld): void {
    if (!scare.threat) return;
    const before = this.drives.fear;
    this.startle(scare.threat, scare.stim);
    if (this.drives.fear > before + NEW_SCARE) {   // a new scare, not fear topped up by the same one
      this.hop = scare.social;   // 0: saw the danger itself
      if (scare.social) { this.caught = world.time; this.contagions += 1; }
      else this.firstHand += 1;
    }
  }

  /**
   * Food within sight: bold, hungry fish notice from further away; less far in dim light, not through
   * rock (flakes on the sand behind a rock are found by searching, not seen).
   */
  private spotFood(world: SwimWorld): Food | null {
    const me = this.fish;
    if (!world.food.length || this.drives.hunger <= HUNGER_TO_NOTICE_FOOD) return null;
    let best = (5 + this.traits.boldness * 5) * (0.3 + 0.7 * world.light);
    let spotted: Food | null = null;
    for (const f of world.food) {
      if (f.eaten) continue;
      const dist = f.pos.distanceTo(me.pos);
      if (dist >= best || (dist >= me.size * 1.5 && !world.lineOfSight(me.pos, f.pos))) continue;
      // Pecking order: a flake a much bigger fish is already closing on is left to it.
      if (world.fish.some((o) => o !== me && o.brain.focusFood === f && o.size > me.size * 1.3 && o.pos.distanceTo(f.pos) < dist)) continue;
      best = dist;
      spotted = f;
    }
    return spotted;
  }

  private decide(world: SwimWorld): void {
    const ctx: DecisionContext = {
      brain: this, world, drives: this.drives, personality: this.traits, species: this.fish.sp.brain, dark: 1 - world.light,
    };
    for (const b of BEHAVIOURS) this.scores[b.mode] = b.score(ctx);
    // Pick the best, with a little noise (one draw per mode, in registry order) and hysteresis.
    let best: Mode = this.mode, bestScore = -1;
    for (const b of BEHAVIOURS) {
      let v = (this.scores[b.mode] ?? 0) + (this.rng() - 0.5) * DECISION_NOISE;
      if (b.mode === this.mode) v += STAY_BONUS;
      if (v > bestScore) { bestScore = v; best = b.mode; }
    }
    const urgent = best === 'flee' || best === 'feed';
    if (best !== this.mode && (this.modeTime > MIN_MODE_SECONDS || urgent)) this.enter(best, world);
    this.thought = behaviourFor(this.mode).narrate?.(this) ?? MODES[this.mode];
  }

  private enter(mode: Mode, world: SwimWorld): void {
    behaviourFor(this.mode).exit?.(this);
    const st = world.station;
    if (st && st.client === this.fish && mode !== 'pose') st.client = null;   // leaving frees the station
    this.mode = mode;
    this.posing = false;
    this.modeTime = 0;
    this.targetTimer = 0;
    this.pecking = 0;
    this.focus = null;
    this.drives.boredom *= 0.5;
    behaviourFor(mode).enter?.(this);
  }

  /**
   * Where to swim to reach shelter sh: a ledge is entered from its open front (+z, towards the glass),
   * level with the gap; the coral from above.
   */
  shelterGoal(sh: Shelter, pos: THREE.Vector3, world: SwimWorld): THREE.Vector3 {
    const g = this.shelterTarget;
    const inside = Math.hypot(pos.x - sh.pos.x, pos.z - sh.pos.z) < sh.r;
    if (sh.kind === 'coral') return inside || pos.y < sh.top ? this.ownSpot(sh, world) : g.copy(sh.pos).setY(sh.top + 0.3);
    if (inside || (pos.z > sh.pos.z && Math.abs(pos.y - sh.pos.y) < 0.25 && Math.abs(pos.x - sh.pos.x) < 0.5)) return this.ownSpot(sh, world);
    return g.set(sh.pos.x, sh.pos.y, sh.pos.z + 0.9);
  }

  /**
   * This fish's own spot in a shelter, so a shoal sheltering together spreads through it instead of
   * all crowding its centre (they shoved each other and jittered there): a fixed bearing and distance
   * from the centre (from orbit, drawn once per fish) and, in coral, a height between its base and
   * top. Falls back to the centre when the spot is in or against the rock.
   */
  private ownSpot(sh: Shelter, world: SwimWorld): THREE.Vector3 {
    const g = this.shelterTarget, a = this.orbit;
    const frac = (v: number): number => v - Math.floor(v);
    const r = sh.r * (OWN_SPOT_NEAR + OWN_SPOT_SPREAD * frac(a * 7.31));
    g.set(sh.pos.x + Math.cos(a) * r, sh.pos.y, sh.pos.z + Math.sin(a) * r);
    if (sh.kind === 'coral' && sh.top > sh.pos.y) g.y = sh.pos.y + (sh.top - sh.pos.y) * (0.2 + 0.6 * frac(a * 3.17));
    if (world.rockDist(g) < this.fish.size * OWN_SPOT_ROOM) g.copy(sh.pos);
    return g;
  }

  /** A random point in the species' depth zone, above the reef. */
  pickZonePoint(world: SwimWorld, out: THREE.Vector3): THREE.Vector3 {
    const [a, b] = this.fish.sp.brain.zone;
    const B = world.bounds;
    const x = range(this.rng, B.x0 + 1, B.x1 - 1);
    const z = range(this.rng, B.z0 + 0.6, B.z1 - 0.6);
    const floor = world.reefHeight(x, z) + this.fish.size * 0.8;
    const top = B.y1 - 0.5;
    const f = range(this.rng, a, b);
    out.set(x, Math.max(floor, top + (floor - top) * f), z);
    return out;
  }

  /**
   * Writes the desired heading into `dir` (not normalised) and returns the desired speed as a fraction
   * of the species' maximum sustained speed, from the species' pace table (species.ts PACE).
   */
  steer(dt: number, world: SwimWorld, dir: THREE.Vector3): number {
    const me = this.fish;
    const out = this.steering;
    out.speed = 0.4;
    out.clearance = me.size * 0.45;
    dir.set(0, 0, 0);
    this.targetTimer -= dt;
    const wasBacking = this.backing;
    this.backing = 0;
    const ctx: SteerContext = {
      brain: this, me, world, dt, dir, pos: me.pos, species: me.sp.brain, pace: me.sp.pace, wasBacking, out,
    };
    behaviourFor(this.mode).steer(ctx);
    applyReflexes(this, me, world, dt, dir, out.clearance);
    // Close behind another fish it slows, down to CROWD_SLOW of its pace; a fleeing fish doesn't.
    return this.mode === 'flee' ? out.speed : out.speed * (1 - (1 - CROWD_SLOW) * this.crowding);
  }
}

/** Keeps the stronger of the scare so far and this one. */
function consider(scare: Scare, stim: number, threat: Threat, social: number): void {
  if (stim > scare.stim) {
    scare.stim = stim;
    scare.threat = threat;
    scare.social = social;
  }
}
