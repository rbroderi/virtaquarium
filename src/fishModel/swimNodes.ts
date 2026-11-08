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
import type {
  LightingModelDirectInput, LightingModelIndirectInput, Node, NodeBuilder, ShaderNodeObject, StackNode, UniformArrayNode, UniformNode,
} from 'three/webgpu';
import { tsl, type Tsl } from '../webgpu/tsl.js';
import { installReefLight } from '../reefLight/webgpu.js';
import { makeSwimMaterial, PATH_POINTS, type SwimUniforms, type Tissue } from './swimShader.js';

type NodeObject = ShaderNodeObject<Node>;
type FloatUniformNode = ShaderNodeObject<UniformNode<number>>;
type Vec2UniformNode = ShaderNodeObject<UniformNode<THREE.Vector2>>;
type Vec3UniformNode = ShaderNodeObject<UniformNode<THREE.Vector3>>;
type PathArrayNode = ShaderNodeObject<UniformArrayNode>;

/** Brightest linear radiance a fish fragment may write, as swimShader.ts's HDR_CLAMP. */
const HDR_CLAMP = 4;

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
  uGaze: Vec2UniformNode | undefined;
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
    uGaze: uniforms.uGaze ? vec2Uniform(t, uniforms.uGaze) : undefined,
  };
  nodesByUniforms.set(uniforms, nodes);
  return nodes;
}

/** Node builders mirroring swimShader.ts's spineH / liftY / finFlutter / pect / pathFrame. */
interface SwimCtx {
  spineH(x: NodeObject): NodeObject;
  liftY(x: NodeObject): NodeObject;
  finFlutter(p: NodeObject): NodeObject;
  pectFlex(y: NodeObject, pBend: Vec3UniformNode): NodeObject;
  pectWave(q: NodeObject, pBend: Vec3UniformNode, pWave: Vec2UniformNode): NodeObject;
  pathFrame(x: NodeObject): { P: NodeObject; T: NodeObject; U: NodeObject };
}

function swimCtx(t: Tsl, u: SwimNodes): SwimCtx {
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
        .mul(t.sin(pWave.x.add(t.float(PECT_WAVE_K).mul(t.atan2(q.y, t.max(q.x, 1e-4))))));
    },
    pathFrame: (x) => {
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
    },
  };
}

