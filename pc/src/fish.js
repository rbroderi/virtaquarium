// A fish = 3D model + swimming physics + its own Brain.
//
// Physics (per individual, body length L in world units, 1 unit = 12.5 cm):
//   mass         m  = L^3               (neutrally buoyant, so gravity and buoyancy cancel)
//   axial drag   Fd = kf * U|U|,  kf = CF * L^2   (pressure drag at Re ~ 1e4-1e5)
//   lateral drag strong (body acts like a keel), so velocity follows heading
//   thrust       T  from a speed controller, limited by sustained/burst capacity
//   turning      yaw rate <= hoverTurn + U / (rmin * L)   (fins at rest, body at speed)
// All visible motion is derived from the force balance:
//   tail-beat frequency from the Strouhal relation St = f A / U ~ 0.3 with A = 0.2 L,
//     using U_eq = sqrt(T / kf), the speed the present thrust would sustain;
//   labriform / balistiform swimmers use fins below their gait-transition speed;
//   BCF swimmers at low speed use burst-and-coast (thrust off while gliding);
//   the body curves into turns according to path curvature.
// The fish also drifts with the water: position += (velocity relative to water + flow) * dt.
import * as THREE from 'three';
import { Brain } from './brain.js';
import { buildFishModel } from './fishModel.js';
import { clamp, lerp, range } from './util.js';

const CF = 0.9;          // axial drag coefficient (folded constants)
const LATERAL = 8;       // lateral velocity decay rate (1/s)
const ST = 0.3;          // Strouhal number
const TAIL_AMP = 0.2;    // tail-tip amplitude / L

