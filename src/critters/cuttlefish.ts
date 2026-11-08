// Common cuttlefish.
//
// Mantle 1.0-1.3 units (13-16 cm). A flattened oval mantle with a fin skirt round its whole edge that
// carries waves (forward or backward: they hover, cruise and swim backwards on the fins alone), a broad
// head with W-shaped pupils, eight short arms held together in a point. The dorsal mantle shows the
// zebra display of the reference photos (dark brown bars with white between), a row of white spots
// along the fin base and a pale belly; when hunting, dark "passing clouds" sweep forward over the back,
// and resting on the sand it turns mottled.
import * as THREE from 'three';
import { range, clamp, lerp, wrapAngle, mulberry32, type Rng } from '../util.js';
import { mantleR } from '../softBodies.js';
import { softBodyGeometry } from './softBodyMeshes.js';
import { skin, spring, threatNear, randomTarget, Swimmer, CEPH_SSS, scalarNode, vec3Node, type ShaderHook, type NodeHook, type SpringState } from './shared.js';
import { boundMaterialColor, type NodeObject } from '../webgpu/tsl.js';
import { cuttleSkin, cuttleFinTex, wPupilEye, cuttleArmGeometry, armVariation, finGeometry, FIN_K, CUTTLE_ARM_GLSL } from './cuttlefishParts.js';
import type { InspectPanel } from '../inspect.js';
import { CritterBrain, type DriveInfo } from './critterBrain.js';
import type { Critter, CritterFood, CritterSpecies, CritterWorld, JoinRule } from './types.js';

export type CuttlefishMode = 'hover' | 'cruise' | 'rest' | 'hunt' | 'jet';

interface CuttleUniforms {
  [name: string]: THREE.IUniform;
  uTime: { value: number }; uCloud: { value: number }; uMottle: { value: number }; uPale: { value: number };
  uSqueeze: { value: THREE.Vector3 }; uExt: { value: number };
}

const ARM_COUNT = 8;
const TENTACLE_ARMS: ReadonlySet<number> = new Set([1, 3]);
const ARM_LENGTH = 0.27;
const ARM_SEED = 0xa2b5;
const TENTACLE_LENGTH_SHARE = 0.85;
const FIN_SEGMENTS = 48;
const STRIKE_SECONDS = 0.4;
const STRIKE_STRETCH = 2.5;
const JET_SECONDS = 1.4;
const CALM_AFTER_JET = 12;
const THREAT_RANGE = 1.6;
const FOOD_RANGE = 3.5;
const HUNT_SECONDS = 20;
const JET_AWAY_DISTANCE = 3;
const JET_SPEED = 2.2;

/** Drive time scales (s), and how much a catch takes off hunger. */
const HUNGER_SECONDS = 200, FOOD_BITE = 0.25;
const TIRE_SECONDS = 150, JET_TIRE_SECONDS = 8, REST_SECONDS = 50, FEAR_SECONDS = 30, FIDGET_SECONDS = 60, CALM_SECONDS = 40;
/** Seconds between reconsiderations once a choice stands. */
const RETHINK_SECONDS = 3;

type CuttleDrive = 'hunger' | 'fatigue' | 'fear' | 'restless';
const DRIVES: Readonly<Record<CuttleDrive, DriveInfo>> = {
  hunger: { label: 'Hunger', cls: 'hunger' },
  fatigue: { label: 'Tiredness', cls: 'energy' },
  fear: { label: 'Fear', cls: 'fear' },
  restless: { label: 'Restlessness', cls: 'boredom' },
};
type CuttleTrait = 'appetite' | 'activity' | 'calm';
const TRAITS: Readonly<Record<CuttleTrait, string>> = { appetite: 'Appetite', activity: 'Activity', calm: 'Calm' };

const MODE_NOTES: Readonly<Record<CuttlefishMode, string>> = {
  hover: 'Hovering on its fins',
  cruise: 'Cruising over the reef',
  rest: 'Resting on the sand, mottled',
  hunt: 'Hunting: dark passing clouds sweep its back',
  jet: 'Startled: jetting away, pale as a ghost',
};

