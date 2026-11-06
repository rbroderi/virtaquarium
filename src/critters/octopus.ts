// Day octopus.
//
// Mantle ~1.0 unit (12 cm), arms ~3x the mantle. A wrinkled mantle sac behind the head, eyes on raised
// turrets with a bar pupil, eight arms as tubes along chains of points that curl and reach, draped over
// the reef (each point stays above the rock or sand). Skin: red-brown with papillae, pale spots and
// pale suckers on the underside of the arms. It keeps a den (a cave the moray doesn't use, or a crevice
// low in the reef), sits there with arms curled, makes forays crawling over the reef, pounces on food
// that lands near it, and jets away when startled.
import * as THREE from 'three';
import { range, clamp, lerp, wrapAngle, mulberry32, type Rng } from '../util.js';
import { OCTO_SAC } from '../softBodies.js';
import { softBodyGeometry } from './softBodyMeshes.js';
import { skin, threatNear, randomTarget, ceilingAt, floorAt, CEPH_SSS, UP, type ShaderHook } from './shared.js';
import { octoSkin, octoEyeTex, octoBump, suckerGeometry, ArmTube, SUCKERS_PER_ARM, ARM_W } from './octopusParts.js';
import { ArmUntangler, type ArmObstacle } from './armUntangle.js';
import type { Critter, CritterCave, CritterFood, CritterSpecies, CritterWorld, JoinRule, OctopusDen } from './types.js';
import { limitStep } from '../world/stepLimit.js';

export type OctopusMode = 'den' | 'forage' | 'pounce' | 'jet';

interface OctopusUniforms {
  [name: string]: THREE.IUniform;
  uShade: { value: number };
  uBreath: { value: number };
}

const ARM_COUNT = 8;
const ARM_POINTS = 22;
const ARM_ROOT_RADIUS = 0.095;
const ARM_TIP_RADIUS = 0.01;
const ARM_LENGTH = 3.0;          // times the mantle scale
const SKIN_SEED = 17;            // body and arms share one skin pattern
const ARM_WHITE_SPOTS = 180;
const WEB_ROWS = 6;              // the interbrachial web over each arm's first rows
const WEB_COLUMNS = 3;
const NEVER_CULL_RADIUS = 1e3;
const THREAT_RANGE = 1.4;
const FOOD_RANGE = 3;
const JET_SECONDS = 2.2;
const CALM_AFTER_JET = 15;
const JET_SPEED = 2.0;
/** Crawling and pouncing speeds over the reef (units/s), and how fast it can haul itself up besides. */
const CRAWL_SPEED = 0.18, POUNCE_SPEED = 0.6, OCTOPUS_HAUL = 0.5;
const SAC_BREATH_RATE = 2.2;   // rad/s
const SAC_BREATH = 0.04;
const OBSTACLE_SAC_RADIUS = 1.1;   // the sac's bumpy skin, up to 9% proud
const SIPHON_BALL_RADIUS = 0.08;
const WEB_CLEARANCE = 0.02;

const SHADE_FRAG = `#include <map_fragment>
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.55, 0.5), uShade);`;
const BODY_VERT_HEAD = 'uniform float uBreath;\nattribute float aWeight;\nvarying vec3 vTriP, vTriN;\n';
const BODY_VERT_BEGIN = `#include <begin_vertex>
        transformed = vec3(-0.48, 0.3, 0.0) + (transformed - vec3(-0.48, 0.3, 0.0)) * (1.0 + uBreath * aWeight);
        vTriP = position; vTriN = normal;`;
const BODY_FRAG_HEAD = 'uniform float uShade;\nvarying vec3 vTriP, vTriN;\n';
const BODY_FRAG_MAP = `{
          vec3 bw = pow(abs(normalize(vTriN)), vec3(4.0)); bw /= bw.x + bw.y + bw.z;
          vec3 tp = vTriP * 0.45;
          diffuseColor *= texture2D(map, tp.zy) * bw.x + texture2D(map, tp.xz + 0.37) * bw.y + texture2D(map, tp.xy + 0.71) * bw.z;
        }
        diffuseColor.rgb *= mix(vec3(1.0), vec3(0.62, 0.55, 0.5), uShade);`;

