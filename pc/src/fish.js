// A fish = 3D model + swimming physics + its own Brain.
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
import { Brain } from './brain.js';
import { buildFishModel, posePectoral } from './fishModel.js';
import { clamp, lerp, range, wrapAngle } from './util.js';

// Per-species turning and posture limits (aLat, wide, pitchCruise, bank, ...) are in species.js MOTION.
const CF = 0.9;          // axial drag coefficient (folded constants)
const LATERAL = 8;       // lateral velocity decay rate (1/s)
const ST = 0.3;          // Strouhal number
const TAIL_AMP = 0.2;    // tail-tip amplitude / L

const _d = new THREE.Vector3(), _up = new THREE.Vector3(), _side = new THREE.Vector3();
const _lat = new THREE.Vector3(), _flow = new THREE.Vector3(), _gaze = new THREE.Vector3(), _n = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

// A damped spring (semi-implicit Euler, substepped so a frame hitch can't blow it up): s = { x, v }
// is pulled towards `target` at natural frequency hz with damping ratio zeta. Real reef-fish bodies
// are stiff (an overshoot of a few percent), fins much softer.
function spring(s, target, hz, zeta, dt) {
  const w = 2 * Math.PI * hz, n = Math.ceil(dt * hz * 8), h = dt / n;
  for (let i = 0; i < n; i++) {
    s.v += (w * w * (target - s.x) - 2 * zeta * w * s.v) * h;
    s.x += s.v * h;
  }
  return s.x;
}
const springState = (x = 0) => ({ x, v: 0 });

