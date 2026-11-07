// WebGPU (TSL) counterparts of the fish swim material. The WebGL path stays in swimShader.ts; these
// node materials only exist so fish swim under WebGPURenderer, which does not run onBeforeCompile GLSL.
//
// Ported: the whole vertex deformation from SWIM_GLSL's begin_vertex branch (body wave / tail bend /
// median-fin flutter and fold, jaw shear, erectile spines, pectoral ray bending and ripple, the moray
// path) plus the night/stress colour patch. Not ported yet (documented in notes/webgpu-plan.md):
// bend-corrected normals (left geometric), tissue light transport, packed-map second channels, specular
// AA and the HDR clamp.
import * as THREE from 'three';
import type { Node, ShaderNodeObject, UniformArrayNode, UniformNode } from 'three/webgpu';
import { tsl, type Tsl } from '../webgpu/tsl.js';
import { makeSwimMaterial, PATH_POINTS, type SwimUniforms, type Tissue } from './swimShader.js';

type NodeObject = ShaderNodeObject<Node>;
type FloatUniformNode = ShaderNodeObject<UniformNode<number>>;
type Vec2UniformNode = ShaderNodeObject<UniformNode<THREE.Vector2>>;
type Vec3UniformNode = ShaderNodeObject<UniformNode<THREE.Vector3>>;
type PathArrayNode = ShaderNodeObject<UniformArrayNode>;

/** TSL uniform nodes shared by every material of one fish (they all read the same SwimUniforms). */
interface SwimNodes {
  uPhase: FloatUniformNode;
  uAmp: FloatUniformNode;
  uFlutter: FloatUniformNode;
  uFinH: FloatUniformNode;
  uBend: FloatUniformNode;
  uFinPhase: FloatUniformNode;
  uXPed: FloatUniformNode;
  uVent: FloatUniformNode;
  uAnguil: FloatUniformNode;
  uLift: FloatUniformNode;
  uBendTail: FloatUniformNode;
  uFold: FloatUniformNode;
  uCup: FloatUniformNode;
  uPathOn: FloatUniformNode;
  uNight: FloatUniformNode | undefined;
  uGape: FloatUniformNode | undefined;
  uErect: FloatUniformNode | undefined;
  uHinge: Vec2UniformNode | undefined;
  uPBend: Vec3UniformNode | undefined;
  uPWave: Vec2UniformNode | undefined;
  uPath: PathArrayNode;
  uPathUp: PathArrayNode;
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

/** A Vector2 uniform, read by reference (fish.ts mutates its .x/.y in place). */
function vec2Uniform(t: Tsl, entry: THREE.IUniform<THREE.Vector2>): Vec2UniformNode {
  return t.uniform(entry.value, 'vec2') as Vec2UniformNode;
}

/** A Vector3 uniform, read by reference (fish.ts mutates its .x/.y/.z in place). */
function vec3Uniform(t: Tsl, entry: THREE.IUniform<THREE.Vector3>): Vec3UniformNode {
  return t.uniform(entry.value, 'vec3') as Vec3UniformNode;
}

/** The path stations/ups as a uniform array of vec3 (24 elements, indexed by the shader). */
function vec3Path(t: Tsl, entry: THREE.IUniform<Float32Array>): PathArrayNode {
  const arr: { readonly x: number; readonly y: number; readonly z: number }[] = Array.from({ length: PATH_POINTS }, (_, i) => ({
    get x(): number { return entry.value[i * 3] ?? 0; },
    get y(): number { return entry.value[i * 3 + 1] ?? 0; },
    get z(): number { return entry.value[i * 3 + 2] ?? 0; },
  }));
  return t.uniformArray(arr as unknown as THREE.Vector3[], 'vec3');
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
    uVent: scalar(t, uniforms.uVent),
    uAnguil: scalar(t, uniforms.uAnguil),
    uLift: scalar(t, uniforms.uLift),
    uBendTail: scalar(t, uniforms.uBendTail),
    uFold: scalar(t, uniforms.uFold),
    uCup: scalar(t, uniforms.uCup),
    uPathOn: scalar(t, uniforms.uPathOn),
    uNight: uniforms.uNight ? scalar(t, uniforms.uNight) : undefined,
    uGape: uniforms.uGape ? scalar(t, uniforms.uGape) : undefined,
    uErect: uniforms.uErect ? scalar(t, uniforms.uErect) : undefined,
    uHinge: uniforms.uHinge ? vec2Uniform(t, uniforms.uHinge) : undefined,
    uPBend: uniforms.uPBend ? vec3Uniform(t, uniforms.uPBend) : undefined,
    uPWave: uniforms.uPWave ? vec2Uniform(t, uniforms.uPWave) : undefined,
    uPath: vec3Path(t, uniforms.uPath),
    uPathUp: vec3Path(t, uniforms.uPathUp),
  };
  nodesByUniforms.set(uniforms, nodes);
  return nodes;
}

