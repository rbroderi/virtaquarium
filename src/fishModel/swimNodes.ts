// WebGPU (TSL) counterparts of the fish swim material. The WebGL path stays in swimShader.ts; these
// node materials only exist so fish swim under WebGPURenderer, which does not run onBeforeCompile GLSL.
//
// Ported: the whole vertex deformation from SWIM_GLSL's begin_vertex branch (body wave / tail bend /
// median-fin flutter and fold, jaw shear, erectile spines, pectoral ray bending and ripple, the moray
// path) plus the night/stress colour patch, the bend-corrected normals (beginnormal_vertex), the tissue
// light transport (TISSUE_GLSL direct transmission + wrap), specular anti-aliasing with the grazing
// variance, the normal-map edge fade and the grazing specular guard. The packed-map second channels are
// read through iridescenceThicknessNode/aoNode.
import * as THREE from 'three';
import {
  tsl, webgpu,
  type LightingModelDirectInput, type Node, type NodeBuilder,
  type FloatUniformNode, type Vec2UniformNode, type Vec3UniformNode, type PathArrayNode, type NodeObject,
  type Tsl, type Webgpu,
} from '../webgpu/tsl.js';
import { installReefLight } from '../reefLight/webgpu.js';
import { makeSwimMaterial, swimUniforms, PATH_POINTS, type SwimUniforms, type Tissue } from './swimShader.js';

/** Brightest linear radiance a fish fragment may write, as swimShader.ts's HDR_CLAMP. */
const HDR_CLAMP = 4;

/** TSL uniform nodes shared by EVERY swim material. Each fish keeps its own SwimUniforms (fish.ts writes
 *  `u.uPhase.value` and so on); a node reads the drawn object's material's uniforms in its object update,
 *  so a node graph can be shared between fish. Sharing matters because three keys a node material's compiled
 *  program on its node ids: a graph built per fish was built, and its program cache missed, once per fish
 *  and per pass (about 40 ms of TSL building each). */
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
  uNight: FloatUniformNode;
  uGape: FloatUniformNode;
  uErect: FloatUniformNode;
  uHinge: Vec2UniformNode;
  uPBend: Vec3UniformNode;
  uPWave: Vec2UniformNode;
  uGaze: Vec2UniformNode;
  /** Per-material numbers (SwimConstants) that would otherwise be literals, splitting the shader per species. */
  uSizeMM: FloatUniformNode;
  uThickMM: FloatUniformNode;
  uNormalScale: Vec2UniformNode;
  uIridRange: Vec2UniformNode;
  /** The drawn material's colour and iridescence (a node bound to one material would be wrong for the rest). */
  uMatColor: NodeObject;
  uMatIridescence: FloatUniformNode;
}

/** The two moray path arrays: a uniform buffer is shared by every object using it, so these stay per fish. */
interface PathNodes { uPath: PathArrayNode; uPathUp: PathArrayNode }

type ObjectFrame = { readonly object?: unknown };
type ObjectUpdatable = { onObjectUpdate(callback: (frame: ObjectFrame) => void): unknown };

/** The material of the object being drawn (the shadow pass swaps the material, not the object). */
function drawnMaterial(frame: ObjectFrame): THREE.Material | undefined {
  const m = (frame.object as THREE.Mesh | undefined)?.material;
  return Array.isArray(m) ? m[0] : m;
}

interface SwimConstants {
  readonly sizeMM: number;
  readonly thickMM: number;
  readonly normalScale: THREE.Vector2;
  readonly iridLo: number;
  readonly iridRange: number;
}

function swimConstantsOf(frame: ObjectFrame): SwimConstants | undefined {
  return (drawnMaterial(frame)?.userData as { swimConstants?: SwimConstants } | undefined)?.swimConstants;
}

function swimUniformsOf(frame: ObjectFrame): SwimUniforms | undefined {
  return (drawnMaterial(frame)?.userData as { swimUniforms?: SwimUniforms } | undefined)?.swimUniforms;
}

let swimNodeSet: SwimNodes | null = null;
const pathNodesByUniforms = new WeakMap<SwimUniforms, PathNodes>();
const fishIds = new WeakMap<SwimUniforms, number>();
const sharedNodes = new Map<string, unknown>();

/** One node per structure key: materials of the same structure share a graph (and so a compiled program). */
function shared<T>(key: string, build: () => T): T {
  let node = sharedNodes.get(key);
  if (node === undefined) {
    node = build();
    sharedNodes.set(key, node);
  }
  return node as T;
}

type ScalarKey = 'uPhase' | 'uAmp' | 'uFlutter' | 'uFinH' | 'uBend' | 'uFinPhase' | 'uXPed' | 'uVent' | 'uAnguil' | 'uLift'
  | 'uBendTail' | 'uFold' | 'uCup' | 'uPathOn' | 'uNight' | 'uGape' | 'uErect';
