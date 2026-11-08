// Reef materials: the standard lit material with caustics, and the sway that bends soft tissue and
// plants with the water.
import * as THREE from 'three';
import { addCaustics, waterUniforms } from '../water.js';
import { FISH_PUSH_APPLY, FISH_PUSH_HEADER, fishPushBend, fishUniforms } from './fishPush.js';
import { applyInstance, gpuActive, tsl, webgpu, type FloatUniformNode, type Node, type NodeObject } from '../webgpu/tsl.js';
import { installReefLight } from '../reefLight/webgpu.js';
import { waterTimeNode } from '../webgpu/timeUniform.js';

const GLSL_DIGITS = 4;

/** A caustic-lit MeshStandardMaterial (water.ts addCaustics); under WebGPU the caustic GLSL is dead,
 *  so the same parameters become a plain MeshStandardNodeMaterial. */
export function stdMat(params: THREE.MeshStandardMaterialParameters): THREE.Material {
  if (gpuActive()) {
    const wg = webgpu();
    return installReefLight(new wg.MeshStandardNodeMaterial(params));
  }
  return addCaustics(new THREE.MeshStandardMaterial(params));
}

export interface SwayOptions {
  /** Tip displacement along the model's own x (scaled with the model). */
  readonly ax?: number;
  /** Tip displacement along the model's own z. */
  readonly az?: number;
  /** Main frequency (Hz-ish, radians per second of uTime). */
  readonly hz?: number;
  /** Model-space height of the top, where the bend is full. */
  readonly hTop?: number;
  /** Also part from nearby fish (a fixed-size uniform array updated once a frame). */
  readonly fishPush?: boolean;
  /** The mesh is an InstancedMesh carrying the aInst0..aInst3 instance-matrix attributes (WebGPU). */
  readonly instanced?: boolean;
  /** A storage-buffer node over the instance matrix (WebGPU), for a material used by one instanced mesh;
   *  reading this instead of aInst0..aInst3 keeps the draw under the vertex-buffer limit. */
  readonly instanceMatrixNode?: NodeObject | undefined;
  /** GLSL declarations prepended to the vertex shader, for the attributes the deform reads. */
  readonly prelude?: string;
  /** GLSL run inside the bend block after the sway (h is in scope), e.g. a per-instance curl. */
  readonly deform?: string;
  /** Distinguishes program cache entries that share a key but not a deform. */
  readonly variant?: string;
  /** TSL counterpart of `deform`, run after the sway bend on the WebGPU path: (swayedLocal, h) => position. */
  readonly deformNode?: (p: NodeObject, h: NodeObject) => NodeObject;
}

const SWAY_DEFAULTS = { ax: 0.05, az: 0.035, hz: 1.0, hTop: 1 } as const;

/** TSL port of the sway's begin_vertex patch: the same h^2 bend from the piece's model-space position.
 *  The bend runs in the blade/tentacle's own space (the authored position, not the instance-transformed
 *  one), exactly like the GLSL, then applies the instance matrix itself: NodeMaterial assigns positionNode
 *  after its own instancing step, so the node's result is the final local position. */
function swayNode(options: { ax: number; az: number; hz: number; hTop: number; fishPush: boolean; instanced: boolean; instanceMatrixNode: NodeObject | undefined; deformNode: ((p: NodeObject, h: NodeObject) => NodeObject) | undefined }): Node {
  const t = tsl();
  const { ax, az, hz, hTop, fishPush, instanced, instanceMatrixNode, deformNode } = options;
  const time = waterTimeNode();
  // The per-species sway numbers arrive as uniforms, not float() literals, so every swayed material
  // shares one vertex program instead of one per (ax, az, hz, hTop) combination.
  const uAx = t.uniform(ax, 'float') as FloatUniformNode;
  const uAz = t.uniform(az, 'float') as FloatUniformNode;
  const uHz = t.uniform(hz, 'float') as FloatUniformNode;
  const uHTop = t.uniform(hTop, 'float') as FloatUniformNode;
  return t.Fn(() => {
    const p = t.positionGeometry.toVar();   // the authored position: h is the model's own height
    const h = t.clamp(p.y.div(uHTop), t.float(0), t.float(1));
    // The instance matrix's four columns: a storage-buffer node when the caller supplied one (a single
    // mesh per material), else the aInst0..aInst3 per-instance attributes.
    const i0 = (instanceMatrixNode ? t.element(instanceMatrixNode, 0) : t.attribute('aInst0', 'vec4')) as unknown as NodeObject;
    const i1 = (instanceMatrixNode ? t.element(instanceMatrixNode, 1) : t.attribute('aInst1', 'vec4')) as unknown as NodeObject;
    const i2 = (instanceMatrixNode ? t.element(instanceMatrixNode, 2) : t.attribute('aInst2', 'vec4')) as unknown as NodeObject;
    const i3 = (instanceMatrixNode ? t.element(instanceMatrixNode, 3) : t.attribute('aInst3', 'vec4')) as unknown as NodeObject;
    const ph = instanced
      ? i3.x.mul(t.float(1.7)).add(i3.z.mul(t.float(2.3)))
      : t.modelPosition.x.mul(t.float(1.7)).add(t.modelPosition.z.mul(t.float(2.3)));
    const s = t.sin(time.mul(uHz).add(ph))
      .add(t.float(0.35).mul(t.sin(time.mul(uHz.mul(t.float(2.3))).add(ph.mul(t.float(1.9))))));
    const out = p.toVar();
    out.x.addAssign(s.mul(uAx).mul(h).mul(h));
    out.z.addAssign(t.cos(time.mul(uHz.mul(t.float(0.8))).add(ph.mul(t.float(1.3)))).mul(uAz).mul(h).mul(h));
    if (deformNode) out.assign(deformNode(out, h));
    const local = !fishPush ? out : (instanced
      ? fishPushBend(out, h, i0, i1, i2, i3)
      : fishPushBend(out, h, t.vec4(1, 0, 0, 0), t.vec4(0, 1, 0, 0), t.vec4(0, 0, 1, 0), t.vec4(0, 0, 0, 1))) as unknown as NodeObject;
    // Since r17x, NodeMaterial assigns positionNode after its instancing step, so the result replaces
    // the instance-transformed position: apply the instance matrix here.
    return instanced ? applyInstance(local, i0, i1, i2, i3) : local;
  })();
}

