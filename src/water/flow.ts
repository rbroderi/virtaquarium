// The water velocity field a particle system is advected by (supplied by the World: pump circulation).
import type * as THREE from 'three';

/** Writes the water velocity at p into out (units/s). */
export type FlowField = (p: THREE.Vector3, out: THREE.Vector3) => void;

export const NO_FLOW: FlowField = (_p, out) => {
  out.set(0, 0, 0);
};
