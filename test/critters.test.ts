// Critter determinism: for a fixed seed, every critter builds the same model (geometry, transforms,
// texture drawing, shader patches) and steps through the same behaviour (state, pose, uniforms, the
// inspection panel), consuming its random stream in the same order. Built headlessly behind a canvas
// that records every drawing call; the soft bodies are read from web/models/critters/*.glb. The hashes
// are recorded in test/goldens/critters.json (run with WRITE_GOLDENS=1 to re-record them).
import { createHash, type Hash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { readGolden, writeGolden } from './support/golden.js';
import { mulberry32 } from '../src/util.js';
import type { Critter, CritterCave, CritterFood, CritterWorld, OctopusDen } from '../src/critters.js';

const TIMEOUT_MS = 120_000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STEP_DT = 1 / 30;
const STEPS = 900;
const SNAPSHOT_EVERY = 15;
const SEED = 1234;

// ---- a canvas that records every call and property write into the current hash ----
let canvasLog: Hash | null = null;
const logCanvas = (entry: string): void => { canvasLog?.update(entry + '\n'); };
const FAKE_GRADIENT = { addColorStop: (...a: unknown[]): void => logCanvas(`stop ${JSON.stringify(a)}`) };

function recordingContext(canvas: { width: number; height: number }): object {
  const target: Record<string | symbol, unknown> = {
    canvas,
    createLinearGradient: (...a: unknown[]) => { logCanvas(`lin ${JSON.stringify(a)}`); return FAKE_GRADIENT; },
    createRadialGradient: (...a: unknown[]) => { logCanvas(`rad ${JSON.stringify(a)}`); return FAKE_GRADIENT; },
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(Math.max(1, w * h * 4)) }),
    putImageData: (img: { data: Uint8ClampedArray }, ...a: unknown[]) => { logCanvas(`put ${JSON.stringify(a)}`); canvasLog?.update(img.data); },
    measureText: () => ({ width: 0 }),
  };
  return new Proxy(target, {
    get: (t, key) => (key in t ? t[key] : (...a: unknown[]) => logCanvas(`${String(key)} ${JSON.stringify(a)}`)),
    set: (t, key, value) => { logCanvas(`${String(key)}=${typeof value === 'object' ? 'obj' : String(value)}`); t[key] = value; return true; },
  });
}

class RecordingCanvas {
  private w = 300;
  private h = 150;
  style: Record<string, string> = {};
  private ctx: object | null = null;
  get width(): number { return this.w; }
  set width(v: number) { logCanvas(`width=${v}`); this.w = v; }
  get height(): number { return this.h; }
  set height(v: number) { logCanvas(`height=${v}`); this.h = v; }
  getContext(): object { this.ctx ??= recordingContext(this); return this.ctx; }
  toDataURL(): string { return 'data:,'; }
  addEventListener(): void {}
}

function installRecordingDom(): void {
  const g = globalThis as Record<string, unknown>;
  g['document'] = {
    createElement: (tag: string) => (tag === 'canvas' ? new RecordingCanvas() : { style: {} }),
    createElementNS: () => new RecordingCanvas(),
  };
  g['HTMLCanvasElement'] = RecordingCanvas;
  g['self'] = globalThis;
  g['location'] = new URL('http://localhost/index.html');
  // The soft bodies, from the baked files.
  g['fetch'] = (url: URL | string): Promise<Response> => {
    const name = path.basename(String(url));
    const buf = fs.readFileSync(path.join(ROOT, 'web', 'models', 'critters', name));
    return Promise.resolve(new Response(buf));
  };
}

// ---- a small fixed world ----
const CAVE_ROOF = { y: 1.0, hx: 1.0, z0: -1, z1: 1 } as const;
const cave: CritterCave = {
  x: -6, z: 0, yaw: 0.3, ground: 0,
  mouth: new THREE.Vector3(-5, 0.2, 0.3), dir: new THREE.Vector3(1, 0, 0.2).normalize(), roof: CAVE_ROOF,
};
const reefHeight = (x: number, z: number): number => Math.max(0, 1.2 * Math.sin(x * 0.7) * Math.cos(z * 0.9) + 0.2 * Math.sin(x * 2.3 + z));
function roofAt(x: number, z: number): { y: number } | null {
  const dx = x - cave.x, dz = z - cave.z, cs = Math.cos(cave.yaw), sn = Math.sin(cave.yaw);
  const lx = dx * cs - dz * sn, lz = dx * sn + dz * cs;
  return Math.abs(lx) < CAVE_ROOF.hx && lz > CAVE_ROOF.z0 && lz < CAVE_ROOF.z1 ? { y: CAVE_ROOF.y } : null;
}

interface TestWorld extends CritterWorld {
  critters: Critter[];
  fish: { pos: THREE.Vector3; size: number; speed: number }[];
  food: CritterFood[];
}

function makeWorld(): TestWorld {
  return {
    bounds: { x0: -10, x1: 10, y0: 0, y1: 8, z0: -4, z1: 4 },
    reef: { caves: [cave] },
    critters: [],
    fish: [{ pos: new THREE.Vector3(0, 3, 0), size: 1.5, speed: 2 }],
    food: [],
    reefHeight,
    roofAt,
  };
}

// ---- hashing ----
function nums(h: Hash, values: ArrayLike<number>): void {
  h.update(new Uint8Array(Float64Array.from(values).buffer));
}

