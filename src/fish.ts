// A fish = 3D model + swimming physics + its own Brain, on the creature step template (creature.ts):
// sense = the brain's update, think = its steering, act = the physics and the animation below.
//
// Physics (per individual, body length L in world units, 1 unit = 12.5 cm):
//   mass         m  = L^3               (neutrally buoyant, so gravity and buoyancy cancel)
//   axial drag   Fd = kf * U|U|,  kf = CF * L^2   (pressure drag at Re ~ 1e4-1e5)
//   lateral drag strong (body acts like a keel), so velocity follows heading
//   thrust       T  from a speed controller, limited by sustained/burst capacity
//   turning      yaw and pitch are separate rotations with rotational inertia (angular acceleration
//                limited by fin torque). Yaw rate is bounded by pectoral sculling at low speed and,
//                at speed, by both the turning radius (r >= rmin*L for escapes, 2x that for routine
//                turns) and the lateral acceleration fins and body can produce (omega <= a_lat / U).
//                Pitch stays shallow while cruising and steepens only when nearly stopped.
//                Bending into a turn adds drag, so fish slow down in tight turns.
// All visible motion is derived from the force balance:
//   tail-beat frequency from the Strouhal relation St = f A / U ~ 0.3 with A = 0.2 L,
//     using U_eq = sqrt(T / kf), the speed the present thrust would sustain;
//   labriform / balistiform swimmers use fins below their gait-transition speed;
//   BCF swimmers at low speed use burst-and-coast (thrust off while gliding);
//   the body curves into turns according to path curvature.
// The fish also drifts with the water: position += (velocity relative to water + flow) * dt.
import * as THREE from 'three';
import { Brain, type Drives, type Mode, type Personality } from './brain.js';
import { CreatureBase } from './creature.js';
import { brainRows, type InspectPanel } from './inspect.js';
import { buildFishModel, posePectoral, posePectoralFan, mountPectoral, FAN_POSE, pickVariant, variantTweak, requestVariant, type FishModel } from './fishModel.js';
import { limitStep, STEP_CRAWL_BL, STEP_SLACK } from './world/stepLimit.js';
import { clamp, lerp, range, wrapAngle, type Rng } from './util.js';
import type { Species } from './species.js';
import type { SwimWorld } from './world/ports.js';
import type { SwimUniforms } from './fishModel/swimShader.js';
import { SpineChain, spineClearance, type SpineBody } from './fish/spineChain.js';
import { spring, springState, smoothstep, type SpringState } from './fish/spring.js';
import { bodyDims, radiusToward, type BodyDims } from './fish/bodyShape.js';

export type { SwimUniforms } from './fishModel/swimShader.js';

// Per-species turning and posture limits (aLat, wide, pitchCruise, bank, ...) are in species.ts MOTION.
/** Axial drag coefficient (folded constants). */
const CF = 0.9;
/** Lateral velocity decay rate (1/s). */
const LATERAL = 8;
/** Strouhal number. */
const ST = 0.3;
/** Tail-tip amplitude / L. */
const TAIL_AMP = 0.2;
/** Heading error (rad) beyond which a turn is a reversal, and below which the reversal is over. */
const REVERSE_ERR = 2.7;
const REVERSE_DONE = 2.0;
/** Size spread between individuals of a species. */
const SIZE_SPREAD: readonly [number, number] = [0.85, 1.12];
/** Opercular breathing rate at rest (Hz). */
const VENT_HZ: readonly [number, number] = [1.0, 1.5];
const VENT_AMPLITUDE = 0.035;
/**
 * Drawn position damping (present): the drawn fish follows its own velocity and eases to pos at this
 * rate (1/s), so the push-backs from rock and other fish (fish.ts, world/separation.ts), which move pos
 * without the fish swimming there, are smoothed instead of shown as a shudder. It never lags pos by
 * more than SHOW_MAX_LAG body lengths, so bodies that only touch don't look as if they intersect.
 */
const SHOW_RATE = 10;
const SHOW_MAX_LAG = 0.06;
/**
 * Body stations kept off the rock, snout (0) to the caudal fin's tip (1), about every 0.13 L; the
 * snout's tip is a sliver, so the first is just behind it.
 */
const ROCK_STATIONS = [0.05, 0.18, 0.31, 0.44, 0.57, 0.7, 0.85, 1] as const;
/**
 * Share of the body's section kept clear of the rock field. The field reads the rock ~0.05 units
 * nearer than the drawn surface (it is built from voxels the triangles touch), so the skin can graze it.
 */
const ROCK_CLEARANCE = 0.8;
const MIN_ROCK_CLEARANCE = 0.03;
/** Rock pushes a body station out at least this fast (body lengths/s), as the step limit's crawl. */
const ROCK_CRAWL_BL = 0.5;

