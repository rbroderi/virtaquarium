// Creature determinism across a whole stocked tank: for a fixed seed, the reef tank (every reef fish
// species, plus the critters) and the moon-jelly tank stock the same animals and step through the same
// behaviour, in the tank loop's order, as recorded. Covers each fish species' build (size, variant,
// placement, geometry) and run (physics, brain, pose, swim uniforms), the critters as stocked in a real
// reef, the jellies' build (meshes, shader uniforms) and run, and the food. Feeding, a startle, the viewer
// at the glass and nightfall are in the run. Built headlessly behind the fake canvas, on the procedural
// reef; the eyes' idle saccades draw from Math.random, which is seeded here. The hashes are in
// test/goldens/creatures-reef.json and creatures-jelly.json (run with WRITE_GOLDENS=1 to re-record them).
import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { installFakeDom } from './support/fakeDom.js';
import { readGolden, writeGolden } from './support/golden.js';
import { mulberry32 } from '../src/core/rng.js';
import type { World, TankBounds } from '../src/world.js';
import type { Fish } from '../src/fish.js';
import type { Jelly } from '../src/jelly.js';
import type { Critter } from '../src/critters.js';
import type { TankScene } from '../src/reef/types.js';

const TIMEOUT_MS = 300_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEP_DT = 1 / 30;
const REEF_STEPS = 600;
const JELLY_STEPS = 900;
const SNAPSHOT_EVERY = 15;
const SEED = 7;
const TANK_WIDTH = 22;
const VIEW = new THREE.Vector3(0, 4.6, 15);
/** As main.ts swimBox at a 16:9 window. */
const BOUNDS: TankBounds = { x0: -10.1, x1: 10.1, y0: 0.25, y1: 8.6, z0: -3.0, z1: 2.7 };

function installDom(): void {
  installFakeDom();
  const g = globalThis as Record<string, unknown>;
  g['requestAnimationFrame'] = (): number => 0;
  g['ImageData'] ??= class {
    readonly data: Uint8ClampedArray;
    constructor(dataOrW: Uint8ClampedArray | number, w: number, h?: number) {
      this.data = typeof dataOrW === 'number' ? new Uint8ClampedArray(dataOrW * w * 4) : dataOrW;
      this.width = typeof dataOrW === 'number' ? dataOrW : w;
      this.height = typeof dataOrW === 'number' ? w : (h ?? dataOrW.length / 4 / w);
    }
    readonly width: number;
    readonly height: number;
  };
  // The critters' soft bodies, from the baked files.
  g['fetch'] = (url: URL | string): Promise<Response> => {
    const buf = fs.readFileSync(path.join(ROOT, 'web', 'models', 'critters', path.basename(String(url))));
    return Promise.resolve(new Response(buf));
  };
}

// ---- hashing ----
function nums(h: Hash, values: ArrayLike<number>): void {
  h.update(new Uint8Array(Float64Array.from(values).buffer));
}

const vec = (v: THREE.Vector3 | THREE.Quaternion): number[] => v.toArray();

/** The model tree: transforms always; geometry at build (all) or what has been rewritten since (run). */
function hashObject(h: Hash, o: THREE.Object3D, all: boolean): void {
  h.update(`${o.type}:${o.name}:${o.visible ? 1 : 0}:${o.castShadow ? 1 : 0}:${o.receiveShadow ? 1 : 0}:${o.frustumCulled ? 1 : 0}\n`);
  nums(h, [...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()]);
  if (o instanceof THREE.Mesh || o instanceof THREE.LineSegments) {
    const g = o.geometry as THREE.BufferGeometry;
    for (const [name, a] of Object.entries(g.attributes)) {
      if (!all && !(a instanceof THREE.BufferAttribute && a.version > 0)) continue;
      h.update(`attr ${name} ${a.itemSize} ${a.count}\n`);
      nums(h, (a as THREE.BufferAttribute).array);
    }
    if (all && g.index) nums(h, g.index.array);
  }
  for (const c of o.children) hashObject(h, c, all);
}

