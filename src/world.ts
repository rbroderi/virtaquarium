// The tank's shared state that brains perceive: bounds, reef shape, food, light, shoal goals.
import * as THREE from 'three';
import { range, clamp, type Rng } from './util.js';
import type { Fish } from './fish.js';
import type { Species } from './species.js';
import type { Anemone, CaveRoof, TankScene } from './reef/types.js';
import type { FanWormWorld } from './fanWorms.js';
import type { SwimWorld } from './world/ports.js';
import type { Food, Station, TankBounds, Viewer, WorldCritter } from './world/types.js';

export type { Food, Station, TankBounds, Viewer, WorldCritter, Threat } from './world/types.js';
export type { SwimWorld } from './world/ports.js';

const FLAKE_COLORS = [0xd8782a, 0xb8552a, 0xe3a040, 0x8a5a2a, 0x6d8a3a] as const;
const MAX_FOOD = 160;
const FLAKES_PER_FEED = 14;
const FLAKE_SIZE = { x: 0.07, y: 0.008, z: 0.05 } as const;
const FLAKE_ROUGHNESS = 0.9;
/** A flake dissolves this long after it went in (s). */
const FLAKE_LIFETIME = 60;
/** World units per metre-ish: 1 unit = 12.5 cm. */
const UNITS_PER_METRE = 1 / 0.125;

/** Above this the whole tank is in view, so flakes start on the surface film. */
const SURFACE_VISIBLE_Y = 9.0;
const SURFACE_Y = 9.38;
/** Without the surface in view, flakes come in this far above the top of the window. */
const WINDOW_ENTRY = 0.5;

/** Open water: the distance reported where there is no rock field. */
const OPEN_WATER_DIST = 10;
/** Viewer activity fades with this time constant (s). */
const VIEWER_FADE = 3;

/** Return-pump circulation: tank height for the stream function, peak strength, pulse. */
const FLOW_HEIGHT = 9.4;
const FLOW_STRENGTH = 0.12;
const FLOW_PULSE_HZ = 0.21;
/** Flow fades to nothing over this height above the reef (s). */
const FLOW_SHELTER = 0.8;

/** Fractions along a sight line sampled against the reef top and cave roofs. */
const SIGHT_SAMPLES = [0.2, 0.4, 0.6, 0.8] as const;
/** The height field is a conservative grid: allowance before rock blocks a sight line. */
const SIGHT_ALLOWANCE = 0.15;

interface ShoalGoal {
  readonly pos: THREE.Vector3;
  t: number;
}

export class World implements SwimWorld, FanWormWorld {
  readonly fish: Fish[] = [];
  readonly food: Food[] = [];
  /** Cuttlefish, octopus, turtle (critters.ts). */
  readonly critters: WorldCritter[] = [];
  light = 1;
  time = 0;
  /** Seconds to the next scheduled feed (main). */
  feedIn = Infinity;
  /** The pointer at the glass (main). */
  viewer: Viewer | null = null;
  /** The cleaning station, if the tank has a cleaner (main). */
  station: Station | null = null;
  lastFeedX: number | undefined = undefined;
  /** Feeds so far (checks read it). */
  feeds = 0;
  readonly speciesById = new Map<string, Species>();
  readonly maxFood = MAX_FOOD;
  readonly foodMesh: THREE.InstancedMesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;

  private readonly goals = new Map<string, ShoalGoal>();
  private readonly scratchMatrix = new THREE.Matrix4();
  private readonly scratchQuat = new THREE.Quaternion();
  private readonly scratchEuler = new THREE.Euler();
  private readonly unitScale = new THREE.Vector3(1, 1, 1);
  private readonly scratchFlow = new THREE.Vector3();