const _v = new THREE.Vector3(), _w = new THREE.Vector3();

function pointOf(arm: ArmTube, i: number): THREE.Vector3 {
  const p = arm.pts[i];
  if (!p) throw new RangeError(`arm point ${i} out of range`);
  return p;
}

export class Octopus implements Critter {
  readonly kind = 'octopus' as const;
  readonly sp: CritterSpecies;
  readonly radius: number;
  /** Mantle scale. */
  readonly M: number;
  readonly model = new THREE.Group();
  readonly sac = new THREE.Object3D();
  readonly disc = new THREE.Object3D();
  readonly suckers: THREE.InstancedMesh;
  readonly arms: ArmTube[] = [];
  readonly web: THREE.Mesh;
  readonly buildMs: number;
  // Where parts are attached (and may run into each other): critterCheck.ts.
  readonly joins: readonly JoinRule[] = [['eye*', 'body'], ['arm*', 'body'], ['web', 'arm*'], ['web', 'body'], ['suckers', '*']];
  readonly den: THREE.Vector3;
  readonly cave: CritterCave | null;
  readonly pos: THREE.Vector3;
  /** Where the body was at the start of the step (for the step limit). */
  private readonly prevPos = new THREE.Vector3();
  yaw: number;
  mode: OctopusMode = 'den';
  modeT: number;
  target: THREE.Vector3;
  /** Jet strength left, 1 at the start of a jet. */
  jet = 0;
  private readonly rng: Rng;
  private readonly u: OctopusUniforms = { uShade: { value: 0 }, uBreath: { value: 0 } };
  private readonly siphonBalls: THREE.Object3D[];
  private readonly obstacles: ArmObstacle[];
  private readonly untangler = new ArmUntangler();
  private t = 0;
  private calm = 0;
  private stand = 0;
  private squash = 1;
  private tuck = 1;
  private food: CritterFood | null = null;
  private jetDir = new THREE.Vector3();
  private readonly down = new THREE.Vector3(0, -1, 0);
  private readonly worldToLocal = new THREE.Matrix4();

  constructor(sp: CritterSpecies, rng: Rng, den: OctopusDen) {
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
    const M = this.M = range(rng, 0.85, 1.05);
    const hook: ShaderHook = (shader) => {
      Object.assign(shader.uniforms, this.u);
      shader.fragmentShader = 'uniform float uShade;\n' + shader.fragmentShader.replace('#include <map_fragment>', SHADE_FRAG);
    };
    const tex = octoSkin(mulberry32(SKIN_SEED)), armTex = octoSkin(mulberry32(SKIN_SEED), ARM_WHITE_SPOTS), bump = octoBump(rng);   // the same skin; the arms add bold white spots
    const mat = skin({ map: armTex, bumpMap: bump, bumpScale: 2.5, roughness: 0.55, vertexColors: true }, 'octo-skin', hook, { ...CEPH_SSS, thin: 'attr' });
    const bodyMat = skin({ map: tex, roughness: 0.55 }, 'octo-body', this.bodyHook(), CEPH_SSS);
    // Mantle sac, head, eye turrets, oral disc with the arm roots, and siphon: one mesh (built for
    // M = 1, softBodies.ts), so the arms grow out of the body rather than meeting it at seams.
    const body = new THREE.Mesh(softBodyGeometry('octopus-body'), bodyMat);
    body.scale.setScalar(M);
    body.castShadow = true;
    body.name = 'body';
    this.model.add(body);
    this.addSacStandIn(M);
    const eyeParts = this.addEyes(M);
    this.siphonBalls = this.addSiphonBalls(M);
    const t0 = performance.now();
    this.suckers = this.addSuckers(hook);
    this.addArms(M, mat, rng);
    this.buildMs = performance.now() - t0;
    this.addDiscStandIn(M);
    this.web = this.addWeb(tex, bump, hook);
    // The obstacles are spheres in their own frames (the sac's stretched): the turrets (stand-ins),
    // the eyes, and the siphon's tube, in two balls along it.
    this.obstacles = [{ object: this.sac, radius: OBSTACLE_SAC_RADIUS }, ...eyeParts, ...this.siphonBalls.map((o) => ({ object: o, radius: SIPHON_BALL_RADIUS * M }))];

    this.den = den.pos.clone();
    this.pos = this.den.clone();
    this.yaw = range(rng, -Math.PI, Math.PI);
    this.modeT = range(rng, 20, 60);
    this.target = this.pos.clone();
    this.cave = den.cave;
    if (den.cave) this.yaw = Math.atan2(den.cave.dir.z, den.cave.dir.x);
  }