const SCALAR_DEFAULTS = swimUniforms({ uNight: { value: 0 }, uGape: { value: 0 }, uErect: { value: 1 } });

/** A float uniform refreshed from the drawn object's swim uniforms. */
function scalar(t: Tsl, key: ScalarKey): FloatUniformNode {
  const rest = SCALAR_DEFAULTS[key]!.value;
  const node = t.uniform(rest);
  (node as unknown as ObjectUpdatable).onObjectUpdate((frame) => { node.value = swimUniformsOf(frame)?.[key]?.value ?? rest; });
  return node;
}

type VectorKey = 'uHinge' | 'uPWave' | 'uGaze';

function vec2Uniform(t: Tsl, key: VectorKey, rest: THREE.Vector2): Vec2UniformNode {
  const node = t.uniform(rest.clone(), 'vec2') as Vec2UniformNode;
  (node as unknown as ObjectUpdatable).onObjectUpdate((frame) => { node.value.copy(swimUniformsOf(frame)?.[key]?.value ?? rest); });
  return node;
}

function vec3Uniform(t: Tsl, rest: THREE.Vector3): Vec3UniformNode {
  const node = t.uniform(rest.clone(), 'vec3') as Vec3UniformNode;
  (node as unknown as ObjectUpdatable).onObjectUpdate((frame) => { node.value.copy(swimUniformsOf(frame)?.uPBend?.value ?? rest); });
  return node;
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

/** A uniform refreshed from the drawn material's SwimConstants. */
function constant(t: Tsl, type: 'float', read: (c: SwimConstants) => number): FloatUniformNode;
function constant(t: Tsl, type: 'vec2', read: (c: SwimConstants, v: THREE.Vector2) => void): Vec2UniformNode;
function constant(t: Tsl, type: 'float' | 'vec2', read: (c: SwimConstants, v: THREE.Vector2) => unknown): FloatUniformNode | Vec2UniformNode {
  if (type === 'float') {
    const node = t.uniform(0);
    (node as unknown as ObjectUpdatable).onObjectUpdate((frame) => {
      const c = swimConstantsOf(frame);
      if (c) node.value = read(c, node.value as never) as number;
    });
    return node;
  }
  const node = t.uniform(new THREE.Vector2(), 'vec2') as Vec2UniformNode;
  (node as unknown as ObjectUpdatable).onObjectUpdate((frame) => {
    const c = swimConstantsOf(frame);
    if (c) read(c, node.value);
  });
  return node;
}

function swimNodes(): SwimNodes {
  if (swimNodeSet) return swimNodeSet;
  const t = tsl();
  const matColor = t.uniform(new THREE.Color(1, 1, 1), 'color');
  (matColor as unknown as ObjectUpdatable).onObjectUpdate((frame) => {
    const m = drawnMaterial(frame) as (THREE.Material & { color?: THREE.Color }) | undefined;
    if (m?.color) matColor.value.copy(m.color);
  });
  const matIrid = t.uniform(0);
  (matIrid as unknown as ObjectUpdatable).onObjectUpdate((frame) => {
    matIrid.value = (drawnMaterial(frame) as (THREE.Material & { iridescence?: number }) | undefined)?.iridescence ?? 0;
  });
  swimNodeSet = {
    uPhase: scalar(t, 'uPhase'), uAmp: scalar(t, 'uAmp'), uFlutter: scalar(t, 'uFlutter'), uFinH: scalar(t, 'uFinH'),
    uBend: scalar(t, 'uBend'), uFinPhase: scalar(t, 'uFinPhase'), uXPed: scalar(t, 'uXPed'), uVent: scalar(t, 'uVent'),
    uAnguil: scalar(t, 'uAnguil'), uLift: scalar(t, 'uLift'), uBendTail: scalar(t, 'uBendTail'), uFold: scalar(t, 'uFold'),
    uCup: scalar(t, 'uCup'), uPathOn: scalar(t, 'uPathOn'), uNight: scalar(t, 'uNight'), uGape: scalar(t, 'uGape'),
    uErect: scalar(t, 'uErect'),
    uHinge: vec2Uniform(t, 'uHinge', new THREE.Vector2(9, 9)),
    uPBend: vec3Uniform(t, new THREE.Vector3(0, 0, 1)),
    uPWave: vec2Uniform(t, 'uPWave', new THREE.Vector2()),
    uGaze: vec2Uniform(t, 'uGaze', new THREE.Vector2()),
    uSizeMM: constant(t, 'float', (c) => c.sizeMM),
    uThickMM: constant(t, 'float', (c) => c.thickMM),
    uNormalScale: constant(t, 'vec2', (c, v) => v.copy(c.normalScale)),
    uIridRange: constant(t, 'vec2', (c, v) => v.set(c.iridLo, c.iridRange)),
    uMatColor: matColor as unknown as NodeObject,
    uMatIridescence: matIrid as unknown as FloatUniformNode,
  };
  return swimNodeSet;
}

function pathNodesFor(uniforms: SwimUniforms): PathNodes {
  const known = pathNodesByUniforms.get(uniforms);
  if (known) return known;
  const t = tsl();
  const nodes = { uPath: vec3Path(t, uniforms.uPath), uPathUp: vec3Path(t, uniforms.uPathUp) };
  pathNodesByUniforms.set(uniforms, nodes);
  return nodes;
}

/** The eel's body is drawn along its path (uPathOn is 1 for its whole life); every other fish never is. */
const drawsAlongPath = (u: SwimUniforms): boolean => u.uAnguil.value === 1;

/** Tells fish apart in a structure key where they cannot share nodes (the eel's per-fish path buffers). */
function fishId(u: SwimUniforms): number {
  let id = fishIds.get(u);
  if (id === undefined) fishIds.set(u, id = nextFishId++);
  return id;
}
let nextFishId = 1;

/** Node builders mirroring swimShader.ts's spineH / liftY / finFlutter / pect / pathFrame. */
interface SwimCtx {
  spineH(x: NodeObject): NodeObject;
  liftY(x: NodeObject): NodeObject;
  finFlutter(p: NodeObject): NodeObject;
  pectFlex(y: NodeObject, pBend: Vec3UniformNode): NodeObject;
  pectWave(q: NodeObject, pBend: Vec3UniformNode, pWave: Vec2UniformNode): NodeObject;
  pathFrame(x: NodeObject): { P: NodeObject; T: NodeObject; U: NodeObject };
}

function swimCtx(t: Tsl, u: SwimNodes, path: PathNodes | null): SwimCtx {
  const PECT_WAVE_K = 2.6;
  return {
    spineH: (x) => {
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
    },
    liftY: (x) => {
      const d = t.max(0, x.sub(0.1));
      return u.uLift.mul(d).mul(d).mul(2.5);
    },
    finFlutter: (p) => {
      const fin = t.smoothstep(u.uFinH, u.uFinH.add(0.15), t.abs(p.y));
      return u.uFlutter.mul(fin).mul(0.018).mul(t.sin(u.uFinPhase.add(p.x.mul(14)).add(t.abs(p.y).mul(6))));
    },
    pectFlex: (y, pBend) =>
      t.float(1).sub(t.float(0.45).mul(t.clamp(y.div(t.float(0.5).mul(pBend.z)), -1, 1))),
    pectWave: (q, pBend, pWave) => {
      const r = t.length(q).div(pBend.z);
      return pWave.y.mul(pBend.z).mul(r).mul(r)
        .mul(t.sin(pWave.x.add(t.float(PECT_WAVE_K).mul(t.atan(q.y, t.max(q.x, 1e-4))))));
    },
    pathFrame: (x) => {
      const f = t.clamp(t.float(0.5).sub(x).mul(23), 0, 22.999);
      const i = t.int(t.floor(f));
      const tt = f.sub(t.float(i));
      const p1 = path!.uPath.element(i) as unknown as NodeObject;
      const p2 = path!.uPath.element(i.add(1)) as unknown as NodeObject;
      const iPrev = t.max(i.sub(1) as unknown as NodeObject, 0);
      const iNext = t.min(i.add(2) as unknown as NodeObject, PATH_POINTS - 1);
      const p0 = t.select(t.greaterThan(i, t.int(0)), path!.uPath.element(iPrev), p2.mul(2).sub(p1));
      const p3 = t.select(t.lessThan(i, t.int(PATH_POINTS - 2)), path!.uPath.element(iNext), p2.mul(2).sub(p1));
      const c1 = p2.sub(p0);
      const c2 = p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3);
      const c3 = p1.sub(p2).mul(3).add(p3).sub(p0);
      const P = p1.add(t.float(0.5).mul(tt).mul(c1.add(tt.mul(c2.add(tt.mul(c3))))));
      const T = t.negate(t.normalize(c1.add(tt.mul(c2.mul(2).add(c3.mul(3).mul(tt)))).add(t.vec3(1e-6, 0, 0))));
      const up = t.mix(path!.uPathUp.element(i) as unknown as NodeObject, path!.uPathUp.element(i.add(1)) as unknown as NodeObject, tt) as unknown as NodeObject;
      const U = t.normalize(up.sub(T.mul(t.dot(up, T))).add(t.vec3(0, 1e-6, 0)) as unknown as NodeObject);
      return { P, T, U };
    },
  };
}