  constructor(
    readonly scene: THREE.Scene,
    readonly reef: TankScene,
    readonly bounds: TankBounds,
    private readonly rng: Rng,
  ) {
    const geo = new THREE.BoxGeometry(FLAKE_SIZE.x, FLAKE_SIZE.y, FLAKE_SIZE.z);
    this.foodMesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ roughness: FLAKE_ROUGHNESS }), this.maxFood);
    this.foodMesh.count = 0;
    this.foodMesh.frustumCulled = false;
    scene.add(this.foodMesh);
  }

  reefHeight(x: number, z: number): number {
    return this.reef.heightAt(x, z);
  }

  /**
   * Signed distance (units) from p to the solid scenery, negative inside it (rockField.ts). Without a
   * field (e.g. the jelly tank), open water.
   */
  rockDist(p: THREE.Vector3): number {
    return this.reef.rockField ? this.reef.rockField.dist(p.x, p.y, p.z) : OPEN_WATER_DIST;
  }

  rockNormal(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return this.reef.rockField ? this.reef.rockField.normal(p.x, p.y, p.z, out) : out.set(0, 1, 0);
  }

  /**
   * The cave roof over (x, z) as { y: underside, top }, or null in the open. Roofs overhang, so the
   * height field doesn't hold them (reef caves[].roof).
   */
  roofAt(x: number, z: number): CaveRoof | null {
    for (const c of this.reef.caves) {
      const r = c.roof;
      const dx = x - c.x, dz = z - c.z, cs = Math.cos(c.yaw), sn = Math.sin(c.yaw);
      const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
      if (Math.abs(lx) < r.hx && lz > r.z0 && lz < r.z1) return r;
    }
    return null;
  }

  /**
   * Water velocity (units/s) from the return pump: one slow overturning cell across the tank, built
   * from a stream function psi = A sin(pi x'/W) sin(pi y/H), so it is divergence-free. Peak speed
   * ~1.5 cm/s, gently pulsing like a wave-maker. Rock blocks it near the bottom.
   */
  flow(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    const B = this.bounds, W = B.x1 - B.x0 + 2, H = FLOW_HEIGHT;
    const xs = Math.PI * (p.x - B.x0 + 1) / W, ys = Math.PI * Math.min(Math.max(p.y, 0), H) / H;
    const A = FLOW_STRENGTH * (0.75 + 0.25 * Math.sin(this.time * FLOW_PULSE_HZ)) / Math.PI;
    let u = A * (Math.PI / H) * Math.sin(xs) * Math.cos(ys) * W;
    let v = -A * (Math.PI / W) * Math.cos(xs) * Math.sin(ys) * H;
    const shelter = Math.min(1, Math.max(0, (p.y - this.reefHeight(p.x, p.z)) / FLOW_SHELTER));
    u *= shelter; v *= shelter;
    return out.set(u, v, 0.02 * Math.sin(this.time * 0.13 + p.x * 0.4) * shelter);
  }

  anemoneFor(_fish: Fish): Anemone | null {
    return this.reef.anemones[0] ?? null;
  }

  /**
   * Can a fish at a see b? Samples along the sightline against the reef top and cave roofs. No
   * raycasts: cheap enough for every pair at 5 Hz.
   */
  lineOfSight(a: THREE.Vector3, b: THREE.Vector3): boolean {
    for (const k of SIGHT_SAMPLES) {
      const x = a.x + (b.x - a.x) * k, y = a.y + (b.y - a.y) * k, z = a.z + (b.z - a.z) * k;
      if (y < this.reefHeight(x, z) - SIGHT_ALLOWANCE) return false;
      const r = this.roofAt(x, z);
      if (r && y > r.y && y < r.top) return false;
    }
    return true;
  }

  addFish(f: Fish): void {
    this.fish.push(f);
    this.speciesById.set(f.sp.id, f.sp);
    this.scene.add(f.model);
  }

  /** A moving target each shoal drifts towards, so schools travel around the tank together. */
  schoolGoal(id: string): THREE.Vector3 {
    let g = this.goals.get(id);
    if (!g) {
      g = { pos: new THREE.Vector3(), t: 0 };
      this.goals.set(id, g);
    }
    const sp = this.speciesById.get(id);
    if (g.t <= 0 && sp) {
      const B = this.bounds;
      const [a, b] = sp.brain.zone;
      const x = range(this.rng, B.x0 + 1.5, B.x1 - 1.5), z = range(this.rng, B.z0 + 0.8, B.z1 - 1);
      const floor = this.reefHeight(x, z) + 1, top = B.y1 - 0.6;
      g.pos.set(x, clamp(top + (floor - top) * range(this.rng, a, b), floor, top), z);
      g.t = range(this.rng, 7, 14);
    }
    return g.pos;
  }

  dropFood(x: number, count: number = FLAKES_PER_FEED): void {
    const B = this.bounds;
    this.lastFeedX = x;
    this.feeds += 1;
    // The zoomed view (view.ts) cuts off the surface, where flakes would float out of frame: they come
    // in just above the top of the window, already sinking, so the feeding is seen. With the whole tank
    // in view they start on the surface film.
    const surface = B.y1 > SURFACE_VISIBLE_Y, y0 = surface ? SURFACE_Y : B.y1 + WINDOW_ENTRY;
    for (let i = 0; i < count; i++) {
      if (this.food.length >= this.maxFood) break;
      this.food.push({
        pos: new THREE.Vector3(clamp(x + range(this.rng, -0.8, 0.8), B.x0, B.x1), y0 + range(this.rng, 0, surface ? 0 : 0.6), range(this.rng, -1.5, 2.0)),
        // Flakes float on the surface film for a few seconds, then settle at ~1-2.5 cm/s (thin plates
        // sink slowly and flutter side to side like a falling leaf).
        vy: range(this.rng, 0.01, 0.025) * UNITS_PER_METRE,
        float: surface ? range(this.rng, 1.5, 9) : 0,
        ph: this.rng() * 6,
        spin: this.rng() * 6,
        age: 0,
        eaten: false,
        resting: false,
        color: new THREE.Color(FLAKE_COLORS[i % FLAKE_COLORS.length]),
      });
    }
    // The splash startles the shy ones a little.
    for (const f of this.fish) if (Math.abs(f.pos.x - x) < 3 && f.pos.y > B.y1 - 3) f.brain.startle({ pos: new THREE.Vector3(x, B.y1, 0) }, 0.35);
  }

  update(dt: number): void {
    this.time += dt;
    if (this.viewer) this.viewer.activity *= Math.exp(-dt / VIEWER_FADE);
    for (const g of this.goals.values()) g.t -= dt;
    this.updateFood(dt);
    this.drawFood();
    for (const f of this.fish) f.update(dt, this);
    this.reef.fanWorms?.update(dt, this);
  }

  /** Food sinks with a gentle flutter, settles on rock or sand, then dissolves. */
  private updateFood(dt: number): void {
    const flow = this.scratchFlow;
    for (let i = this.food.length - 1; i >= 0; i--) {
      const f = this.food[i];
      if (!f) continue;
      f.age += dt;
      if (!f.resting) {
        this.flow(f.pos, flow);
        if (f.float > 0) { f.float -= dt; f.pos.x += flow.x * dt; f.pos.z += flow.z * dt; }
        else {
          f.pos.y -= (f.vy - flow.y) * dt;
          f.pos.x += (flow.x + Math.cos(this.time * 3.1 + f.ph) * 0.08) * dt;
          f.pos.z += (flow.z + Math.sin(this.time * 2.3 + f.ph) * 0.05) * dt;
          f.spin += dt * 3;
        }
        const floor = this.reefHeight(f.pos.x, f.pos.z) - 0.25;
        if (f.pos.y <= Math.max(floor, 0.02)) { f.pos.y = Math.max(floor, 0.02); f.resting = true; }
      }
      if (f.eaten || f.age > FLAKE_LIFETIME) this.food.splice(i, 1);
    }
  }

  private drawFood(): void {
    let n = 0;
    for (const f of this.food) {
      this.scratchQuat.setFromEuler(this.scratchEuler.set(Math.sin(f.spin) * 0.6, f.spin, Math.cos(f.spin) * 0.4));
      this.scratchMatrix.compose(f.pos, this.scratchQuat, this.unitScale);
      this.foodMesh.setMatrixAt(n, this.scratchMatrix);
      this.foodMesh.setColorAt(n, f.color);
      n++;
    }
    this.foodMesh.count = n;
    this.foodMesh.instanceMatrix.needsUpdate = true;
    if (this.foodMesh.instanceColor) this.foodMesh.instanceColor.needsUpdate = true;
  }
}
