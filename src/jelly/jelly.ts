// A moon jelly: one pulse a second or so (a quick contraction of the bell margin that thrusts along
// the bell axis and a slow relaxation). Each beat is a surge that the water's drag soon stops, and
// between beats the jelly, a little heavier than water, sinks. The bell points where it swims, often
// towards or away from the viewer, and the tank's current carries it round.
import * as THREE from 'three';
import { range, clamp, type Rng } from '../util.js';
import { sharedJellyGeometry } from './geometry.js';
import { BELL_VERT, BELL_FRAG, TENT_VERT, TENT_FRAG, ARM_VERT, ARM_FRAG } from './shaders.js';
import { makeGpuJellyMaterials } from './webgpu.js';
import { gpuActive, tsl } from '../webgpu/tsl.js';
import type { JellyBounds, JellySpecies, JellyWorld } from './types.js';
import { limitStep } from '../world/stepLimit.js';
import { fmtMetres, fmtSeconds, fmtSpeed, type InspectPanel } from '../inspect.js';
import { CreatureBase } from '../creature.js';
import { ContactInbox } from '../world/contactInbox.js';

/** How fast a jelly may be eased back inside the tank beyond its own drift (units/s). */
const JELLY_CRAWL = 0.05;

type Uniform<T> = { value: T };
interface JellyUniforms {
  uPulse: Uniform<number>; uTrail: Uniform<THREE.Vector3>; uR: Uniform<number>; uTime: Uniform<number>;
  uSeed: Uniform<number>; uLight: Uniform<number>; uTint: Uniform<THREE.Color>; uGonad: Uniform<THREE.Color>;
  [name: string]: THREE.IUniform;
}

const ADDITIVE = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false } as const;

const CONTRACT_SHARE = 0.3;          // of each pulse cycle: the quick close; the rest relaxes
const RELAX_FLARE = 0.35;            // how far the relaxing bell overshoots its rest shape (dips to about -0.07)
const THRUST_PER_RADIUS = 3.0;     // speed gained per unit contraction per unit bell radius
/** Heavier than water: with DRAG_RATE it settles to ~0.12 units/s (~1.5 cm/s) of sinking between beats. */
const SINK_RATE = 0.42;              // units/s^2
/** Strong drag: each beat's surge bleeds off in ~0.3 s, so the jelly glides, stalls and sinks before the next. */
const DRAG_RATE = 3.5;
const BUMP_RANGE = 1.15;             // bells nearer than this many summed radii push apart
const BUMP_STRENGTH = 0.6;
/** How hard a jelly tilts away from another it is touching or about to (against its wander, length 1). */
const JELLY_AVOID = 2;
/** The oral arms for collisions: their length (bell radii, as the arm shader draws them), the points
 *  along them (a share of the length: from just under the bell), and the bundle's radius there (bell
 *  radii, as base + slope * share: the four arms spread as they hang). */
const ARM_LENGTH = 1.3;
const ARM_CHAIN_S = [0.15, 0.45, 0.75, 1] as const;
const ARM_BUNDLE_R = [0.15, 0.2] as const;
const RIGHTING_RATE = 0.25;
/** Heading tilt from vertical (radians) a wander picks: from nearly upright to well over on its side. */
const WANDER_TILT: readonly [number, number] = [0.4, 1.45];
/** Share of wanders aimed mostly towards or away from the viewer, so the jellies travel through the depth. */
const WANDER_DEPTH_SHARE = 0.6;
/** Seconds a jelly keeps one heading. */
const WANDER_SECONDS: readonly [number, number] = [6, 14];
const WALL_MARGIN_X = 1.2;
const WALL_MARGIN_Z = 0.6;
const TOP_MARGIN = 1.0;
const MIN_Y = 0.6;
const LOW_Y = 1.2;
const TRAIL_HZ = 0.35;               // the soft parts' spring: slow and underdamped
const TRAIL_DAMPING = 0.3;
const TRAIL_DRAG = 6;                // trailing per unit speed per bell radius
const TRAIL_MAX = 1.2;
const NIGHT_GLOW = 0.25;             // light through the jelly with the tank lights off
const SEED_RANGE = 10;
const PULSE_HZ_REFERENCE_RADIUS = 0.5;
const PULSE_HZ_SCALE = 0.9;
/** Pulse rate spread between individuals (Hz at the reference radius, before PULSE_HZ_SCALE). */
const PULSE_HZ_RANGE: readonly [number, number] = [0.7, 1.1];

