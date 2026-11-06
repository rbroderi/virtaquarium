// The Roku's fish: a reduced brain (targets, fear, shoaling) and swimming on a heading in the plane of
// x and depth, turned at a limited rate, so a fish swings towards or away from the viewer as it turns
// and its size changes as it swims nearer.
import type { Rng } from '../util.js';
import { DEG_TO_RAD } from '../util.js';
import type { SceneGeometry } from './geometry.js';
import { wrapAngle } from './geometry.js';
import type { SceneEntry, ShelterSpot, SpriteSpecies } from './manifest.js';

export type SwimMode = 'cruise' | 'host' | 'graze' | 'flee' | 'rest';

export interface SpriteFish {
  readonly sp: SpriteSpecies;
  depth: number;       // -1 back .. 1 at the glass
  tdepth: number;      // target depth
  scale: number;
  x: number; y: number;
  vx: number; vy: number; vz: number;
  speed: number;
  psi: number;         // heading: 0 right, +pi/2 at the viewer
  omega: number;       // heading rate
  turnSign: number;    // side a U-turn committed to, or 0
  tilt: number;
  u: number;           // shown angle (index into the angle pages) ...
  du: number;          // ... and its rate, for loading ahead
  phase: number;
  tx: number; ty: number;
  timer: number;
  mode: SwimMode;
  fear: number;
  fearAge: number;
  caughtT: number;
  pendingFear: number;
  threatX: number; threatY: number;
  shelter: ShelterSpot | null;
  onScreen: boolean;
}

// Population
const DEPTH_SCALE_GAIN = 0.18;          // sprites are this much larger at the glass
const SPAWN_MARGIN_X = 100, SPAWN_MARGIN_Y = 150;
const INITIAL_FEAR_AGE = 9;
// Targets
const TARGET_MARGIN_X = 60;
const HOST_CHANCE = 0.6, HOST_SPREAD_PX = 90, HOST_ZONE = 0.92;
const SCHOOLER = 0.5, SHOAL_SPREAD_PX = 260;
const GRAZE_FROM_GRAZER = 0.4, GRAZE_FROM_SHY = 0.5;
const DEPTH_CHANGE_CHANCE = 0.5;
const TIMER_MIN_S = 3, TIMER_MAX_S = 10, TIMER_ACTIVITY_BASE = 0.4, TIMER_NON_CRUISE = 1.8;
const SHELTER_CORAL_SCHOOL = 0.8;
const HIDING_REACH_PX = 90;
const BODY_ABOVE_TOP = 0.5, HIDE_BELOW_SHELTER = 0.3, BODY_ABOVE_FLOOR = 0.35;
// Fear
const FEAR_DECAY = 0.45;
const FEAR_RAISE_RESET = 0.1;
const PREDATOR_REACH_BODIES = 2.5, PREDATOR_DEPTH = 0.6, PREDATOR_FEAR = 0.8;
const CONTAGION_DELAY_S = 0.25, CONTAGION_HOP = 0.6, CONTAGION_RECEPTIVE = 0.3, CONTAGION_SOURCE = 0.45;
const CONTAGION_FRESH_S = 1, CONTAGION_REACH_BODIES = 4;
const FLEE_FEAR = 0.4, FLEE_BOOST = 2.5, FLEE_MIN_TIMER = 0.5, FLEE_DEPTH = -0.5;
// Swimming
const ARRIVED_PX = 20, ARRIVE_EASE_PX = 160;
const CRUISE_BASE = 0.2, CRUISE_ACTIVITY = 0.3;
const MATE_RANGE_PX = 400, MATES_HEEDED = 3;
const ROOM_BODIES = 0.55, ROOM_DEPTH = 0.4, ROOM_PUSH_X = 0.8, ROOM_PUSH_Y = 0.5;
const SEPARATE_BODIES = 0.6, COHERE_BODIES = 1.5, COHERE_RAMP_BODIES = 3, SEPARATE_X = 0.6, SEPARATE_Y = 0.4, COHERE_GAIN = 0.5, ALIGN_GAIN = 0.1;
const MIN_PAIR_PX = 0.01;
const CLIMB_LIMIT = 0.45, DEPTH_SPEED_LIMIT = 0.5, DEPTH_GAIN = 0.4;
const MIN_HEADING_WANT = 0.1, UTURN_ERR = 2.6, UTURN_RELEASE = 2.0, NEAR_GLASS_DEPTH = 0.4;
const TURN_GAIN = 2.5, TURN_ACCEL = 4, TURN_SLOWDOWN = 0.5, SPEED_RESPONSE = 1.4;
const MAX_EFFORT = 1.5, TAIL_BASE = 0.35, TAIL_EFFORT = 0.65, IDLE_FIN_HZ = 0.7, IDLE_FIN_EFFORT = 2.2;

