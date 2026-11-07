// Live screen-space ambient occlusion on the WebGPU path, in TSL (the WebGL path is
// src/reefLight/screenAO.ts, a ShaderMaterial WebGPURenderer never runs). Hemisphere AO from the scene
// pass's depth at half resolution with a depth-aware blur, published to reefLightUniforms.uRLAO for the
// baked reef light's ambient term (reefLight/webgpu.ts) to read next frame — the same split as WebGL.
import * as THREE from 'three';
import type { Node, ShaderNodeObject, UniformNode } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { tsl } from '../webgpu/tsl.js';
import { reefLightUniforms } from '../reefLight/uniforms.js';

type NodeObject = ShaderNodeObject<Node>;
/** A texture node we re-sample at a custom uv and whose value can be swapped between passes. */
type AoSamplerNode = NodeObject & { uv(uv: NodeObject): NodeObject; value: THREE.Texture };

const DEFAULT_RADIUS = 0.3;
const DEFAULT_STRENGTH = 0.65;
const RESOLUTION_DIVISOR = 2;
const K = 12;

export interface WebGpuScreenAOOptions { readonly radius?: number; readonly strength?: number }

export class WebGpuScreenAO {
  private readonly targets: readonly [THREE.RenderTarget, THREE.RenderTarget];
  private readonly ao: THREE.Scene;
  private readonly blur: THREE.Scene;
  private readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly uTexel: ShaderNodeObject<UniformNode<THREE.Vector2>>;
  private readonly uStep: ShaderNodeObject<UniformNode<THREE.Vector2>>;
  private readonly uProj: ShaderNodeObject<UniformNode<THREE.Matrix4>>;
  private readonly uProjInv: ShaderNodeObject<UniformNode<THREE.Matrix4>>;
  private readonly uNear: ShaderNodeObject<UniformNode<number>>;
  private readonly uFar: ShaderNodeObject<UniformNode<number>>;
  private readonly aoTexture: AoSamplerNode;
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: WebGPURenderer, depthNode: NodeObject, {
    radius = DEFAULT_RADIUS, strength = DEFAULT_STRENGTH,
  }: WebGpuScreenAOOptions = {}) {
    const t = tsl();
    this.targets = [
      new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }),
      new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: false }),
    ];
    const depth = depthNode as NodeObject & { uv(uv: NodeObject): NodeObject };
    const uProjInv = this.uProjInv = t.uniform(new THREE.Matrix4());
    const uProj = this.uProj = t.uniform(new THREE.Matrix4());
    const uNear = this.uNear = t.uniform(0.1);
    const uFar = this.uFar = t.uniform(120);
    const uRadius = t.uniform(radius);
    const uStrength = t.uniform(strength);
    this.uTexel = t.uniform(new THREE.Vector2(1, 1));
    this.uStep = t.uniform(new THREE.Vector2(1, 1));
    this.aoTexture = t.texture(new THREE.Texture()) as unknown as AoSamplerNode;

    const vpos = t.Fn(([uv]: [NodeObject]) => t.getViewPosition(uv, depth.uv(uv), uProjInv));
    const ign = t.Fn(([p]: [NodeObject]) => t.fract(t.float(52.9829189).mul(t.fract(t.dot(p, t.vec2(0.06711056, 0.00583715))))));

    // AO_FRAG.
    const aoMaterial = new t.NodeMaterial();
    aoMaterial.fragmentNode = t.Fn(() => {
      const uv = t.uv();
      const dCenter = depth.uv(uv);
      const occ = t.float(0).toVar();
      t.If(dCenter.lessThan(t.float(0.9999)), () => {
        const P = vpos(uv) as unknown as NodeObject;
        const dx1 = (vpos(uv.add(t.vec2(this.uTexel.x, t.float(0)))) as unknown as NodeObject).sub(P);
        const dx0 = P.sub(vpos(uv.sub(t.vec2(this.uTexel.x, t.float(0)))) as unknown as NodeObject);
        const dy1 = (vpos(uv.add(t.vec2(t.float(0), this.uTexel.y))) as unknown as NodeObject).sub(P);
        const dy0 = P.sub(vpos(uv.sub(t.vec2(t.float(0), this.uTexel.y))) as unknown as NodeObject);
        let N: NodeObject = t.normalize(t.cross(
          t.select(t.abs(dx1.z).lessThan(t.abs(dx0.z)), dx1, dx0),
          t.select(t.abs(dy1.z).lessThan(t.abs(dy0.z)), dy1, dy0),
        )) as unknown as NodeObject;
        N = t.select(N.dot(P).greaterThan(t.float(0)), N.negate(), N) as unknown as NodeObject;
        const T = t.normalize(t.select(t.abs(N.x).lessThan(t.float(0.9)), t.cross(N, t.vec3(1, 0, 0)), t.cross(N, t.vec3(0, 1, 0))));
        const Bt = t.cross(N, T);
        const a0 = ign(t.screenCoordinate.xy).mul(t.float(6.2831853));
        const j = ign(t.screenCoordinate.yx.add(t.float(17)));
        t.Loop(K, ({ i }: { i: NodeObject }) => {
          const f = t.float(i).add(t.float(0.5)).div(t.float(K));
          const r = t.sqrt(f);
          const th = a0.add(t.float(i).mul(t.float(2.399963)));
          const dir = T.mul(t.cos(th).mul(r)).add(Bt.mul(t.sin(th).mul(r))).add(N.mul(t.sqrt(t.float(1).sub(f))));
          const S = P.add(dir.mul(uRadius.mul(t.mix(t.float(0.15), t.float(1), t.fract(f.mul(t.float(7.13)).add(j))))));
          const c = uProj.mul(t.vec4(S, t.float(1)));
          const suv = c.xy.div(c.w).mul(t.float(0.5)).add(t.float(0.5));
          const inside = suv.x.greaterThanEqual(t.float(0)).and(suv.x.lessThanEqual(t.float(1)))
            .and(suv.y.greaterThanEqual(t.float(0))).and(suv.y.lessThanEqual(t.float(1)));
          t.If(inside, () => {
            const sz = (vpos(suv) as unknown as NodeObject).z;
            occ.addAssign(
              t.select(sz.greaterThanEqual(S.z.add(t.float(0.01))), t.float(1), t.float(0))
                .mul(t.smoothstep(t.float(0), t.float(1), uRadius.div(t.max(t.float(1e-3), t.abs(P.z.sub(sz)))))),
            );
          });
        });
      });
      return t.vec4(t.vec3(1).sub(uStrength.mul(occ).div(t.float(K))), t.float(1));
    })();
    aoMaterial.depthTest = false;
    aoMaterial.depthWrite = false;
    aoMaterial.fog = false;
    const aoQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), aoMaterial);
    aoQuad.frustumCulled = false;
    this.ao = new THREE.Scene().add(aoQuad);

    // BLUR_FRAG (separable, depth-aware; the loop runs i = -4 .. 4).
    const lz = t.Fn(([uv]: [NodeObject]) => (t.perspectiveDepthToViewZ(depth.uv(uv), uNear, uFar) as NodeObject));
    const blurMaterial = new t.NodeMaterial();
    blurMaterial.fragmentNode = t.Fn(() => {
      const uv = t.uv();
      const z0 = lz(uv) as unknown as NodeObject;
      const s = t.float(0).toVar();
      const w = t.float(0).toVar();
      t.Loop(9, ({ i }: { i: NodeObject }) => {
        const o = t.float(i).sub(t.float(4));
        const uvi = uv.add(this.uStep.mul(o));
        const g = t.exp(o.mul(o).div(t.float(8)).negate())
          .mul(t.exp(t.abs((lz(uvi) as unknown as NodeObject).sub(z0)).mul(t.float(6)).negate()));
        s.addAssign(this.aoTexture.uv(uvi).r.mul(g));
        w.addAssign(g);
      });
      return t.vec4(t.vec3(s.div(w)), t.float(1));
    })();
    blurMaterial.depthTest = false;
    blurMaterial.depthWrite = false;
    blurMaterial.fog = false;
    const blurQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), blurMaterial);
    blurQuad.frustumCulled = false;
    this.blur = new THREE.Scene().add(blurQuad);
  }

  /** Computes AO from the frame's depth and publishes it to the reef light uniforms (read next frame). */
  update(camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, Math.ceil(this.size.x / RESOLUTION_DIVISOR)), h = Math.max(1, Math.ceil(this.size.y / RESOLUTION_DIVISOR));
    for (const target of this.targets) if (target.width !== w || target.height !== h) target.setSize(w, h);
    this.uTexel.value.set(1 / w, 1 / h);
    this.uProj.value.copy(camera.projectionMatrix);
    this.uProjInv.value.copy(camera.projectionMatrixInverse);
    this.uNear.value = camera.near;
    this.uFar.value = camera.far;

    const prev = r.getRenderTarget();
    const [first, second] = this.targets;
    r.setRenderTarget(first);
    r.render(this.ao, this.camera);
    this.aoTexture.value = first.texture;
    this.uStep.value.set(1 / w, 0);
    r.setRenderTarget(second);
    r.render(this.blur, this.camera);
    this.aoTexture.value = second.texture;
    this.uStep.value.set(0, 1 / h);
    r.setRenderTarget(first);
    r.render(this.blur, this.camera);
    r.setRenderTarget(prev);

    reefLightUniforms.uRLAO.value = first.texture;
    reefLightUniforms.uRLAOInv.value.set(1 / this.size.x, 1 / this.size.y);
    reefLightUniforms.uRLAOOn.value = 1;
  }
}