export class Jelly extends CreatureBase<JellyWorld> {
  readonly kind = 'jelly';
  readonly stepPhase = 'free';
  readonly sp: JellySpecies;
  readonly R: number;
  /** Click-proxy radius for the inspection overlay. */
  readonly pickRadius: number;
  readonly model = new THREE.Group();
  readonly inner = new THREE.Group();
  readonly pos: THREE.Vector3;
  readonly vel = new THREE.Vector3();
  readonly axis: THREE.Vector3;
  /** The avoidance reflex's messages (world/contactInbox.ts): the bell tilts away and pulses clear. */
  readonly inbox = new ContactInbox();
  private readonly _away = new THREE.Vector3();
  /** Its solid body (world/partHull.ts): the bell, and the oral arms hanging under it as one soft chain. */
  readonly hullParts: readonly string[] = ['bell'];
  readonly limbChains: readonly { readonly pts: readonly THREE.Vector3[]; radiusAt(i: number): number; readonly bends: boolean }[];
  private readonly armPts = ARM_CHAIN_S.map(() => new THREE.Vector3());
  private readonly rng: Rng;
  private readonly u: JellyUniforms;
  private readonly prefY: number;
  private readonly prefX: number;
  private readonly hz: number;
  private phase: number;
  private readonly wander = new THREE.Vector3();
  private wanderT = 0;
  private readonly _q = new THREE.Quaternion();
  private readonly _f = new THREE.Vector3();
  private readonly prevPos = new THREE.Vector3();
  private readonly trailV = new THREE.Vector3();   // velocity of the trail spring
  private readonly _t = new THREE.Vector3();

