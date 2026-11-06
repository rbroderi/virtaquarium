// The geometry every moon jelly shares (unit bell; the shaders move every vertex), built once.
import * as THREE from 'three';
import { mulberry32 } from '../util.js';

export interface JellyGeometry {
  readonly bell: THREE.LatheGeometry;
  readonly tent: THREE.BufferGeometry;
  readonly arms: readonly THREE.BufferGeometry[];
}

const BELL_PROFILE_POINTS = 24;
const BELL_SEGMENTS = 128;          // 4 per lappet, for the scalloped margin
const BELL_DEPTH = 0.5;             // dome depth per unit radius (resting bells in the photos)
const MIN_LATHE_RADIUS = 1e-4;
const TENTACLE_COUNT = 160;
const TENTACLE_SEGMENTS = 5;
const TENTACLE_SEED = 5;
const ORAL_ARMS = 4;
const RIBBON_SEGMENTS_ACROSS = 14;  // fine enough across for the rolled lip ...
const RIBBON_SEGMENTS_ALONG = 90;   // ... and along for its frill
const NEVER_CULL_RADIUS = 1e3;      // shaders move every vertex: never cull on the rest-pose bounds

function bellGeometry(): THREE.LatheGeometry {
  // Bell: a dome about half as deep as it is wide in radius (resting bells in the photos, e.g.
  // losada_finisterrae.jpg), round-shouldered, the margin curling slightly under, unit radius.
  const prof: THREE.Vector2[] = [];
  for (let i = 0; i <= BELL_PROFILE_POINTS; i++) {
    const t = i / BELL_PROFILE_POINTS, r = Math.sin(t * Math.PI / 2) * 1.0;
    prof.push(new THREE.Vector2(Math.max(MIN_LATHE_RADIUS, r + (t > 0.9 ? (t - 0.9) * 0.15 : 0)), BELL_DEPTH * Math.cos(t * Math.PI / 2) ** 0.9 - (t > 0.9 ? (t - 0.9) * 0.5 : 0)));
  }
  return new THREE.LatheGeometry(prof, BELL_SEGMENTS);
}

function tentacleGeometry(): THREE.BufferGeometry {
  // Tentacles: line segments, a few points each.
  const pos: number[] = [], ang: number[] = [], ss: number[] = [], len: number[] = [], rng = mulberry32(TENTACLE_SEED);
  for (let i = 0; i < TENTACLE_COUNT; i++) {
    const a = (i + rng() * 0.5) / TENTACLE_COUNT, l = 0.16 + rng() * 0.1;
    for (let k = 0; k < TENTACLE_SEGMENTS; k++) for (const kk of [k, k + 1]) { pos.push(0, 0, 0); ang.push(a); ss.push(kk / TENTACLE_SEGMENTS); len.push(l); }
  }
  const tent = new THREE.BufferGeometry();
  tent.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  tent.setAttribute('aAng', new THREE.Float32BufferAttribute(ang, 1));
  tent.setAttribute('aS', new THREE.Float32BufferAttribute(ss, 1));
  tent.setAttribute('aLen', new THREE.Float32BufferAttribute(len, 1));
  return tent;
}

function oralArmGeometries(): THREE.BufferGeometry[] {
  // Arms: four ribbons, one geometry with an arm index per vertex.
  const ribbon = new THREE.PlaneGeometry(1, 1, RIBBON_SEGMENTS_ACROSS, RIBBON_SEGMENTS_ALONG), arms: THREE.BufferGeometry[] = [];
  for (let k = 0; k < ORAL_ARMS; k++) {
    const g = ribbon.clone();
    g.setAttribute('aArm', new THREE.Float32BufferAttribute(new Array<number>(g.attributes['position']?.count ?? 0).fill(k), 1));
    arms.push(g);
  }
  return arms;
}

let shared: JellyGeometry | null = null;

export function sharedJellyGeometry(): JellyGeometry {
  if (shared) return shared;
  const bell = bellGeometry(), tent = tentacleGeometry(), arms = oralArmGeometries();
  for (const g of [bell, tent, ...arms]) g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), NEVER_CULL_RADIUS);
  shared = { bell, tent, arms };
  return shared;
}
