// WebGPU (TSL) counterparts of the fish swim material. The WebGL path stays in swimShader.ts; these
// node materials only exist so fish swim under WebGPURenderer, which does not run onBeforeCompile GLSL.
//
// Scope: the body wave / tail bend / median-fin flutter vertex deformation. Not ported yet (documented
// in notes/webgpu-plan.md): the moray path (uPathOn), tissue light transport, night colour, jaw/gape,
// erectile spines, pectoral ray bending and ripple, packed-map second channels, specular AA and the HDR
// clamp. Normals are left geometric, so lighting does not quite follow the bend of the caudal blade.
import * as THREE from 'three';
import type { Node, ShaderNodeObject, UniformNode } from 'three/webgpu';
import { tsl, type Tsl } from '../webgpu/tsl.js';
import { makeSwimMaterial, type SwimUniforms, type Tissue } from './swimShader.js';

type NodeObject = ShaderNodeObject<Node>;
type FloatUniformNode = ShaderNodeObject<UniformNode<number>>;

/** TSL uniform nodes shared by every material of one fish (they all read the same SwimUniforms). */
interface SwimNodes {
  uPhase: FloatUniformNode;
  uAmp: FloatUniformNode;
  uFlutter: FloatUniformNode;
  uFinH: FloatUniformNode;
  uBend: FloatUniformNode;
  uFinPhase: FloatUniformNode;
  uXPed: FloatUniformNode;
  uAnguil: FloatUniformNode;
  uLift: FloatUniformNode;
  uBendTail: FloatUniformNode;
  uCup: FloatUniformNode;
}

const nodesByUniforms = new WeakMap<SwimUniforms, SwimNodes>();

/**
 * Bridges a scalar swim uniform to a TSL uniform node exactly once: fish.ts writes `u.uPhase.value`,
 * so the entry's `value` becomes an accessor over the node's own value. Object uniforms (Vector2/3,
 * Float32Array) need no bridge — they are mutated in place and read back by reference each frame.
 */
function scalar(t: Tsl, entry: THREE.IUniform<number>): FloatUniformNode {
  const node = t.uniform(entry.value);
  Object.defineProperty(entry, 'value', {
    get: (): number => node.value,
    set: (v: number): void => { node.value = v; },
    configurable: true,
    enumerable: true,
  });
  return node;
}

function nodesFor(uniforms: SwimUniforms): SwimNodes {
  const known = nodesByUniforms.get(uniforms);
  if (known) return known;
  const t = tsl();
  const nodes: SwimNodes = {
    uPhase: scalar(t, uniforms.uPhase),
    uAmp: scalar(t, uniforms.uAmp),
    uFlutter: scalar(t, uniforms.uFlutter),
    uFinH: scalar(t, uniforms.uFinH),
    uBend: scalar(t, uniforms.uBend),
    uFinPhase: scalar(t, uniforms.uFinPhase),
    uXPed: scalar(t, uniforms.uXPed),
    uAnguil: scalar(t, uniforms.uAnguil),
    uLift: scalar(t, uniforms.uLift),
    uBendTail: scalar(t, uniforms.uBendTail),
    uCup: scalar(t, uniforms.uCup),
  };
  nodesByUniforms.set(uniforms, nodes);
  return nodes;
}

/** The displaced local position for the swim wave (the non-path, non-fin branch of SWIM_GLSL). */
export function swimPositionNode(uniforms: SwimUniforms): Node {
  const t = tsl();
  const u = nodesFor(uniforms);

  // Node builders mirror swimShader.ts's spineH / liftY / finFlutter.
  const spineH = (x: NodeObject): NodeObject => {
    const xc = t.max(x, t.float(-0.55));
    const s = t.float(0.5).sub(xc);
    const env = t.mix(
      t.float(0.02).sub(t.float(0.06).mul(s)).add(t.float(0.2).mul(s).mul(s)),
      t.float(0.03).add(t.float(0.07).mul(s)),
      u.uAnguil,
    );
    const lag = t.float(0.8).add(u.uCup)
      .mul(t.float(1).sub(u.uAnguil))
      .mul(t.float(1).sub(t.smoothstep(u.uXPed.sub(0.12), u.uXPed.add(0.02), xc)));
    const bend = t.mix(u.uBendTail, u.uBend, t.smoothstep(t.float(-0.3), t.float(0.2), xc));
    return u.uAmp.mul(env)
      .mul(t.sin(u.uPhase.add(xc.mul(t.mix(t.float(6.6), t.float(10.5), u.uAnguil))).sub(lag)))
      .add(bend.mul(xc.sub(0.05)).mul(xc.sub(0.05)).mul(2));
  };
  const liftY = (x: NodeObject): NodeObject => {
    const d = t.max(0, x.sub(0.1));
    return u.uLift.mul(d).mul(d).mul(2.5);
  };
  const finFlutter = (p: NodeObject): NodeObject => {
    const fin = t.smoothstep(u.uFinH, u.uFinH.add(0.15), t.abs(p.y));
    return u.uFlutter.mul(fin).mul(0.018).mul(t.sin(u.uFinPhase.add(p.x.mul(14)).add(t.abs(p.y).mul(6))));
  };

  return t.Fn(() => {
    const p0 = t.positionLocal;
    const swH = spineH(p0.x);
    const swT = t.atan(spineH(p0.x.add(0.005)).sub(swH).div(0.005));
    const swC = t.cos(swT);
    const swS = t.sin(swT);
    const swZ = p0.z.add(finFlutter(p0));   // ventScale is skipped (no gill-cover attribute yet)
    return t.vec3(p0.x.sub(swZ.mul(swS)), p0.y.add(liftY(p0.x)), swH.add(swZ.mul(swC)));
  })();
}

/** A MeshPhysicalNodeMaterial with the swim vertex wave, from the same parameters as the WebGL path. */
export function makeSwimNodeMaterial(
  params: THREE.MeshPhysicalMaterialParameters,
  uniforms: SwimUniforms,
): InstanceType<Tsl['MeshPhysicalNodeMaterial']> {
  const t = tsl();
  const mat = new t.MeshPhysicalNodeMaterial(params as object);
  mat.positionNode = swimPositionNode(uniforms);
  return mat;
}

/**
 * One entry point for building a swim material on either backend. Under WebGPU the tissue/GLSL patches
 * are not applied (they are WebGL-only); the maps and physical parameters carry over as-is.
 */
export function swimMaterialFor(
  params: THREE.MeshPhysicalMaterialParameters,
  uniforms: SwimUniforms,
  tissue: Tissue | null,
  gpu: boolean,
): THREE.Material {
  if (gpu) return makeSwimNodeMaterial(params, uniforms);
  return makeSwimMaterial(new THREE.MeshPhysicalMaterial(params), uniforms, tissue);
}