  constructor(sp: JellySpecies, rng: Rng, bounds: JellyBounds) {
    super();
    this.sp = sp;
    this.rng = rng;
    this.R = range(rng, sp.size[0], sp.size[1]);
    this.pickRadius = 1.3 * this.R;
    const g = sharedJellyGeometry();
    this.u = {
      uPulse: { value: 0 }, uTrail: { value: new THREE.Vector3() }, uR: { value: this.R }, uTime: { value: 0 }, uSeed: { value: rng() * SEED_RANGE }, uLight: { value: 1 },
      uTint: { value: new THREE.Color(0.55, 0.75, 1.0) }, uGonad: { value: new THREE.Color(0.95, 0.8, 1.0) },
    };
    const mat = (vertexShader: string, fragmentShader: string, uniforms: Record<string, THREE.IUniform> = this.u): THREE.ShaderMaterial =>
      new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader, ...ADDITIVE });
    // The shapes are built for a unit bell (uR = 1) and scaled with the group.
    this.u.uR.value = 1;
    const gpuMats = gpuActive() ? makeGpuJellyMaterials(tsl(), this.u) : null;
    const bell = gpuMats
      ? new THREE.Mesh(g.bell, gpuMats.bell)
      : new THREE.Mesh(g.bell, mat(BELL_VERT, BELL_FRAG, { ...this.u, uInner: { value: 0 } }));
    const sub = gpuMats
      ? new THREE.Mesh(g.bell, gpuMats.sub)
      : new THREE.Mesh(g.bell, mat(BELL_VERT, BELL_FRAG, { ...this.u, uInner: { value: 1 } }));   // the subumbrella
    const tent = gpuMats
      ? new THREE.LineSegments(g.tent, gpuMats.tent)
      : new THREE.LineSegments(g.tent, mat(TENT_VERT, TENT_FRAG));
    const arms = gpuMats
      ? g.arms.map((a) => new THREE.Mesh(a, gpuMats.arms))
      : g.arms.map((a) => new THREE.Mesh(a, mat(ARM_VERT, ARM_FRAG)));
    this.inner.scale.setScalar(this.R);
    bell.name = 'bell'; sub.name = 'subumbrella';
    this.inner.add(bell, sub, tent, ...arms);
    this.model.add(this.inner);
    for (const m of [bell, sub, tent, ...arms]) m.frustumCulled = false;

    const B = bounds;
    this.pos = new THREE.Vector3(range(rng, B.x0 + 1, B.x1 - 1), range(rng, 1.5, B.y1 - 1), range(rng, B.z0 + 0.8, B.z1 - 0.8));
    this.prefY = range(rng, 0.6, B.y1 - 1.8);
    this.prefX = this.pos.x;
    this.axis = new THREE.Vector3(range(rng, -0.4, 0.4), 1, range(rng, -0.4, 0.4)).normalize();
    this.hz = range(rng, PULSE_HZ_RANGE[0], PULSE_HZ_RANGE[1]) * (PULSE_HZ_SCALE / Math.sqrt(this.R / PULSE_HZ_REFERENCE_RADIUS));   // bigger bells pulse slower
    this.phase = rng();
    const R = this.R;
    this.limbChains = [{ pts: this.armPts, radiusAt: (i: number) => R * (ARM_BUNDLE_R[0] + ARM_BUNDLE_R[1] * (ARM_CHAIN_S[i] ?? 1)), bends: false }];
    this.placeArms();
  }

  /** Mass by the fish's measure (length cubed), its length taken as the bell's width. */
  get mass(): number { return (2 * this.R) ** 3; }

  /** The oral arms' chain, as the arm shader hangs them: down from under the bell, swung by the trail. */
  private placeArms(): void {
    const tr = this.u.uTrail.value, R = this.R;
    ARM_CHAIN_S.forEach((s, i) => this.armPts[i]?.set(0, -ARM_LENGTH * s, 0).addScaledVector(tr, ARM_LENGTH * s * s).multiplyScalar(R));
  }

  /** The click panel: its real pulse, drift, favoured level and home column. */
  override inspect(): InspectPanel {
    const dy = this.prefY - this.pos.y;
    const note = Math.abs(dy) > 0.5
      ? (dy > 0 ? 'Pulsing to climb towards its favoured level' : 'Sinking back towards its favoured level')
      : 'Holding its level on the current';
    return {
      title: this.sp.name,
      sci: this.sp.sci,
      note,
      rows: [
        { heading: 'State' },
        { label: 'Bell', bar: Jelly.contraction(this.phase), cls: 'energy' },
        { label: 'Pulse rate', value: `${this.hz.toFixed(2)} Hz` },
        { label: 'Drift', value: fmtSpeed(this.vel.length()) },
        { label: 'Height', value: fmtMetres(this.pos.y) },
        { heading: 'Home' },
        { label: 'Favoured height', value: fmtMetres(this.prefY) },
        { label: 'Home column', value: `x = ${this.prefX.toFixed(1)}` },
        { label: 'Next wander', value: fmtSeconds(this.wanderT) },
        { label: 'Bell width', value: `${Math.round(2 * this.R * 12.5)} cm` },
      ],
      fact: this.sp.fact,
    };
  }

  /**
   * Bell contraction over one pulse cycle: quick (30%), then a slower relaxation that overshoots a
   * little below 0 near its end (the bell flares past its rest shape, then settles).
   */
  static contraction(ph: number): number {
    if (ph < CONTRACT_SHARE) return Math.sin((ph / CONTRACT_SHARE) * Math.PI / 2);
    const t = (ph - CONTRACT_SHARE) / (1 - CONTRACT_SHARE);
    return Math.cos(t * Math.PI / 2) ** 2 - RELAX_FLARE * t * Math.sin(t * Math.PI);
  }

  /** Bells that touch bump softly apart. */
  protected override sense(dt: number, world: JellyWorld): void {
    for (const o of world.jellies) {
      if (o === this) continue;
      const d = this.pos.distanceTo(o.pos), min = (this.R + o.R) * BUMP_RANGE;
      if (d < min && d > 1e-4) this.vel.addScaledVector(this._f.subVectors(this.pos, o.pos), ((min - d) / min) * BUMP_STRENGTH * dt / d);
    }
  }

  /** Pulse, drift on the current, turn to its heading, then pose the bell and its trailing parts. */
  protected act(dt: number, world: JellyWorld): void {
    const c = this.pulse(dt);
    this.prevPos.copy(this.pos);
    const drift = this.drift(dt, world);
    this.right(dt, world.bounds);
    limitStep(this.prevPos, this.pos, this.vel.length() + drift, JELLY_CRAWL, dt);
    this.model.position.copy(this.pos);
    this.model.quaternion.copy(this._q.setFromUnitVectors(THREE.Object3D.DEFAULT_UP, this.axis));
    this.u.uPulse.value = c;
    this.trail(dt);
    this.placeArms();
    this.u.uTime.value += dt;
    this.u.uLight.value = NIGHT_GLOW + (1 - NIGHT_GLOW) * world.light;
  }

  /**
   * Thrust while the bell closes, along the bell axis: a surge to ~8 cm/s (a mid-size bell at its
   * favoured depth) that drag bleeds off within the beat, then a slow sink until the next; pointed
   * straight up it still nets ~2 cm/s of climb. Each jelly holds a
   * loose depth: above it the pulses weaken and it sinks, below it they strengthen. Returns the
   * contraction now.
   */
  private pulse(dt: number): number {
    // Thrust comes from the bell closing, not from easing back out of the flare.
    const prev = Math.max(0, Jelly.contraction(this.phase));
    this.phase = (this.phase + dt * this.hz) % 1;
    const c = Jelly.contraction(this.phase);
    const effort = clamp(0.6 + (this.prefY - this.pos.y) * 0.35, 0.15, 1.3);
    const push = Math.max(0, c - prev) * this.R * THRUST_PER_RADIUS * effort;
    this.vel.addScaledVector(this.axis, push);
    this.vel.y -= SINK_RATE * dt;
    this.vel.multiplyScalar(Math.exp(-dt * DRAG_RATE));   // drag
    return c;
  }

  /** The kreisel current carries it round. Returns the current's speed here. */
  private drift(dt: number, world: JellyWorld): number {
    world.flow(this.pos, this._f);
    this.pos.addScaledVector(this.vel, dt).addScaledVector(this._f, dt);
    return this._f.length();
  }

  /**
   * The bell swims where it points, so its heading is its course: every few seconds it picks a new
   * one anywhere in the upper hemisphere (often towards or away from the viewer, through the tank's
   * depth) and turns to it slowly. Near the walls it tips away from them.
   */
  private right(dt: number, B: JellyBounds): void {
    this.wanderT -= dt;
    if (this.wanderT <= 0) {
      const tilt = range(this.rng, WANDER_TILT[0], WANDER_TILT[1]);
      const side = this.rng() < 0.5 ? -1 : 1;
      const az = this.rng() < WANDER_DEPTH_SHARE
        ? side * Math.PI / 2 + range(this.rng, -0.5, 0.5)   // mostly along z: towards or away from the viewer
        : range(this.rng, -Math.PI, Math.PI);
      this.wander.set(Math.sin(tilt) * Math.cos(az), Math.cos(tilt), Math.sin(tilt) * Math.sin(az));
      this.wanderT = range(this.rng, WANDER_SECONDS[0], WANDER_SECONDS[1]);
    }
    const want = this._f.copy(this.wander);
    want.x += clamp((this.prefX - this.pos.x) * 0.12, -0.5, 0.5);   // a loose home column, so they spread out
    const m = WALL_MARGIN_X, mz = WALL_MARGIN_Z + 0.5 * this.R;   // big bells turn before their rim meets the glass
    if (this.pos.x < B.x0 + m) want.x += (B.x0 + m - this.pos.x) * 2;
    if (this.pos.x > B.x1 - m) want.x -= (this.pos.x - B.x1 + m) * 2;
    if (this.pos.z < B.z0 + mz) want.z += 1.5;
    if (this.pos.z > B.z1 - mz) want.z -= 1.5;
    if (this.pos.y > B.y1 - TOP_MARGIN) want.y -= 2.5;   // near the top: tip over and drift back down
    if (this.pos.y < LOW_Y) want.y += 1.5;
    const u = this.inbox.read(this._away);
    if (u > 0) want.addScaledVector(this._away, u * JELLY_AVOID);
    this.axis.lerp(want.normalize(), Math.min(1, dt * RIGHTING_RATE)).normalize();
    this.pos.x = clamp(this.pos.x, B.x0, B.x1);
    this.pos.y = clamp(this.pos.y, MIN_Y, B.y1);
    this.pos.z = clamp(this.pos.z, B.z0, B.z1);
  }

  /**
   * Tentacles and oral arms are soft: they trail opposite the bell's motion through the water and keep
   * hanging towards the world's down as the bell tips, on a soft, underdamped spring (so a tilt or a
   * bump sets them swinging slowly).
   */
  private trail(dt: number): void {
    const inv = this._q.invert();
    const target = this._t.copy(this.vel).multiplyScalar(-TRAIL_DRAG / this.R).add(this._f.set(0, -1, 0)).applyQuaternion(inv);
    target.y += 1;   // the rest pose already hangs along the bell's own down
    target.clampLength(0, TRAIL_MAX);
    const tr = this.u.uTrail.value, w = 2 * Math.PI * TRAIL_HZ;
    this.trailV.addScaledVector(this._f.subVectors(target, tr), w * w * dt).multiplyScalar(Math.exp(-2 * TRAIL_DAMPING * w * dt));
    tr.addScaledVector(this.trailV, dt);
  }
}