const _d = new THREE.Vector3(), _prev = new THREE.Vector3(), _up = new THREE.Vector3(), _side = new THREE.Vector3();
const _lat = new THREE.Vector3(), _flow = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class Fish {
  constructor(sp, name, rng) {
    this.sp = sp;
    this.name = name;
    this.size = sp.size * range(rng, 0.85, 1.12);
    this.model = buildFishModel(sp);
    this.model.scale.setScalar(this.size);
    this.model.traverse((o) => { if (o.isMesh) o.castShadow = true; });
    this.model.userData.fish = this;
    this.pos = new THREE.Vector3();
    this.dir = new THREE.Vector3(rng() - 0.5, 0, (rng() - 0.5) * 0.4).normalize();
    this.vel = new THREE.Vector3();      // relative to the water
    this.speed = 0;                      // forward speed relative to water
    this.thrust = 0;
    this.coasting = false;
    this.phase = rng() * 10;
    this.finPhase = rng() * 10;
    this.pectPhase = rng() * 10;
    this.roll = 0;
    this.turnRate = 0;
    this.bend = 0;
    this.gulp = 0;
    this.brain = new Brain(this, rng);
  }

  get mass() { return this.size ** 3; }

  update(dt, world) {
    const sp = this.sp, sw = sp.swim, brain = this.brain, L = this.size;
    brain.update(dt, world);
    const want = brain.steer(dt, world, _d);
    if (_d.lengthSq() < 1e-8) _d.copy(this.dir);
    _d.normalize();
    _d.y = clamp(_d.y, -0.6, 0.6);   // fish keep near-level; steep climbs are done in stages
    _d.normalize();

    // ---- heading: yaw-rate limited by fins (at rest) and turning radius (at speed) ----
    let ang = this.dir.angleTo(_d);
    if (ang > 2.7) {
      // Reversing: swing round through the depth axis.
      _d.z += this.pos.z > 0 ? -0.9 : 0.9;
      _d.normalize();
      ang = this.dir.angleTo(_d);
    }
    const U = Math.max(0, this.speed);
    const omegaMax = Math.min(8, sw.hoverTurn + U / (sw.rmin * L)) * (want > 1 ? 1.6 : 1);
    _prev.copy(this.dir);
    if (ang > 1e-4) this.dir.lerp(_d, Math.min(1, (omegaMax * dt) / ang)).normalize();
    const yawDelta = Math.atan2(_prev.x * this.dir.z - _prev.z * this.dir.x, _prev.x * this.dir.x + _prev.z * this.dir.z);
    this.turnRate = lerp(this.turnRate, yawDelta / Math.max(dt, 1e-4), Math.min(1, dt * 8));

    // ---- thrust controller ----
    const maxU = sw.maxBL * L, burstU = sw.burstBL * L;
    const Ustar = clamp(want * sp.brain.maxSpeed * (0.8 + 0.3 * brain.drives.energy), 0, burstU);
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

    // ---- integrate (forward axis + decaying lateral slip) ----
    const vf = this.vel.dot(this.dir);
    _lat.copy(this.vel).addScaledVector(this.dir, -vf).multiplyScalar(Math.exp(-LATERAL * dt));
    const af = (T - kf * vf * Math.abs(vf)) / m;
    const vfNew = vf + af * dt;
    this.vel.copy(this.dir).multiplyScalar(vfNew).add(_lat);
    this.speed = vfNew;
    world.flow(this.pos, _flow);
    this.pos.addScaledVector(this.vel, dt).addScaledVector(_flow, dt);

    // Hard limits: glass and rock are rigid.
    const B = world.bounds;
    this.pos.x = clamp(this.pos.x, B.x0, B.x1);
    this.pos.z = clamp(this.pos.z, B.z0, B.z1);
    this.pos.y = clamp(this.pos.y, Math.max(B.y0, world.reefHeight(this.pos.x, this.pos.z) - 0.1), B.y1);

    // ---- orientation: heading + bank into turns ----
    _up.set(0, 1, 0).addScaledVector(this.dir, -this.dir.y).normalize();
    this.roll = lerp(this.roll, clamp(this.turnRate * U * 0.15, -0.4, 0.4), Math.min(1, dt * 3));
    _up.applyAxisAngle(this.dir, this.roll);
    _side.crossVectors(this.dir, _up);
    _basis.makeBasis(this.dir, _up, _side);
    this.model.quaternion.setFromRotationMatrix(_basis);
    this.model.position.copy(this.pos);

    // ---- propulsors driven by thrust ----
    this.gulp = Math.max(0, this.gulp - dt);
    const Ueq = Math.sqrt(Math.max(0, T) / kf);          // speed the current thrust sustains
    const blEq = Ueq / L;                                 // in body lengths / s
    const bursting = want > 1 || blEq > sw.maxBL;
    const tailShare = sw.mode === 'bcf' || bursting ? 1 : smoothstep(sw.gait * 0.8, sw.gait * 1.3, blEq);
    const finShare = 1 - 0.7 * tailShare;

    // Tail: Strouhal f = St U / A. A small idle beat keeps the fish from looking frozen.
    const fTail = (ST * blEq) / TAIL_AMP;
    const tailAmp = tailShare * clamp(blEq / 1.2, 0, 1);
    const idle = 0.06 + 0.05 * Math.abs(this.turnRate);
    this.phase += dt * Math.PI * 2 * Math.max(fTail * tailShare, 1.2);
    const u = this.model.userData.uniforms;
    u.uPhase.value = this.phase;
    u.uAmp.value = Math.max(tailAmp, idle) + this.gulp;

    // Body bends with path curvature (kappa = omega / U), stronger in sharp, slow turns.
    const kappa = this.turnRate / Math.max(U, 0.25 * L);
    this.bend = lerp(this.bend, clamp(kappa * L * 0.12, -0.25, 0.25), Math.min(1, dt * 6));
    u.uBend.value = this.bend;

    // Median fins: balistiform swimmers undulate dorsal + anal fins for thrust; others ripple gently.
    const finDrive = sw.mode === 'balistiform' ? finShare * (0.5 + blEq * 1.5) : 0.3 + 0.2 * blEq;
    this.finPhase += dt * Math.PI * 2 * (sw.mode === 'balistiform' ? 1.5 + 2.0 * blEq : 1.2);
    u.uFinPhase.value = this.finPhase;
    u.uFlutter.value = finDrive;

    // Pectorals: labriform rowing (2-4 Hz typical), plus sculling for hovering and turning.
    const labri = sw.mode === 'labriform' ? finShare : 0.4;
    const fPect = 1.0 + 1.2 * blEq * labri + 0.6 * Math.abs(this.turnRate);
    this.pectPhase += dt * Math.PI * 2 * fPect;
    const pectAmp = clamp(0.15 + labri * (0.25 + 0.35 * blEq / Math.max(sw.gait, 1)) + 0.15 * Math.abs(this.turnRate), 0, 0.85);
    for (const p of this.model.userData.pects) {
      const s = p.userData.side;
      if (this.model.userData.fan) {
        // Lionfish fans stay spread; they ripple rather than row.
        p.rotation.set(s * 0.25, s * (0.75 + 0.1 * Math.sin(this.pectPhase * 0.5)), 0.35);
      } else {
        // Asymmetric stroke when turning: the outside fin works harder.
        const turnBias = 1 + clamp(-s * this.turnRate * 0.3, -0.4, 0.4);
        const open = 0.2 + pectAmp * turnBias * (0.5 + 0.5 * Math.sin(this.pectPhase + (s > 0 ? 0 : 0.2)));
        p.rotation.set(0, s * open, 0.2 + 0.25 * Math.cos(this.pectPhase));
      }
    }
  }
}