/** The displaced local position for the swim wave (SWIM_GLSL's begin_vertex branch). */
function swimPositionNode(uniforms: SwimUniforms, tissue: Tissue | null = null): Node {
  const t = tsl();
  const u = swimNodes();
  const path = drawsAlongPath(uniforms) ? pathNodesFor(uniforms) : null;
  const c = swimCtx(t, u, path);

  return t.Fn(() => {
    const p0 = t.positionLocal.toVar();

    // Lower jaw shear (FISH_JAW): the chin drops as if turned about the hinge at the mouth corner.
    if (tissue?.jaw && uniforms.uGape && uniforms.uHinge) {
      const aJaw = t.attribute('aJaw', 'float');
      const a = t.negate(u.uGape.mul(aJaw));
      const dx = p0.x.sub(u.uHinge.x);
      p0.x.addAssign(dx.mul(t.cos(a).sub(1)));
      p0.y.addAssign(dx.mul(t.sin(a)));
    }

    // Erectile spines (FISH_ERECT): each spine (and its web) turns about its base.
    let erSpine: NodeObject = t.float(0);
    if (tissue?.erect && uniforms.uErect) {
      const aErect = t.attribute('aErect', 'vec4');
      const e = t.min(u.uErect, t.float(2).sub(t.float(1.8).mul(u.uFold)));
      const a = t.select(t.lessThan(e, 1) as unknown as NodeObject, aErect.z.mul(t.float(1).sub(e)), aErect.w.mul(e.sub(1)));
      const cs = t.cos(a), sn = t.sin(a);
      const d = p0.xy.sub(aErect.xy);
      erSpine = t.step(1e-5, t.abs(aErect.z));
      const nx = aErect.x.add(cs.mul(d.x).sub(sn.mul(d.y)));
      const ny = aErect.y.add(sn.mul(d.x).add(cs.mul(d.y)));
      p0.x.assign(t.mix(p0.x, nx, erSpine));
      p0.y.assign(t.mix(p0.y, ny, erSpine));
    }

    // Pectoral bending along the rays, tips trailing the stroke, plus the fan ripple (FISH_PECT).
    if (tissue?.pect && uniforms.uPBend && uniforms.uPWave) {
      const r = t.clamp(p0.x.div(u.uPBend.z), 0, 1);
      p0.z.addAssign(u.uPBend.x.mul(u.uPBend.z).mul(t.pow(r, 2)).mul(c.pectFlex(p0.y, u.uPBend)).add(c.pectWave(p0.xy, u.uPBend, u.uPWave)));
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

    const swH = c.spineH(p0.x);
    const swT = t.atan(c.spineH(p0.x.add(0.005)).sub(swH).div(0.005));
    const swC = t.cos(swT), swS = t.sin(swT);
    // Gill-cover flare (FISH_COVER): the rear of the operculum scales its lateral offset.
    const vent = tissue?.cover
      ? t.float(1).add(u.uVent.mul(1.5).mul(t.attribute('aCover', 'float')))
      : t.float(1);
    const swZ = p0.z.mul(vent).add(c.finFlutter(p0));
    if (!path) return t.vec3(p0.x.sub(swZ.mul(swS)), p0.y.add(c.liftY(p0.x)), swH.add(swZ.mul(swC)));

    // Straight body (and non-path fins) versus the moray drawn along its path (uPathOn).
    const straight = t.vec3(p0.x.sub(swZ.mul(swS)), p0.y.add(c.liftY(p0.x)), swH.add(swZ.mul(swC)));
    const frame = c.pathFrame(p0.x);
    const xc = t.clamp(p0.x, -0.5, 0.5);
    const pathP = frame.P
      .add(frame.T.mul(p0.x.sub(xc)))
      .add(frame.U.mul(p0.y))
      .add(t.cross(frame.T, frame.U).mul(swZ));
    return t.select(t.greaterThan(u.uPathOn, 0.5), pathP, straight);
  })();
}

/** The bend-corrected normal (SWIM_GLSL's beginnormal_vertex branch): the same jaw shear / erectile-spine
 *  / pectoral / spine / path transforms applied to the authored object normal, then to view space with the
 *  tangent-space normal map perturbed about the bent normal (the same derivative method three uses, but
 *  around the bent geometric normal instead of the rest-pose one). The result is faceDirection-flipped by
 *  the material's transformedNormalView, matching how the stock normal node behaves. */
function swimNormalNode(uniforms: SwimUniforms, tissue: Tissue | null, params: THREE.MeshPhysicalMaterialParameters): Node {
  const t = tsl();
  const u = swimNodes();
  const path = drawsAlongPath(uniforms) ? pathNodesFor(uniforms) : null;
  const c = swimCtx(t, u, path);
  const normalMapTex = params.normalMap ?? null;
  const normalScale = u.uNormalScale;

  // three's perturbNormal2Arb, but with a caller-supplied surface normal (the bent one).
  const perturbNormal2Arb = t.Fn(([eyePos, surfNorm, mapN]: [NodeObject, NodeObject, NodeObject]) => {
    const q0 = eyePos.dFdx();
    const q1 = eyePos.dFdy();
    const st0 = t.uv().dFdx();
    const st1 = t.uv().dFdy();
    const N = surfNorm;
    const q1perp = q1.cross(N);
    const q0perp = N.cross(q0);
    const T = q1perp.mul(st0.x).add(q0perp.mul(st1.x));
    const B = q1perp.mul(st0.y).add(q0perp.mul(st1.y));
    const det = T.dot(T).max(B.dot(B));
    const scale = t.faceDirection.mul(det.inverseSqrt());
    return T.mul(mapN.x).mul(scale).add(B.mul(mapN.y).mul(scale)).add(N.mul(mapN.z)).normalize();
  });

  return t.Fn(() => {
    const rest = t.positionGeometry;   // the rest-pose position (positionLocal has been displaced)
    const n = t.normalLocal.toVar();

    // Lower jaw shear: the inverse transpose of the shear applied to the chin.
    if (tissue?.jaw && uniforms.uGape && uniforms.uHinge) {
      const aJaw = t.attribute('aJaw', 'float');
      const aJawG = t.attribute('aJawG', 'float');
      const a = t.negate(u.uGape.mul(aJaw));
      const k = u.uGape.mul(aJawG);
      const dx = rest.x.sub(u.uHinge.x);
      const dEx = t.cos(a).sub(1).add(dx.mul(t.sin(a)).mul(k));
      const dDy = t.sin(a).sub(dx.mul(t.cos(a)).mul(k));
      n.x.assign(n.x.sub(dDy.mul(n.y)).div(t.float(1).add(dEx)));
    }

    // Erectile spines: the normal turns with its spine about the base.
    if (tissue?.erect && uniforms.uErect) {
      const aErect = t.attribute('aErect', 'vec4');
      const e = t.min(u.uErect, t.float(2).sub(t.float(1.8).mul(u.uFold)));
      const a = t.select(t.lessThan(e, 1) as unknown as NodeObject, aErect.z.mul(t.float(1).sub(e)), aErect.w.mul(e.sub(1)));
      const cs = t.cos(a), sn = t.sin(a);
      const nx = cs.mul(n.x).sub(sn.mul(n.y));
      const ny = sn.mul(n.x).add(cs.mul(n.y));
      n.x.assign(nx);
      n.y.assign(ny);
    }

    // Pectoral bending + ripple: tilt the normal by the derivatives of the z offset.
    if (tissue?.pect && uniforms.uPBend && uniforms.uPWave) {
      const r = t.clamp(rest.x.div(u.uPBend.z), 0, 1);
      const dzdx = t.float(2).mul(u.uPBend.x).mul(r).mul(c.pectFlex(rest.y, u.uPBend));
      const dzdy = t.select(
        t.lessThan(t.abs(rest.y), t.float(0.5).mul(u.uPBend.z)) as unknown as NodeObject,
        t.negate(t.float(0.9).mul(u.uPBend.x).mul(r).mul(r)),
        t.float(0),
      );
      n.x.assign(n.x.sub(dzdx.mul(n.z)));
      n.y.assign(n.y.sub(dzdy.mul(n.z)));
      const E = t.float(0.002);
      const wx = c.pectWave(t.vec2(rest.x.add(E), rest.y), u.uPBend, u.uPWave)
        .sub(c.pectWave(t.vec2(rest.x.sub(E), rest.y), u.uPBend, u.uPWave)).div(E.mul(2));
      const wy = c.pectWave(t.vec2(rest.x, rest.y.add(E)), u.uPBend, u.uPWave)
        .sub(c.pectWave(t.vec2(rest.x, rest.y.sub(E)), u.uPBend, u.uPWave)).div(E.mul(2));
      n.x.assign(n.x.sub(wx.mul(n.z)));
      n.y.assign(n.y.sub(wy.mul(n.z)));
    }

    // The cross-section turns to the spine tangent (or into the path's frame for the moray).
    const swH = c.spineH(rest.x);
    const swT = t.atan(c.spineH(rest.x.add(0.005)).sub(swH).div(0.005));
    const swC = t.cos(swT), swS = t.sin(swT);
    const straightN = t.vec3(n.x.mul(swC).sub(n.z.mul(swS)), n.y, n.x.mul(swS).add(n.z.mul(swC)));
    let bent: NodeObject = straightN;
    if (path) {
      const frame = c.pathFrame(rest.x);
      const paS = t.cross(frame.T, frame.U);
      const pathN = frame.T.mul(n.x).add(frame.U.mul(n.y)).add(paS.mul(n.z));
      bent = t.select(t.greaterThan(u.uPathOn, 0.5), pathN, straightN);
    }

    const viewN = t.transformNormalToView(bent).normalize();

    if (normalMapTex) {
      const mapN = t.texture(normalMapTex).rgb.mul(2).sub(1);
      const scaled = t.vec3(mapN.x.mul(normalScale.x), mapN.y.mul(normalScale.y), mapN.z);
      const perturbed = perturbNormal2Arb(t.positionView, viewN, scaled);
      // NORMAL_EDGE_FADE (swimShader.ts): fade the map detail towards the geometric normal at grazing,
      // where a silhouette pixel covers a long swath of the map and one minified texel's tilt would
      // otherwise be a lone glint on the rim.
      const nv = perturbed.dot(t.positionViewDirection).saturate();
      return t.mix(viewN, perturbed, t.smoothstep(t.float(0), t.float(0.35), nv)).normalize();
    }
    return viewN;
  })();
}

/** The fish's light-transport + specAA lighting model: TISSUE_GLSL's Beer-Lambert transmission and
 *  wrapped diffusion are added to each directional light before the stock Lambert + GGX; specular
 *  anti-aliasing widens the roughness by the perturbed-normal variance (Tokuyoshi & Kaplanyan 2019),
 *  matching the GLSL patch after lights_physical_fragment. */
function fishLightingModel(t: Tsl, wg: Webgpu, tissue: Tissue | null, u: SwimNodes): InstanceType<Webgpu['PhysicalLightingModel']> {
  const body = tissue?.kind === 'body';
  const sigma = tissue ? (body ? t.vec3(0.38, 0.8, 1.05) : t.vec3(0.9, 1.4, 1.8)) : null;
  const wrap = tissue ? (body ? t.vec3(0.45, 0.22, 0.14) : t.vec3(0, 0, 0)) : null;
  let thick: NodeObject | null = null;
  if (tissue) {
    if (body) {
      thick = t.attribute('aThick', 'float').mul(u.uSizeMM);
    } else if (tissue.thickMap) {
      // The fin's data map: R holds ray thickness, so the rays read ~4x the membrane (read through the
      // roughness map's sampler, not a unit of its own).
      thick = u.uThickMM.mul(t.mix(t.float(1), t.float(4), t.texture(tissue.thickMap).r));
    } else {
      thick = u.uThickMM;
    }
  }

  class FishLightingModel extends wg.PhysicalLightingModel {
    /** The grazing specular guard's fade factor (swimShader.ts opaque_fragment patch). */
    private specularCover(): NodeObject {
      const nvG = t.normalView.dot(t.positionViewDirection).saturate();
      return t.smoothstep(t.float(0), t.float(0.15), nvG);
    }

    override direct(input: LightingModelDirectInput, builder: NodeBuilder): void {
      if (tissue && sigma && wrap && thick) {
        const L = input.lightDirection as unknown as NodeObject;
        const lc = input.lightColor as unknown as NodeObject;
        const Nn = t.normalView;
        // Beer-Lambert transmission: red survives furthest, so thin parts glow warm when backlit.
        const Tt = t.exp(sigma.mul(thick).negate());
        const alb = t.diffuseColor.rgb;
        // White skin is a leucophore layer that scatters light back first: a fifth of the tissue glow.
        const leu = t.float(1).sub(t.float(0.8).mul(t.smoothstep(t.float(0.55), t.float(0.85), t.min(alb.r, t.min(alb.g, alb.b)))));
        const TtLeu = Tt.mul(leu);
        const ndl = Nn.dot(L);
        const back = ndl.negate().saturate();
        const lobe = t.positionViewDirection.dot(L.negate()).saturate().pow(6);
        const irr = lc.div(Math.PI);
        const d = input.reflectedLight.directDiffuse as unknown as NodeObject;
        // Grazing fade on the transmission lobe, matching TISSUE_GLSL's transCover.
        const transCover = t.smoothstep(t.float(0), t.float(0.15), Nn.dot(t.positionViewDirection).saturate());
        d.addAssign(alb.mul(TtLeu).mul(irr).mul(back).mul(t.float(1).add(t.float(2.5).mul(lobe))).mul(transCover));
        // Wrapped Lambert: only the light past the terminator (wider for red), softened under the skin.
        const wrapped = t.vec3(ndl).add(wrap).div(wrap.add(1)).saturate().sub(ndl.saturate()).max(0);
        d.addAssign(alb.mul(irr).mul(wrapped).mul(leu));
      }
      super.direct(input, builder);
      // Grazing specular guard: a silhouette pixel spans a long arc, so fade the main GGX lobe over the
      // outermost sliver (body highlights and scale detail at NdotV > 0.15 are untouched).
      (input.reflectedLight.directSpecular as unknown as NodeObject).mulAssign(this.specularCover());
    }

    override indirect(builder: NodeBuilder): void {
      super.indirect(builder);
      // The same grazing fade on the IBL lobe (a scalar multiply, so it commutes with the reef light's
      // later rlSky scaling of indirectSpecular).
      const reflected = (builder.context as unknown as { reflectedLight: { indirectSpecular: NodeObject } }).reflectedLight;
      reflected.indirectSpecular.mulAssign(this.specularCover());
    }

    override finish(builder: NodeBuilder): void {
      super.finish(builder);
      // swimShader.ts's opaque_fragment patch also guards against NaN/Inf and clamps the fish's outgoing
      // radiance to HDR_CLAMP, so one overbright texel (a rim firefly or an isolated normal-map peak)
      // cannot reach the shaft/motion-blur composite and bloom into a white speck.
      const out = (builder.context as unknown as { outgoingLight: NodeObject }).outgoingLight;
      const finite = (c: NodeObject): NodeObject =>
        t.select(c.equal(c).and(c.abs().lessThanEqual(t.float(1e20))), c, t.float(0));
      out.assign(t.vec3(finite(out.x), finite(out.y), finite(out.z)).max(t.vec3(0)).min(t.vec3(HDR_CLAMP)));
    }
  }
  return new FishLightingModel();
}

/** A MeshPhysicalNodeMaterial with the swim vertex wave, bend-corrected normals, tissue light transport
 *  and specular AA, from the same parameters as the WebGL path. */
export function makeSwimNodeMaterial(
  params: THREE.MeshPhysicalMaterialParameters,
  uniforms: SwimUniforms,
  tissue: Tissue | null = null,
  gaze = false,
): InstanceType<Webgpu['MeshPhysicalNodeMaterial']> {
  const t = tsl();
  const wg = webgpu();
  const anisotropic = (params.anisotropy as number | undefined) !== 0;
  const nodes = swimNodes();
  // Everything that shapes this material's node graph or lighting model. Materials with the same key share
  // their nodes (and so one compiled program); a texture a node samples is part of the key because that
  // node is bound to it. Textures read through the material's own slots (map, roughnessMap...) are not.
  const texId = (x: THREE.Texture | null | undefined): string => x?.uuid ?? '-';
  const structure = [
    tissue ? JSON.stringify({ k: tissue.kind, m: texId(tissue.thickMap), j: !!tissue.jaw, c: !!tissue.cover, n: tissue.night ?? null, p: !!tissue.packed, e: !!tissue.erect, f: !!tissue.pect }) : 'none',
    gaze ? `gaze:${texId(params.map)}` : '-',
    texId(params.normalMap),
    params.iridescenceMap && (gaze || tissue?.packed) ? texId(params.iridescenceMap) : '-',
    params.roughnessMap && tissue?.packed ? texId(params.roughnessMap) : '-',
    [uniforms.uGape && uniforms.uHinge, uniforms.uErect, uniforms.uPBend && uniforms.uPWave, uniforms.uNight, uniforms.uGaze].map((o) => (o ? 1 : 0)).join(''),
    anisotropic ? 'aniso' : '-',
    drawsAlongPath(uniforms) ? `eel${fishId(uniforms)}` : '-',
  ].join('|');
  class SwimNodeMaterial extends wg.MeshPhysicalNodeMaterial {
    constructor(p: object) {
      super(p);
    }

    override customProgramCacheKey(): string {
      return super.customProgramCacheKey() + '|swim' + structure;
    }

    override setupLightingModel(): InstanceType<Webgpu['PhysicalLightingModel']> {
      return fishLightingModel(t, wg, tissue, nodes);
    }

    override setupVariants(builder: NodeBuilder): void {
      // The night (and stress) colour patch acts on the standard diffuse colour (colour x map), so it
      // needs no node bound to this material.
      if (tissue?.night && uniforms.uNight) nightColourPatch(t, nodes.uNight, tissue.night);
      super.setupVariants(builder);
      // Specular anti-aliasing (swimShader.ts lights_physical_fragment patch): widen the lobe by the
      // pixel footprint's normal variance, plus a grazing variance that only grows below NdotV ~0.4,
      // where the lobe is under-sampled and one pixel can catch the whole specular line.
      const N = t.normalView;
      const ndx = N.dFdx(), ndy = N.dFdy();
      const nvA = N.dot(t.positionViewDirection).saturate();
      const graze = t.float(1).sub(nvA);
      const nVar = ndx.dot(ndx).add(ndy.dot(ndy))
        .add(t.float(0.35).mul(graze).mul(graze).mul(graze).mul(graze))
        .min(0.5);
      const r = t.roughness.toVar('specAaRoughness');
      t.roughness.assign(t.sqrt(r.mul(r).add(nVar)).min(1));
      if (anisotropic) {
        // The anisotropy lobe was computed above from the unwidened roughness; rebuild it (GLSL's
        // USE_ANISOTROPY branch of the same patch).
        t.alphaT.assign(t.mix(t.pow(t.roughness, 2), t.float(1), t.pow(t.anisotropy, 2)));
      }
    }
  }

  const mat = new SwimNodeMaterial(params as object);
  mat.userData['swimUniforms'] = uniforms;   // the shared uniform nodes read these through the drawn mesh
  const iridLo = params.iridescenceThicknessMinimum, iridHi = params.iridescenceThicknessMaximum;
  mat.userData['swimConstants'] = {
    sizeMM: tissue?.sizeMM ?? 100, thickMM: tissue?.thickMM ?? 0.2,
    normalScale: params.normalScale ?? new THREE.Vector2(1, 1),
    iridLo: iridLo ?? 0, iridRange: iridLo !== undefined && iridHi !== undefined ? iridHi - iridLo : 0,
  } satisfies SwimConstants;   // per-species numbers that would otherwise be literals in the shader source
  mat.positionNode = shared(`${structure}|pos`, () => swimPositionNode(uniforms, tissue));
  mat.normalNode = shared(`${structure}|nrm`, () => swimNormalNode(uniforms, tissue, params));
  // Eye gaze (builder.ts addGaze on WebGL): the iris, pupil and iridophore ring slide across the cap.
  // The eyeSide attribute (+1 right, -1 left) turns the shared gaze vector into each eye's texture shift.
  if (gaze && params.map && uniforms.uGaze) {
    const u = nodes.uGaze;
    const map = params.map, ring = params.iridescenceMap;
    const gazeUv = shared(`${structure}|gazeUv`, () => t.uv().add(t.vec2(u.x.mul(t.attribute('eyeSide', 'float')), u.y.negate())));
    mat.colorNode = shared(`${structure}|gazeColor`, () => nodes.uMatColor.mul(t.texture(map, gazeUv).rgb));
    if (ring) {
      // The ring mask modulates iridescence strength (three's GLSL iridescenceMap, shifted by the same gaze).
      mat.iridescenceNode = shared(`${structure}|gazeIrid`, () => nodes.uMatIridescence.mul(t.texture(ring, gazeUv).r));
    }
  }
  // Packed body maps' second channels (swimShader.ts's `packed`): the film thickness is the iridescence
  // map's G (three's native iridescenceMap already reads its R as the strength), and the cavity under
  // each scale's free margin is the roughness map's R, applied as ambient occlusion. Roughness itself is
  // the roughness map's G, which three's standard material already reads.
  if (tissue?.packed) {
    const lo = params.iridescenceThicknessMinimum as number | undefined;
    const hi = params.iridescenceThicknessMaximum as number | undefined;
    const iridMap = params.iridescenceMap, roughMap = params.roughnessMap;
    if (iridMap && lo !== undefined && hi !== undefined) {
      mat.iridescenceThicknessNode = shared(`${structure}|thick`, () => nodes.uIridRange.y
        .mul(t.texture(iridMap).g).add(nodes.uIridRange.x));
    }
    if (roughMap) mat.aoNode = shared(`${structure}|ao`, () => t.texture(roughMap).r);
  }
  return installReefLight(mat);
}

/** The night (and stress) colour patch from swimShader.ts, in TSL: chromatophores contract or expand
 *  over minutes at dusk, paling or darkening the fish. uNight 0..1 is written by fish.ts. It rewrites the
 *  diffuse colour the material has just set up (colour x map). */
function nightColourPatch(t: Tsl, uNight: FloatUniformNode, kind: 'pale' | 'dark'): void {
  const diffuse = t.diffuseColor as NodeObject;
  const c = diffuse.rgb.toVar();
  const l = c.dot(t.vec3(0.2126, 0.7152, 0.0722));
  const night: NodeObject = kind === 'pale'
    ? t.mix(t.vec3(l), t.vec3(t.float(0.75).add(t.float(0.2).mul(
        t.float(0.5).add(t.float(0.5).mul(t.sin(t.uv().x.mul(23).add(t.sin(t.uv().y.mul(9)).mul(2))))),
      ))), 0.45)
    : t.vec3(l).mul(0.45).add(c.mul(0.12));
  diffuse.rgb.assign(t.mix(c, night, uNight.mul(0.8)));
}

/**
 * One entry point for building a swim material on either backend. Under WebGPU the tissue/GLSL patches
 * become a node material (positionNode/normalNode + a custom lighting model); under WebGL the classic
 * onBeforeCompile swim shader is used unchanged.
 */
export function swimMaterialFor(
  params: THREE.MeshPhysicalMaterialParameters,
  uniforms: SwimUniforms,
  tissue: Tissue | null,
  gpu: boolean,
  gaze = false,
): THREE.Material {
  if (gpu) return makeSwimNodeMaterial(params, uniforms, tissue, gaze);
  return makeSwimMaterial(new THREE.MeshPhysicalMaterial(params), uniforms, tissue);
}