// The moray's body as a chain of point masses (position-based dynamics): the head node is carried by
// the fish, the rest follow through distance constraints, resist bending (stiffer near the head),
// lose their momentum to the water, and lie on the rock. The shader bends the body through the chain's
// offsets from the straight body axis (uSpine), so the body traces the path the head took, swings
// wide out of a sharp turn, and drapes over a ledge.
const SPINE_N = 12;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
// Body radius the chain keeps off the rock surface (rockField.js), in units: about half the body depth.
const spineClear = (fish) => 0.45 * (fish.sp.body?.depth ?? 0.065) * fish.size;
// Shader head lift (uLift) of node i, in units: the front of the body raised out of the crevice.
const liftAt = (fish, i) => fish.model.userData.uniforms.uLift.value * Math.max(0, 0.5 - i / (SPINE_N - 1) - 0.1) ** 2 * 2.5 * fish.size;
class SpineChain {
  constructor() {
    this.p = Array.from({ length: SPINE_N }, () => new THREE.Vector3());
    this.prev = Array.from({ length: SPINE_N }, () => new THREE.Vector3());
    this.ready = false;
  }
  update(dt, fish, world, stiff) {
    const L = fish.size, seg = L / (SPINE_N - 1), P = this.p;
    const head = _a.copy(fish.pos).addScaledVector(fish.dir, 0.5 * L);
    if (!this.ready) {
      for (let i = 0; i < SPINE_N; i++) { P[i].copy(head).addScaledVector(fish.dir, -seg * i); this.prev[i].copy(P[i]); }
      this.ready = true;
    }
    const drag = Math.exp(-2.5 * dt);
    for (let i = 1; i < SPINE_N; i++) {
      _b.subVectors(P[i], this.prev[i]).multiplyScalar(drag);   // carried momentum, damped by the water
      this.prev[i].copy(P[i]);
      P[i].add(_b);
    }
    P[0].copy(head); this.prev[0].copy(head);
    const R = spineClear(fish);
    for (let it = 0; it < 4; it++) {
      for (let i = 1; i < SPINE_N; i++) {
        // Bending stiffness: pull towards the straight continuation of the two nodes ahead.
        const ahead = i === 1 ? _b.copy(P[0]).addScaledVector(fish.dir, -seg) : _b.subVectors(P[i - 1], P[i - 2]).add(P[i - 1]);
        P[i].lerp(ahead, stiff * (1 - (i / SPINE_N) * 0.6));
        // Length.
        _b.subVectors(P[i], P[i - 1]);
        const d = _b.length() || 1e-6;
        P[i].copy(P[i - 1]).addScaledVector(_b, seg / d);
        // Rock and sand: the body lies over a ledge a little below the head. Rock well above the head is
        // the crevice the eel is in (the height field is the rock's top), so that doesn't lift it.
        // (Not in its burrow: there the body runs on into the reef behind the cave, hidden in the rock.)
        if (fish.inBurrow(P[i])) continue;
        const floor = world.reefHeight(P[i].x, P[i].z) - 0.05;
        if (P[i].y < floor && floor < P[0].y + 0.15 * L) P[i].y = floor;
        // The real rock surface in 3D (rockField.js): out along its normal, so the body that cuts a corner
        // behind the head slides round the rock instead of through it. Tested where the shader draws the
        // node (with the head lift).
        const up = liftAt(fish, i), dr = world.rockDist(_c.set(P[i].x, P[i].y + up, P[i].z));
        if (dr < R) {
          world.rockNormal(_c, _t);
          // Under a cave roof with the head below it, rock overhead is the roof: always out downwards,
          // or a node pushed past the slab's middle pops out on top of it (and the body with it).
          const roof = _t.y > 0.3 && P[0].y < P[i].y + up && world.roofAt(P[i].x, P[i].z);
          if (roof && P[0].y < roof.y) _t.set(0, -1, 0);
          P[i].addScaledVector(_t, R - dr);
        }
      }
    }
    // Lurking at home, the body behind home lies along its burrow (inBurrow): held near the burrow's
    // axis, so the tail stays straight and hidden in the rock instead of snaking out of it.
    const b = fish.brain;
    if (b.lurkDir && b.mode === 'lurk' && fish.pos.distanceTo(b.home) < 0.6) {
      for (let i = 1; i < SPINE_N; i++) {
        _t.subVectors(P[i], b.home);
        const s = _t.dot(b.lurkDir);
        if (s >= 0) continue;
        _t.addScaledVector(b.lurkDir, -s);   // off the axis
        const lim = 0.6 * (0.3 + 0.4 * Math.min(-s, 0.55 * L) / L), off = _t.length();
        if (off > lim) P[i].addScaledVector(_t, lim / off - 1);
      }
    }
    // Cave roofs (not in the height field): the body stays under one the head is below, or over one it
    // swims across. The shader's head lift (uLift, liftY) raises the front further, so allow for it.
    const lift = fish.model.userData.uniforms.uLift.value, r = 0.05 * L;
    for (let i = 0; i < SPINE_N; i++) {
      const roof = world.roofAt(P[i].x, P[i].z);
      if (!roof) continue;
      const x = 0.5 - i / (SPINE_N - 1), up = lift * Math.max(0, x - 0.1) ** 2 * 2.5 * L;
      if (P[0].y < roof.y) P[i].y = Math.min(P[i].y, roof.y - r - up);
      else P[i].y = Math.max(P[i].y, roof.top + r - up);
    }
    // Never let a bad step (a NaN from anywhere) stick in the chain: lay it out straight again next time.
    if (!P.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))) this.ready = false;
  }
  // Offsets from the straight body axis in the fish's own frame, in body lengths.
  write(arr, fish, up, side) {
    const L = fish.size;
    for (let i = 0; i < SPINE_N; i++) {
      const x = 0.5 - i / (SPINE_N - 1);
      _b.copy(fish.pos).addScaledVector(fish.dir, x * L);
      _a.subVectors(this.p[i], _b);
      // (A NaN in a vec2[] uniform breaks three's upload, which tests only element 0: write 0 instead.)
      const s = clamp(_a.dot(side) / L, -0.35, 0.35), u = clamp(_a.dot(up) / L, -0.25, 0.25);
      arr[i * 2] = Number.isFinite(s) ? s : 0;
      arr[i * 2 + 1] = Number.isFinite(u) ? u : 0;
    }
  }
}

export class Fish {
  constructor(sp, name, rng) {
    this.sp = sp;
    this.name = name;
    this.size = sp.size * range(rng, 0.85, 1.12);
    this.model = buildFishModel(sp);
    this.model.scale.setScalar(this.size);
    // Receive too, so fins shade the flank (and other fish) as they do in photos.
    this.model.traverse((o) => { if (o.isMesh) o.castShadow = o.receiveShadow = true; });
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
    this.ventPhase = rng() * 10;
    this.ventHz = range(rng, 1.0, 1.5);   // opercular breathing rate at rest
    this.roll = 0;
    this.turnRate = 0;
    this.yaw = Math.atan2(this.dir.z, this.dir.x);
    this.pitch = 0;
    this.yawRate = 0;
    this.pitchRate = 0;
    this.turnSign = 0;   // remembered direction while reversing, so a U-turn doesn't dither
    this.bend = 0;
    this.gulp = 0;
    // Secondary motion springs: body bend (front, and the tail behind it), tail amplitude, median fin
    // fold, caudal cup; each pectoral gets its own (opening, stroke roll).
    this.sBend = springState(); this.sBendTail = springState(); this.sAmp = springState(0.1);
    this.sFold = springState(); this.sCup = springState();
    this.spine = sp.swim.mode === 'anguilliform' ? new SpineChain() : null;
    this.brain = new Brain(this, rng);
  }