/**
 * Soft tissue and plants sway with the water. h = height up the model (0 at the base, 1 at the top,
 * position.y / hTop in model units) and the bend grows with h^2. The phase comes from where each piece
 * stands, so neighbours don't move in step, and a second harmonic keeps it from looking mechanical.
 * key: the program cache key (materials with the same key share the compiled shader).
 */
export function addSway<M extends THREE.Material>(mat: M, key: string, options: SwayOptions = {}): M {
  const ax = options.ax ?? SWAY_DEFAULTS.ax, az = options.az ?? SWAY_DEFAULTS.az;
  const hz = options.hz ?? SWAY_DEFAULTS.hz, hTop = options.hTop ?? SWAY_DEFAULTS.hTop;
  const fishPush = options.fishPush ?? false;
  const instanced = options.instanced ?? false;
  if (gpuActive()) {
    // WebGPURenderer never runs onBeforeCompile, so the GLSL below is dead; the same bend goes through
    // a positionNode instead (the instance matrix arrives as a storage buffer or per-instance attributes).
    (mat as unknown as { positionNode: Node | null }).positionNode = swayNode({ ax, az, hz, hTop, fishPush, instanced, instanceMatrixNode: options.instanceMatrixNode, deformNode: options.deformNode });
    return mat;
  }
  const prelude = options.prelude ?? '', deform = options.deform ?? '';
  const prev = mat.onBeforeCompile.bind(mat);
  const f = (x: number): string => x.toFixed(GLSL_DIGITS);
  mat.onBeforeCompile = (shader, r) => {
    prev(shader, r);
    shader.uniforms['uTime'] = waterUniforms.uTime;
    if (fishPush) {
      shader.uniforms['uFishPos'] = fishUniforms.uFishPos;
      shader.uniforms['uFishVel'] = fishUniforms.uFishVel;
      shader.uniforms['uFishCount'] = fishUniforms.uFishCount;
    }
    const head = 'uniform float uTime;\n' + prelude + (fishPush ? FISH_PUSH_HEADER : '');
    shader.vertexShader = head + shader.vertexShader.replace('#include <begin_vertex>', `
      vec3 transformed = vec3(position);
      {
        #ifdef USE_INSTANCING
        vec3 swayAt = instanceMatrix[3].xyz;
        #else
        vec3 swayAt = modelMatrix[3].xyz;
        #endif
        float h = clamp(position.y / ${f(hTop)}, 0.0, 1.0), ph = swayAt.x * 1.7 + swayAt.z * 2.3;
        float s = sin(uTime * ${f(hz)} + ph) + 0.35 * sin(uTime * ${f(hz * 2.3)} + ph * 1.9);
        transformed.x += s * ${f(ax)} * h * h;
        transformed.z += cos(uTime * ${f(hz * 0.8)} + ph * 1.3) * ${f(az)} * h * h;
        ${deform}
        ${fishPush ? FISH_PUSH_APPLY : ''}
      }`);
  };
  const variant = options.variant ?? '';
  mat.customProgramCacheKey = () => key + (fishPush ? '-fish' : '') + (variant ? `-${variant}` : '');
  return mat;
}

/** The (first) material of a mesh, for the per-mesh patches that expect one. */
export function firstMaterial(mesh: THREE.Mesh): THREE.Material | undefined {
  return Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
}