const shelterOf = (fish: SpriteFish, scene: SceneEntry): ShelterSpot | null => {
  const b = fish.sp.brain, list = scene.shelters;
  if (b.host || !list.length) return null;
  const coral = list.find((s) => s.kind === 'coral');
  if (b.school >= SHELTER_CORAL_SCHOOL && coral) return coral;
  let best: ShelterSpot | null = null, bd = Infinity;
  for (const s of list) {
    if (s.kind !== 'ledge') continue;
    const d = Math.abs(s.pos[0] - fish.x);
    if (d < bd) { bd = d; best = s; }
  }
  return best;
};

export class School {
  readonly fish: SpriteFish[] = [];

  constructor(
    species: readonly SpriteSpecies[],
    private readonly scene: SceneEntry,
    private readonly geo: SceneGeometry,
    private readonly rng: Rng,
  ) {
    for (const sp of species) for (let n = 0; n < sp.count; n++) this.fish.push(this.spawn(sp));
    this.sortByDepth();
    // Each fish knows a shelter (bake.ts: reef shelters in screen space): shoalers their coral, the
    // rest the nearest ledge to where they start. Hosts keep to the anemone.
    for (const f of this.fish) if (!f.sp.brain.host && scene.shelters.length) f.shelter = shelterOf(f, scene);
  }

  private range(lo: number, hi: number): number {
    return lo + (hi - lo) * this.rng();
  }

  private spawn(sp: SpriteSpecies): SpriteFish {
    const { geo } = this;
    const depth = this.range(-1, 1);
    const x = this.range(geo.bx0 + SPAWN_MARGIN_X, geo.bx1 - SPAWN_MARGIN_X);
    const y = this.range(geo.by0 + SPAWN_MARGIN_Y, geo.by1 - SPAWN_MARGIN_Y);
    const psi = this.rng() < 0.5 ? 0 : Math.PI;
    const phase = this.rng();
    return {
      sp, depth, tdepth: depth, scale: this.scaleAt(depth),
      x, y, vx: 0, vy: 0, vz: 0, speed: 0, psi, omega: 0, turnSign: 0, tilt: 0, u: 0, du: 0,
      phase, tx: 0, ty: 0, timer: 0, mode: 'cruise',
      fear: 0, fearAge: INITIAL_FEAR_AGE, caughtT: 0, pendingFear: 0, threatX: 0, threatY: 0, shelter: null, onScreen: false,
    };
  }

  private scaleAt(depth: number): number {
    return this.geo.baseScale * (1 + DEPTH_SCALE_GAIN * depth);
  }

  /** Depth changes as fish swim nearer or further: back to front for drawing. */
  sortByDepth(): void {
    this.fish.sort((a, b) => a.depth - b.depth);
  }

  /** Vertical limits for a fish at x: under the surface, above the reef line. */
  private limits(f: SpriteFish, x: number): readonly [number, number] {
    const { geo } = this;
    const h = f.sp.frameH * f.scale;
    // A fish at its shelter may go down among the rock (behind the foreground layer).
    const shelter = f.shelter;
    const hiding = shelter !== null && (f.mode === 'flee' || f.mode === 'rest') && Math.abs(f.x - shelter.pos[0]) < HIDING_REACH_PX;
    const bottom = hiding ? Math.min(geo.by1, shelter.pos[1] + h * HIDE_BELOW_SHELTER) : Math.min(geo.by1, geo.floorAt(x)) - h * BODY_ABOVE_FLOOR;
    return [geo.by0 + h * BODY_ABOVE_TOP, bottom];
  }

  private pickTarget(f: SpriteFish): void {
    const b = f.sp.brain, { geo } = this;
    f.mode = 'cruise';
    let x = this.range(geo.bx0 + TARGET_MARGIN_X, geo.bx1 - TARGET_MARGIN_X), zoneF = this.range(b.zone[0], b.zone[1]);
    if (b.host && this.rng() < HOST_CHANCE) {
      x = this.scene.anemone[0] + this.range(-HOST_SPREAD_PX, HOST_SPREAD_PX);
      zoneF = HOST_ZONE;
      f.mode = 'host';
    } else if (b.school >= SCHOOLER) {
      const mates = this.fish.filter((o) => o.sp === f.sp && o !== f);
      if (mates.length) {
        const cx = mates.reduce((s, o) => s + o.x, 0) / mates.length;
        x = Math.min(Math.max(cx + this.range(-SHOAL_SPREAD_PX, SHOAL_SPREAD_PX), geo.bx0 + TARGET_MARGIN_X), geo.bx1 - TARGET_MARGIN_X);
      }
    } else if (this.rng() < b.grazer * GRAZE_FROM_GRAZER || this.rng() < b.shy * GRAZE_FROM_SHY) {
      zoneF = 1;
      f.mode = 'graze';
    }
    const [top, bottom] = this.limits(f, x);
    f.tx = x;
    f.ty = top + (bottom - top) * zoneF;
    // Sometimes also move nearer the glass or further back; host fish stay at the anemone's depth.
    if (f.mode === 'host') f.tdepth = 0;
    else if (this.rng() < DEPTH_CHANGE_CHANCE) f.tdepth = this.range(-1, 1);
    f.timer = this.range(TIMER_MIN_S, TIMER_MAX_S) / (TIMER_ACTIVITY_BASE + b.activity) * (f.mode === 'cruise' ? 1 : TIMER_NON_CRUISE);
  }