/** The displaced local position for the swim wave (SWIM_GLSL's begin_vertex branch). */
export function swimPositionNode(uniforms: SwimUniforms, tissue: Tissue | null = null): Node {
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
  // Pectoral ray bending and the fan ripple (FISH_PECT), in the fin's own space (x out along the rays).
  const pectFlex = (y: NodeObject, pBend: Vec3UniformNode): NodeObject =>
    t.float(1).sub(t.float(0.45).mul(t.clamp(y.div(t.float(0.5).mul(pBend.z)), -1, 1)));
  const PECT_WAVE_K = 2.6;
  const pectWave = (q: NodeObject, pBend: Vec3UniformNode, pWave: Vec2UniformNode): NodeObject => {
    const r = t.length(q).div(pBend.z);
    return pWave.y.mul(pBend.z).mul(r).mul(r)
      .mul(t.sin(pWave.x.add(t.float(PECT_WAVE_K).mul(t.atan2(q.y, t.max(q.x, 1e-4))))));
  };
  // The frame at body position x along the path (swimShader.ts pathFrame): a Catmull-Rom curve.
  const pathFrame = (x: NodeObject): { P: NodeObject; T: NodeObject; U: NodeObject } => {
    const f = t.clamp(t.float(0.5).sub(x).mul(23), 0, 22.999);
    const i = t.int(t.floor(f));
    const tt = f.sub(t.float(i));
    const p1 = u.uPath.element(i);
    const p2 = u.uPath.element(i.add(1));
    const iPrev = t.max(i.sub(1), 0);
    const iNext = t.min(i.add(2), PATH_POINTS - 1);
    const p0 = t.select(t.greaterThan(i, t.int(0)), u.uPath.element(iPrev), p2.mul(2).sub(p1));
    const p3 = t.select(t.lessThan(i, t.int(PATH_POINTS - 2)), u.uPath.element(iNext), p2.mul(2).sub(p1));
    const c1 = p2.sub(p0);
    const c2 = p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3);
    const c3 = p1.sub(p2).mul(3).add(p3).sub(p0);
    const P = p1.add(t.float(0.5).mul(tt).mul(c1.add(tt.mul(c2.add(tt.mul(c3))))));
    const T = t.negate(t.normalize(c1.add(tt.mul(c2.mul(2).add(c3.mul(3).mul(tt)))).add(t.vec3(1e-6, 0, 0))));
    const up = t.mix(u.uPathUp.element(i), u.uPathUp.element(i.add(1)), tt);
    const U = t.normalize(up.sub(T.mul(t.dot(up, T))).add(t.vec3(0, 1e-6, 0)));
    return { P, T, U };
  };

  return t.Fn(() => {
    const p0 = t.positionLocal.toVar();

    // Lower jaw shear (FISH_JAW): the chin drops as if turned about the hinge at the mouth corner.
    if (tissue?.jaw && u.uGape && u.uHinge) {
      const aJaw = t.attribute('aJaw', 'float');
      const a = t.negate(u.uGape.mul(aJaw));
      const dx = p0.x.sub(u.uHinge.x);
      p0.x.addAssign(dx.mul(t.cos(a).sub(1)));
      p0.y.addAssign(dx.mul(t.sin(a)));
    }

    // Erectile spines (FISH_ERECT): each spine (and its web) turns about its base.
    let erSpine: NodeObject = t.float(0);
    if (tissue?.erect && u.uErect) {
      const aErect = t.attribute('aErect', 'vec4');
      const e = t.min(u.uErect, t.float(2).sub(t.float(1.8).mul(u.uFold)));
      const a = t.select(t.lessThan(e, 1), aErect.z.mul(t.float(1).sub(e)), aErect.w.mul(e.sub(1)));
      const c = t.cos(a), s = t.sin(a);
      const d = p0.xy.sub(aErect.xy);
      erSpine = t.step(1e-5, t.abs(aErect.z));
      const nx = aErect.x.add(c.mul(d.x).sub(s.mul(d.y)));
      const ny = aErect.y.add(s.mul(d.x).add(c.mul(d.y)));
      p0.x.assign(t.mix(p0.x, nx, erSpine));
      p0.y.assign(t.mix(p0.y, ny, erSpine));
    }

    // Pectoral bending along the rays, tips trailing the stroke, plus the fan ripple (FISH_PECT).
    if (tissue?.pect && u.uPBend && u.uPWave) {
      const r = t.clamp(p0.x.div(u.uPBend.z), 0, 1);
      p0.z.addAssign(u.uPBend.x.mul(u.uPBend.z).mul(t.pow(r, 2)).mul(pectFlex(p0.y, u.uPBend)).add(pectWave(p0.xy, u.uPBend, u.uPWave)));
    }

    // Median fin fold (FISH_FIN): rays above/below the body lower and sweep back at speed.
    if (tissue?.kind === 'fin') {
      const over = t.abs(p0.y).sub(u.uFinH);
      const guard = t.step(0, over).mul(t.step(u.uXPed.add(0.03), p0.x)).mul(t.float(1).sub(erSpine));
      const k = u.uFold.mul(t.smoothstep(0, 0.05, over));
      const foldX = p0.x.sub(over.mul(0.35).mul(k));
      const foldY = t.sign(p0.y).mul(u.uFinH.add(over.mul(t.float(1).sub(t.float(0.55).mul(k)))));
      p0.x.assign(t.mix(p0.x, foldX, guard));
      p0.y.assign(t.mix(p0.y, foldY, guard));
    }

    const swH = spineH(p0.x);
    const swT = t.atan(spineH(p0.x.add(0.005)).sub(swH).div(0.005));
    const swC = t.cos(swT), swS = t.sin(swT);
    // Gill-cover flare (FISH_COVER): the rear of the operculum scales its lateral offset.
    const vent = tissue?.cover
      ? t.float(1).add(u.uVent.mul(1.5).mul(t.attribute('aCover', 'float')))
      : t.float(1);
    const swZ = p0.z.mul(vent).add(finFlutter(p0));

    // Straight body (and non-path fins) versus the moray drawn along its path (uPathOn).
    const straight = t.vec3(p0.x.sub(swZ.mul(swS)), p0.y.add(liftY(p0.x)), swH.add(swZ.mul(swC)));
    const frame = pathFrame(p0.x);
    const xc = t.clamp(p0.x, -0.5, 0.5);
    const pathP = frame.P
      .add(frame.T.mul(p0.x.sub(xc)))
      .add(frame.U.mul(p0.y))
      .add(t.cross(frame.T, frame.U).mul(swZ));
    return t.select(t.greaterThan(u.uPathOn, 0.5), pathP, straight);
  })();
}

