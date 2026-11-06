// A comparable summary of a built reef's layout (where things are, as plain numbers), and a headless
// reef build behind the fake canvas.
import * as THREE from 'three';
import { installFakeDom } from './fakeDom.js';
import type { Reef, Scenery } from '../../src/reef/types.js';

installFakeDom();

export const TANK_WIDTH = 22;
const VIEW = new THREE.Vector3(0, 4.6, 15);
const SAMPLE_STEP = 0.5;
const EMPTY_SCENERY: Scenery = { rocks: [], coral: {}, props: {}, plants: {} };

export interface LayoutSnapshot {
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

/** Works on any reef with the Reef shape (the JS build's too, read through the same field names). */
export function snapshot(reef: Reef): LayoutSnapshot {
  const heights: number[] = [];
  for (let x = -TANK_WIDTH / 2; x <= TANK_WIDTH / 2; x += SAMPLE_STEP) {
    for (let z = -3; z <= 3; z += SAMPLE_STEP) heights.push(round(reef.heightAt(x, z)));
  }
  let meshes = 0, vertices = 0;
  reef.group.traverse((o) => {
    // Duck-typed, so a reef built with another copy of three counts the same.
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

export type BuildReefFn = (scene: THREE.Object3D, width: number, seed: number, scenery: Scenery, view: THREE.Vector3) => Reef;

export const buildSnapshot = (build: BuildReefFn, seed: number): LayoutSnapshot =>
  snapshot(build(new THREE.Scene(), TANK_WIDTH, seed, EMPTY_SCENERY, VIEW));