/** The displaced local position for the swim wave (SWIM_GLSL's begin_vertex branch). */
export function swimPositionNode(uniforms: SwimUniforms, tissue: Tissue | null = null): Node {
  const t = tsl();
  const u = nodesFor(uniforms);
  const c = swimCtx(t, u);

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
      const cs = t.cos(a), sn = t.sin(a);
      const d = p0.xy.sub(aErect.xy);
      erSpine = t.step(1e-5, t.abs(aErect.z));
      const nx = aErect.x.add(cs.mul(d.x).sub(sn.mul(d.y)));
      const ny = aErect.y.add(sn.mul(d.x).add(cs.mul(d.y)));
      p0.x.assign(t.mix(p0.x, nx, erSpine));
      p0.y.assign(t.mix(p0.y, ny, erSpine));
    }

    // Pectoral bending along the rays, tips trailing the stroke, plus the fan ripple (FISH_PECT).
    if (tissue?.pect && u.uPBend && u.uPWave) {
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
export function swimNormalNode(uniforms: SwimUniforms, tissue: Tissue | null, params: THREE.MeshPhysicalMaterialParameters): Node {
  const t = tsl();
  const u = nodesFor(uniforms);
  const c = swimCtx(t, u);
  const normalMapTex = params.normalMap ?? null;
  const normalScale = params.normalScale ?? new THREE.Vector2(1, 1);

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
    if (tissue?.jaw && u.uGape && u.uHinge) {
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
    if (tissue?.erect && u.uErect) {
      const aErect = t.attribute('aErect', 'vec4');
      const e = t.min(u.uErect, t.float(2).sub(t.float(1.8).mul(u.uFold)));
      const a = t.select(t.lessThan(e, 1), aErect.z.mul(t.float(1).sub(e)), aErect.w.mul(e.sub(1)));
      const cs = t.cos(a), sn = t.sin(a);
      const nx = cs.mul(n.x).sub(sn.mul(n.y));
      const ny = sn.mul(n.x).add(cs.mul(n.y));
      n.x.assign(nx);
      n.y.assign(ny);
    }

    // Pectoral bending + ripple: tilt the normal by the derivatives of the z offset.
    if (tissue?.pect && u.uPBend && u.uPWave) {
      const r = t.clamp(rest.x.div(u.uPBend.z), 0, 1);
      const dzdx = t.float(2).mul(u.uPBend.x).mul(r).mul(c.pectFlex(rest.y, u.uPBend));
      const dzdy = t.select(
        t.lessThan(t.abs(rest.y), t.float(0.5).mul(u.uPBend.z)),
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
    const frame = c.pathFrame(rest.x);
    const paS = t.cross(frame.T, frame.U);
    const straightN = t.vec3(n.x.mul(swC).sub(n.z.mul(swS)), n.y, n.x.mul(swS).add(n.z.mul(swC)));
    const pathN = frame.T.mul(n.x).add(frame.U.mul(n.y)).add(paS.mul(n.z));
    const bent = t.select(t.greaterThan(u.uPathOn, 0.5), pathN, straightN);

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
function fishLightingModel(t: Tsl, tissue: Tissue | null): InstanceType<Tsl['PhysicalLightingModel']> {
  const body = tissue?.kind === 'body';
  const sigma = tissue ? (body ? t.vec3(0.38, 0.8, 1.05) : t.vec3(0.9, 1.4, 1.8)) : null;
  const wrap = tissue ? (body ? t.vec3(0.45, 0.22, 0.14) : t.vec3(0, 0, 0)) : null;
  let thick: NodeObject | null = null;
  if (tissue) {
    if (body) {
      thick = t.attribute('aThick', 'float').mul(t.float(tissue.sizeMM ?? 100));
    } else if (tissue.thickMap) {
      // The fin's data map: R holds ray thickness, so the rays read ~4x the membrane (read through the
      // roughness map's sampler, not a unit of its own).
      thick = t.float(tissue.thickMM ?? 0.2).mul(t.mix(t.float(1), t.float(4), t.texture(tissue.thickMap).r));
    } else {
      thick = t.float(tissue.thickMM ?? 0.2);
    }
  }

  class FishLightingModel extends t.PhysicalLightingModel {
    /** The grazing specular guard's fade factor (swimShader.ts opaque_fragment patch). */
    private specularCover(): NodeObject {
      const nvG = t.transformedNormalView.dot(t.positionViewDirection).saturate();
      return t.smoothstep(t.float(0), t.float(0.15), nvG);
    }

    override direct(input: LightingModelDirectInput, stack: StackNode, builder: NodeBuilder): void {
      if (tissue && sigma && wrap && thick) {
        const L = input.lightDirection as unknown as NodeObject;
        const lc = input.lightColor as unknown as NodeObject;
        const Nn = t.transformedNormalView;
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
      super.direct(input, stack, builder);
      // Grazing specular guard: a silhouette pixel spans a long arc, so fade the main GGX lobe over the
      // outermost sliver (body highlights and scale detail at NdotV > 0.15 are untouched).
      (input.reflectedLight.directSpecular as unknown as NodeObject).mulAssign(this.specularCover());
    }

    override indirect(input: LightingModelIndirectInput, stack: StackNode, builder: NodeBuilder): void {
      super.indirect(input, stack, builder);
      // The same grazing fade on the IBL lobe (a scalar multiply, so it commutes with the reef light's
      // later rlSky scaling of indirectSpecular).
      (input.reflectedLight.indirectSpecular as unknown as NodeObject).mulAssign(this.specularCover());
    }

    override finish(input: LightingModelIndirectInput, stack: StackNode, builder: NodeBuilder): void {
      super.finish(input, stack, builder);
      // swimShader.ts's opaque_fragment patch also guards against NaN/Inf and clamps the fish's outgoing
      // radiance to HDR_CLAMP, so one overbright texel (a rim firefly or an isolated normal-map peak)
      // cannot reach the shaft/motion-blur composite and bloom into a white speck.
      const out = (input as unknown as { outgoingLight: NodeObject }).outgoingLight;
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
): InstanceType<Tsl['MeshPhysicalNodeMaterial']> {
  const t = tsl();
  const anisotropic = (params.anisotropy as number | undefined) !== 0;
  class SwimNodeMaterial extends t.MeshPhysicalNodeMaterial {
    constructor(p: object) {
      super(p);
    }

    override setupLightingModel(): InstanceType<Tsl['PhysicalLightingModel']> {
      return fishLightingModel(t, tissue);
    }

    override setupVariants(builder: NodeBuilder): void {
      super.setupVariants(builder);
      // Specular anti-aliasing (swimShader.ts lights_physical_fragment patch): widen the lobe by the
      // pixel footprint's normal variance, plus a grazing variance that only grows below NdotV ~0.4,
      // where the lobe is under-sampled and one pixel can catch the whole specular line.
      const N = t.transformedNormalView;
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
  mat.positionNode = swimPositionNode(uniforms, tissue);
  mat.normalNode = swimNormalNode(uniforms, tissue, params);
  if (tissue?.night && uniforms.uNight) mat.colorNode = nightColourNode(t, nodesFor(uniforms).uNight!, tissue.night);
  // Eye gaze (builder.ts addGaze on WebGL): the iris, pupil and iridophore ring slide across the cap.
  // The eyeSide attribute (+1 right, -1 left) turns the shared gaze vector into each eye's texture shift.
  if (gaze && params.map && uniforms.uGaze) {
    const u = nodesFor(uniforms).uGaze!;
    const gazeUv = t.uv().add(t.vec2(u.x.mul(t.attribute('eyeSide', 'float')), u.y.negate()));
    mat.colorNode = t.materialReference('color', 'color').mul(t.texture(params.map, gazeUv).rgb);
    if (params.iridescenceMap) {
      // The ring mask modulates iridescence strength (three's GLSL iridescenceMap, shifted by the same gaze).
      mat.iridescenceNode = t.materialReference('iridescence', 'float').mul(t.texture(params.iridescenceMap, gazeUv).r);
    }
  }
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
  return installReefLight(mat);
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