/** A MeshPhysicalNodeMaterial with the swim vertex wave, from the same parameters as the WebGL path. */
export function makeSwimNodeMaterial(
  params: THREE.MeshPhysicalMaterialParameters,
  uniforms: SwimUniforms,
  tissue: Tissue | null = null,
): InstanceType<Tsl['MeshPhysicalNodeMaterial']> {
  const t = tsl();
  const mat = new t.MeshPhysicalNodeMaterial(params as object);
  mat.positionNode = swimPositionNode(uniforms, tissue);
  if (tissue?.night && uniforms.uNight) mat.colorNode = nightColourNode(t, nodesFor(uniforms).uNight!, tissue.night);
  // Packed body maps' second channels (swimShader.ts's `packed`): the film thickness is the iridescence
  // map's G (three's native iridescenceMap already reads its R as the strength), and the cavity under
  // each scale's free margin is the roughness map's R, applied as ambient occlusion. Roughness itself is
  // the roughness map's G, which three's standard material already reads.
  if (tissue?.packed) {
    const range = params.iridescenceThicknessRange as [number, number] | undefined;
    if (params.iridescenceMap && range) {
      mat.iridescenceThicknessNode = t.float(range[1]).sub(t.float(range[0]))
        .mul(t.texture(params.iridescenceMap).g).add(t.float(range[0]));
    }
    if (params.roughnessMap) mat.aoNode = t.texture(params.roughnessMap).r;
  }
  return mat;
}

/** The night (and stress) colour patch from swimShader.ts, in TSL: chromatophores contract or expand
 *  over minutes at dusk, paling or darkening the fish. uNight 0..1 is written by fish.ts. */
function nightColourNode(t: Tsl, uNight: FloatUniformNode, kind: 'pale' | 'dark'): Node {
  const c = t.materialColor.rgb;   // the standard colour incl. map, before the patch
  const l = c.dot(t.vec3(0.2126, 0.7152, 0.0722));
  const night: Node = kind === 'pale'
    ? t.mix(t.vec3(l), t.vec3(t.float(0.75).add(t.float(0.2).mul(
        t.float(0.5).add(t.float(0.5).mul(t.sin(t.uv().x.mul(23).add(t.sin(t.uv().y.mul(9)).mul(2))))),
      ))), 0.45)
    : t.vec3(l).mul(0.45).add(c.mul(0.12));
  return t.mix(c, night, uNight.mul(0.8));
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
  if (gpu) return makeSwimNodeMaterial(params, uniforms, tissue);
  return makeSwimMaterial(new THREE.MeshPhysicalMaterial(params), uniforms, tissue);
}
