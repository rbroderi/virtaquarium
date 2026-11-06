// Reef layout determinism: the same seed builds the same reef, different seeds differ, and the TS
// builder reproduces the JS build's layout (pc/src/reef.js) exactly. Built headlessly behind a fake
// canvas (the layout never reads texture pixels) with the procedural scenery only.
import { beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { installFakeDom } from './support/fakeDom.js';
import type { Reef } from '../src/reef/types.js';

installFakeDom();

const TANK_WIDTH = 22;
const VIEW = new THREE.Vector3(0, 4.6, 15);
const SAMPLE_STEP = 0.5;
const SNAPSHOT_TIMEOUT_MS = 120_000;

/** A comparable summary of a reef's layout: where things are, as plain numbers. */
interface LayoutSnapshot {
  homes: number[][];
  caves: number[][];
  shelters: unknown[];
  anemones: number[][];
  bubbler: number[] | null;
  planted: unknown;
  heights: number[];
  meshes: number;
  vertices: number;
}

const round = (v: number): number => Math.round(v * 1e6) / 1e6;
const vec = (v: THREE.Vector3): number[] => [round(v.x), round(v.y), round(v.z)];

/** Accepts both the typed TS Reef and the untyped JS one (read through the same field names). */
function snapshot(reef: Reef): LayoutSnapshot {
  const heights: number[] = [];
  for (let x = -TANK_WIDTH / 2; x <= TANK_WIDTH / 2; x += SAMPLE_STEP) {
    for (let z = -3; z <= 3; z += SAMPLE_STEP) heights.push(round(reef.heightAt(x, z)));
  }
  let meshes = 0, vertices = 0;
  reef.group.traverse((o) => {
    // Duck-typed: the JS build loads its own copy of three, so instanceof would not match its meshes.
    if ((o as Partial<THREE.Mesh>).isMesh === true) {
      meshes++;
      vertices += (o as THREE.Mesh).geometry.getAttribute('position')?.count ?? 0;
    }
  });
  return {
    homes: reef.homes.map(vec),
    caves: reef.caves.map((c) => [...vec(c.mouth), ...vec(c.dir)]),
    shelters: (reef.shelters ?? []).map((s) => ({ kind: s.kind, pos: vec(s.pos), top: round(s.top), floor: round(s.floor) })),
    anemones: reef.anemones.map((a) => vec(a.pos)),
    bubbler: reef.bubbler ? vec(reef.bubbler) : null,
    planted: reef.planted,
    heights,
    meshes,
    vertices,
  };
}

type BuildFn = (scene: THREE.Object3D, width: number, seed: number, scenery: unknown, view: THREE.Vector3) => Reef;

let buildTs: BuildFn;
let buildJs: BuildFn;
const EMPTY = { rocks: [], coral: {}, props: {}, plants: {} };

async function loadBuild(url: string): Promise<BuildFn> {
  const mod: unknown = await import(url);
  if (typeof mod !== 'object' || mod === null || !('buildReef' in mod) || typeof mod.buildReef !== 'function') throw new Error(`${url}: no buildReef`);
  return mod.buildReef as BuildFn;
}

const build = (fn: BuildFn, seed: number): LayoutSnapshot => snapshot(fn(new THREE.Scene(), TANK_WIDTH, seed, EMPTY, VIEW));

beforeAll(async () => {
  buildTs = await loadBuild(new URL('../src/reef.ts', import.meta.url).href);
  buildJs = await loadBuild(new URL('../../pc/src/reef.js', import.meta.url).href);
}, SNAPSHOT_TIMEOUT_MS);

describe('reef layout', () => {
  it('is deterministic for a seed', () => {
    const a = build(buildTs, 7), b = build(buildTs, 7);
    expect(a).toEqual(b);
    expect(a.homes.length).toBeGreaterThan(0);
    expect(a.caves.length).toBeGreaterThan(0);
  }, SNAPSHOT_TIMEOUT_MS);

  it('differs across seeds', () => {
    expect(build(buildTs, 7).homes).not.toEqual(build(buildTs, 42).homes);
  }, SNAPSHOT_TIMEOUT_MS);

  it.each([7, 42])('matches the JS build for seed %i', (seed) => {
    expect(build(buildTs, seed)).toEqual(build(buildJs, seed));
  }, SNAPSHOT_TIMEOUT_MS);
});
