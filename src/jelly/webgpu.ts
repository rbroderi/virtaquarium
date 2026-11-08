// Moon jellies on the WebGPU path, in TSL (the WebGL path is jelly/shaders.ts + jelly/jelly.ts, which
// WebGPURenderer never runs). The same additive, translucent animals and the backlit blue void become
// node materials: each vertex deformation is a positionNode (the group's scale is applied after), and
// each rim/backlight colour is a fragmentNode (additive, alpha 1, exactly like gl_FragColor).
import * as THREE from 'three';
import { webgpu, type FloatUniformNode, type Node, type NodeObject, type Tsl, type Vec3UniformNode, type Webgpu } from '../webgpu/tsl.js';

type FloatNode = FloatUniformNode;
type Vec3Node = Vec3UniformNode;

/** Beam attenuation per unit (shaders.ts WATER_C: metres x METRES_PER_UNIT x 1.6 path gain). */
const WATER_C = [0.6 * 0.125 * 1.6, 0.17 * 0.125 * 1.6, 0.12 * 0.125 * 1.6] as const;
/** The light panel behind and above the tank, normalised (shaders.ts PANEL_DIR). */
const PANEL_DIR = new THREE.Vector3(0, 0.32, -0.95).normalize();

/** The live per-jelly uniforms as TSL nodes. Scalars are replaced each frame, so they are bridged. */
export interface JellyNodes {
  readonly uPulse: FloatNode;
  readonly uTrail: Vec3Node;
  readonly uR: FloatNode;
  readonly uTime: FloatNode;
  readonly uSeed: FloatNode;
  readonly uLight: FloatNode;
  readonly uTint: NodeObject;
  readonly uGonad: NodeObject;
}

/** The per-jelly uniform bag (jelly.ts JellyUniforms, written every frame). */
export interface JellyUniformBag {
  uPulse: { value: number };
  uTrail: { value: THREE.Vector3 };
  uR: { value: number };
  uTime: { value: number };
  uSeed: { value: number };
  uLight: { value: number };
  uTint: { value: THREE.Color };
  uGonad: { value: THREE.Color };
  [name: string]: THREE.IUniform;
}

function bridgeScalar(entry: { value: number }, node: FloatNode): void {
  Object.defineProperty(entry, 'value', {
    get: (): number => node.value,
    set: (v: number): void => { node.value = v; },
    configurable: true, enumerable: true,
  });
}

/** Bridges a Jelly's uniform bag to TSL nodes (jelly.ts writes them identically on both backends). */
export function jellyNodes(t: Tsl, u: JellyUniformBag): JellyNodes {
  const uPulse = t.uniform(u.uPulse.value);
  bridgeScalar(u.uPulse, uPulse);
  const uR = t.uniform(u.uR.value);
  bridgeScalar(u.uR, uR);
  const uTime = t.uniform(u.uTime.value);
  bridgeScalar(u.uTime, uTime);
  const uSeed = t.uniform(u.uSeed.value);
  bridgeScalar(u.uSeed, uSeed);
  const uLight = t.uniform(u.uLight.value);
  bridgeScalar(u.uLight, uLight);
  return {
    uPulse, uR, uTime, uSeed, uLight,
    uTrail: t.uniform(u.uTrail.value),
    uTint: t.uniform(u.uTint.value),
    uGonad: t.uniform(u.uGonad.value),
  };
}

/** Bell margin under contraction (shaders.ts bellShape). */
function bellShapeFn(t: Tsl, n: JellyNodes): (r: NodeObject, y: NodeObject, s: NodeObject) => NodeObject {
  return t.Fn(([r, y, s]: [NodeObject, NodeObject, NodeObject]) => {
    const c = n.uPulse.mul(s.pow(t.float(1.5)));
    const curl = n.uPulse.max(t.float(0)).mul(t.smoothstep(t.float(0.8), t.float(1), s));
    return t.vec2(
      r.mul(t.float(1).sub(t.float(0.3).mul(c)).sub(t.float(0.1).mul(curl))),
      y.add(n.uR.mul(t.float(-0.05).mul(c).sub(t.float(0.04).mul(curl)).add(t.float(0.04).mul(n.uPulse).mul(t.float(1).sub(s))))),
    );
  });
}