const _d = new THREE.Vector3(), _up = new THREE.Vector3(), _side = new THREE.Vector3();
const _lat = new THREE.Vector3(), _flow = new THREE.Vector3(), _gaze = new THREE.Vector3(), _n = new THREE.Vector3();
const _c = new THREE.Vector3(), _t = new THREE.Vector3(), _prev = new THREE.Vector3(), _dir0 = new THREE.Vector3();
const _turn = new THREE.Vector3();
/** A click within this share of a fish's length of it selects the fish (ui.ts). */
const PICK_SHARE = 0.6;
const DRIVE_LABELS: Readonly<Record<keyof Drives, string>> = {
  hunger: 'Hunger', energy: 'Energy', fear: 'Fear', social: 'Social need', boredom: 'Boredom', parasites: 'Parasites',
};
const TRAIT_LABELS: Readonly<Record<keyof Personality, string>> = {
  boldness: 'Boldness', curiosity: 'Curiosity', activity: 'Activity', sociability: 'Sociability', aggression: 'Aggression', appetite: 'Appetite',
};
const typedEntries = <K extends string, V>(o: Readonly<Record<K, V>>): [K, V][] => Object.entries(o) as [K, V][];
/** An eel lurking this close to home is braced in its cave (fish/spineChain.ts holds its body there). */
const EEL_BRACED_RANGE = 0.6;
const _basis = new THREE.Matrix4();

/** Eye saccade state: the gaze target held between jumps, and the eased current gaze. */
interface GazeState { t: number; fx: number; fy: number; x: number; y: number }

/** One pectoral's flexible-fin springs (opening, stroke roll). */
interface PectoralSprings { readonly open: SpringState; readonly flap: SpringState }

/** Values one step's stages share: speed, thrust and the swimming gait they imply. */
interface StepState {
  readonly want: number;
  readonly U: number;
  readonly burst: boolean;
  omegaMax: number;
  T: number;
  kf: number;
  af: number;
}

export class Fish extends CreatureBase<SwimWorld> implements SpineBody {
  readonly kind = 'fish';
  /** Moved before the body separation pass and drawn after it (present). */
  readonly stepPhase = 'bodies';
  readonly sp: Species;
  readonly name: string;
  readonly size: number;
  /** Look variant 0..VARIANT_COUNT-1, picked from the seed stream. */
  readonly variant: number;
  /** The body's axis and section for collision (fish/bodyShape.ts). */
  readonly body: BodyDims;
  readonly model: FishModel;
  readonly pos = new THREE.Vector3();
  readonly dir: THREE.Vector3;
  /** Relative to the water. */
  readonly vel = new THREE.Vector3();
  /** Where the model is drawn: pos with the collision pushes' jerks smoothed out (present). */
  private readonly shown = new THREE.Vector3();
  private shownSet = false;
  /** Forward speed relative to water. */
  speed = 0;
  thrust = 0;
  coasting = false;
  phase: number;
  finPhase: number;
  pectPhase: number;
  ventPhase: number;
  readonly ventHz: number;
  roll = 0;
  turnRate = 0;
  yaw: number;
  pitch = 0;
  yawRate = 0;
  pitchRate = 0;
  /** Remembered direction while reversing, so a U-turn doesn't dither. */
  turnSign = 0;
  bend = 0;
  gulp = 0;
  /** Spine erection 0..2 (species with erectile spines only). */
  erect: number | undefined = undefined;
  readonly spine: SpineChain | null;
  readonly brain: Brain;

  // Secondary motion springs: body bend (front, and the tail behind it), tail amplitude, median fin
  // fold, caudal cup; each pectoral gets its own (opening, stroke roll).
  private readonly sBend = springState();
  private readonly sBendTail = springState();
  private readonly sAmp = springState(0.1);
  private readonly sFold = springState();
  private readonly sCup = springState();
  private readonly pectSprings: PectoralSprings[];
  /** Speed of the water carrying the fish this step (units/s). */
  private drift = 0;
  /** Heading at the start of this step (the turn sweeps the snout and tail into or out of rock). */
  private readonly dirBefore = new THREE.Vector3();
  /** Steps the global step limit cut short (world/stepLimit.ts), for the motion check. */
  limitedSteps = 0;
  /** Fan pectorals swept back at speed (lionfish), 0..1. */
  private readonly fanFold = springState();
  private gazeState: GazeState | null = null;
  /** The speed the brain asked for this step (think), 1 = cruising, above 1 a burst. */
  private want = 0;