  /**
   * The body is one blended mesh without UVs: its skin is mapped triplanar (three taps, blended by
   * the normal, so the wrinkles run on across the joins), and it breathes in the vertex shader: the
   * sac's share of each vertex (aWeight) swells about the sac's centre.
   */
  private bodyHook(): ShaderHook {
    return (shader) => {
      Object.assign(shader.uniforms, this.u);
      shader.vertexShader = BODY_VERT_HEAD + shader.vertexShader.replace('#include <begin_vertex>', BODY_VERT_BEGIN);
      shader.fragmentShader = BODY_FRAG_HEAD + shader.fragmentShader.replace('#include <map_fragment>', BODY_FRAG_MAP);
    };
  }

  /** An invisible stand-in for the sac the arms keep clear of, with the old part's place and scale. */
  private addSacStandIn(M: number): void {
    this.sac.scale.set(OCTO_SAC.r[0] * M, OCTO_SAC.r[1] * M, OCTO_SAC.r[2] * M);   // a long sac held low behind the head
    this.sac.position.set(OCTO_SAC.c[0] * M, OCTO_SAC.c[1] * M, 0); this.sac.rotation.z = OCTO_SAC.rotZ;
    this.sac.name = 'sac';
    this.model.add(this.sac);
  }

  /** The eyes on their turrets (stand-ins for the turrets, which are in the body mesh). */
  private addEyes(M: number): ArmObstacle[] {
    const eyeMat = skin({ map: octoEyeTex(), roughness: 0.25 }, 'octo-eye');
    const turrets: ArmObstacle[] = [], eyes: ArmObstacle[] = [];
    for (const s of [1, -1]) {
      const turret = new THREE.Object3D();
      turret.position.set(0.13 * M, 0.36 * M, s * 0.2 * M);
      const eyeRadius = 0.07 * M;
      const eye = new THREE.Mesh(new THREE.SphereGeometry(eyeRadius, 20, 14), eyeMat);
      eye.position.set(0.15 * M, 0.4 * M, s * 0.24 * M);
      eye.rotation.set(Math.PI / 2, -s * Math.PI / 2 + s * 0.5, 0, 'YXZ');   // bar turned horizontal, then the iris turned out and a little forward
      turret.name = `turret${s > 0 ? 0 : 1}`; eye.name = `eye${s > 0 ? 0 : 1}`;
      this.model.add(turret, eye);
      turrets.push({ object: turret, radius: 0.1 * M });
      eyes.push({ object: eye, radius: eyeRadius });
    }
    // (in the model's child order: turret, eye, turret, eye)
    return turrets.flatMap((t, i) => { const e = eyes[i]; return e ? [t, e] : [t]; });
  }

