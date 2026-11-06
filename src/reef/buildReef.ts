// buildReef: the reef's public entry point. Runs the ReefBuilder with ray casts accelerated.
//
// The layout ray casts (corals finding the ground, cave sight lines, shelters) go through bounding
// volume hierarchies (three-mesh-bvh) while the reef is built: the same hits, triangle for triangle, as
// three's brute-force test of every triangle, which took seconds against the generated models. Each
// BVH is built on a geometry's first ray (indirect: the geometry's index is left as it was) and freed
// when the reef is done.
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';
import { ReefBuilder } from './builder.js';
import { EMPTY_SCENERY, type Reef, type Scenery } from './types.js';

/** Geometries smaller than this are tested brute force (a tree costs more than it saves). */
const BVH_MIN_ELEMENTS = 300;
const DEFAULT_SEED = 7;
const DEFAULT_VIEW = new THREE.Vector3(0, 4.6, 15);

export interface ReefBuildOptions {
  /** Accelerate the layout's ray casts (?bvh=0 turns it off, to A/B). */
  readonly useBvh?: boolean;
}

/** ?bvh=0 in the page URL turns the acceleration off (read where the default is needed, not at load). */
function bvhFromLocation(): boolean {
  return typeof location === 'undefined' || new URLSearchParams(location.search).get('bvh') !== '0';
}

/** Runs build with Mesh.prototype.raycast temporarily routed through lazily built BVHs. */
function withAcceleratedRaycast<T>(build: () => T): T {
  const plain = THREE.Mesh.prototype.raycast;
  const built = new Set<THREE.BufferGeometry>();
  THREE.Mesh.prototype.raycast = function raycast(this: THREE.Mesh, raycaster: THREE.Raycaster, hits: THREE.Intersection[]): void {
    const g = this.geometry;
    const elements = g.index ? g.index.count : (g.attributes['position']?.count ?? 0);
    if (!g.boundsTree && elements > BVH_MIN_ELEMENTS) {
      g.boundsTree = new MeshBVH(g, { indirect: true });
      built.add(g);
    }
    if (g.boundsTree) acceleratedRaycast.call(this, raycaster, hits);
    else plain.call(this, raycaster, hits);
  };
  try {
    return build();
  } finally {
    THREE.Mesh.prototype.raycast = plain;
    for (const g of built) delete g.boundsTree;
  }
}

/**
 * Builds the seeded reef into scene. width: tank width (the layout scales with it). scenery: generated
 * models from loadScenery() that replace procedural ones. view: the camera's rest position (main's
 * CAM_BASE, bake's camera), which the moray caves must face.
 */
export function buildReef(
  scene: THREE.Object3D,
  width: number,
  seed: number = DEFAULT_SEED,
  scenery: Scenery = EMPTY_SCENERY,
  view: THREE.Vector3 = DEFAULT_VIEW,
  options: ReefBuildOptions = {},
): Reef {
  const build = (): Reef => new ReefBuilder({ scene, width, seed, scenery, view }).build();
  return (options.useBvh ?? bvhFromLocation()) ? withAcceleratedRaycast(build) : build();
}
