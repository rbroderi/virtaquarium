// The built fish: a THREE.Group with its swim uniforms and pectoral pivots as typed fields. The same
// values are mirrored on userData, as the JavaScript build exposed them.
import * as THREE from 'three';
import type { SwimUniforms } from './swimShader.js';

/** One pectoral fin's pivot (rotated by posePectoral); its first child is the fin mesh. */
export class PectoralPivot extends THREE.Group {
  constructor(
    /** +1 right, -1 left. */
    readonly side: number,
    readonly fin: THREE.Mesh,
    /** The fin's ray-bending uniform (procedural fins only). */
    readonly uPBend: THREE.IUniform<THREE.Vector3> | undefined,
  ) {
    super();
    this.add(fin);
    this.userData['side'] = side;
    this.userData['uPBend'] = uPBend;
  }
}

export interface FishModelParts {
  uniforms: SwimUniforms;
  pects: PectoralPivot[];
  /** A fan pectoral (lionfish wings), posed rather than rowed. */
  fan: boolean;
  /** Built from a loaded GLB rather than procedurally. */
  custom: boolean;
}

export class FishModel extends THREE.Group {
  readonly uniforms: SwimUniforms;
  readonly pects: PectoralPivot[];
  readonly fan: boolean;
  readonly custom: boolean;

  constructor({ uniforms, pects, fan, custom }: FishModelParts) {
    super();
    this.uniforms = uniforms;
    this.pects = pects;
    this.fan = fan;
    this.custom = custom;
    this.userData = custom ? { uniforms, pects, fan, custom } : { uniforms, pects, fan };
  }
}
