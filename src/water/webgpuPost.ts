// Light shafts (volumetric single scattering) and per-object motion blur on the WebGPU path, in TSL.
// The WebGL path is src/water/renderer.ts (a ShaderMaterial post quad WebGPURenderer never runs). Here
// the scene renders through a PassNode into an HDR target with depth, and one composite Fn ray-marches
// the same single-scattering integral and, when motion blur is on, averages the frame along each moving
// model's screen motion from a separate half-res velocity pass (the built-in `velocity` node, written
// with an override material like the WebGL velocity pass). The composite outputs linear radiance;
// PostProcessing's renderOutput() tone-maps and encodes to sRGB exactly like the WebGL chain.
import * as THREE from 'three';
import type { Node, ShaderNodeObject, UniformNode } from 'three/webgpu';
import type { WebGPURenderer } from 'three/webgpu';
import { tsl, type Tsl } from '../webgpu/tsl.js';
import { getGpuCausticState, shaftCausticNode } from './webgpuCaustics.js';
import { GpuPhotoCamera, type GpuPhotoOptions } from '../webgpu/photo.js';
import { METRES_PER_UNIT, SURFACE_Y, GLASS_Z } from './medium.js';
import type { ShaftLight } from './renderer.js';

type NodeObject = ShaderNodeObject<Node>;
/** A pass texture node: its `.uv()` re-samples the same texture (keeping the pass-node link). */
type UvSamplerNode = NodeObject & { uv(uv: NodeObject): NodeObject };

const MSAA_SAMPLES = 4;
const DEFAULT_SCATTER_PER_METRE = 0.35;
const SHAFT_SAMPLES = 20;
const BLUR_TAPS = 7;
const PI4 = 12.566371;
/** Layer the velocity pass draws (the moving models enable it). */
const VELOCITY_LAYER = 1;

/** Per-unit beam attenuation c (red/green/blue), as UW_C in medium.ts. */
const BEAM_PER_UNIT = [0.60 * METRES_PER_UNIT, 0.17 * METRES_PER_UNIT, 0.12 * METRES_PER_UNIT] as const;
/** Camera white balance, exp(UW_KD * 7), as UW_WB in medium.ts. */
const WHITE_BALANCE = [
  Math.exp(0.45 * METRES_PER_UNIT * 7),
  Math.exp(0.07 * METRES_PER_UNIT * 7),
  Math.exp(0.05 * METRES_PER_UNIT * 7),
] as const;

/** The same per-pixel hash as the WebGL passes. */
function ignHash(t: Tsl): (p: NodeObject) => NodeObject {
  return t.Fn(([p]: [NodeObject]) => t.fract(t.float(52.9829189).mul(t.fract(t.dot(p, t.vec2(0.06711056, 0.00583715))))));
}

/** Henyey-Greenstein phase function (the same hg() as the WebGL shaft shader). */
function hg(t: Tsl): (c: NodeObject, g: NodeObject) => NodeObject {
  return t.Fn(([c, g]: [NodeObject, NodeObject]) => {
    const g2 = g.mul(g);
    const denom = t.float(1).add(g2).sub(t.float(2).mul(g).mul(c));
    return t.float(1).sub(g2).div(t.float(PI4).mul(t.pow(denom, t.float(1.5))));
  });
}

export interface WebGpuWaterPostOptions {
  readonly scatterPerMetre?: number;
  /** Per-object motion blur (a separate half-res velocity pass). */
  readonly motionBlur?: boolean;
  /** The photo camera (depth of field, lens fall-off, grain) on top of the composite. */
  readonly photo?: GpuPhotoOptions | null;
}

/** The WebGPU counterpart of WaterRenderer: the HDR scene pass and the shaft/motion-blur composite. */
export class WebGpuWaterPost {
  readonly scenePass: ShaderNodeObject<import('three/webgpu').PassNode>;
  /** The raw (perspective NDC) depth texture node, read by the photo and AO passes. */
  readonly depthNode: NodeObject;
  /** The linear HDR composite (shafts + motion blur), before tone mapping. */
  readonly compositeNode: NodeObject;
  /** The photo camera output on top of the composite, or null when photo is off. */
  readonly photo: GpuPhotoCamera | null = null;
  /** Shutter time / step time; 0 turns the motion blur off. Set by the caller. */
  blurScale = 0;

  private readonly post: InstanceType<Tsl['PostProcessing']>;
  private readonly uBlur: ShaderNodeObject<UniformNode<number>>;
  private readonly uSunColor: ShaderNodeObject<UniformNode<THREE.Color>>;
  private readonly uProjInv: ShaderNodeObject<UniformNode<THREE.Matrix4>>;
  private readonly uViewInv: ShaderNodeObject<UniformNode<THREE.Matrix4>>;
  private readonly uCamPos: ShaderNodeObject<UniformNode<THREE.Vector3>>;
  private readonly size = new THREE.Vector2();
  private readonly velocityTarget: THREE.RenderTarget | null = null;
  private readonly velocityMaterial: InstanceType<Tsl['NodeMaterial']> | null = null;