  /**
   * The siphon (funnel, in the body mesh): a muscular tube opening low on one side of the head,
   * behind the eye, pointing out, forward and a little up. Two balls along the tube, for keeping the
   * arms off it.
   */
  private addSiphonBalls(M: number): THREE.Object3D[] {
    const siphPos = new THREE.Vector3(-0.08 * M, 0.12 * M, 0.27 * M), sax = new THREE.Vector3(0, 1, 0).applyEuler(new THREE.Euler(-1.1, 0, -0.9));
    return [-1, 1].map((s) => { const o = new THREE.Object3D(); o.position.copy(siphPos).addScaledVector(sax, s * 0.055 * M); this.model.add(o); return o; });
  }

  private addSuckers(hook: ShaderHook): THREE.InstancedMesh {
    const suckers = new THREE.InstancedMesh(suckerGeometry(), skin({ color: 0xf0d6c8, roughness: 0.4 }, 'octo-sucker', hook, { ...CEPH_SSS, thin: 0.6 }), ARM_COUNT * SUCKERS_PER_ARM);
    suckers.name = 'suckers';
    suckers.frustumCulled = false;
    // (critterCheck.ts sees only the base cup, at the model's origin inside the body: a sheet, joined)
    suckers.userData['sheet'] = true;
    this.model.add(suckers);
    return suckers;
  }

  /**
   * Arms. Proportions from octopod morphometrics: the arm width index (base width of the stoutest arm
   * over mantle length) runs ~13-23%, so with the mantle ~1.1 M long the arms are ~0.19 M across at
   * the base, tapering to fine tips; they run ~3x the mantle here (O. cyanea's reach 4-5x, but
   * longer chains read as spider legs at this scale).
   */
  private addArms(M: number, mat: THREE.Material, rng: Rng): void {
    for (let i = 0; i < ARM_COUNT; i++) {
      const tube = new ArmTube(ARM_POINTS, ARM_ROOT_RADIUS * M, ARM_TIP_RADIUS * M, mat, this.suckers, i * SUCKERS_PER_ARM);
      tube.angle = ((i + 0.5) / ARM_COUNT) * Math.PI * 2;
      tube.len = ARM_LENGTH * M * range(rng, 0.85, 1.05);
      tube.curl = range(rng, 0.5, 1.5); tube.ph = rng() * 6;
      tube.mesh.name = `arm${i}`;
      this.model.add(tube.mesh);
      this.arms.push(tube);
    }
  }

  /** The oral disc under the head (in the body mesh): a stand-in with its ellipsoid's place and radii. */
  private addDiscStandIn(M: number): void {
    this.disc.scale.set(0.36 * M, 0.11 * M, 0.36 * M);
    this.disc.position.set(0, 0.02 * M, 0);
    this.disc.name = 'disc';
    this.model.add(this.disc);
  }