/** Uniform values (numbers, vectors, colours, number arrays), by name. */
function hashUniforms(h: Hash, u: Record<string, { value: unknown }>): void {
  for (const k of Object.keys(u).sort()) {
    const v = u[k]?.value;
    if (typeof v === 'number') nums(h, [v]);
    else if (v instanceof THREE.Vector2 || v instanceof THREE.Vector3 || v instanceof THREE.Vector4 || v instanceof THREE.Color) nums(h, v.toArray());
    else if (Array.isArray(v)) for (const e of v as unknown[]) { if (typeof e === 'number') nums(h, [e]); else if (e instanceof THREE.Vector3) nums(h, e.toArray()); }
    else if (v instanceof Float32Array) nums(h, v);
  }
}

function hashShaderUniforms(h: Hash, model: THREE.Object3D): void {
  model.traverse((o) => {
    const m = (o as THREE.Mesh).material;
    if (m instanceof THREE.ShaderMaterial) hashUniforms(h, m.uniforms);
  });
}

function hashFish(h: Hash, f: Fish): void {
  const b = f.brain;
  h.update(`${f.name} ${f.variant} ${b.mode} ${b.thought} ${f.coasting ? 1 : 0} ${b.sheltered ? 1 : 0} ${b.posing ? 1 : 0}\n`);
  h.update(JSON.stringify({ drives: b.drives, scores: b.scores, traits: b.traits }) + '\n');
  nums(h, [
    f.size, f.speed, f.thrust, f.phase, f.finPhase, f.pectPhase, f.ventPhase, f.roll, f.turnRate, f.yaw, f.pitch,
    f.yawRate, f.pitchRate, f.bend, f.gulp, f.erect ?? -1, f.limitedSteps,
    ...vec(f.pos), ...vec(f.dir), ...vec(f.vel), ...vec(b.target), ...vec(b.home),
    ...vec(f.model.position), ...vec(f.model.quaternion),
  ]);
  hashUniforms(h, f.model.uniforms as unknown as Record<string, { value: unknown }>);
}

function hashCritter(h: Hash, c: Critter): void {
  h.update(`${c.kind} ${c.mode} ${JSON.stringify(c.inspect())}\n`);
  nums(h, [c.modeT, ...vec(c.pos), ...vec(c.target)]);
  hashObject(h, c.model, false);
}

function hashJelly(h: Hash, j: Jelly): void {
  h.update(JSON.stringify(j.inspect()) + '\n');
  nums(h, [j.R, ...vec(j.pos), ...vec(j.vel), ...vec(j.axis)]);
  hashObject(h, j.model, false);
  hashShaderUniforms(h, j.model);
}

function hashFood(h: Hash, world: World): void {
  h.update(`food ${world.food.length} ${world.feeds}\n`);
  for (const f of world.food) nums(h, [...vec(f.pos), f.age, f.eaten ? 1 : 0, f.resting ? 1 : 0]);
}

/** Per-key running hashes; digest() gives the record. */
class Hashes {
  private readonly map = new Map<string, Hash>();
  get(key: string): Hash {
    let h = this.map.get(key);
    if (!h) { h = createHash('sha256'); this.map.set(key, h); }
    return h;
  }
  digest(): Record<string, string> {
    return Object.fromEntries([...this.map].sort(([a], [b]) => a.localeCompare(b)).map(([k, h]) => [k, h.digest('hex')]));
  }
}

interface Tank {
  world: World;
  jellies: readonly Jelly[];
  critters: readonly Critter[];
  step(dt: number): void;
}