/** The notched, lappeted margin (shaders.ts marginCut). */
function marginCutFn(t: Tsl): (a: NodeObject, s: NodeObject) => NodeObject {
  return t.Fn(([a, s]: [NodeObject, NodeObject]) => {
    const m = t.smoothstep(t.float(0.82), t.float(1), s);
    const q = t.fract(a.mul(t.float(8)));
    const notch = t.exp(t.min(q, t.float(1).sub(q)).div(t.float(0.035)).pow(2).negate());
    const lappet = t.sin(q.mul(t.float(6.2831853))).abs();
    return t.float(1).sub(m.mul(t.float(0.07).mul(notch).sub(t.float(0.018).mul(lappet)).add(t.float(0.012))));
  });
}

/** Light through the jelly from the panel behind and above (shaders.ts throughLight). */
function throughLightFn(t: Tsl): (V: NodeObject) => NodeObject {
  const panel = t.vec3(PANEL_DIR.x, PANEL_DIR.y, PANEL_DIR.z);
  return t.Fn(([V]: [NodeObject]) => V.negate().dot(panel).clamp(t.float(0), t.float(1)).pow(4));
}

/** Water between the jelly and the eye: blue survives longest (shaders.ts waterFade). */
function waterFadeFn(t: Tsl): (col: NodeObject, dist: NodeObject) => NodeObject {
  const C = t.vec3(WATER_C[0], WATER_C[1], WATER_C[2]);
  return t.Fn(([col, dist]: [NodeObject, NodeObject]) => col.mul(t.exp(C.mul(dist).negate())));
}

/** A thin line at a repeating phase (shaders.ts BELL_FRAG line). */
function lineFn(t: Tsl): (x: NodeObject, w: NodeObject) => NodeObject {
  return t.Fn(([x, w]: [NodeObject, NodeObject]) =>
    t.float(1).sub(t.smoothstep(t.float(0), w, t.fract(x).sub(t.float(0.5)).abs().mul(t.float(2)))));
}

const ADDITIVE = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false } as const;

/** The bell's local-space deformation (shaders.ts BELL_VERT): contraction, curl, lens offset, wobble. */
function bellPositionNode(t: Tsl, n: JellyNodes, uInner: number): Node {
  const bellShape = bellShapeFn(t, n);
  const marginCut = marginCutFn(t);
  return t.Fn(() => {
    const pos = t.positionLocal as unknown as NodeObject;
    const nrm = t.normalLocal as unknown as NodeObject;
    const uv = t.uv() as unknown as NodeObject;
    const s = uv.y;
    const r = t.length(pos.xz);
    const rs = bellShape(r, pos.y, s).toVar() as NodeObject;
    const dxz = t.select(r.greaterThan(t.float(1e-5)), pos.xz.div(r), t.vec2(0)) as NodeObject;
    const a = uv.x.mul(t.float(6.2831853));
    rs.x.assign(rs.x.mul(marginCut(uv.x, s)));
    rs.y.assign(rs.y.add(n.uR.mul(t.float(0.035)).mul(t.smoothstep(t.float(0.85), t.float(1), s))
      .mul(t.float(1).sub(marginCut(uv.x, s))).mul(t.float(10))));
    const p = t.vec3(dxz.x.mul(rs.x), rs.y, dxz.y.mul(rs.x)).toVar();
    const th = n.uR.mul(t.float(0.2)).mul(t.float(1).sub(s).pow(t.float(1.6))).mul(t.float(1).sub(t.float(0.25).mul(n.uPulse)));
    p.subAssign(nrm.mul(th).mul(t.float(uInner)));
    p.xz.assign(p.xz.mul(t.float(1).add(t.float(0.025).mul(t.sin(a.mul(t.float(3)).add(n.uSeed))).mul(s))));
    return p;
  })();
}