  // Fear, reduced from brain.ts for the Roku's CPU: prey fear a predator heading their way; a shoalmate
  // that has just bolted passes it on after a reaction delay, weaker by a hop; a scared fish dashes for
  // its shelter (or away from the threat).
  private feel(f: SpriteFish, dt: number): void {
    const b = f.sp.brain, L = f.sp.lengthPx * f.scale;
    f.fear *= Math.exp(-dt * FEAR_DECAY);
    f.fearAge += dt;
    const raise = (s: number, x: number, y: number): void => {
      if (s > f.fear + FEAR_RAISE_RESET) f.fearAge = 0;
      if (s > f.fear) { f.fear = s; f.threatX = x; f.threatY = y; }
    };
    if (b.prey) {
      for (const o of this.fish) {
        if (!o.sp.brain.predator) continue;
        const ox = f.x - o.x, oy = f.y - o.y, d = Math.hypot(ox, oy), R = PREDATOR_REACH_BODIES * o.sp.lengthPx * o.scale;
        if (d < R && Math.abs(o.depth - f.depth) < PREDATOR_DEPTH && o.vx * ox + o.vy * oy > 0) raise(PREDATOR_FEAR * (1 - d / R), o.x, o.y);
      }
    }
    if (f.caughtT > 0) {
      f.caughtT -= dt;
      if (f.caughtT <= 0) raise(f.pendingFear, f.threatX, f.threatY);
    } else if (b.school > 0 && f.fear < CONTAGION_RECEPTIVE) {
      for (const o of this.fish) {
        if (o === f || o.sp !== f.sp || o.fear < CONTAGION_SOURCE || o.fearAge > CONTAGION_FRESH_S || Math.hypot(f.x - o.x, f.y - o.y) > CONTAGION_REACH_BODIES * L) continue;
        f.caughtT = CONTAGION_DELAY_S; f.pendingFear = o.fear * CONTAGION_HOP; f.threatX = o.threatX; f.threatY = o.threatY;
        break;
      }
    }
  }

  /** Flee mode: head for the shelter, or away from the threat. Returns the speed boost. */
  private flee(f: SpriteFish): number {
    const { geo } = this;
    if (f.fear > FLEE_FEAR) {
      f.mode = 'flee'; f.timer = Math.max(f.timer, FLEE_MIN_TIMER);
      if (f.shelter) { f.tx = f.shelter.pos[0]; f.ty = f.shelter.pos[1]; f.tdepth = FLEE_DEPTH; }
      else { f.tx = Math.min(Math.max(f.x + (f.x - f.threatX) * 2, geo.bx0 + TARGET_MARGIN_X), geo.bx1 - TARGET_MARGIN_X); f.ty = f.y + (f.y - f.threatY); }
      return FLEE_BOOST;
    }
    if (f.mode === 'flee') f.timer = 0;
    return 1;
  }

  /**
   * Everyone keeps a little room from fish at a similar depth. Schoolers follow pairwise rules on their
   * nearest three mates (as brain.ts): apart inside ~0.6 body lengths, together beyond ~1.5, and a
   * little of their heading. Returns the wish velocity (wx, wy) with those added.
   */
  private neighbours(f: SpriteFish, cruise: number, wishX: number, wishY: number): readonly [number, number] {
    const b = f.sp.brain;
    let wx = wishX, wy = wishY;
    const mates: [number, SpriteFish, number, number][] = [];
    for (const o of this.fish) {
      if (o === f) continue;
      const ox = f.x - o.x, oy = f.y - o.y, d = Math.hypot(ox, oy);
      if (o.sp === f.sp && b.school > 0 && d < MATE_RANGE_PX) mates.push([d, o, ox, oy]);
      const room = (f.sp.lengthPx * f.scale + o.sp.lengthPx * o.scale) * ROOM_BODIES;
      if (d < room && d > MIN_PAIR_PX && Math.abs(f.depth - o.depth) < ROOM_DEPTH) { wx += (ox / d) * cruise * ROOM_PUSH_X; wy += (oy / d) * cruise * ROOM_PUSH_Y; }
    }
    if (mates.length) {
      const L = f.sp.lengthPx * f.scale;
      mates.sort((p, q) => p[0] - q[0]);
      for (const [d, o, ox, oy] of mates.slice(0, MATES_HEEDED)) {
        if (d < SEPARATE_BODIES * L && d > MIN_PAIR_PX) { wx += (ox / d) * cruise * SEPARATE_X; wy += (oy / d) * cruise * SEPARATE_Y; }
        else if (d > COHERE_BODIES * L) {
          const k = Math.min(1, (d - COHERE_BODIES * L) / (COHERE_RAMP_BODIES * L)) * cruise * COHERE_GAIN * b.school;
          wx -= (ox / d) * k; wy -= (oy / d) * k;
        }
        wx += o.vx * b.school * ALIGN_GAIN; wy += o.vy * b.school * ALIGN_GAIN;
      }
    }
    return [wx, wy];
  }