const MANTLE_VERT_HEAD = 'uniform vec3 uSqueeze;\nattribute float aWeight;\nvarying float vMantle;\n';
const MANTLE_VERT_BEGIN = `#include <begin_vertex>
        transformed *= mix(vec3(1.0), uSqueeze, aWeight);
        vMantle = aWeight;`;
const MANTLE_FRAG_HEAD = 'uniform float uTime, uCloud, uMottle, uPale;\nvarying float vMantle;\n';
const MANTLE_FRAG_MAP = `#include <map_fragment>
        {
          float dors = smoothstep(0.35, 0.0, min(abs(vMapUv.x - 0.75), 1.0 - abs(vMapUv.x - 0.75)));
          diffuseColor.rgb = mix(vec3(0.3, 0.16, 0.11) * (1.1 - 0.35 * dors), diffuseColor.rgb, smoothstep(0.15, 0.7, vMantle));   // the head
          float cloud = smoothstep(0.55, 0.95, sin(vMapUv.y * 18.0 - uTime * 3.0 + sin(vMapUv.x * 30.0) * 0.6));
          float mott = smoothstep(0.4, 0.7, fract(sin(dot(floor(vec2(fract(vMapUv.x), vMapUv.y) * vec2(60.0, 40.0)), vec2(12.9898, 78.233))) * 43758.5453));
          diffuseColor.rgb *= 1.0 - dors * (uCloud * 0.55 * cloud + uMottle * 0.35 * mott);
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.82, 0.78, 0.74), uPale * 0.6);
        }`;

const _v = new THREE.Vector3();

export class Cuttlefish implements Critter {
  readonly kind = 'cuttlefish' as const;
  readonly sp: CritterSpecies;
  readonly radius: number;
  /** Mantle length (units). */
  readonly ML: number;
  /** Click-proxy radius for the inspection overlay. */
  readonly pickRadius: number;
  readonly model = new THREE.Group();
  readonly mantle: THREE.Mesh;
  readonly crown = new THREE.Group();
  readonly arms: THREE.Mesh[] = [];
  readonly fins: THREE.Mesh[];
  readonly buildMs: number;
  // Where parts are attached (and may run into each other): critterCheck.ts.
  readonly joins: readonly JoinRule[] = [['eye*', 'mantle'], ['arm*', 'mantle'], ['fin*', 'mantle']];
  readonly body: Swimmer;
  readonly pos: THREE.Vector3;
  mode: CuttlefishMode = 'hover';
  modeT = 0;
  target: THREE.Vector3;
  /** Jet strength left, 1 at the start of a jet. */
  jet = 0;
  /** Strike time left (s): the tentacles are out. */
  strike = 0;
  private readonly rng: Rng;
  private readonly u: CuttleUniforms;
  private readonly finN = FIN_SEGMENTS;
  private finPhase = 0;
  private readonly sArmY: SpringState = { x: 0, v: 0 };
  private readonly sArmZ: SpringState = { x: 0, v: 0 };
  private readonly sSqueeze: SpringState = { x: 0, v: 0 };
  private calm = 0;
  private reverse = false;
  /** The food it last saw (new food in sight makes it think again). */
  private seen: CritterFood | null = null;
  readonly brain: CritterBrain<CuttleDrive, CuttlefishMode, CuttleTrait>;

  constructor(sp: CritterSpecies, rng: Rng, world: CritterWorld) {
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
    this.brain = new CritterBrain(DRIVES,
      { hunger: range(rng, 0.2, 0.5), fatigue: range(rng, 0.1, 0.3), fear: 0, restless: range(rng, 0.1, 0.4) },
      { appetite: rng(), activity: rng(), calm: rng() }, TRAITS);
    const ML = this.ML = range(rng, 1.0, 1.3);
    this.pickRadius = 0.75 * ML;
    this.u = { uTime: { value: 0 }, uCloud: { value: 0 }, uMottle: { value: 0 }, uPale: { value: 0 }, uSqueeze: { value: new THREE.Vector3(1, 1, 1) }, uExt: { value: 1 } };
    const skinTex = cuttleSkin(rng);
    skinTex.wrapS = THREE.RepeatWrapping;   // the seam's own vertices run on past u = 1
    const mantleMat = skin({ map: skinTex, roughness: 0.45, metalness: 0 }, 'cuttle-mantle', this.mantleHook(), CEPH_SSS, this.mantleNodeHook());

    // Mantle, head, eye bulges and the arm crown: one blended mesh (built for ML = 1).
    const body = new THREE.Mesh(softBodyGeometry('cuttlefish-body'), mantleMat);
    body.scale.setScalar(ML);
    body.castShadow = true;
    body.name = 'mantle';
    this.model.add(body);
    this.mantle = body;
    this.addEyes(ML);
    const t0 = performance.now();
    this.addArms(ML);
    this.fins = this.addFins(rng);
    this.buildMs = performance.now() - t0;

    const B = world.bounds;
    this.body = new Swimmer(new THREE.Vector3(range(rng, B.x0 + 2, B.x1 - 2), range(rng, 1.8, 4.5), range(rng, -1, 1.5)), range(rng, -3, 3));
    this.pos = this.body.pos;
    this.target = this.pos.clone();
  }