/** The bell's additive colour (shaders.ts BELL_FRAG): the outer surface, or the subumbrella (inner = 1). */
function bellFragmentNode(t: Tsl, n: JellyNodes, uInner: number): Node {
  const throughLight = throughLightFn(t);
  const waterFade = waterFadeFn(t);
  const line = lineFn(t);
  return t.Fn(() => {
    const uv = t.uv() as unknown as NodeObject;
    // World-space view vector (shaders.ts vView = cameraPosition - w): the normal is world-space too.
    const V = t.cameraPosition.sub(t.positionWorld).normalize() as unknown as NodeObject;
    const N = t.normalLocal.transformDirection(t.modelWorldMatrix).normalize() as unknown as NodeObject;
    const dist = t.length(t.positionView) as unknown as NodeObject;
    const s = uv.y, a = uv.x;
    // pow() of a negative base is NaN in WGSL; |N.V| can exceed 1 by an ulp where the dome faces the
    // eye, which painted the whole subumbrella black under additive blending.
    const f = t.float(1).sub(N.dot(V).abs()).clamp(t.float(0), t.float(1)).pow(t.float(2.2));
    if (uInner === 1) {
      const col = n.uTint.mul(t.float(0.35).mul(f).add(t.float(0.12).mul(throughLight(V)).mul(t.float(1).sub(s))));
      return t.vec4(waterFade(col, dist).mul(n.uLight), 1);
    }
    // Rhopalia: bright points in each notch, just inside the margin. Never use pow() to square a
    // signed value here: WGSL pow(negative, 2.0) is NaN, which under additive blending paints the
    // whole bell black (s - 0.965 is negative over almost all of it).
    const qn = t.fract(a.mul(t.float(8)));
    const qnIn = t.min(qn, t.float(1).sub(qn)).div(t.float(0.012));
    const sOut = s.sub(t.float(0.965)).div(t.float(0.012));
    const rho = t.exp(qnIn.mul(qnIn).negate()).mul(t.exp(sOut.mul(sOut).negate()));
    // Radial canals and the ring canal.
    const canal = line(a.mul(t.float(16)), t.float(0.06)).mul(t.smoothstep(t.float(0.15), t.float(0.3), s))
      .add(line(a.mul(t.float(32)).add(t.float(0.5)), t.float(0.05)).mul(t.smoothstep(t.float(0.55), t.float(0.8), s)).mul(t.float(0.8)));
    const ring = t.smoothstep(t.float(0.93), t.float(0.985), s).mul(t.float(1).sub(t.smoothstep(t.float(0.985), t.float(1), s)));
    // Four horseshoe gonads around the centre, open towards the margin.
    const q = s.mul(t.vec2(t.cos(a.mul(t.float(6.2831853))), t.sin(a.mul(t.float(6.2831853)))));
    const g = t.float(0).toVar();
    t.Loop(4, ({ i }: { i: NodeObject }) => {
      const k = t.float(i);
      const ang = k.add(t.float(0.5)).mul(t.float(1.5707963)).add(t.float(0.15).mul(t.sin(n.uSeed.add(k))));
      const dir = t.vec2(t.cos(ang), t.sin(ang));
      const d = q.sub(dir.mul(t.float(0.27)));
      const rr = t.length(d);
      const open = d.add(t.float(1e-5)).normalize().dot(dir);
      g.addAssign(t.float(1).sub(t.smoothstep(t.float(0.015), t.float(0.06), rr.sub(t.float(0.11)).abs()))
        .mul(t.float(1).sub(t.smoothstep(t.float(0.2), t.float(0.8), open))).mul(t.float(0.75)));
    });
    const top = t.float(0.75).add(t.float(0.25).mul(N.y));
    const col = n.uTint.mul(t.float(0.1).add(t.float(0.8).mul(f)).add(t.float(0.14).mul(canal)).add(t.float(0.6).mul(ring)).add(t.float(0.9).mul(rho))).mul(top)
      .add(n.uGonad.mul(g).mul(t.float(0.45).add(t.float(0.4).mul(f))))
      .add(n.uTint.mul(t.float(0.5)).add(n.uGonad.mul(g).mul(t.float(0.6))).mul(throughLight(V)).mul(t.float(0.15).add(t.float(0.35).mul(t.float(1).sub(s)))));
    return t.vec4(waterFade(col, dist).mul(n.uLight), 1);
  })();
}