  get mass() { return this.size ** 3; }

  // An eel's burrow: the crevice running on into the reef behind its cave, which the cave is too
  // shallow to hold (a 50 cm moray, a 20 cm cave). main.js puts home a quarter body length behind the
  // mouth, facing out along lurkDir, which is about the cave's back wall; the burrow is a capsule along
  // lurkDir from there back to 0.55 body lengths behind home, deep enough for the tail of an eel that has
  // backed all the way in. Inside it the body ignores the rock: it is out of sight in the rock, not
  // clipping through it. (In the cave itself, home to mouth, the rock still holds the body.) It widens
  // away from home, as the lurking eel's slow sway turns its body about home (pos).
  inBurrow(p) {
    const b = this.brain;
    if (!this.spine || !b.lurkDir) return false;
    const L = this.size;
    _t.subVectors(p, b.home);
    const s = clamp(_t.dot(b.lurkDir), -0.55 * L, 0), r = 0.3 + 0.4 * Math.abs(s) / L;
    return _t.addScaledVector(b.lurkDir, -s).lengthSq() < r * r;
  }

  updateGaze(dt, out) {
    const b = this.brain, st = this.gazeState || (this.gazeState = { t: 0, fx: 0, fy: 0, x: 0, y: 0 });
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
        st.fx = range(Math.random, -0.03, 0.05);   // idle scanning
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

  update(dt, world) {
    const sp = this.sp, sw = sp.swim, brain = this.brain, L = this.size;
    brain.update(dt, world);
    const want = brain.steer(dt, world, _d);
    if (_d.lengthSq() < 1e-8) _d.copy(this.dir);
    _d.normalize();

    // ---- heading: yaw and pitch, each limited in rate and in angular acceleration ----
    const U = Math.max(0, this.speed), burst = want > 1;
    const hover = sw.hoverTurn * clamp(1 - U / (sw.maxBL * L), 0.25, 1);   // pectoral sculling fades with speed
    const rTurn = sw.rmin * L * (burst ? 1 : sw.wide);
    const aLat = burst ? sw.aLatBurst : sw.aLat;
    const omegaMax = Math.max(hover, Math.min(U / rTurn, aLat / Math.max(U, 1e-3)));
    const alpha = sw.hoverTurn * (burst ? 30 : 5);   // rad/s^2
    let err = wrapAngle(Math.atan2(_d.z, _d.x) - this.yaw);
    if (Math.abs(err) > 2.7) {
      // Reversing: commit to turning towards open water (away from the nearer glass).
      if (!this.turnSign) this.turnSign = Math.sign(-this.pos.z * Math.cos(this.yaw)) || 1;
      err = Math.abs(err) * this.turnSign;
    } else if (Math.abs(err) < 2.0) this.turnSign = 0;
    const wYaw = clamp(err * 2.5, -omegaMax, omegaMax);   // ease into the new heading
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
    const turnDrag = 1 + sw.turnDrag * Math.min(1, Math.abs(this.yawRate) / Math.max(omegaMax, 1e-3)) ** 2;   // bent body
    const af = (T - kf * turnDrag * vf * Math.abs(vf)) / m;
    const vfNew = vf + af * dt;
    this.vel.copy(this.dir).multiplyScalar(vfNew).add(_lat);
    this.speed = vfNew;
    world.flow(this.pos, _flow);
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

    // Hard limits: glass and rock are rigid. Rock pushes a fish out at a limited rate, not in one step:
    // the height field is a conservative 0.2-unit grid, and a snap to it reads as a jump.
    const B = world.bounds;
    this.pos.x = clamp(this.pos.x, B.x0, B.x1);
    this.pos.z = clamp(this.pos.z, B.z0, B.z1);
    // A fish in its shelter is under the rock's top (the height field holds only the top): keep it
    // between the gap's floor and roof instead.
    const sh = brain.sheltered;
    if (sh && this.pos.y > sh.top - 0.1 * L) this.pos.y = sh.top - 0.1 * L;
    if (sh && this.pos.y < sh.floor) this.pos.y = Math.min(sh.floor, this.pos.y + 0.5 * L * dt);
    if (!this.spine) {
      // Against the real rock surface (rockField.js): out along its normal, so a fish that touches the
      // side of a rock slides along it instead of being lifted to the top of the height field's column.
      // At most as fast as it can have gone in, plus a little: no jumps.
      const r = Math.max(0.03, 0.35 * (sp.body?.depth ?? 0.45) * L);
      const d = world.rockDist(this.pos);
      if (d < r) {
        world.rockNormal(this.pos, _n);
        this.pos.addScaledVector(_n, Math.min(r - d, (0.5 * L + 1.2 * U) * dt));
        const vn = this.vel.dot(_n);
        if (vn < 0) this.vel.addScaledVector(_n, -vn);
      }
    } else {
      // The eel: pos is the middle of a straight body axis, not a point on the body (SpineChain carries
      // the body along the path the head took), and lurking it lies in the rock behind the cave. So the
      // head is what meets the rock (rockField.js), pushed out along the surface normal as above; the
      // chain keeps the rest of the body off it. Not in its burrow (inBurrow), where it backs in.
      const r = spineClear(this) * 1.2, head = _c.copy(this.pos).addScaledVector(this.dir, 0.5 * L);
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
    this.pos.y = clamp(this.pos.y, B.y0, B.y1);
    // A cave roof is a slab the height field doesn't hold: keep to the side of it the fish is on. (The
    // rock field holds the roof for the others.)
    const roof = this.spine && world.roofAt(this.pos.x, this.pos.z), rr = 0.05 * L;
    if (roof && this.pos.y > roof.y - rr && this.pos.y < roof.top + rr) {
      this.pos.y = this.pos.y < (roof.y + roof.top) / 2 ? roof.y - rr : roof.top + rr;
    }

    // ---- orientation: heading + bank into turns ----
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
    this.model.position.copy(this.pos);

    // ---- propulsors driven by thrust ----
    this.gulp = Math.max(0, this.gulp - dt);
    const Ueq = Math.sqrt(Math.max(0, T) / kf);          // speed the current thrust sustains
    const blEq = Ueq / L;                                 // in body lengths / s
    const bursting = want > 1 || blEq > sw.maxBL;
    const tailShare = sw.mode === 'bcf' || sw.mode === 'anguilliform' || bursting ? 1 : smoothstep(sw.gait * 0.8, sw.gait * 1.3, blEq);
    const finShare = 1 - 0.7 * tailShare;

    // Tail: Strouhal f = St U / A. A small idle beat keeps the fish from looking frozen.
    const fTail = (ST * blEq) / TAIL_AMP;
    const tailAmp = tailShare * clamp(blEq / 1.2, 0, 1);
    // Hovering fish hold the body still (the pectorals do the work); a slight wave only once moving.
    const idle = 0.06 * smoothstep(0.05, 0.3, U / L) + 0.05 * Math.abs(this.turnRate);
    const back = brain.backing ? brain.backing / L : 0;   // reverse swimming, body lengths per second
    let fBeat = Math.max(fTail * tailShare, 1.2), ampT = Math.max(tailAmp, idle);
    if (sw.mode === 'anguilliform') {
      // Eels keep a near-constant amplitude (tail ~0.08-0.1 L) and swim faster by beating faster: the
      // wave (0.6 L long) runs back at about U / 0.7 (slip ratio ~0.7), so it never slides along a still
      // body. Resting, the body sways slowly.
      fBeat = Math.max(blEq / (0.7 * 0.6), 0.35);
      ampT = lerp(0.3, 0.9, smoothstep(0.03, 0.25, blEq)) + 0.1 * clamp(blEq / sw.maxBL, 0, 1);
    }
    this.phase += back ? -dt * Math.PI * 2 * (0.8 + back * 4) : dt * Math.PI * 2 * fBeat;
    const u = this.model.userData.uniforms;
    u.uPhase.value = this.phase;
    // Amplitude eases in and out of a burst (a kick builds over a beat) rather than jumping.
    u.uAmp.value = Math.max(0, spring(this.sAmp, Math.max(ampT, back ? 0.5 : 0) + this.gulp, 2.5, 0.9, dt));

    // Body bends with path curvature (kappa = omega / U), stronger in sharp, slow turns. The bend is a
    // stiff damped spring (a little overshoot as the turn ends), and the rear half follows it on a
    // softer one, so the tail lags into a turn and swings past straight coming out of it.
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
    // Erectile spines (sp.erect: uErect at rest and when alarmed): raised by fear, a chase or a stalk,
    // and locked up when the fish wedges into its shelter (a trigger bracing in its crevice). They go up
    // in a fraction of a second and come down slowly.
    if (sp.erect) {
      const alarm = clamp(brain.drives.fear * 2 + (brain.sheltered ? 1 : 0) + (brain.mode === 'patrol' && brain.focus ? 0.7 : 0) + (brain.mode === 'stalk' ? 0.6 : 0), 0, 1);
      const eT = lerp(sp.erect.rest, sp.erect.alarm, alarm);
      this.erect ??= sp.erect.rest;
      this.erect += (eT - this.erect) * Math.min(1, dt * (eT > this.erect ? 6 : 0.8));
      u.uErect.value = this.erect;
    }
    if (this.spine) {
      // The moray's chain does the bending; the analytic bend is off. Braced in its crevice, the body is stiff.
      this.spine.update(dt, this, world, brain.mode === 'lurk' ? 0.5 : 0.12);
      this.spine.write(u.uSpine.value, this, _up, _side);
      u.uSpineOn.value = 1;
      u.uBend.value = u.uBendTail.value = 0;
    } else {
      u.uBend.value = this.bend;
      u.uBendTail.value = tail;
    }

    // Ventilation: the gill covers flare at ~1-1.5 Hz at rest, faster when working hard.
    this.ventPhase += dt * Math.PI * 2 * this.ventHz * (1 + 0.5 * clamp(blEq / sw.maxBL, 0, 1));
    u.uVent.value = 0.035 * (0.5 + 0.5 * Math.sin(this.ventPhase));
    // Buccal pump: the mouth opens a little while the gill covers close (drawing water in), then shuts
    // as they flare (pushing it out over the gills); it snaps open to take food.
    if (u.uGape) u.uGape.value = 0.07 * (0.5 - 0.5 * Math.sin(this.ventPhase)) + this.gulp * 2;
    if (sp.gill === false) {
      // Morays have no gill covers: they pump water over the gills by opening and closing the mouth
      // (~0.6-0.9 Hz), wider when working, and gape wide to strike.
      u.uVent.value = 0;
      u.uGape.value = 0.06 + (0.14 + 0.1 * clamp(blEq / sw.maxBL, 0, 1)) * (0.5 + 0.5 * Math.sin(this.ventPhase * 0.6)) + this.gulp * 1.5;
      // Resting in its crevice, an eel holds the front of its body up and out.
      u.uLift.value = lerp(u.uLift.value, brain.mode === 'lurk' ? 0.35 : 0, Math.min(1, dt * 0.8));
    }

    // Colour change: night colours come on over a few minutes as the light goes (sleeping fish fully),
    // and a client posing at the cleaning station shows them partly (many clients darken or pale to
    // signal they want cleaning).
    if (u.uNight) {
      const nightT = clamp((1 - world.light) * (brain.mode === 'rest' ? 1 : 0.7) + (brain.posing ? 0.5 : 0), 0, 1);
      u.uNight.value += (nightT - u.uNight.value) * Math.min(1, dt / (brain.posing ? 3 : 40));
    }
    // Eyes: saccades every 1-4 s to whatever the brain attends to (food, a chase, a threat, the cleaner,
    // a shoalmate), held between jumps; and counter-rolling against pitch, so the gaze stays level as the
    // body tilts (vestibulo-ocular reflex).
    if (u.uGaze) this.updateGaze(dt, u.uGaze.value);

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
        const ph = this.pectPhase + (s > 0 ? 0 : 0.2);
        // At speed a BCF swimmer tucks its pectorals back against the body. The fin is flexible: it
        // follows the stroke on a soft spring, so it lags the reversals and flicks past them.
        const tuck = tailShare * smoothstep(0.4, 1.0, U / (sw.maxBL * L));
        const ud = p.userData;
        ud.sOpen ??= springState(0.3); ud.sFlap ??= springState(0.2);
        const open = spring(ud.sOpen, (0.2 + pectAmp * turnBias * (0.5 + 0.5 * Math.sin(ph))) * (1 - 0.75 * tuck), 7, 0.5, dt);
        const flap = spring(ud.sFlap, (0.2 + 0.25 * Math.cos(this.pectPhase)) * (1 - 0.5 * tuck), 7, 0.5, dt);
        posePectoral(p, ph, open, flap);
      }
    }
  }
}
