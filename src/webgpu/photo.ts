// The photo camera on the WebGPU path, in TSL (the WebGL path is src/photo.ts, a ShaderMaterial post
// WebGPURenderer never runs). Same thin-lens depth of field (24-tap disc, scatter-as-gather), lateral
// chromatic aberration, natural cos^4 vignetting, shot noise and the room's double reflection in the
// front glass. It consumes the water post's linear HDR composite and its depth; the output stays linear
// and PostProcessing's renderOutput() tone-maps it, matching the WebGL chain.
import * as THREE from 'three';
import { tsl, type FloatUniformNode, type Mat3UniformNode, type NodeObject, type Vec2UniformNode } from './tsl.js';
import { METRES_PER_UNIT } from '../water/medium.js';

/** A pass texture node: `.sample()` re-samples the same texture (keeping the pass-node link). */
type SamplerNode = NodeObject & { sample(uv: NodeObject): NodeObject };

const TAPS = 24;
const GOLDEN_ANGLE = 2.39996323;
/** Golden-angle spiral, uniform over the unit disc (photo.ts DISC). */
const DISC = Array.from({ length: TAPS }, (_, i) => {
  const r = Math.sqrt((i + 0.5) / TAPS), a = i * GOLDEN_ANGLE;
  return new THREE.Vector2(Math.cos(a) * r, Math.sin(a) * r);
});

const DEFAULTS = { fNumber: 2.8, sensorMM: 36, ca: 0.0012, iso: 1 } as const;
const SENSOR_ASPECT = 1.5;
const INITIAL_FOCUS = 10;
const MIN_FOCUS = 0.05;
const MIN_FOCUS_MINUS_FOCAL_MM = 1;
const MM_PER_M = 1000;
const PANE_THICKNESS_M = 0.012;
const ROOM_DISTANCE_M = 2.5;
const SEED_PERIOD = 100;
const DEFAULT_NEAR = 0.1, DEFAULT_FAR = 100;

export interface GpuPhotoOptions {
  readonly fNumber?: number;
  readonly sensorMM?: number;
  readonly ca?: number;
  readonly iso?: number;
  readonly glass?: boolean;
}

export class GpuPhotoCamera {
  /** Focus distance, world units (autofocus moves it, as photo.ts focus). */
  focus = INITIAL_FOCUS;
  readonly fNumber: number;
  readonly sensorMM: number;
  /** The photo output node (linear HDR), for PostProcessing.outputNode. */
  readonly outputNode: NodeObject;

  private readonly uNear: FloatUniformNode;
  private readonly uFar: FloatUniformNode;
  private readonly uCocK: FloatUniformNode;
  private readonly uFocus: FloatUniformNode;
  private readonly uRes: Vec2UniformNode;
  private readonly uTanHalf: Vec2UniformNode;
  private readonly uSeed: FloatUniformNode;
  private readonly uCamRot: Mat3UniformNode;