  /**
   * The mantle and head are one mesh (softBodies.ts): the mantle's share (aWeight) squeezes in a
   * jet, about the head end, and the head takes its own colour.
   */
  private mantleHook(): ShaderHook {
    return (shader) => {
      Object.assign(shader.uniforms, this.u);
      shader.vertexShader = MANTLE_VERT_HEAD + shader.vertexShader.replace('#include <begin_vertex>', MANTLE_VERT_BEGIN);
      shader.fragmentShader = MANTLE_FRAG_HEAD + shader.fragmentShader.replace('#include <map_fragment>', MANTLE_FRAG_MAP);
    };
  }

  /** TSL form of mantleHook(): the mantle squeeze (position) and the head/cloud/mottle/pale patch. */
  private mantleNodeHook(): NodeHook {
    return (t, mat) => {
      const uSqueeze = vec3Node(t, this.u.uSqueeze);
      const uTime = scalarNode(t, this.u.uTime), uCloud = scalarNode(t, this.u.uCloud);
      const uMottle = scalarNode(t, this.u.uMottle), uPale = scalarNode(t, this.u.uPale);
      const aWeight = t.attribute('aWeight', 'float');
      const positionNode = t.Fn(() => t.positionLocal.mul(t.mix(t.vec3(1), uSqueeze, aWeight)))();
      const colorNode = t.Fn(() => {
        const uv = t.uv();
        const dors = t.smoothstep(0.35, 0, t.min(t.abs(uv.x.sub(0.75)), t.float(1).sub(t.abs(uv.x.sub(0.75)))));
        const head = t.mix(
          t.vec3(0.3, 0.16, 0.11).mul(t.float(1.1).sub(t.float(0.35).mul(dors))),
          boundMaterialColor(t, mat),
          t.smoothstep(0.15, 0.7, aWeight),
        );
        const cloud = t.smoothstep(0.55, 0.95, t.sin(uv.y.mul(18).sub(uTime.mul(3)).add(t.sin(uv.x.mul(30)).mul(0.6))));
        const mott = t.smoothstep(0.4, 0.7, t.fract(t.sin(t.dot(
          t.floor(t.vec2(t.fract(uv.x), uv.y).mul(t.vec2(60, 40))),
          t.vec2(12.9898, 78.233),
        )).mul(43758.5453)));
        const c = head.mul(t.float(1).sub(dors.mul(uCloud.mul(0.55).mul(cloud).add(uMottle.mul(0.35).mul(mott)))));
        return t.mix(c, t.vec3(0.82, 0.78, 0.74), uPale.mul(0.6));
      })();
      return { positionNode, colorNode };
    };
  }