async function stock(scenery: 'reef' | 'jelly'): Promise<Tank> {
  const { buildReef, EMPTY_SCENERY } = await import('../src/reef.js');
  const { World } = await import('../src/world.js');
  const { stockTank } = await import('../src/app/stocking.js');
  const { SPECIES } = await import('../src/species.js');
  const { CRITTER_SPECIES } = await import('../src/critters.js');
  const { JELLY_SPECIES, buildJellyTank } = await import('../src/jelly.js');
  const { DEFAULT_TANK, normalizeTank } = await import('../src/tank.js');
  const scene = new THREE.Scene();
  const reef = (scenery === 'jelly' ? buildJellyTank(scene) : buildReef(scene, TANK_WIDTH, SEED, EMPTY_SCENERY, VIEW)) as TankScene;
  const tank = scenery === 'jelly' ? normalizeTank({ scenery: 'jelly' }).tank : DEFAULT_TANK;
  const rng = mulberry32(SEED);
  const world = new World(scene, reef, BOUNDS, rng);
  stockTank({
    world, reef, bounds: BOUNDS, rng, tank,
    catalogue: { fish: SPECIES, critters: CRITTER_SPECIES, jellies: JELLY_SPECIES },
  });
  // The tank loop's step (app/tankLoop.ts) for the animals: the world steps every creature.
  return { world, jellies: world.jellies, critters: world.critters, step: (dt) => world.update(dt) };
}

describe('creatures', () => {
  installDom();

  it('stock and behave in a reef tank exactly as recorded', async () => {
    vi.spyOn(Math, 'random').mockImplementation(mulberry32(99));
    const { world, critters, step } = await stock('reef');
    const hashes = new Hashes();
    for (const f of world.fish) {
      const h = hashes.get(`fish:${f.sp.id}:build`);
      f.model.updateMatrixWorld(true);
      hashObject(h, f.model, true);
      hashFish(h, f);
    }
    for (const c of critters) hashCritter(hashes.get(`reef-critter:${c.kind}:build`), c);
    for (let i = 1; i <= REEF_STEPS; i++) {
      world.feedIn = Math.max(0, 200 - i) * STEP_DT;
      if (i === 60) world.dropFood(-2);
      if (i === 240) world.dropFood(4, 20);
      if (i === 300) world.viewer = { pos: new THREE.Vector3(1, 4, BOUNDS.z1 + 0.5), activity: 1 };
      if (i === 360) for (const f of world.fish) f.brain.startle({ pos: new THREE.Vector3(0, 4, 0) }, 0.9);
      if (i >= 450) world.light = Math.max(0.05, 1 - (i - 450) / 100);
      step(STEP_DT);
      if (i % SNAPSHOT_EVERY) continue;
      for (const f of world.fish) hashFish(hashes.get(`fish:${f.sp.id}:run`), f);
      for (const c of critters) hashCritter(hashes.get(`reef-critter:${c.kind}:run`), c);
      hashFood(hashes.get('reef:food'), world);
    }
    const result = hashes.digest();
    vi.restoreAllMocks();
    if (process.env['WRITE_GOLDENS']) writeGolden('creatures-reef', result);
    expect(result).toEqual(readGolden('creatures-reef'));
  }, TIMEOUT_MS);

  it('stock and behave in the jelly tank exactly as recorded', async () => {
    const { world, jellies, step } = await stock('jelly');
    const hashes = new Hashes();
    for (const j of jellies) {
      const h = hashes.get('jelly:build');
      hashObject(h, j.model, true);
      hashShaderUniforms(h, j.model);
      hashJelly(h, j);
    }
    for (let i = 1; i <= JELLY_STEPS; i++) {
      if (i >= 600) world.light = Math.max(0, 1 - (i - 600) / 200);
      step(STEP_DT);
      if (i % SNAPSHOT_EVERY) continue;
      jellies.forEach((j, n) => hashJelly(hashes.get(`jelly:${n}:run`), j));
    }
    const result = hashes.digest();
    if (process.env['WRITE_GOLDENS']) writeGolden('creatures-jelly', result);
    expect(result).toEqual(readGolden('creatures-jelly'));
  }, TIMEOUT_MS);
});