/** The tentacle's local-space deformation (shaders.ts TENT_VERT). */
function tentPositionNode(t: Tsl, n: JellyNodes): Node {
  const bellShape = bellShapeFn(t, n);
  return t.Fn(() => {
    const aAng = t.attribute('aAng', 'float') as unknown as NodeObject;
    const aS = t.attribute('aS', 'float') as unknown as NodeObject;
    const aLen = t.attribute('aLen', 'float') as unknown as NodeObject;
    const rim = bellShape(n.uR.mul(t.float(1)), n.uR.mul(t.float(-0.05)), t.float(1));
    const a = aAng.mul(t.float(6.2831853));
    const dir = t.vec3(t.cos(a), t.float(0), t.sin(a));
    const L = aLen.mul(n.uR);
    const sweep = t.float(0.35).add(t.float(0.5).mul(n.uPulse));
    return dir.mul(rim.x).add(t.vec3(0, rim.y, 0))
      .add(dir.mul(sweep).mul(aS).sub(t.vec3(0, aS, 0)).mul(L))
      .add(t.vec3(t.sin(n.uTime.mul(t.float(0.7)).add(a.mul(t.float(5))).add(n.uSeed)), t.float(0),
        t.cos(n.uTime.mul(t.float(0.6)).add(a.mul(t.float(4))))).mul(t.float(0.08)).mul(L).mul(aS).mul(aS))
      .add(n.uTrail.mul(L).mul(aS).mul(aS));
  })();
}

/** The tentacle's additive colour (shaders.ts TENT_FRAG). */
function tentFragmentNode(t: Tsl, n: JellyNodes): Node {
  const waterFade = waterFadeFn(t);
  return t.Fn(() => {
    const aS = t.attribute('aS', 'float') as unknown as NodeObject;
    const dist = t.length(t.positionView) as unknown as NodeObject;
    const col = n.uTint.mul(t.float(0.22)).mul(t.float(1).sub(t.float(0.7).mul(aS)));
    return t.vec4(waterFade(col, dist).mul(n.uLight), 1);
  })();
}

/** The oral arm's local-space deformation (shaders.ts ARM_VERT). */
function armPositionNode(t: Tsl, n: JellyNodes): Node {
  return t.Fn(() => {
    const aArm = t.attribute('aArm', 'float') as unknown as NodeObject;
    const uv = t.uv() as unknown as NodeObject;
    const s = uv.y, x = uv.x.mul(t.float(2)).sub(t.float(1));
    const vEdge = x.abs();
    const a = aArm.add(t.float(0.5)).mul(t.float(1.5707963)).add(t.float(0.7854));
    const out = t.vec3(t.cos(a), t.float(0), t.sin(a));
    const side = t.vec3(out.z.negate(), t.float(0), out.x);
    const L = n.uR.mul(t.float(1.3));
    const w = n.uR.mul(t.float(0.24)).mul(t.float(1).sub(t.float(0.55).mul(s)))
      .mul(t.float(0.75).add(t.float(0.25).mul(t.smoothstep(t.float(0), t.float(0.15), s))));
    const ruffle = t.sin(s.mul(t.float(11)).add(x.mul(t.float(1.5))).add(aArm.mul(t.float(1.7)))).mul(vEdge).mul(vEdge);
    const e = vEdge.sub(t.float(0.65)).div(t.float(0.35)).clamp(t.float(0), t.float(1));
    const phi = e.mul(t.float(3.4)), Rr = t.float(0.35).mul(w).div(t.float(3.4));
    const lat = vEdge.min(t.float(0.65)).mul(w).add(Rr.mul(t.sin(phi)));
    const lift = Rr.mul(t.float(1).sub(t.cos(phi)));
    const frill = t.sin(s.mul(t.float(58)).add(aArm.mul(t.float(3.1))).add(t.sign(x).mul(t.float(1.3)))).mul(e).mul(e).mul(t.float(0.16)).mul(w);
    const p = t.vec3(0, n.uR.mul(t.float(-0.02)), 0)
      .add(out.mul(n.uR.mul(t.float(0.06)).add(s.mul(L).mul(t.float(0.15)))))
      .add(side.mul(t.sign(x)).mul(lat.add(frill.mul(t.float(0.4)))))
      .add(t.vec3(0, s.mul(L).negate(), 0))
      .add(out.mul(ruffle.mul(t.float(0.45)).mul(w).add(vEdge.min(t.float(0.65)).mul(t.float(0.6)).mul(w)).add(lift).add(frill)))
      .add(t.vec3(t.sin(n.uTime.mul(t.float(0.5)).add(aArm.mul(t.float(2.1))).add(n.uSeed)), t.float(0),
        t.cos(n.uTime.mul(t.float(0.43)).add(aArm))).mul(t.float(0.12)).mul(L).mul(s).mul(s)).toVar();
    p.y.addAssign(n.uPulse.mul(t.float(0.06)).mul(n.uR).mul(t.float(1).sub(s)));
    p.addAssign(n.uTrail.mul(L).mul(s).mul(s));
    return p;
  })();
}