  /**
   * The interbrachial web: a membrane joining each pair of neighbouring arms over their first
   * quarter, rebuilt with the arms each frame. It is what makes the arms rise into the body as one
   * skirt instead of leaving it as separate legs.
   */
  private addWeb(tex: THREE.Texture, bump: THREE.Texture, hook: ShaderHook): THREE.Mesh {
    const K = WEB_ROWS, cols = WEB_COLUMNS, rows = K + 1, per = rows * cols, g = new THREE.BufferGeometry(), idx: number[] = [], uv: number[] = [];
    for (let a = 0; a < ARM_COUNT; a++) for (let k = 0; k < rows; k++) for (let c = 0; c < cols; c++) {
      uv.push(0.3 + (a + c / 2) / ARM_COUNT * 0.7, k / K * 0.5);
      if (k < K && c < cols - 1) { const i0 = a * per + k * cols + c, i1 = i0 + 1, i2 = i0 + cols, i3 = i2 + 1; idx.push(i0, i2, i1, i1, i2, i3); }
    }
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(ARM_COUNT * per * 3), 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), NEVER_CULL_RADIUS);
    const web = new THREE.Mesh(g, skin({ map: tex, bumpMap: bump, bumpScale: 2.5, roughness: 0.55, side: THREE.DoubleSide }, 'octo-web', hook, { ...CEPH_SSS, thin: 0.8 }));
    web.frustumCulled = false;
    web.castShadow = true;
    web.name = 'web';
    this.model.add(web);
    return web;
  }

  update(dt: number, world: CritterWorld): void {
    this.t += dt; this.modeT -= dt;
    this.calm -= dt;
    const threat = this.calm <= 0 && this.mode !== 'jet' ? threatNear(this, world, THREAT_RANGE) : null;
    if (threat) this.startle(world, threat.pos);
    this.lookForFood(world);
    if (this.modeT <= 0) this.chooseMode(world);
    this.prevPos.copy(this.pos);
    const reach = this.mode === 'jet' ? JET_SPEED * this.jet : this.mode === 'pounce' ? POUNCE_SPEED : CRAWL_SPEED;
    this.moveBody(dt);
    const ceil = this.settleOnFloor(dt, world);
    // Up a ledge or out of a jet onto the floor at its own pace (it hauls itself up), never in a jump.
    limitStep(this.prevPos, this.pos, reach, OCTOPUS_HAUL, dt);
    this.colourAndBreathe(dt);
    this.model.position.copy(this.pos);
    this.model.rotation.set(0, -this.yaw, 0);
    this.model.updateMatrixWorld(true);
    this.worldToLocal.copy(this.model.matrixWorld).invert();
    this.poseArms(dt, world, ceil);
    this.untangler.solve(this.arms, this.obstacles, this.disc, this.M);
    for (const arm of this.arms) {
      // tow on from where they settled, so the next frame starts nearly untangled
      for (let i = 1; i < arm.n; i++) arm.prevW[i - 1]?.copy(pointOf(arm, i)).applyMatrix4(this.model.matrixWorld);
      arm.build(this.down);
    }
    this.buildWeb();
  }

  private lookForFood(world: CritterWorld): void {
    if (this.mode !== 'den' && this.mode !== 'forage') return;
    let food: CritterFood | null = null;
    for (const f of world.food) if (!f.eaten && f.resting && f.pos.distanceTo(this.pos) < FOOD_RANGE) { food = f; break; }
    if (food) { this.mode = 'pounce'; this.target.copy(food.pos); this.food = food; this.modeT = 8; }
  }

  private chooseMode(world: CritterWorld): void {
    const rng = this.rng;
    if (this.mode === 'den') {
      this.mode = 'forage'; this.modeT = range(rng, 25, 50);
      this.target = randomTarget(rng, world, 0, 0);
      this.target.x = clamp(this.den.x + range(rng, -4, 4), world.bounds.x0 + 1.5, world.bounds.x1 - 1.5);
    } else this.returnToDen(range(rng, 40, 90));
  }

  private returnToDen(seconds: number): void {
    this.mode = 'den'; this.target.copy(this.den); this.modeT = seconds;
  }

  /** Body: crawl over the surface (or jet clear of it). */
  private moveBody(dt: number): void {
    const rng = this.rng;
    if (this.mode === 'jet') {
      this.pos.addScaledVector(this.jetDir, JET_SPEED * this.jet * dt);
      // Mantle first: it turns its sac into the jet, so the arms stream out behind it, clear of the sac.
      const yawT = Math.atan2(-this.jetDir.z, -this.jetDir.x);
      this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(yawT - this.yaw), -1, 1) * dt * 6);
      this.jet = Math.max(0, this.jet - dt * 0.7);
      if (this.modeT <= 0) this.returnToDen(range(rng, 30, 60));
      return;
    }
    _v.subVectors(this.target, this.pos).setY(0);
    const d = _v.length();
    const speed = this.mode === 'pounce' ? POUNCE_SPEED : this.mode === 'den' && d < 0.2 ? 0 : CRAWL_SPEED;
    if (d > 0.05) {
      const yawT = Math.atan2(_v.z, _v.x);
      this.yaw = wrapAngle(this.yaw + clamp(wrapAngle(yawT - this.yaw), -1, 1) * dt * 0.8);
      this.pos.addScaledVector(_v.normalize(), Math.min(d, speed * dt));
    }
    if (this.mode === 'pounce' && this.food && (this.food.eaten || d < 0.35)) { this.food.eaten = true; this.food = null; this.returnToDen(range(rng, 30, 60)); }
  }

  /**
   * Rest on the ground (standing taller while out), inside the tank. Under a roof the body flattens to
   * fit (octopuses squeeze into gaps), and never rises through it.
   */
  private settleOnFloor(dt: number, world: CritterWorld): number {
    const M = this.M;
    const ground = Math.max(floorAt(world, this.pos.x, this.pos.z), 0);
    this.stand = lerp(this.stand, this.mode === 'forage' || this.mode === 'pounce' ? 1 : 0, Math.min(1, dt));
    const restY = ground + lerp(0.12, 0.34, this.stand) * M;
    if (this.mode === 'jet') this.pos.y = Math.max(this.pos.y, restY);
    else this.pos.y = lerp(this.pos.y, restY, Math.min(1, dt * 3));
    const B = world.bounds;
    this.pos.x = clamp(this.pos.x, B.x0, B.x1); this.pos.z = clamp(this.pos.z, B.z0, B.z1); this.pos.y = Math.min(this.pos.y, B.y1);
    const ceil = ceilingAt(world, this.pos.x, this.pos.z), room = ceil - ground;
    this.pos.y = Math.min(this.pos.y, ceil - 0.5 * M);
    this.squash = lerp(this.squash, clamp((room - 0.04) / (0.78 * M), 0.55, 1), Math.min(1, dt * 2));
    return ceil;
  }

  /** Colour: darker and cryptic in the den, paler in a jet. Breathing: the mantle swells and relaxes. */
  private colourAndBreathe(dt: number): void {
    const M = this.M;
    this.u.uShade.value = lerp(this.u.uShade.value, this.mode === 'den' ? 0.6 : this.mode === 'jet' ? -0.3 : 0.1, Math.min(1, dt));
    const br = 1 + SAC_BREATH * Math.sin(this.t * SAC_BREATH_RATE);
    this.sac.scale.set(OCTO_SAC.r[0] * M * br, OCTO_SAC.r[1] * M * br, OCTO_SAC.r[2] * M * br);   // (the stand-in, for the arms)
    this.u.uBreath.value = br - 1;
    this.model.scale.set(1, this.squash, 1);
  }

  /**
   * Arms: from the crown, curling chains that reach and drape over the ground. In the den the arms
   * coil close round the body; foraging they sprawl and step; in a jet they trail behind together.
   */
  private poseArms(dt: number, world: CritterWorld, ceil: number): void {
    const coil = this.mode === 'den' ? 1 : this.mode === 'jet' ? 0 : 0.35;
    for (const arm of this.arms) {
      // In the den the arms are drawn in (tucked under and round the body), not spread over the rock.
      this.tuck = lerp(this.tuck, this.mode === 'den' ? 1 : 0, Math.min(1, dt * 0.5));
      this.poseArm(arm, dt, world, ceil, coil);
    }
  }

  private poseArm(arm: ArmTube, dt: number, world: CritterWorld, ceil: number, coil: number): void {
    const M = this.M, jet = this.mode === 'jet', toWorld = this.model.matrixWorld, toLocal = this.worldToLocal;
    const local = new THREE.Vector3(), world_ = new THREE.Vector3();
    // In a cave the den's walls are behind and beside it, so the tucked arms spread out of the mouth
    // (over most of the ring: any narrower and eight arms can't lie side by side).
    const a = this.cave ? wrapAngle(arm.angle) * (1 - 0.4 * this.tuck) : arm.angle;
    const n = arm.n, seg = arm.len * (1 - 0.55 * this.tuck) / (n - 1);
    arm.seg = seg;   // (its rest length, for the untangle)
    const out = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const dir = jet
      ? new THREE.Vector3(1, -0.3, 0).addScaledVector(out, 0.35).normalize()
      : out.clone().multiplyScalar(0.75).setY(lerp(-0.2, -0.45, this.stand)).normalize();   // out from the mouth before they drape (straight down, the roots ran into one another)
    const p = local.set(Math.cos(a) * 0.12 * M, 0.02 * M, Math.sin(a) * 0.12 * M);
    const walk = this.mode === 'forage' || this.mode === 'pounce' ? Math.sin(this.t * 2.5 + arm.ph) : 0;
    // Per segment: turn about the vertical (a flat spiral that tightens towards the tip), a slow
    // wave, a crawling step, and a little lift of the tip (arm tips curl up off the rock).
    const sense = arm.curl > 1 ? 1 : -1;
    let gap = 0;   // how far the last point hung above the rock: unsupported arm sags into the hollow
    let lastY = world_.copy(p).applyMatrix4(toWorld).y;   // the last point's height (world)
    for (let i = 0; i < n; i++) {
      pointOf(arm, i).copy(p);
      const s = i / (n - 1);
      if (!jet) {
        // (the coil turns every arm the same way, a pinwheel whose curves nest, and by under a
        // radian in all, so each keeps to about its own sector: turned either way at random, or
        // wrapped round the body, they ran into one another)
        const turn = coil * (0.01 + 0.12 * s ** 3) * arm.curl + sense * ((Math.sin(this.t * 0.7 + arm.ph + s * 6) + 0.5 * Math.sin(this.t * 0.45 + arm.ph * 2 + s * 11)) * (0.06 + 0.16 * (1 - coil)) + walk * 0.06 * (1 - s));
        dir.applyAxisAngle(UP, turn);
        if (i > 2) dir.y = lerp(dir.y, s > 0.8 ? 0.25 * (1 - coil * 0.5) : -0.05 - clamp(gap * 3, 0, 0.8), 0.35);   // drape down, then the tip lifts
        dir.normalize();
      } else dir.y = -0.3 + Math.sin(this.t * 6 + s * 3 + arm.ph) * 0.08;   // streaming out ahead of the head, away from the sac
      if (!jet && i > 1) this.turnAlongWall(dir, p, seg, sense, world, world_.copy(p).applyMatrix4(toWorld).y);
      p.addScaledVector(dir, seg);
      // Keep the chain above the reef (in world space).
      world_.copy(p).applyMatrix4(toWorld);
      // Soft arms: each point is towed through the water towards its pose rather than placed there,
      // more loosely towards the tip, so the arms trail a jet, swing after a turn and settle. The
      // first two points, the root, turn with the body (towed, they swung in across a neighbour's).
      const pw = (arm.prevW[i] ??= world_.clone());
      if (i < 2) pw.copy(world_); else pw.lerp(world_, 1 - Math.exp(-dt * lerp(20, 2.5, s)));
      world_.copy(pw);
      p.copy(world_).applyMatrix4(toLocal);
      // Rock and sand below, and a cave roof above (the model is squashed under a roof: undo that
      // for the world-space limits). Under a roof the height field is the roof's own top (it's
      // splatted for the fishes' sake), so the underside caps the floor. Nor can an arm climb more
      // than a step per segment, or above the roof over the body: past a ledge's edge, where no roof
      // is mapped, the height field is still the ledge's top, and an arm lifted onto it would run up
      // through the rock and the body. Under a roof the arms lie at the level of the body's own
      // underside (pressed up to the roof, they rose above the head), and in a den, under its roof,
      // they keep below the eyes rather than climb its walls (the web would cut the eye turrets).
      const r = arm.rAt(s) * ARM_W;   // (the section's half-width: its half-depth is less on either side)
      const roof = ceilingAt(world, world_.x, world_.z), top = Math.min(roof, ceil, ceil < Infinity ? this.pos.y + 0.15 * M * this.squash + r : Infinity) - r;
      const below = roof < Infinity ? this.pos.y - 0.1 * M * this.squash : Math.max(floorAt(world, world_.x, world_.z), 0);
      const floor = Math.min(below + r * 0.9, top, lastY + 1.2 * seg);
      gap = world_.y - floor;
      if (gap < 0) { world_.y = floor; gap = 0; dir.y = Math.max(dir.y, 0); }
      if (world_.y > top) { world_.y = top; dir.y = Math.min(dir.y, 0); }
      p.copy(world_).applyMatrix4(toLocal);
      pw.copy(world_);
      lastY = world_.y;
    }
  }

  /**
   * A wall ahead (rock rising more than a step): the arm turns along it rather than standing up it.
   * Try turning either way and take the lower ground.
   */
  private turnAlongWall(dir: THREE.Vector3, p: THREE.Vector3, seg: number, sense: number, world: CritterWorld, here: number): void {
    const rise = (d: THREE.Vector3): number => { _w.copy(p).addScaledVector(d, seg).applyMatrix4(this.model.matrixWorld); return floorAt(world, _w.x, _w.z) - here; };
    if (rise(dir) <= seg * 1.2) return;
    let best = dir.clone(), bestR = rise(dir);
    for (const ang of [0.6, -0.6, 1.2, -1.2]) {
      const d = dir.clone().applyAxisAngle(UP, ang * sense), rr = rise(d);
      if (rr < bestR) { bestR = rr; best = d; }
    }
    dir.copy(best);
  }

  /** Startled by something at `from`: jet away (critterCheck.ts calls this too). */
  startle(world: CritterWorld, from: THREE.Vector3): void {
    this.mode = 'jet'; this.modeT = JET_SECONDS; this.jet = 1; this.calm = CALM_AFTER_JET;
    // Away from the threat and a little up; under the den's roof, straight out of the mouth instead.
    this.jetDir = this.cave && ceilingAt(world, this.pos.x, this.pos.z) < Infinity
      ? this.cave.dir.clone().setY(0.05).normalize()
      : _w.subVectors(this.pos, from).setY(0.4).normalize().clone();
  }

  private buildWeb(): void {
    const K = WEB_ROWS, cols = WEB_COLUMNS, per = (K + 1) * cols, M = this.M;
    const positions = this.web.geometry.getAttribute('position'), P = positions.array;
    const order = this.arms.map((_, i) => i).sort((i, j) => wrapAngle(this.arms[i]?.angle ?? 0) - wrapAngle(this.arms[j]?.angle ?? 0));
    const armAt = (i: number): ArmTube => { const arm = this.arms[order[i % ARM_COUNT] ?? 0]; if (!arm) throw new RangeError('no arm'); return arm; };
    for (let a = 0; a < ARM_COUNT; a++) {
      const L = armAt(a), R = armAt(a + 1);
      for (let k = 0; k <= K; k++) {
        const pl = pointOf(L, k), pr = pointOf(R, k), f = k / K;
        // The free edge is scalloped: the middle of the web is drawn back towards the body.
        _v.addVectors(pl, pr).multiplyScalar(0.5);
        _w.set(0, _v.y + 0.03 * M, 0);
        _v.lerp(_w, 0.45 * f ** 1.5);
        // (and clear of the eye turrets and eyes, which it would sweep through when the arms rise
        // past the head under a roof)
        for (const { object: ob, radius: r } of this.obstacles) {
          if (ob === this.sac) continue;
          _w.copy(_v).sub(ob.position);
          if (_w.lengthSq() < (r + WEB_CLEARANCE * M) ** 2) _v.copy(ob.position).addScaledVector(_w.normalize(), r + WEB_CLEARANCE * M);
        }
        for (let c = 0; c < cols; c++) {
          const q = c === 0 ? pl : c === 2 ? pr : _v, o = (a * per + k * cols + c) * 3;
          P[o] = q.x; P[o + 1] = q.y; P[o + 2] = q.z;
        }
      }
    }
    positions.needsUpdate = true;
    this.web.geometry.computeVertexNormals();
  }
}