  constructor(sp: Species, name: string, rng: Rng) {
    super();
    this.sp = sp;
    this.name = name;
    this.variant = pickVariant(rng);
    this.size = sp.size * range(rng, SIZE_SPREAD[0], SIZE_SPREAD[1]) * variantTweak(sp, this.variant).size;
    // Every fish starts on the species' variant-0 textures (shared and cached, so startup stays fast);
    // variant 1-3 colour maps are painted in idle time and swapped in (variantLoader).
    this.model = buildFishModel(sp, { variant: 0 });
    if (this.variant !== 0) requestVariant(sp, this.variant, this.model);
    this.model.scale.setScalar(this.size);
    this.body = bodyDims(this);
    // Receive too, so fins shade the flank (and other fish) as they do in photos.
    this.model.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = o.receiveShadow = true;
    });
    this.model.userData['fish'] = this;
    this.pectSprings = this.model.pects.map(() => ({ open: springState(0.3), flap: springState(0.2) }));
    this.dir = new THREE.Vector3(rng() - 0.5, 0, (rng() - 0.5) * 0.4).normalize();
    this.phase = rng() * 10;
    this.finPhase = rng() * 10;
    this.pectPhase = rng() * 10;
    this.ventPhase = rng() * 10;
    this.ventHz = range(rng, VENT_HZ[0], VENT_HZ[1]);
    this.yaw = Math.atan2(this.dir.z, this.dir.x);
    this.spine = sp.swim.mode === 'anguilliform' ? new SpineChain() : null;
    // The eel's body is drawn along its path (uPath), which reaches well outside the straight body's bounds.
    if (this.spine) this.model.traverse((o) => { o.frustumCulled = false; });
    this.brain = new Brain(this, rng);
  }

  get mass(): number {
    return this.size ** 3;
  }

  get uniforms(): SwimUniforms {
    return this.model.uniforms;
  }

  /** The head lift (uLift), for the eel's body path. */
  get lift(): number {
    return this.model.uniforms.uLift.value;
  }

  /**
   * An eel's burrow: its cave (main puts home a quarter body length behind the mouth, facing out along
   * lurkDir) and the crevice running on into the reef behind it, which the cave is too shallow to hold.
   * A capsule along lurkDir from the mouth back to 0.55 body lengths behind home, deep enough for the
   * tail of an eel that has backed all the way in. Inside it the body ignores the rock.
   */
  inBurrow(p: THREE.Vector3): boolean {
    const b = this.brain;
    if (!this.spine || !b.lurkDir) return false;
    const L = this.size;
    _t.subVectors(p, b.home);
    const s = clamp(_t.dot(b.lurkDir), -0.55 * L, 0.25 * L);
    return _t.addScaledVector(b.lurkDir, -s).lengthSq() < 0.35 * 0.35;
  }

  updateGaze(dt: number, out: THREE.Vector2): void {
    const b = this.brain;
    const st = this.gazeState ?? (this.gazeState = { t: 0, fx: 0, fy: 0, x: 0, y: 0 });
    st.t -= dt;
    if (st.t <= 0) {
      const look = b.focus?.pos || b.focusFood?.pos || b.threat?.pos || b.neighbors[0]?.pos || null;
      if (look) {
        // Target in the fish's frame: forward along dir, up along the body's up.
        _gaze.subVectors(look, this.pos);
        const d = _gaze.length() || 1, fwd = _gaze.dot(this.dir) / d;
        st.fx = clamp(fwd, -0.6, 1) * 0.07;
        st.fy = clamp((_gaze.y - this.dir.y * _gaze.dot(this.dir)) / d, -1, 1) * 0.05;
      } else {
        st.fx = range(Math.random, -0.03, 0.05);   // idle scanning (unseeded: eyes don't affect the tank)
        st.fy = range(Math.random, -0.02, 0.02);
      }
      st.t = range(Math.random, 1, 4) * (b.mode === 'rest' ? 2 : 1);
    }
    // Saccades are fast (~50 ms); the counter-roll is continuous.
    const k = Math.min(1, dt * 20);
    st.x += (st.fx - st.x) * k;
    st.y += (st.fy - st.y) * k;
    out.set(st.x, st.y - this.pitch * 0.06);
  }

  /** Click-proxy radius: a share of its length (fish are small and moving). */
  get pickRadius(): number {
    return this.size * PICK_SHARE;
  }

  /** Hidden while its look loads: not clickable then. */
  override get pickable(): boolean {
    return this.model.visible;
  }

  /** The click panel: its name, its brain's thought, drives, options and personality (inspect.ts). */
  override inspect(): InspectPanel {
    const b = this.brain;
    return {
      title: this.name,
      species: this.sp.name,
      sci: this.sp.sci,
      note: b.thought,
      rows: brainRows({
        drives: typedEntries(b.drives).map(([k, v]) => [DRIVE_LABELS[k], v, k]),
        scores: (Object.entries(b.scores) as [Mode, number | undefined][]).map(([k, v]) => [k, v ?? 0]),
        mode: b.mode,
        traits: typedEntries(b.traits).map(([k, v]) => [TRAIT_LABELS[k], v]),
      }),
      fact: this.sp.fact,
    };
  }

  /** The brain takes in the tank: drives, perception, the behaviour to run. */
  protected override sense(dt: number, world: SwimWorld): void {
    this.brain.update(dt, world);
  }

  /** The brain steers: a heading (into _d) and the speed it wants. */
  protected override think(dt: number, world: SwimWorld): void {
    this.want = this.brain.steer(dt, world, _d);
    if (_d.lengthSq() < 1e-8) _d.copy(this.dir);
    _d.normalize();
  }

  /** Swim there by the force balance (see the top of this file), then pose and animate the model. */
  protected act(dt: number, world: SwimWorld): void {
    const brain = this.brain, want = this.want;
    const s: StepState = { want, U: Math.max(0, this.speed), burst: want > 1, omegaMax: 0, T: 0, kf: 0, af: 0 };
    _prev.copy(this.pos);
    _dir0.copy(this.dir);
    this.dirBefore.copy(this.dir);
    const v0 = this.vel.length();
    this.turnTowards(dt, s);
    if (this.spine) this.turnAboutHead();
    this.controlThrust(s);
    this.integrate(dt, world, s);
    this.enforceLimits(dt, world, s.U);
    // No step longer than the fish can swim (its speed through the water, the drift and any backing):
    // corrections out of rock or into a shelter finish over the next frames instead of in a jump.
    const reach = Math.max(v0, this.vel.length()) + this.drift + brain.backing;
    if (limitStep(_prev, this.pos, reach, STEP_CRAWL_BL * this.size, dt)) this.limitedSteps++;
    this.orient(dt, s.U);
    this.animate(dt, world, s);
  }

  /** Heading: yaw and pitch, each limited in rate and in angular acceleration. */
  private turnTowards(dt: number, s: StepState): void {
    const sw = this.sp.swim, L = this.size, U = s.U, burst = s.burst;
    const hover = sw.hoverTurn * clamp(1 - U / (sw.maxBL * L), 0.25, 1);   // pectoral sculling fades with speed
    const rTurn = sw.rmin * L * (burst ? 1 : sw.wide);
    const aLat = burst ? sw.aLatBurst : sw.aLat;
    s.omegaMax = Math.max(hover, Math.min(U / rTurn, aLat / Math.max(U, 1e-3)));
    const alpha = sw.hoverTurn * (burst ? 30 : 5);   // rad/s^2
    let err = wrapAngle(Math.atan2(_d.z, _d.x) - this.yaw);
    if (Math.abs(err) > REVERSE_ERR) {
      // Reversing: commit to turning towards open water (away from the nearer glass).
      if (!this.turnSign) this.turnSign = Math.sign(-this.pos.z * Math.cos(this.yaw)) || 1;
      err = Math.abs(err) * this.turnSign;
    } else if (Math.abs(err) < REVERSE_DONE) this.turnSign = 0;
    const wYaw = clamp(err * 2.5, -s.omegaMax, s.omegaMax);   // ease into the new heading
    this.yawRate += clamp(wYaw - this.yawRate, -alpha * dt, alpha * dt);
    this.yaw = wrapAngle(this.yaw + this.yawRate * dt);

    const pMax = lerp(sw.pitchSlow, sw.pitchCruise, clamp((U / L - 0.15) / 0.3, 0, 1));   // steep only when ~stopped
    // Fish gain depth gradually and mostly swim level: climb at a shallower angle than straight at the goal.
    const pitchTarget = clamp(sw.climb * Math.asin(clamp(_d.y, -1, 1)), -pMax, pMax);
    const pitchRateMax = sw.pitchRate[burst ? 1 : 0];
    const wPitch = clamp((pitchTarget - this.pitch) * 2.0, -pitchRateMax, pitchRateMax);
    this.pitchRate += clamp(wPitch - this.pitchRate, -alpha * 0.6 * dt, alpha * 0.6 * dt);
    this.pitch = clamp(this.pitch + this.pitchRate * dt, -sw.pitchSlow, sw.pitchSlow);
    const cp = Math.cos(this.pitch);
    this.dir.set(Math.cos(this.yaw) * cp, Math.sin(this.pitch), Math.sin(this.yaw) * cp);
    this.turnRate = this.yawRate;
  }

  /**
   * An eel steers with its head and the body follows its path (fish/spineChain.ts), so it turns about
   * its head, not its middle (pos): turning about the middle would swing the head through an arc half a
   * body length across, which the body would then follow. Not braced in its cave, where it turns its
   * head on its neck instead.
   */
  private turnAboutHead(): void {
    const b = this.brain;
    if (b.mode === 'lurk' && b.lurkDir && this.pos.distanceTo(b.home) < EEL_BRACED_RANGE) return;
    _dir0.sub(this.dir).multiplyScalar(0.5 * this.size);
    this.pos.add(_dir0);
    _prev.add(_dir0);   // a turn, not a step: the step limit measures the swim from here
  }

  /** Thrust controller: towards the speed the brain wants, within sustained / burst capacity. */
  private controlThrust(s: StepState): void {
    const sp = this.sp, sw = sp.swim, L = this.size, U = s.U, want = s.want;
    const maxU = sw.maxBL * L, burstU = sw.burstBL * L;
    const Ustar = clamp(want * sp.brain.maxSpeed * (0.8 + 0.3 * this.brain.drives.energy), 0, burstU);
    const kf = CF * L * L, m = this.mass;
    const Tmax = want > 1 ? kf * burstU * burstU * 1.3 : kf * maxU * maxU * 1.15;
    let T = kf * Ustar * Ustar + m * (Ustar - U) * 3.5;
    if (sw.mode === 'bcf' && Ustar < 0.6 * maxU && Ustar > 0.05 * L) {
      // Burst-and-coast: kick until 15% over target, glide until 20% under.
      if (U > Ustar * 1.15) this.coasting = true;
      else if (U < Ustar * 0.8) this.coasting = false;
      T = this.coasting ? 0 : kf * (Ustar * 1.4) ** 2 + m * (Ustar * 1.2 - U) * 3;
    }
    // Fins can brake (flared pectorals) but not reverse-thrust hard.
    T = clamp(T, -kf * (0.6 * maxU) ** 2, Tmax);
    this.thrust = T;
    s.T = T;
    s.kf = kf;
  }

  /** Integrate (forward axis + decaying lateral slip), drift with the water, back into a cave. */
  private integrate(dt: number, world: SwimWorld, s: StepState): void {
    const sw = this.sp.swim, brain = this.brain, kf = s.kf, m = this.mass;
    const vf = this.vel.dot(this.dir);
    _lat.copy(this.vel).addScaledVector(this.dir, -vf).multiplyScalar(Math.exp(-LATERAL * dt));
    const turnDrag = 1 + sw.turnDrag * Math.min(1, Math.abs(this.yawRate) / Math.max(s.omegaMax, 1e-3)) ** 2;   // bent body
    s.af = (s.T - kf * turnDrag * vf * Math.abs(vf)) / m;
    const vfNew = vf + s.af * dt;
    this.vel.copy(this.dir).multiplyScalar(vfNew).add(_lat);
    this.speed = vfNew;
    world.flow(this.pos, _flow);
    this.drift = _flow.length();
    this.pos.addScaledVector(this.vel, dt).addScaledVector(_flow, dt);
    if (brain.backing) {
      // Swimming backwards into the cave: the body wave runs tail to head (phase below) and pushes it home.
      _flow.subVectors(brain.home, this.pos);
      this.pos.addScaledVector(_flow, Math.min(1, (brain.backing * dt) / Math.max(_flow.length(), 1e-3)));
      this.vel.multiplyScalar(Math.exp(-3 * dt));
    }
    if (brain.mode === 'lurk' && brain.lurkDir && this.pos.distanceTo(brain.home) < 0.6) {
      // A lurking eel braces its body in the crevice: the current and its own sway don't carry it off.
      this.pos.lerp(brain.home, 1 - Math.exp(-3 * dt));
      this.vel.multiplyScalar(Math.exp(-3 * dt));
    }
  }

  /**
   * Hard limits: glass and rock are rigid. Rock pushes a fish out at a limited rate, not in one step:
   * the height field is a conservative 0.2-unit grid, and a snap to it reads as a jump.
   */
  private enforceLimits(dt: number, world: SwimWorld, U: number): void {
    const L = this.size, B = world.bounds;
    this.pos.x = clamp(this.pos.x, B.x0, B.x1);
    this.pos.z = clamp(this.pos.z, B.z0, B.z1);
    // A fish in its shelter is under the rock's top (the height field holds only the top): keep it
    // between the gap's floor and roof instead.
    const sh = this.brain.sheltered;
    // Eased in, not snapped: a fish that takes up its shelter from above settles under the roof.
    const ease = (0.5 * L + U) * dt;
    if (sh && this.pos.y > sh.top - 0.1 * L) this.pos.y = Math.max(sh.top - 0.1 * L, this.pos.y - ease);
    if (sh && this.pos.y < sh.floor) this.pos.y = Math.min(sh.floor, this.pos.y + ease);
    if (!this.spine) this.pushOutOfRock(dt, world);
    else this.pushEelHeadOutOfRock(dt, world, U);
    this.pos.y = clamp(this.pos.y, B.y0, B.y1);
  }

  /**
   * Against the real rock surface (rockField.ts): out along its normal, so a fish that touches the side
   * of a rock slides along it instead of being lifted to the top of the height field's column. At most
   * as fast as it can have gone in, plus a little: no jumps.
   */
  private pushOutOfRock(dt: number, world: SwimWorld): void {
    const L = this.size, d = this.body;
    // Stations from the snout to the tail fin's tip each keep their own radius (the body's section towards the rock)
    // off it: testing the centre alone let the head, half a body length ahead, go into the rock. Each
    // is pushed out no faster than it was moving into the rock (the body's speed plus the turn's sweep at
    // that station), plus a slow crawl: a fish turning its head into a wall is not thrown off it.
    _turn.subVectors(this.dir, this.dirBefore).multiplyScalar(1 / dt);
    for (const k of ROCK_STATIONS) {
      const s = d.nose + (d.fin - d.nose) * k;
      _c.copy(this.pos).addScaledVector(this.dir, s);
      const dist = world.rockDist(_c);
      if (dist >= d.halfDepth) continue;   // no section is deeper than this: clear
      world.rockNormal(_c, _n);
      const r = Math.max(MIN_ROCK_CLEARANCE, ROCK_CLEARANCE * radiusToward(this, d, s, _n));
      if (dist >= r) continue;
      const inward = Math.max(0, -(this.vel.dot(_n) + s * _turn.dot(_n)));
      const push = Math.min(r - dist, (ROCK_CRAWL_BL * L + STEP_SLACK * inward) * dt);
      this.pos.addScaledVector(_n, push);
      const vn = this.vel.dot(_n);
      if (vn < 0) this.vel.addScaledVector(_n, -vn);
    }
  }

  /**
   * The eel: pos is half a body length behind the head along dir, not a point on the body (SpineChain
   * lays the body along the path the head took), and lurking it lies in the rock behind the cave. So the
   * head is what meets the rock, pushed out along the surface normal; the path keeps the rest of the body
   * off it. Not in its burrow (inBurrow), where it backs in.
   */
  private pushEelHeadOutOfRock(dt: number, world: SwimWorld, U: number): void {
    const L = this.size, B = world.bounds;
    const r = spineClearance(this) * 1.2, head = _c.copy(this.pos).addScaledVector(this.dir, 0.5 * L);
    const d = this.inBurrow(head) ? 10 : world.rockDist(head);
    if (d < r) {
      world.rockNormal(head, _n);
      this.pos.addScaledVector(_n, Math.min(r - d, (0.5 * L + 1.2 * U) * dt));
      const vn = this.vel.dot(_n);
      if (vn < 0) this.vel.addScaledVector(_n, -vn);
    }
    // The sand (not in the rock field) under the head.
    if (head.y < B.y0) this.pos.y += Math.min(B.y0 - head.y, (0.5 * L + 1.2 * U) * dt);
  }

  /** Orientation: heading plus a bank into turns (and the resting tuck in shelter). */
  private orient(dt: number, U: number): void {
    const sp = this.sp, sw = sp.swim, brain = this.brain;
    _up.set(0, 1, 0).addScaledVector(this.dir, -this.dir.y).normalize();
    // Bank slightly with the centripetal acceleration; reef fish stay close to upright (sw.bank, ~5-12 deg).
    const lean = clamp((U * this.yawRate) / (sw.aLat * 0.7), -1, 1) * sw.bank;
    // Resting postures in shelter (sp.brain.shelterRoll): tangs wedge in on their side; the gramma hangs
    // upside down under its ledge.
    const tuck = brain.sheltered && brain.mode === 'rest' ? (sp.brain.shelterRoll || 0) : 0;
    this.roll = lerp(this.roll, lean + tuck, Math.min(1, dt * (tuck ? 0.8 : 3)));
    _up.applyAxisAngle(this.dir, this.roll);
    _side.crossVectors(this.dir, _up);
    _basis.makeBasis(this.dir, _up, _side);
    this.model.quaternion.setFromRotationMatrix(_basis);
  }

  /**
   * Place the model, after the world has moved every fish and pushed overlapping ones apart
   * (world.ts update). The eel's chain is laid out from pos, so it is drawn there exactly.
   */
  present(dt: number): void {
    const shown = this.shown;
    if (this.spine || !this.shownSet) {
      shown.copy(this.pos);
      this.shownSet = true;
    } else {
      shown.addScaledVector(this.vel, dt).lerp(this.pos, 1 - Math.exp(-dt * SHOW_RATE));
      const lag = shown.distanceTo(this.pos), max = SHOW_MAX_LAG * this.size;
      if (lag > max) shown.lerp(this.pos, 1 - max / lag);
    }
    this.model.position.copy(shown);
  }

  /** Propulsors and expression driven by the thrust: tail, bend, fins, gills, colour, eyes, pectorals. */
  private animate(dt: number, world: SwimWorld, s: StepState): void {
    const sp = this.sp, sw = sp.swim, brain = this.brain, L = this.size, U = s.U;
    this.gulp = Math.max(0, this.gulp - dt);
    const Ueq = Math.sqrt(Math.max(0, s.T) / s.kf);       // speed the current thrust sustains
    const blEq = Ueq / L;                                 // in body lengths / s
    const bursting = s.want > 1 || blEq > sw.maxBL;
    const tailShare = sw.mode === 'bcf' || sw.mode === 'anguilliform' || bursting ? 1 : smoothstep(sw.gait * 0.8, sw.gait * 1.3, blEq);
    const finShare = 1 - 0.7 * tailShare;
    const u = this.model.uniforms;

    this.animateTail(dt, u, blEq, tailShare, U);
    this.animateBody(dt, world, u, U, s.af);
    this.animateGills(dt, u, blEq);
    // Colour change: night colours come on over a few minutes as the light goes (sleeping fish fully),
    // and a client posing at the cleaning station shows them partly.
    if (u.uNight) {
      const nightT = clamp((1 - world.light) * (brain.mode === 'rest' ? 1 : 0.7) + (brain.posing ? 0.5 : 0), 0, 1);
      u.uNight.value += (nightT - u.uNight.value) * Math.min(1, dt / (brain.posing ? 3 : 40));
    }
    // Eyes: saccades every 1-4 s to whatever the brain attends to, held between jumps; and
    // counter-rolling against pitch, so the gaze stays level as the body tilts.
    if (u.uGaze) this.updateGaze(dt, u.uGaze.value);

    // Median fins: balistiform swimmers undulate dorsal + anal fins for thrust; others ripple gently.
    const finDrive = sw.mode === 'balistiform' ? finShare * (0.5 + blEq * 1.5) : 0.3 + 0.2 * blEq;
    this.finPhase += dt * Math.PI * 2 * (sw.mode === 'balistiform' ? 1.5 + 2.0 * blEq : 1.2);
    u.uFinPhase.value = this.finPhase;
    u.uFlutter.value = finDrive;
    this.animatePectorals(dt, blEq, finShare, tailShare, U);
  }

  /** Tail: Strouhal f = St U / A. A small idle beat keeps the fish from looking frozen. */
  private animateTail(dt: number, u: SwimUniforms, blEq: number, tailShare: number, U: number): void {
    const sw = this.sp.swim, L = this.size, brain = this.brain;
    const fTail = (ST * blEq) / TAIL_AMP;
    const tailAmp = tailShare * clamp(blEq / 1.2, 0, 1);
    // Hovering fish hold the body still (the pectorals do the work); a slight wave only once moving.
    const idle = 0.06 * smoothstep(0.05, 0.3, U / L) + 0.05 * Math.abs(this.turnRate);
    const back = brain.backing ? brain.backing / L : 0;   // reverse swimming, body lengths per second
    let fBeat = Math.max(fTail * tailShare, 1.2), ampT = Math.max(tailAmp, idle);
    if (sw.mode === 'anguilliform') {
      // Eels keep a near-constant amplitude and swim faster by beating faster: the wave (0.6 L long)
      // runs back at about U / 0.7 (slip ratio ~0.7). Resting, the body sways slowly.
      fBeat = Math.max(blEq / (0.7 * 0.6), 0.35);
      ampT = lerp(0.3, 0.9, smoothstep(0.03, 0.25, blEq)) + 0.1 * clamp(blEq / sw.maxBL, 0, 1);
    }
    this.phase += back ? -dt * Math.PI * 2 * (0.8 + back * 4) : dt * Math.PI * 2 * fBeat;
    u.uPhase.value = this.phase;
    // Amplitude eases in and out of a burst (a kick builds over a beat) rather than jumping.
    u.uAmp.value = Math.max(0, spring(this.sAmp, Math.max(ampT, back ? 0.5 : 0) + this.gulp, 2.5, 0.9, dt));
  }

  /**
   * Body bends with path curvature (kappa = omega / U), stronger in sharp, slow turns. The bend is a
   * stiff damped spring, and the rear half follows it on a softer one, so the tail lags into a turn and
   * swings past straight coming out of it. Also the caudal cup, median fin fold and erectile spines.
   */
  private animateBody(dt: number, world: SwimWorld, u: SwimUniforms, U: number, af: number): void {
    const sp = this.sp, sw = sp.swim, L = this.size, brain = this.brain;
    const kappa = this.turnRate / Math.max(U, 0.25 * L);
    const bendT = clamp(kappa * L * 0.12, -0.25, 0.25);
    this.bend = clamp(spring(this.sBend, bendT, 1.6, 0.55, dt), -0.3, 0.3);
    const tail = clamp(spring(this.sBendTail, this.bend, 1.0, 0.45, dt), -0.32, 0.32);
    // Caudal cup: the blade flexes further behind the peduncle while the fish accelerates.
    const cup = clamp(spring(this.sCup, clamp(af / (L * 3), -0.2, 0.6), 2.0, 0.6, dt), -0.25, 0.7);
    // Median fins: erect when slow or turning (stability), folded down and back at speed.
    const foldT = smoothstep(0.35, 0.9, U / (sw.burstBL * L)) * (1 - clamp(Math.abs(this.yawRate) * 0.8, 0, 0.8));
    u.uFold.value = clamp(spring(this.sFold, foldT, 1.2, 0.8, dt), 0, 1);
    u.uCup.value = cup;
    // Erectile spines (sp.erect): raised by fear, a chase or a stalk, and locked up when the fish wedges
    // into its shelter. They go up in a fraction of a second and come down slowly.
    if (sp.erect) {
      const alarm = clamp(brain.drives.fear * 2 + (brain.sheltered ? 1 : 0) + (brain.mode === 'patrol' && brain.focus ? 0.7 : 0) + (brain.mode === 'stalk' ? 0.6 : 0), 0, 1);
      const eT = lerp(sp.erect.rest, sp.erect.alarm, alarm);
      const erect = this.erect ?? sp.erect.rest;
      this.erect = erect + (eT - erect) * Math.min(1, dt * (eT > erect ? 6 : 0.8));
      if (u.uErect) u.uErect.value = this.erect;
    }
    if (this.spine) {
      // The moray's body follows its head's path with the travelling wave on it (fish/spineChain.ts); the
      // shader draws it along that path, so the analytic bend and wave are off.
      this.spine.update(dt, this, world, { phase: this.phase, amp: u.uAmp.value }, _up);
      this.spine.write(u.uPath.value, u.uPathUp.value, this, _up, _side);
      u.uPathOn.value = 1;
      u.uBend.value = u.uBendTail.value = 0;
    } else {
      u.uBend.value = this.bend;
      u.uBendTail.value = tail;
    }
  }

  /**
   * Ventilation: the gill covers flare at ~1-1.5 Hz at rest, faster when working hard. Buccal pump: the
   * mouth opens a little while the gill covers close, then shuts as they flare; it snaps open for food.
   */
  private animateGills(dt: number, u: SwimUniforms, blEq: number): void {
    const sp = this.sp, sw = sp.swim, brain = this.brain;
    this.ventPhase += dt * Math.PI * 2 * this.ventHz * (1 + 0.5 * clamp(blEq / sw.maxBL, 0, 1));
    u.uVent.value = VENT_AMPLITUDE * (0.5 + 0.5 * Math.sin(this.ventPhase));
    if (u.uGape) u.uGape.value = 0.07 * (0.5 - 0.5 * Math.sin(this.ventPhase)) + this.gulp * 2;
    if (sp.gill === false) {
      // Morays have no gill covers: they pump water over the gills by opening and closing the mouth
      // (~0.6-0.9 Hz), wider when working, and gape wide to strike.
      u.uVent.value = 0;
      if (u.uGape) u.uGape.value = 0.06 + (0.14 + 0.1 * clamp(blEq / sw.maxBL, 0, 1)) * (0.5 + 0.5 * Math.sin(this.ventPhase * 0.6)) + this.gulp * 1.5;
      // Resting in its crevice, an eel holds the front of its body up and out.
      u.uLift.value = lerp(u.uLift.value, brain.mode === 'lurk' ? 0.35 : 0, Math.min(1, dt * 0.8));
    }
  }

  /** Pectorals: labriform rowing (2-4 Hz typical), plus sculling for hovering and turning. */
  private animatePectorals(dt: number, blEq: number, finShare: number, tailShare: number, U: number): void {
    const sw = this.sp.swim, L = this.size;
    const labri = sw.mode === 'labriform' ? finShare : 0.4;
    const fPect = 1.0 + 1.2 * blEq * labri + 0.6 * Math.abs(this.turnRate);
    this.pectPhase += dt * Math.PI * 2 * fPect;
    const pectAmp = clamp(0.15 + labri * (0.25 + 0.35 * blEq / Math.max(sw.gait, 1)) + 0.15 * Math.abs(this.turnRate), 0, 0.85);
    const u = this.model.uniforms;
    // Lionfish fans stay spread: they beat and ripple at half the rowing rate rather than row, harder
    // while swimming fast, turning or stalking with the fans flared. At speed the water sweeps them back
    // along the flanks (on a spring, so they settle as it slows; not while stalking).
    const stalking = this.brain.mode === 'stalk';
    const fanBeat = clamp(blEq / Math.max(sw.gait, 1) + 0.6 * Math.abs(this.turnRate) + (stalking ? 0.5 : 0), 0, 1);
    const fanFold = this.model.fan ? clamp(spring(this.fanFold, stalking ? 0 : smoothstep(0.25, 0.9, U / (sw.maxBL * L)), 4, 0.8, dt), 0, 1) : 0;
    this.model.pects.forEach((p, i) => {
      const side = p.side;
      if (this.model.fan) {
        posePectoralFan(p, this.pectPhase * 0.5 + (side > 0 ? 0 : 0.3), fanBeat, this.sp.pectoral?.pose ?? FAN_POSE, fanFold);
        mountPectoral(p, u);
        return;
      }
      const springs = this.pectSprings[i];
      if (!springs) return;
      // Asymmetric stroke when turning: the outside fin works harder.
      const turnBias = 1 + clamp(-side * this.turnRate * 0.3, -0.4, 0.4);
      const ph = this.pectPhase + (side > 0 ? 0 : 0.2);
      // At speed a BCF swimmer tucks its pectorals back against the body. The fin is flexible: it
      // follows the stroke on a soft spring, so it lags the reversals and flicks past them.
      const tuck = tailShare * smoothstep(0.4, 1.0, U / (sw.maxBL * L));
      const open = spring(springs.open, (0.2 + pectAmp * turnBias * (0.5 + 0.5 * Math.sin(ph))) * (1 - 0.75 * tuck), 7, 0.5, dt);
      const flap = spring(springs.flap, (0.2 + 0.25 * Math.cos(this.pectPhase)) * (1 - 0.5 * tuck), 7, 0.5, dt);
      posePectoral(p, ph, open, flap);
      mountPectoral(p, u);
    });
  }
}