  /**
   * Heading turns at a limited rate (the species' pectoral-sculling rate), easing in and out. A U-turn
   * picks a side once: towards the viewer from the back half of the tank, away from it near the glass.
   * Returns the heading error left after the turn.
   */
  private steer(f: SpriteFish, wx: number, wz: number, cruise: number, rate: number, dt: number): number {
    const want = Math.hypot(wx, wz);
    let err = want > cruise * MIN_HEADING_WANT ? wrapAngle(Math.atan2(wz, wx) - f.psi) : 0;
    if (Math.abs(err) > UTURN_ERR) {
      if (!f.turnSign) f.turnSign = (Math.cos(f.psi) >= 0 ? 1 : -1) * (f.depth < NEAR_GLASS_DEPTH ? 1 : -1);
      err = Math.abs(err) * f.turnSign;
    } else if (Math.abs(err) < UTURN_RELEASE) f.turnSign = 0;
    const wOmega = Math.max(-rate, Math.min(rate, err * TURN_GAIN));
    f.omega += Math.max(-rate * TURN_ACCEL * dt, Math.min(rate * TURN_ACCEL * dt, wOmega - f.omega));
    f.psi = wrapAngle(f.psi + f.omega * dt);
    return err;
  }

  step(f: SpriteFish, dt: number): void {
    const b = f.sp.brain, { geo } = this;
    f.timer -= dt;
    this.feel(f, dt);
    const boost = this.flee(f);
    const dx = f.tx - f.x, dy = f.ty - f.y, dist = Math.hypot(dx, dy);
    if (f.timer <= 0 || (dist < ARRIVED_PX && f.mode === 'cruise')) this.pickTarget(f);

    const cruise = b.maxSpeed * geo.pxPerUnit * (CRUISE_BASE + CRUISE_ACTIVITY * b.activity) * boost;
    const arrive = Math.min(1, dist / ARRIVE_EASE_PX);
    const toTargetX = dist > 1 ? (dx / dist) * cruise * arrive : 0;
    const toTargetY = dist > 1 ? (dy / dist) * cruise * arrive : 0;
    const [wx, wishY] = this.neighbours(f, cruise, toTargetX, toTargetY);
    let wy = wishY;
    wy = Math.max(-cruise * CLIMB_LIMIT, Math.min(cruise * CLIMB_LIMIT, wy));   // fish climb and dive gently
    const wz = Math.max(-cruise * DEPTH_SPEED_LIMIT, Math.min(cruise * DEPTH_SPEED_LIMIT, (f.tdepth - f.depth) * geo.depthPx * DEPTH_GAIN));

    const rate = f.sp.turnRate * DEG_TO_RAD, want = Math.hypot(wx, wz);
    const err = this.steer(f, wx, wz, cruise, rate, dt);

    // The fish swims along its heading, slowing in tight turns.
    const k = Math.min(1, dt * SPEED_RESPONSE);
    f.speed += (want * Math.max(0, Math.cos(err)) * (1 - TURN_SLOWDOWN * Math.min(1, Math.abs(f.omega) / rate)) - f.speed) * k;
    f.vx = f.speed * Math.cos(f.psi);
    f.vz = f.speed * Math.sin(f.psi);
    f.vy += (wy - f.vy) * k;

    f.x = Math.min(Math.max(f.x + f.vx * dt, geo.bx0), geo.bx1);
    f.depth = Math.min(Math.max(f.depth + (f.vz / geo.depthPx) * dt, -1), 1);
    f.scale = this.scaleAt(f.depth);
    const [top, bottom] = this.limits(f, f.x);
    f.y = Math.min(Math.max(f.y + f.vy * dt, top), bottom);
    // Tail beat speeds up with swimming speed; idle fish still fin gently.
    const effort = Math.min(MAX_EFFORT, Math.hypot(f.vx, f.vy) / cruise);
    f.phase += dt * (f.sp.tailHz ? f.sp.tailHz * (TAIL_BASE + TAIL_EFFORT * effort) : IDLE_FIN_HZ + IDLE_FIN_EFFORT * effort);
  }
}