  /** TSL form of the arm hook (CUTTLE_ARM_GLSL): the curl/kink/strike bend on the positions, and the
   *  same frame applied to the authored arm normals. */
  private armNodeHook(): NodeHook {
    return (t) => {
      type N = NodeObject;
      const uExt = scalarNode(t, this.u.uExt);
      const aSec = t.attribute('aSec', 'vec4');
      const aArm = t.attribute('aArm', 'vec3');
      const aNrm = t.attribute('aNrm', 'vec3');
      const aVar = t.attribute('aVar', 'vec3');
      const bend = (q: N, curl: N, straight: N): N =>
        curl.mul(q).mul(q).add(t.float(1).sub(straight).mul(aVar.y).mul(t.sin(aVar.z.add(t.float(6).mul(q)))).mul(q));
      // Shared setup (duplicated in the two Fns below; the loop is the only part that is not).
      const tent = aArm.z, L = aArm.y;
      const ext = t.float(1).add(tent.mul(uExt.sub(1)));
      const s = aSec.x.mul(L).mul(ext);
      const straight = tent.mul(t.clamp(ext.sub(1).div(0.4), 0, 1));
      const curl = t.float(0.7).mul(aVar.x).mul(t.float(1).sub(straight));
      const q = t.min(s, L).div(L);
      const th = bend(q, curl, straight);
      const T = t.vec3(t.cos(th), t.sin(th).negate(), 0);
      const Nm = t.vec3(t.sin(th), t.cos(th), 0);
      const Z = t.vec3(0, 0, 1);
      const positionNode = t.Fn(() => {
        const du = s.div(t.float(10));
        const c = t.vec2(0).toVar('armC');
        t.Loop({ start: 0, end: 10 }, ({ i }: { i: NodeObject }) => {
          const qi = t.min(t.float(i).add(0.5).mul(du), L).div(L);
          const thi = bend(qi, curl, straight);
          c.addAssign(t.vec2(t.cos(thi), t.sin(thi).negate()).mul(du));
        });
        const rho = t.float(3.4).mul(t.mix(t.float(0.022), t.float(0.008), q));
        return t.vec3(c, 0)
          .add(Nm.mul(rho.mul(t.sin(aArm.x)).add(aSec.z)))
          .add(Z.mul(rho.mul(t.cos(aArm.x)).add(aSec.w)))
          .add(T.mul(aSec.y));
      })();
      const normalNode = t.Fn(() => t.transformNormalToView(T.mul(aNrm.x).add(Nm.mul(aNrm.y)).add(Z.mul(aNrm.z))).normalize())();
      return { positionNode, normalNode };
    };
  }

