// The tank's shared state that brains perceive: bounds, reef shape, food, light, shoal goals.
import * as THREE from 'three';
import { range, clamp } from './util.js';

const FLAKE_COLORS = [0xd8782a, 0xb8552a, 0xe3a040, 0x8a5a2a, 0x6d8a3a];

export class World {
  constructor(scene, reef, bounds, rng) {
    this.scene = scene;
    this.reef = reef;
    this.bounds = bounds;
    this.rng = rng;
    this.fish = [];
    this.food = [];
    this.critters = [];   // cuttlefish, octopus, turtle (critters.js)
    this.light = 1;
    this.time = 0;
    this.goals = new Map();
    this.speciesById = new Map();

    this.maxFood = 160;
    const geo = new THREE.BoxGeometry(0.07, 0.008, 0.05);
    this.foodMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: 0.9 }), this.maxFood);
    this.foodMesh.count = 0;
    this.foodMesh.frustumCulled = false;
    scene.add(this.foodMesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._s = new THREE.Vector3(1, 1, 1);
    this._fl = new THREE.Vector3();
  }

  reefHeight(x, z) { return this.reef.heightAt(x, z); }
  // The cave roof over (x, z) as { y: underside, top }, or null in the open. Roofs overhang, so the
  // height field doesn't hold them (reef.js caves[].roof).
  roofAt(x, z) {
    for (const c of this.reef.caves || []) {
      const r = c.roof;
      if (!r) continue;
      const dx = x - c.x, dz = z - c.z, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      if (Math.abs(lx) < r.hx && lz > r.z0 && lz < r.z1) return r;
    }
    return null;
  }

  // Water velocity (units/s) from the return pump: one slow overturning cell across the tank,
  // built from a stream function psi = A sin(pi x'/W) sin(pi y/H), so it is divergence-free.
  // Peak speed ~1.5 cm/s, gently pulsing like a wave-maker. Rock blocks it near the bottom.
  flow(p, out) {
    const B = this.bounds, W = B.x1 - B.x0 + 2, H = 9.4;
    const xs = Math.PI * (p.x - B.x0 + 1) / W, ys = Math.PI * Math.min(Math.max(p.y, 0), H) / H;
    const A = 0.12 * (0.75 + 0.25 * Math.sin(this.time * 0.21)) / Math.PI;
    let u = A * (Math.PI / H) * Math.sin(xs) * Math.cos(ys) * W;
    let v = -A * (Math.PI / W) * Math.cos(xs) * Math.sin(ys) * H;
    const shelter = Math.min(1, Math.max(0, (p.y - this.reefHeight(p.x, p.z)) / 0.8));
    u *= shelter; v *= shelter;
    return out.set(u, v, 0.02 * Math.sin(this.time * 0.13 + p.x * 0.4) * shelter);
  }
  anemoneFor() { return this.reef.anemones[0]; }

  addFish(f) {
    this.fish.push(f);
    this.speciesById.set(f.sp.id, f.sp);
    this.scene.add(f.model);
  }

  // A moving target each shoal drifts towards, so schools travel around the tank together.
  schoolGoal(id) {
    let g = this.goals.get(id);
    if (!g) { g = { pos: new THREE.Vector3(), t: 0 }; this.goals.set(id, g); }
    if (g.t <= 0) {
      const sp = this.speciesById.get(id), B = this.bounds;
      const [a, b] = sp.brain.zone;
      const x = range(this.rng, B.x0 + 1.5, B.x1 - 1.5), z = range(this.rng, B.z0 + 0.8, B.z1 - 1);
      const floor = this.reefHeight(x, z) + 1, top = B.y1 - 0.6;
      g.pos.set(x, clamp(top + (floor - top) * range(this.rng, a, b), floor, top), z);
      g.t = range(this.rng, 7, 14);
    }
    return g.pos;
  }

  dropFood(x, count = 14) {
    const B = this.bounds;
    for (let i = 0; i < count; i++) {
      if (this.food.length >= this.maxFood) break;
      this.food.push({
        pos: new THREE.Vector3(clamp(x + range(this.rng, -0.8, 0.8), B.x0, B.x1), 9.38, range(this.rng, -1.5, 2.0)),
        // Flakes float on the surface film for a few seconds, then settle at ~1-2.5 cm/s
        // (thin plates sink slowly and flutter side to side like a falling leaf).
        vy: range(this.rng, 0.01, 0.025) / 0.125, float: range(this.rng, 1.5, 9), ph: this.rng() * 6, spin: this.rng() * 6, age: 0, eaten: false, resting: false,
        color: new THREE.Color(FLAKE_COLORS[i % FLAKE_COLORS.length]),
      });
    }
    // The splash startles the shy ones a little.
    for (const f of this.fish) if (Math.abs(f.pos.x - x) < 3 && f.pos.y > B.y1 - 3) f.brain.startle({ pos: new THREE.Vector3(x, B.y1, 0) }, 0.35);
  }

  update(dt) {
    this.time += dt;
    for (const g of this.goals.values()) g.t -= dt;
    // Food sinks with a gentle flutter, settles on rock or sand, then dissolves.
    let n = 0;
    for (let i = this.food.length - 1; i >= 0; i--) {
      const f = this.food[i];
      f.age += dt;
      if (!f.resting) {
        this.flow(f.pos, this._fl);
        if (f.float > 0) { f.float -= dt; f.pos.x += this._fl.x * dt; f.pos.z += this._fl.z * dt; }
        else {
          f.pos.y -= (f.vy - this._fl.y) * dt;
          f.pos.x += (this._fl.x + Math.cos(this.time * 3.1 + f.ph) * 0.08) * dt;
          f.pos.z += (this._fl.z + Math.sin(this.time * 2.3 + f.ph) * 0.05) * dt;
          f.spin += dt * 3;
        }
        const floor = this.reefHeight(f.pos.x, f.pos.z) - 0.25;
        if (f.pos.y <= Math.max(floor, 0.02)) { f.pos.y = Math.max(floor, 0.02); f.resting = true; }
      }
      if (f.eaten || f.age > 60) { this.food.splice(i, 1); continue; }
    }
    for (const f of this.food) {
      this._q.setFromEuler(this._e.set(Math.sin(f.spin) * 0.6, f.spin, Math.cos(f.spin) * 0.4));
      this._m.compose(f.pos, this._q, this._s);
      this.foodMesh.setMatrixAt(n, this._m);
      this.foodMesh.setColorAt(n, f.color);
      n++;
    }
    this.foodMesh.count = n;
    this.foodMesh.instanceMatrix.needsUpdate = true;
    if (this.foodMesh.instanceColor) this.foodMesh.instanceColor.needsUpdate = true;
    for (const f of this.fish) f.update(dt, this);
  }
}