/** The oral arm's additive colour (shaders.ts ARM_FRAG). */
function armFragmentNode(t: Tsl, n: JellyNodes): Node {
  const throughLight = throughLightFn(t);
  const waterFade = waterFadeFn(t);
  return t.Fn(() => {
    const uv = t.uv() as unknown as NodeObject;
    const s = uv.y, x = uv.x.mul(t.float(2)).sub(t.float(1));
    const vEdge = x.abs();
    const dist = t.length(t.positionView) as unknown as NodeObject;
    const V = t.cameraPosition.sub(t.positionWorld).normalize() as unknown as NodeObject;
    const frill = t.smoothstep(t.float(0.7), t.float(1), vEdge).mul(t.float(0.7).add(t.float(0.3).mul(t.sin(s.mul(t.float(140))))));
    const col = n.uTint.mul(t.float(0.05).add(t.float(0.26).mul(frill)).add(t.float(0.08).mul(throughLight(V))))
      .mul(t.float(1).sub(t.float(0.6).mul(s)));
    return t.vec4(waterFade(col, dist).mul(n.uLight), 1);
  })();
}

/** Builds the five additive node materials for one jelly (bell, subumbrella, tentacles, four arms). */
export function makeGpuJellyMaterials(t: Tsl, u: JellyUniformBag): {
  readonly bell: InstanceType<Webgpu['NodeMaterial']>;
  readonly sub: InstanceType<Webgpu['NodeMaterial']>;
  readonly tent: InstanceType<Webgpu['NodeMaterial']>;
  readonly arms: InstanceType<Webgpu['NodeMaterial']>;
} {
  const wg = webgpu();
  const n = jellyNodes(t, u);
  const mat = (positionNode: Node, fragmentNode: Node): InstanceType<Webgpu['NodeMaterial']> => {
    const m = new wg.NodeMaterial();
    m.positionNode = positionNode;
    m.fragmentNode = fragmentNode;
    Object.assign(m, ADDITIVE);
    return m;
  };
  return {
    bell: mat(bellPositionNode(t, n, 0), bellFragmentNode(t, n, 0)),
    sub: mat(bellPositionNode(t, n, 1), bellFragmentNode(t, n, 1)),
    tent: mat(tentPositionNode(t, n), tentFragmentNode(t, n)),
    arms: mat(armPositionNode(t, n), armFragmentNode(t, n)),
  };
}

/** The jelly tank's backdrop: a light panel behind and above, falling off to navy (shaders.ts). */
export function makeGpuJellyBackdrop(t: Tsl): THREE.Mesh<THREE.SphereGeometry, InstanceType<Webgpu['NodeMaterial']>> {
  const wg = webgpu();
  const uLight = t.uniform(1);
  const uniforms = { uBase: { value: new THREE.Color(1, 1, 1) }, uLight: { value: 1 } };
  Object.defineProperty(uniforms.uLight, 'value', {
    get: (): number => uLight.value,
    set: (v: number): void => { uLight.value = v; },
    configurable: true, enumerable: true,
  });
  const mat = new wg.NodeMaterial();
  mat.fragmentNode = t.Fn(() => {
    // d points from the eye to the dome (shaders.ts: normalize(vW - cameraPosition)), so the glow sits
    // behind and above the tank rather than mirrored and below.
    const d = t.positionWorld.sub(t.cameraPosition).normalize() as unknown as NodeObject;
    const glow = t.exp(t.length(t.vec2(d.x.mul(t.float(1.1)), d.y.sub(t.float(0.12)))).div(t.float(0.42)).pow(2).negate());
    const halo = t.exp(t.length(t.vec2(d.x.mul(t.float(0.8)), d.y.sub(t.float(0.05)))).div(t.float(0.9)).pow(2).negate());
    const col = t.vec3(0.006, 0.13, 0.75).mul(glow).add(t.vec3(0, 0.025, 0.16).mul(halo)).add(t.vec3(0, 0.003, 0.016));
    return t.vec4(col.mul(uLight), 1);
  })();
  Object.assign(mat, { side: THREE.BackSide, depthWrite: false, fog: false });
  (mat as unknown as { uniforms: typeof uniforms }).uniforms = uniforms;
  const backdrop = new THREE.Mesh(new THREE.SphereGeometry(90, 48, 24), mat);
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -1;
  return backdrop;
}