  constructor(
    private readonly renderer: WebGPURenderer,
    private readonly scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    { scatterPerMetre = DEFAULT_SCATTER_PER_METRE, motionBlur = false, photo = null }: WebGpuWaterPostOptions = {},
  ) {
    const t = tsl();
    this.scenePass = t.pass(scene, camera, { samples: MSAA_SAMPLES }) as ShaderNodeObject<import('three/webgpu').PassNode>;
    this.depthNode = this.scenePass.getTextureNode('depth');
    const colorNode = this.scenePass.getTextureNode('output') as UvSamplerNode;

    if (motionBlur) {
      this.velocityTarget = new THREE.RenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true });
      const velocityMaterial = this.velocityMaterial = new t.NodeMaterial();
      velocityMaterial.side = THREE.DoubleSide;
      // The same velocity as the WebGL pass (motion in texture units since the previous step, and this
      // surface's NDC depth), from the built-in `velocity` node's per-object previous matrices.
      velocityMaterial.fragmentNode = t.Fn(() => {
        const vel = t.velocity.mul(t.float(0.5));
        const clip = t.cameraProjectionMatrix.mul(t.modelViewMatrix).mul(t.positionLocal);
        const depth = clip.z.div(clip.w);
        return t.vec4(vel.x, vel.y, depth, t.float(1));
      })();
    }

    const velocityTex = motionBlur ? (t.texture(this.velocityTarget!.texture) as unknown as UvSamplerNode) : null;

    const uBlur = this.uBlur = t.uniform(0);
    const uSunColor = this.uSunColor = t.uniform(new THREE.Color());
    const uScatter = t.uniform(scatterPerMetre * METRES_PER_UNIT);
    // The post quad renders with its own ortho camera, so the scene camera's matrices are uniforms.
    const uProjInv = this.uProjInv = t.uniform(new THREE.Matrix4());
    const uViewInv = this.uViewInv = t.uniform(new THREE.Matrix4());
    const uCamPos = this.uCamPos = t.uniform(new THREE.Vector3());

    const ign = ignHash(t);
    const phaseFn = hg(t);
    const caustic = shaftCausticNode(t);
    const state = getGpuCausticState();
    const uCauR0 = (state ? state.uCauR0 : t.uniform(new THREE.Vector3(0, -1, 0))) as unknown as NodeObject;
    const uCauOn = (state ? state.uCauOn : t.uniform(0)) as unknown as NodeObject;
    const C = t.vec3(BEAM_PER_UNIT[0], BEAM_PER_UNIT[1], BEAM_PER_UNIT[2]);
    const WB = t.vec3(WHITE_BALANCE[0], WHITE_BALANCE[1], WHITE_BALANCE[2]);
    const surfaceY = t.float(SURFACE_Y);
    const glassZ = t.float(GLASS_Z);

    this.compositeNode = t.Fn(() => {
      const uv = t.screenUV;
      const d = this.depthNode;
      let col = colorNode.xyz;

      // Motion blur: where a moving fish is the visible surface, average the frame along its motion over
      // the shutter time (a video camera's ~1/100 s), centred on the pixel. The velocity pass is
      // depth-tested against itself, so its marker (w) already isolates the visible fish surface.
      if (motionBlur) {
        const vel = velocityTex!.uv(uv);
        const v = vel.xy.mul(uBlur);
        const acc = t.vec3(0).toVar();
        t.Loop(BLUR_TAPS, ({ i }: { i: NodeObject }) => {
          const offset = v.mul(t.float(i).div(t.float(BLUR_TAPS - 1)).sub(t.float(0.5)));
          acc.addAssign(colorNode.uv(uv.add(offset)).xyz);
        });
        const moving = vel.w.greaterThan(t.float(0.5))
          .and(t.dot(v, v).greaterThan(t.float(1e-8)));
        col = t.select(moving, acc.div(t.float(BLUR_TAPS)), col);
      }

      // Reconstruct the world point (getViewPosition handles the WebGPU clip-space convention).
      const viewPos = t.getViewPosition(uv, d, uProjInv);
      const camPos = uCamPos;
      const wp = uViewInv.mul(t.vec4(viewPos, t.float(1))).xyz;
      const rd = t.normalize(wp.sub(camPos));
      const tEnd0 = t.select(d.greaterThanEqual(t.float(0.99999)), t.float(30), t.length(wp.sub(camPos)));
      const tEnd = t.select(rd.y.greaterThan(t.float(0)), t.min(tEnd0, surfaceY.sub(camPos.y).div(rd.y)), tEnd0);
      const tStart = t.select(
        camPos.z.greaterThan(glassZ),
        glassZ.sub(camPos.z).div(t.min(rd.z, t.float(-1e-4))),
        t.float(0),
      );

      const acc = t.vec3(0).toVar();
      const jitter = ign(t.screenCoordinate.xy);
      const cosL = t.max(uCauR0.y.negate(), t.float(0.2));
      t.If(tEnd.greaterThan(tStart).and(uCauOn.greaterThan(t.float(0.5))), () => {
        const dt = tEnd.sub(tStart).div(t.float(SHAFT_SAMPLES));
        t.Loop(SHAFT_SAMPLES, ({ i }: { i: NodeObject }) => {
          const tt = tStart.add(t.float(i).add(jitter).mul(dt));
          const p = camPos.add(rd.mul(tt));
          const D = surfaceY.sub(p.y);
          t.If(D.greaterThanEqual(t.float(0)), () => {
            acc.addAssign(
              caustic(p).sub(t.vec3(1))
                .mul(t.exp(C.mul(D.div(cosL).add(tt).sub(tStart)).negate()))
                .mul(dt),
            );
          });
        });
      });
      const phase = t.float(0.8).mul(phaseFn(t.dot(uCauR0, rd.negate()), t.float(0.75))).add(t.float(0.2).div(t.float(PI4)));
      acc.mulAssign(uScatter).mulAssign(phase).mulAssign(uSunColor);

      return t.vec4(t.max(col.add(acc.mul(WB)), t.vec3(0)), t.float(1));
    })();

    if (photo) {
      // The photo's depth-of-field gather re-samples the composite at arbitrary uvs, so it must be a
      // texture (as WebGL renders it into photo.begin()); render the composite through an RTT first.
      const compositeTex = t.convertToTexture(this.compositeNode) as unknown as NodeObject;
      this.photo = new GpuPhotoCamera(compositeTex, this.depthNode, photo);
    }
    this.post = new t.PostProcessing(renderer, this.photo ? this.photo.outputNode : this.compositeNode);
  }

  /** Publish the current sun colour (times its intensity), as the shaft pass sees it. */
  setSun(sun: ShaftLight): void {
    this.uSunColor.value.copy(sun.color).multiplyScalar(sun.intensity);
  }

  /** Motion blur for the moving models (the fish): put their meshes on the velocity layer. */
  track(models: Iterable<THREE.Object3D>): void {
    if (!this.velocityMaterial) return;
    for (const model of models) {
      model.traverse((o) => {
        if (o instanceof THREE.Mesh) o.layers.enable(VELOCITY_LAYER);
      });
    }
  }

  /** Draw the scene and composite it to the screen (async on the backend). */
  render(camera: THREE.PerspectiveCamera, t: number): void {
    this.uBlur.value = this.blurScale;
    camera.updateMatrixWorld();
    this.uProjInv.value.copy(camera.projectionMatrixInverse);
    this.uViewInv.value.copy(camera.matrixWorld);
    this.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
    if (this.photo) {
      this.renderer.getDrawingBufferSize(this.size);
      this.photo.update(camera, t, this.size);
    }
    if (this.velocityMaterial && this.velocityTarget && this.blurScale > 0) this.renderVelocity(camera);
    this.post.render();
  }

  /** The velocity pass (the WebGL renderVelocity): draw the moving models with the velocity material. */
  private renderVelocity(camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    const target = this.velocityTarget!;
    r.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x >> 1), h = Math.max(1, this.size.y >> 1);
    if (target.width !== w || target.height !== h) target.setSize(w, h);

    const scene = this.scene;
    const mask = camera.layers.mask, background = scene.background, backgroundNode = (scene as typeof scene & { backgroundNode: unknown }).backgroundNode;
    // The common renderer's clear-colour accessors are typed against the internal Color4 (see WebGpuCaustics).
    const cr = this.renderer as unknown as {
      getClearColor(t: THREE.Color): THREE.Color;
      setClearColor(c: THREE.Color | number, a?: number): void;
      getClearAlpha(): number;
    };
    const clearColor = cr.getClearColor(new THREE.Color()), clearAlpha = cr.getClearAlpha();
    camera.layers.set(VELOCITY_LAYER);
    scene.overrideMaterial = this.velocityMaterial;
    scene.background = null;
    (scene as typeof scene & { backgroundNode: unknown }).backgroundNode = null;
    r.setRenderTarget(target);
    cr.setClearColor(0x000000, 0);
    r.clear();
    r.render(scene, camera);
    scene.overrideMaterial = null;
    scene.background = background;
    (scene as typeof scene & { backgroundNode: unknown }).backgroundNode = backgroundNode;
    camera.layers.mask = mask;
    cr.setClearColor(clearColor, clearAlpha);
    r.setRenderTarget(null);
  }
}
