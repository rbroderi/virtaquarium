// Juvenile green turtle.
//
// Carapace 2.0 units (25 cm). An oval, gently domed carapace with five vertebral, four pairs of costal
// and the marginal scutes, each with the radiating orange-brown streaks of a juvenile; a pale plastron;
// head and flippers dark with pale seams between the scales. The long front flippers fly (a
// dorsoventral stroke with feathering, then a glide), the rear flippers steer. It cruises the tank,
// comes up to the surface to breathe every few minutes, rests on the sand, and grazes on the rock.
import * as THREE from 'three';
import { range, clamp, lerp, type Rng } from '../util.js';
import { skin, randomTarget, Swimmer } from './shared.js';
import { carapaceTex, scaleTex, paddle } from './turtleParts.js';
import type { Critter, CritterSpecies, CritterWorld, JoinRule } from './types.js';

export type TurtleMode = 'cruise' | 'rest' | 'graze' | 'breathe';

interface Flipper { readonly front: THREE.Group; readonly rear: THREE.Group; readonly s: number }

const STROKE_HZ = 0.55;
const CRUISE_SPEED = 0.45;
const SURFACE_MARGIN = 0.4;
const SPOT_TRIES = 30;
const SAND_HEIGHT = 0.25;     // rest where the reef is lower than this ...
const ROCK_HEIGHT = 0.8;      // ... graze where it is higher than this

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
  /** Seconds until it needs air. */
  private breath: number;
  private stroke = 0;
  private t = 0;

  constructor(sp: CritterSpecies, rng: Rng, world: CritterWorld) {
    this.sp = sp; this.rng = rng; this.radius = sp.radius;
    const L = this.L = range(rng, 1.8, 2.1);
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
    this.breath = range(rng, 60, 200);
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

  update(dt: number, world: CritterWorld): void {
    this.t += dt; this.modeT -= dt; this.breath -= dt;
    this.breatheWhenDue(world);
    if (this.modeT <= 0 && this.mode !== 'breathe') this.chooseMode(world);
    const b = this.body, d = this.pos.distanceTo(this.target);
    if (this.mode === 'cruise' && d < 1) this.target = randomTarget(this.rng, world, 2, 7);
    const settled = (this.mode === 'rest' || this.mode === 'graze') && d < 0.5;
    const speed = settled ? 0 : this.mode === 'breathe' ? 0.6 : (this.mode === 'cruise' ? CRUISE_SPEED : 0.3) * clamp(d, 0.3, 1);
    b.steer(dt, world, this.target, { turn: 0.45, speed, accel: 0.6, clearance: this.L * 0.14, look: this.L * 1.2 });
    if (settled) { b.pitch = lerp(b.pitch, 0, dt); b.roll = lerp(b.roll, 0, dt); }
    this.stroke += dt * STROKE_HZ * Math.PI * 2 * (settled ? 0 : clamp(Math.abs(b.speed) / CRUISE_SPEED, 0.25, 1.2));
    this.beatFlippers(settled);
    this.moveHead(settled);
    b.place(this.model);
  }

  /** Up to the surface every few minutes for air; back to cruising once there. */
  private breatheWhenDue(world: CritterWorld): void {
    const rng = this.rng, B = world.bounds;
    if (this.breath <= 0 && this.mode !== 'breathe') { this.mode = 'breathe'; this.target.set(this.pos.x + range(rng, -2, 2), B.y1, this.pos.z); }
    if (this.mode === 'breathe' && this.pos.y > B.y1 - SURFACE_MARGIN) { this.mode = 'cruise'; this.modeT = range(rng, 15, 30); this.breath = range(rng, 150, 300); this.target = randomTarget(rng, world, 2, 6); }
  }

  private chooseMode(world: CritterWorld): void {
    const rng = this.rng, r = rng();
    this.mode = r < 0.55 ? 'cruise' : r < 0.8 ? 'rest' : 'graze';
    this.modeT = this.mode === 'rest' ? range(rng, 30, 70) : range(rng, 15, 30);
    if (this.mode === 'cruise') { this.target = randomTarget(rng, world, 2, 7); return; }
    // Rest on open sand (low height field), graze on rock.
    const spot = this.findSpot(world, this.mode === 'rest');
    if (spot) this.target = spot;
    else { this.mode = 'cruise'; this.target = randomTarget(rng, world, 2, 7); }
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
    const grazing = this.mode === 'graze' && settled;
    this.head.rotation.y = Math.sin(this.t * 0.3) * 0.25;
    this.head.rotation.z = grazing ? -0.35 + 0.15 * Math.max(0, Math.sin(this.t * 3)) : Math.sin(this.t * 0.4) * 0.06;
  }
}