  constructor(colorNode: NodeObject, depthNode: NodeObject, {
    fNumber = DEFAULTS.fNumber, sensorMM = DEFAULTS.sensorMM, ca = DEFAULTS.ca, iso = DEFAULTS.iso, glass = true,
  }: GpuPhotoOptions = {}) {
    const t = tsl();
    this.fNumber = fNumber;
    this.sensorMM = sensorMM;

    const color = colorNode as SamplerNode;
    const depth = depthNode as SamplerNode;
    const uNear = this.uNear = t.uniform(DEFAULT_NEAR);
    const uFar = this.uFar = t.uniform(DEFAULT_FAR);
    const uCocK = this.uCocK = t.uniform(0);
    const uFocus = this.uFocus = t.uniform(INITIAL_FOCUS);
    const uRes = this.uRes = t.uniform(new THREE.Vector2(1, 1));
    const uTanHalf = this.uTanHalf = t.uniform(new THREE.Vector2(1, 1));
    const uCA = t.uniform(ca);
    const uIso = t.uniform(iso);
    const uSeed = this.uSeed = t.uniform(0);
    const uGlass = t.uniform(new THREE.Vector3(
      glass ? 1 : 0, PANE_THICKNESS_M / METRES_PER_UNIT, ROOM_DISTANCE_M / METRES_PER_UNIT,
    ));
    const uCamRot = this.uCamRot = t.uniform(new THREE.Matrix3(), 'mat3');
    const uDisc = t.uniformArray(DISC, 'vec2' as const);

    // viewDist / coc / sampleCA from PHOTO_FRAG.
    const viewDist = t.Fn(([uv]: [NodeObject]) => (t.perspectiveDepthToViewZ(depth.sample(uv), uNear, uFar) as NodeObject).negate());
    const coc = t.Fn(([d]: [NodeObject]) =>
      t.min(t.float(0.5).mul(uCocK).mul(t.abs(t.float(1).sub(uFocus.div(t.max(d, t.float(1e-3)))))), t.float(14)));
    const sampleCA = t.Fn(([uv]: [NodeObject]) => {
      const c = uv.sub(t.vec2(0.5));
      const k = uCA.mul(t.dot(c, c)).mul(t.float(4));
      return t.vec3(
        color.sample(t.vec2(0.5).add(c.mul(t.float(1).add(k)))).r,
        color.sample(uv).g,
        color.sample(t.vec2(0.5).add(c.mul(t.float(1).sub(k)))).b,
      );
    });
    // The room behind the camera (photo.ts roomAt / glassReflection).
    const roomAt = t.Fn(([r]: [NodeObject]) => {
      const L = t.vec3(0.025, 0.024, 0.022).mul(t.float(1).add(t.float(0.6).mul(t.max(r.y, t.float(0)))));
      const w = t.vec2(r.x.div(t.max(r.z, t.float(0.05))).add(t.float(0.55)), r.y.div(t.max(r.z, t.float(0.05))).sub(t.float(0.3)));
      const e = t.smoothstep(t.vec2(0.33, 0.21), t.vec2(0.3, 0.18), t.abs(w));
      const mull = t.smoothstep(t.float(0.006), t.float(0.012), t.abs(w.y));
      return L.add(t.vec3(0.9, 0.95, 1.0).mul(t.float(0.22)).mul(e.x).mul(e.y).mul(mull));
    });
    const schlick = t.Fn(([f0, c]: [NodeObject, NodeObject]) =>
      f0.add(t.float(1).sub(f0).mul(t.pow(t.float(1).sub(c), t.float(5)))));
    const glassReflection = t.Fn(([ndc]: [NodeObject]) => {
      const d = t.normalize(uCamRot.mul(t.vec3(ndc.mul(uTanHalf), t.float(-1))));
      const r = t.vec3(d.x, d.y, d.z.negate());
      const c = r.z;
      const s = t.sqrt(t.max(t.float(0), t.float(1).sub(c.mul(c))));
      const f1 = schlick(t.float(0.04), c);
      const f2 = schlick(t.float(0.0044), t.sqrt(t.max(t.float(0), t.float(1).sub(s.mul(s).div(t.float(1.52).mul(t.float(1.52)))))));
      const tg = s.div(t.float(1.52)).div(t.sqrt(t.max(t.float(1e-4), t.float(1).sub(s.mul(s).div(t.float(1.52).mul(t.float(1.52)))))));
      const side = t.select(t.length(r.xy).greaterThan(t.float(1e-4)), t.normalize(r.xy), t.vec2(0));
      const r2 = t.normalize(t.vec3(r.xy.add(side.mul(t.float(2).mul(uGlass.y).mul(tg).mul(c).div(uGlass.z))), r.z));
      const refl = f1.mul(roomAt(r)).add(t.float(1).sub(f1).mul(t.float(1).sub(f1)).mul(f2).mul(roomAt(r2)));
      return t.select(d.z.greaterThanEqual(t.float(-0.05)), t.vec3(0), refl);
    });
    const hash = t.Fn(([p]: [NodeObject]) =>
      t.fract(t.sin(t.dot(p, t.vec2(12.9898, 78.233)).add(uSeed.mul(t.float(7.13)))).mul(t.float(43758.5453))));
    // One channel of shot/read noise (Box-Muller from two hashes).
    const grainChannel = t.Fn(([u1, u2, sig]: [NodeObject, NodeObject, NodeObject]) => {
      const n = t.sqrt(t.float(-2).mul(t.log(t.max(u1, t.float(1e-4))))).mul(t.cos(t.float(6.2831853).mul(u2)));
      return n.mul(t.float(0.012).mul(t.sqrt(t.max(sig, t.float(0)))).add(t.float(0.002)));
    });

    this.outputNode = t.Fn(() => {
      const uv = t.screenUV;
      const d0 = viewDist(uv);
      const r0 = coc(d0);
      const col = sampleCA(uv).toVar();

      t.If(r0.greaterThan(t.float(0.5)), () => {
        const acc = col.toVar();
        const wsum = t.float(1).toVar();
        t.Loop(TAPS, ({ i }: { i: NodeObject }) => {
          const o = uDisc.element(i).mul(r0);
          const uv2 = uv.add(o.div(uRes));
          const ri = coc(viewDist(uv2));
          const w = t.clamp(ri.sub(t.length(o)).add(t.float(1)), t.float(0), t.float(1));
          acc.addAssign(sampleCA(uv2).mul(w));
          wsum.addAssign(w);
        });
        col.assign(acc.div(wsum));
      });

      const ndc = uv.mul(t.float(2)).sub(t.float(1));
      t.If(uGlass.x.greaterThan(t.float(0.5)), () => {
        col.addAssign(glassReflection(ndc));
      });
      const tan2 = t.dot(ndc.mul(uTanHalf), ndc.mul(uTanHalf));
      col.mulAssign(t.float(1).div(t.float(1).add(tan2).mul(t.float(1).add(tan2))));

      const px = t.floor(uv.mul(uRes));
      const noise = t.vec3(
        grainChannel(hash(px), hash(px.add(t.vec2(5))), col.x) as unknown as NodeObject,
        grainChannel(hash(px.add(t.vec2(17))), hash(px.add(t.vec2(36))), col.y) as unknown as NodeObject,
        grainChannel(hash(px.add(t.vec2(34))), hash(px.add(t.vec2(67))), col.z) as unknown as NodeObject,
      );
      col.assign(t.max(col.add(noise.mul(uIso)), t.vec3(0)));

      return t.vec4(col, t.float(1));
    })();
  }

  /** Per-frame lens state (photo.ts finish()): focal length from the fov, CoC scale, seeds, camera rotation. */
  update(camera: THREE.PerspectiveCamera, t: number, size: THREE.Vector2): void {
    const fMM = (this.sensorMM / SENSOR_ASPECT / 2) / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    const s = Math.max(this.focus, MIN_FOCUS) * METRES_PER_UNIT * MM_PER_M;
    this.uCocK.value = ((fMM * fMM) / (this.fNumber * Math.max(s - fMM, MIN_FOCUS_MINUS_FOCAL_MM))) / this.sensorMM * size.x;
    this.uFocus.value = this.focus;
    this.uNear.value = camera.near;
    this.uFar.value = camera.far;
    this.uRes.value.copy(size);
    const ty = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    this.uTanHalf.value.set(ty * camera.aspect, ty);
    this.uSeed.value = t % SEED_PERIOD;
    this.uCamRot.value.setFromMatrix4(camera.matrixWorld);
  }
}