  /** Eyes (in their bulges on the head). */
  private addEyes(ML: number): void {
    const eyeMat = skin({ map: wPupilEye(), roughness: 0.15 }, 'cuttle-eye');
    for (const s of [1, -1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.06 * ML, 20, 14), eyeMat);
      eye.position.set(0.09 * ML, 0.065 * ML, s * 0.14 * ML);   // set high on the head
      eye.rotation.y = s > 0 ? -Math.PI / 2 : Math.PI / 2;
      eye.name = `eye${s > 0 ? 0 : 1}`;
      this.model.add(eye);
    }
  }

  /**
   * Arms: eight thick, tapering arms held together in a bundle, angled forward and down with the
   * tips curling under; pale below (the photos). Built once, in the rest pose, and bent in the vertex
   * shader (cuttleArm): a tentacle's strike is the uExt uniform, so nothing is rebuilt per frame.
   * A crown on the front of the head carries them. The bundle bends as one (rigid in section, so
   * the arms never cross): each arm keeps its place in a ring about the bundle's centre line, the
   * ring narrowing with the arms' taper so neighbours stay just apart to the tips. Two of the upper
   * arms stand in for the tentacles: on a strike they straighten and shoot out ahead, clear above
   * the rest as those curl under.
   */
  private addArms(ML: number): void {
    const armMat = skin({ color: 0xd2bcae, roughness: 0.5 }, 'cuttle-arm', (shader) => {
      shader.uniforms['uExt'] = this.u.uExt;
      shader.vertexShader = CUTTLE_ARM_GLSL + shader.vertexShader
        .replace('#include <beginnormal_vertex>', `vec3 armP, objectNormal;
          cuttleArm(armP, objectNormal);`)
        .replace('#include <begin_vertex>', 'vec3 transformed = armP;');
    }, { ...CEPH_SSS, thin: 'attr' }, this.armNodeHook());
    this.crown.position.set(0.19 * ML, -0.03 * ML, 0);
    this.model.add(this.crown);
    // Each arm is a little different (length, girth, curl, kinks, tip); a stream of its own, seeded from
    // this animal's mantle length, so the animal's rng draws are unchanged.
    const vary = mulberry32(Math.round(ML * 1e6) ^ ARM_SEED);
    for (let i = 0; i < ARM_COUNT; i++) {
      const tentacle = TENTACLE_ARMS.has(i), v = armVariation(vary), len = range(vary, 0.86, 1.1);
      const arm = new THREE.Mesh(cuttleArmGeometry((i / ARM_COUNT) * Math.PI * 2, ARM_LENGTH * len * (tentacle ? TENTACLE_LENGTH_SHARE : 1), tentacle, v), armMat);
      arm.scale.setScalar(ML);   // (built for ML = 1)
      arm.frustumCulled = false;   // a strike reaches well past the rest pose's bounds
      arm.name = `arm${i}`;
      this.crown.add(arm);
      this.arms.push(arm);
    }
  }

  /**
   * Fin skirt: along each side of the mantle, a thick strip with a lens-shaped section that thins to
   * a translucent edge; its root row lies inside the mantle, so it grows out of it. Waved on the CPU
   * each frame (waveFins).
   */
  private addFins(rng: Rng): THREE.Mesh[] {
    const finTex = cuttleFinTex(rng);
    return [1, -1].map((side) => {
      const mesh = new THREE.Mesh(finGeometry(this.finN), skin({ map: finTex, roughness: 0.5, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false }, 'cuttle-fin', null, { ...CEPH_SSS, back: 1.0, thin: 'attr' }));
      mesh.userData['side'] = side; mesh.name = `fin${side > 0 ? 0 : 1}`;
      this.model.add(mesh);
      return mesh;
    });
  }

  private waveFins(dt: number, speed: number): void {
    // Waves run tail-wards to go forward, head-wards to back up; amplitude and rate grow with speed.
    const ML = this.ML, dirn = speed >= 0 ? 1 : -1, a = 0.035 * ML + Math.abs(speed) * 0.03 * ML;
    const ms = this.u.uSqueeze.value;   // the skirt's root follows the mantle as it squeezes
    this.finPhase += dt * (3 + Math.abs(speed) * 6) * dirn;
    const R = FIN_K.length;
    for (const f of this.fins) {
      const p = f.geometry.getAttribute('position'), side = Number(f.userData['side']);
      // the section's normal (across the skirt x along it), for the lens thickness
      const ny = 1 / Math.hypot(1, 0.4), nz = 0.4 * side * ny;
      for (let i = 0; i <= this.finN; i++) {
        const t = i / this.finN, x = -ML * (0.04 + 0.94 * t);                   // head -> tail
        const half = mantleR(0.96 - 0.94 * t) * ML;
        const w = 0.085 * ML * Math.sin(Math.PI * Math.min(1, t * 1.02 + 0.02)) ** 0.2;   // even width, full length
        for (let j = 0; j < R; j++) {
          // The base runs along the lower flank (a third of the way down, where the mantle is ~0.84
          // of its width) and the skirt droops, so from the side it shows as a band below the bars.
          // Rows from the root (k < 0: inside the mantle) out to the edge (k 1), on the top surface
          // then back along the bottom one.
          const k = FIN_K[j] ?? 0, kk = Math.max(0, k), y = Math.sin(this.finPhase + t * 9) * a * kk * kk;
          const th = 0.5 * 0.022 * ML * (1 - kk) ** 0.6 * (0.4 + 0.6 * Math.sin(Math.PI * Math.min(1, t * 1.05 + 0.03)) ** 0.5);
          const X = x * ms.x, Y = y - 0.62 * 0.55 * half * ms.y - 0.4 * w * k, Z = side * (half * 0.82 * ms.z + w * k);
          p.setXYZ(i * 2 * R + j, X, Y + ny * th, Z + nz * th);
          p.setXYZ(i * 2 * R + 2 * R - 1 - j, X, Y - ny * th, Z - nz * th);
        }
      }
      p.needsUpdate = true;
      f.geometry.computeVertexNormals();
      f.geometry.computeBoundingSphere();
    }
  }

  startle(): void {
    this.mode = 'jet'; this.modeT = JET_SECONDS; this.jet = 1;
    this.brain.add('fear', 1);
  }

  forceStrike(seconds: number): void {
    this.strike = seconds;
  }

  /** The click panel, laid out as the fish panel. */
  inspect(): InspectPanel {
    return this.brain.panel(this.sp, this.mode, MODE_NOTES[this.mode]);
  }

  update(dt: number, world: CritterWorld): void {
    this.modeT -= dt;
    this.u.uTime.value += dt;
    this.reactToThreat(dt, world);
    this.feelDrives(dt);
    const food = this.lookForFood(world);
    if (this.modeT <= 0 || this.foodChanged(food)) this.decide(world, food);
    const speed = this.speedFor(dt, food);
    const b = this.body, yaw0 = b.yaw, pitch0 = b.pitch;
    b.steer(dt, world, this.target, { turn: 0.9, speed, accel: this.mode === 'jet' ? 6 : 1.2, clearance: 0.25 * this.ML, reverse: speed < 0 });
    if (this.mode === 'rest' && this.pos.distanceTo(this.target) < 0.4) b.pitch = lerp(b.pitch, 0, dt);
    const { armY, armZ } = this.swingArms(dt, yaw0, pitch0);
    this.colourSkin(dt);
    this.poseArms(dt, armY, armZ);
    this.waveFins(dt, b.speed);
    b.place(this.model);
  }

  /** Startle: jet away backwards, going pale; after a jet it stays put a while before it can startle again. */
  private reactToThreat(dt: number, world: CritterWorld): void {
    this.calm -= dt;
    const threat = this.calm <= 0 && this.mode !== 'jet' ? threatNear(this, world, THREAT_RANGE) : null;
    if (!threat) return;
    this.mode = 'jet'; this.modeT = JET_SECONDS; this.jet = 1; this.calm = CALM_AFTER_JET;
    this.brain.add('fear', 1);
    this.target.copy(this.pos).addScaledVector(_v.subVectors(this.pos, threat.pos).setY(0).normalize(), JET_AWAY_DISTANCE);
  }

  /** The nearest food in sight (none during a jet). */
  private lookForFood(world: CritterWorld): CritterFood | null {
    if (this.mode === 'jet') return null;
    let food: CritterFood | null = null, best = FOOD_RANGE;
    for (const f of world.food) if (!f.eaten) { const d = f.pos.distanceTo(this.pos); if (d < best) { best = d; food = f; } }
    return food;
  }

  /** Cruising tires it and resting restores it; sitting still makes it restless; fear fades. */
  private feelDrives(dt: number): void {
    const br = this.brain, m = this.mode;
    br.add('hunger', dt / HUNGER_SECONDS);
    br.add('fatigue', m === 'cruise' || m === 'hunt' ? dt / TIRE_SECONDS : m === 'jet' ? dt / JET_TIRE_SECONDS : m === 'rest' ? -dt / REST_SECONDS : dt / (TIRE_SECONDS * 3));
    br.add('fear', -dt / FEAR_SECONDS);
    br.add('restless', m === 'cruise' ? -dt / CALM_SECONDS : dt / FIDGET_SECONDS);
  }

  /** Food has come into sight since the last decision (or the one it was after is gone). */
  private foodChanged(food: CritterFood | null): boolean {
    const changed = food !== this.seen;
    this.seen = food;
    return changed && food !== null;
  }

  /** Score hover, cruise, rest and (with food in sight) hunt; a jet runs its course first. */
  private decide(world: CritterWorld, food: CritterFood | null): void {
    if (this.mode === 'jet' && this.modeT > 0) return;
    const br = this.brain, { hunger, fatigue, fear, restless } = br.drives;
    const scores: Partial<Record<CuttlefishMode, number>> = {
      hover: 0.3 + fear * 0.6,
      cruise: (0.2 + restless * 0.9) * br.weight('activity') * (1 - fear * 0.5),
      rest: fatigue * 1.1 * br.weight('calm'),
    };
    if (food) scores.hunt = (0.3 + hunger * 1.3) * br.weight('appetite') - fear * 0.8;
    const current = this.mode === 'jet' ? null : this.mode;
    const next = br.choose(current, scores);
    if (next === current) { this.modeT = RETHINK_SECONDS; return; }
    this.go(next, world);
  }

  private go(mode: CuttlefishMode, world: CritterWorld): void {
    const rng = this.rng;
    this.mode = mode;
    if (mode === 'hunt') { this.modeT = HUNT_SECONDS; return; }
    this.modeT = this.mode === 'rest' ? range(rng, 25, 50) : range(rng, 8, 18);
    this.reverse = this.mode === 'cruise' && rng() < 0.3;
    if (this.mode === 'rest') {
      const t = randomTarget(rng, world, 0, 0);
      t.y = world.reefHeight(t.x, t.z) + 0.12 * this.ML;
      this.target = t;
    } else if (this.mode === 'hover') {
      this.target = this.pos.clone().add(new THREE.Vector3(range(rng, -0.5, 0.5), range(rng, -0.2, 0.2), range(rng, -0.3, 0.3)));
    } else this.target = randomTarget(rng, world, 1.2, 5);
  }

  private speedFor(dt: number, food: CritterFood | null): number {
    if (this.mode === 'jet') {
      const speed = -JET_SPEED * this.jet;
      this.jet = Math.max(0, this.jet - dt * 0.9);
      if (this.modeT <= 0) this.mode = 'hover';
      return speed;
    }
    if (this.mode === 'hunt' && food) {
      this.target.copy(food.pos);
      const d = this.pos.distanceTo(food.pos);
      if (d < 0.5 * this.ML + 0.2) { food.eaten = true; this.strike = STRIKE_SECONDS; this.brain.add('hunger', -FOOD_BITE); this.modeT = 0; }
      return d > 0.6 ? 0.35 : 0.08;
    }
    if (this.mode === 'hunt') { this.modeT = 0; return 0; }
    if (this.mode === 'cruise') return this.reverse ? -0.3 : 0.4;
    if (this.mode === 'rest') return this.pos.distanceTo(this.target) > 0.3 ? 0.25 : 0;
    return 0.05;
  }

  /**
   * Secondary motion: the arm bundle swings behind a turn or a pitch change and settles (soft
   * springs), and the mantle squeezes as it jets.
   */
  private swingArms(dt: number, yaw0: number, pitch0: number): { armY: number; armZ: number } {
    const b = this.body;
    const yawRate = wrapAngle(b.yaw - yaw0) / Math.max(dt, 1e-4), pitchRate = (b.pitch - pitch0) / Math.max(dt, 1e-4);
    const armY = spring(this.sArmY, clamp(yawRate * 0.5, -0.35, 0.35), 1.2, 0.35, dt);
    const armZ = spring(this.sArmZ, clamp(-pitchRate * 0.4, -0.3, 0.3), 1.2, 0.35, dt);
    const squeeze = spring(this.sSqueeze, this.mode === 'jet' ? this.jet : 0, 3, 0.4, dt);
    this.u.uSqueeze.value.set(1 + 0.04 * squeeze, 1 - 0.14 * squeeze, 1 - 0.05 * squeeze);   // fins sit on the edge: keep the width
    return { armY, armZ };
  }

  /** Skin: passing clouds while hunting, mottled at rest, pale in a jet. */
  private colourSkin(dt: number): void {
    const U = this.u;
    U.uCloud.value = lerp(U.uCloud.value, this.mode === 'hunt' ? 1 : 0, Math.min(1, dt * 2));
    U.uMottle.value = lerp(U.uMottle.value, this.mode === 'rest' ? 1 : 0, Math.min(1, dt * 0.8));
    U.uPale.value = lerp(U.uPale.value, this.mode === 'jet' ? 1 : 0, Math.min(1, dt * 5));
  }

  /** Arms: sway together; the two tentacles flick out on a strike. */
  private poseArms(dt: number, armY: number, armZ: number): void {
    const U = this.u;
    this.strike = Math.max(0, this.strike - dt);
    const t = U.uTime.value;
    this.crown.rotation.set(0, Math.sin(t * 0.9) * 0.06 + armY, -0.3 + Math.sin(t * 1.3) * 0.05 + (this.mode === 'jet' ? 0.2 : 0) + armZ);
    U.uExt.value = this.strike > 0 ? 1 + STRIKE_STRETCH * Math.sin((this.strike / STRIKE_SECONDS) * Math.PI) : 1;   // the tentacles' stretch (cuttleArm)
  }
}