function hashObject(h: Hash, o: THREE.Object3D, all: boolean): void {
  h.update(`${o.type}:${o.name}:${o.visible ? 1 : 0}:${o.castShadow ? 1 : 0}:${o.frustumCulled ? 1 : 0}:${JSON.stringify(o.userData)}\n`);
  nums(h, [...o.position.toArray(), ...o.quaternion.toArray(), ...o.scale.toArray()]);
  if (o instanceof THREE.Mesh) {
    const g = o.geometry as THREE.BufferGeometry;
    for (const [name, a] of Object.entries(g.attributes)) {
      // Static geometry once, at build; what the critter rewrites (version > 0) at every snapshot.
      if (!all && !(a instanceof THREE.BufferAttribute && a.version > 0)) continue;
      h.update(`attr ${name} ${a.itemSize} ${a.count}\n`);
      nums(h, (a as THREE.BufferAttribute).array);
    }
    if (all && g.index) nums(h, g.index.array);
    if (o instanceof THREE.InstancedMesh) nums(h, o.instanceMatrix.array);
  }
  for (const c of o.children) hashObject(h, c, all);
}

const FAKE_RENDERER = {} as THREE.WebGLRenderer;

function materialsOf(model: THREE.Object3D): THREE.Material[] {
  const out = new Set<THREE.Material>();
  model.traverse((o) => { if (o instanceof THREE.Mesh) for (const m of ([] as THREE.Material[]).concat(o.material as THREE.Material)) out.add(m); });
  return [...out];
}

/** Each material's parameters and its patched shader; returns the patched uniforms (live objects). */
function hashMaterials(h: Hash, model: THREE.Object3D): Record<string, THREE.IUniform>[] {
  const uniforms: Record<string, THREE.IUniform>[] = [];
  for (const m of materialsOf(model)) {
    const json = m.toJSON() as unknown as Record<string, unknown>;
    for (const k of ['uuid', 'map', 'bumpMap', 'textures', 'images']) delete json[k];
    h.update(JSON.stringify(json) + '\n' + m.customProgramCacheKey() + '\n');
    const std = THREE.ShaderLib.standard;
    const shader = { uniforms: {} as Record<string, THREE.IUniform>, vertexShader: std.vertexShader, fragmentShader: std.fragmentShader } as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, FAKE_RENDERER);
    h.update(shader.vertexShader + '\n' + shader.fragmentShader + '\n' + Object.keys(shader.uniforms).sort().join(',') + '\n');
    uniforms.push(shader.uniforms);
  }
  return uniforms;
}

function hashUniforms(h: Hash, uniforms: readonly Record<string, THREE.IUniform>[]): void {
  for (const u of uniforms) for (const k of Object.keys(u).sort()) {
    const v: unknown = u[k]?.value;
    if (typeof v === 'number') nums(h, [v]);
    else if (v instanceof THREE.Vector3) nums(h, v.toArray());
  }
}

function hashState(h: Hash, c: Critter): void {
  h.update(`${c.kind} ${c.mode} ${JSON.stringify(c.inspect())}\n`);
  nums(h, [c.modeT, ...c.pos.toArray(), ...c.target.toArray(), c.radius, c.pickRadius]);
}

describe('critters', () => {
  it('build and behave exactly as recorded', async () => {
    installRecordingDom();
    const { CRITTER_SPECIES, createCritter } = await import('../src/critters.js');
    const rng = mulberry32(SEED), world = makeWorld();
    const den: OctopusDen = { pos: new THREE.Vector3(-5.2, 0.1, 0.3), cave };
    const result: Record<string, string> = {};
    const hashes = new Map<Critter, Hash>(), uniforms = new Map<Critter, Record<string, THREE.IUniform>[]>();
    for (const sp of CRITTER_SPECIES) {
      const h = createHash('sha256');
      canvasLog = h;
      const c = createCritter(sp, { rng, world, findDen: () => den });
      canvasLog = null;
      h.update(JSON.stringify(c.joins) + '\n');
      c.model.updateMatrixWorld(true);
      hashObject(h, c.model, true);
      uniforms.set(c, hashMaterials(h, c.model));
      hashState(h, c);
      result[`${sp.id}:build`] = h.copy().digest('hex');
      hashes.set(c, h);
      world.critters.push(c);
    }
    nums(hashes.get(world.critters[0] as Critter) as Hash, [rng()]);   // the shared stream's position after building

    const fish = world.fish[0];
    for (let step = 1; step <= STEPS; step++) {
      if (fish) fish.pos.set(7 * Math.cos(step * 0.01), 2 + Math.sin(step * 0.013), 3 * Math.sin(step * 0.01));
      if (step === 200) for (const c of world.critters) world.food.push({ pos: c.pos.clone().add(new THREE.Vector3(0.8, 0, 0.3)), eaten: false, resting: true });
      if (step === 450) world.food.push({ pos: new THREE.Vector3(2, 0.4, 1), eaten: false, resting: false });
      for (const c of world.critters) {
        if (step === 600 && c.startle) c.startle(world, c.pos.clone().add(new THREE.Vector3(1, 0, 0.5)));
        if (step === 700 && c.forceStrike) c.forceStrike(0.3);
        if (step === 750) { c.mode = c.kind === 'octopus' ? 'forage' : c.kind === 'turtle' ? 'graze' : 'rest'; c.modeT = 30; c.target = c.pos.clone().add(new THREE.Vector3(1.5, 0, 0.5)); }
        c.update(STEP_DT, world);
        if (step % SNAPSHOT_EVERY === 0) {
          const h = hashes.get(c) as Hash;
          hashState(h, c);
          hashObject(h, c.model, false);
          hashUniforms(h, uniforms.get(c) ?? []);
        }
      }
    }
    for (const [c, h] of hashes) result[`${c.kind}:run`] = h.digest('hex');

    if (process.env['WRITE_GOLDENS']) writeGolden('critters', result);
    expect(result).toEqual(readGolden('critters'));
  }, TIMEOUT_MS);
});
