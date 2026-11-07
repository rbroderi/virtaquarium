// Fish parting for swayed plants: a fixed-size uniform array of the fish nearest the grass and
// anemone patches, written once a frame from world.fish, and a vertex-shader bend that parts each
// blade/tentacle from nearby bodies and wakes behind them. The sway (materials.ts addSway) already
// bends with the water; this adds a horizontal push on top, so the two compose in the vertex shader.
import * as THREE from 'three';
import { clamp } from '../util.js';
import { tsl } from '../webgpu/tsl.js';
import type { Node, ShaderNodeObject, UniformArrayNode, UniformNode } from 'three/webgpu';

/** How many fish the shader considers at once (the uniform array size). */
export const MAX_FISH = 16;
/** A fish's body radius is half its length. */
const BODY_RADIUS = 0.5;
/** Plants keep parting this far past the body (world units, ~1.9 cm). */
const PUSH_MARGIN = 0.15;
/** A blade/tentacle tip bends this far at full parting (world units, ~2.5 cm). */
const PUSH_MAX = 0.2;
/** The wake trails this far behind a moving fish (seconds of its velocity). */
const WAKE_LAG = 0.3;
/** Hard cap on the bend angle, so a fish cannot splay a tentacle flat (radians, ~40 deg). */
const MAX_BEND = 0.7;
/** Horizontal displacement of a tip bent to MAX_BEND, as a fraction of its length. */
const BEND_CHORD = 2 * Math.sin(MAX_BEND / 2);
/** Parting strength rises this fast when a fish reaches the plants (1/s). */
const STRENGTH_ATTACK = 8;
/** And eases back this slowly as it leaves, so the blades sway back (1/s). */
const STRENGTH_RELEASE = 1.6;
/** Strength fades to zero over this distance past a patch's reach (world units). */
const REACTOR_FADE = 1.5;
/** A fish weaker than this is dropped from the uniform array. */
const STRENGTH_CUTOFF = 0.02;
/** `?fishpush=0` turns the parting off, for side-by-side look checks. */
const FISH_PUSH_ON = typeof location === 'undefined' || new URLSearchParams(location.search).get('fishpush') !== '0';

const GLSL_DIGITS = 4;
const f = (x: number): string => x.toFixed(GLSL_DIGITS);

/** The world-space fields the update reads from each fish (world.fish entries satisfy this). */
export interface FishPushFish {
  readonly pos: { readonly x: number; readonly y: number; readonly z: number };
  readonly vel: { readonly x: number; readonly y: number; readonly z: number };
  readonly size: number;
}

/** The smallest shape the update needs of World. */
export interface FishPushWorld {
  readonly fish: readonly FishPushFish[];
}

/** The smallest shape the update needs of the camera (its position, for the tie-break). */
export interface FishPushCamera {
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

/** A patch of parting plants (a grass bed or the anemone crown), in world x/z. */
export interface FishPushReactor {
  readonly x: number;
  readonly z: number;
  readonly r: number;
}

/** One shared uniform object every fish-push material reads, updated once a frame. */
export const fishUniforms: {
  uFishPos: { value: Float32Array };
  uFishVel: { value: Float32Array };
  uFishCount: { value: number };
} = {
  uFishPos: { value: new Float32Array(MAX_FISH * 4) },
  uFishVel: { value: new Float32Array(MAX_FISH * 4) },
  uFishCount: { value: 0 },
};

/**
 * Uniform declarations and the per-vertex push function, prepended to a sway material's vertex shader.
 * uFishPos[i] = (world x, y, z, falloff radius); uFishVel[i] = (world velocity, smoothed strength).
 */
export const FISH_PUSH_HEADER = /* glsl */`
uniform vec4 uFishPos[${MAX_FISH}];
uniform vec4 uFishVel[${MAX_FISH}];
uniform float uFishCount;
vec3 fishPushWorld(vec3 wp, float h) {
  vec3 push = vec3(0.0);
  float hh = h * h;
  for (int i = 0; i < ${MAX_FISH}; i++) {
    if (float(i) >= uFishCount) break;
    float s = uFishVel[i].w;
    if (s < ${f(STRENGTH_CUTOFF)}) continue;
    vec3 d = wp - (uFishPos[i].xyz - uFishVel[i].xyz * ${f(WAKE_LAG)});
    float r = length(d);
    float g = 1.0 - smoothstep(0.0, uFishPos[i].w, r);
    if (g < 0.001) continue;
    vec2 dir = d.xz;
    float dl = length(dir);
    dir = dl > 0.001 ? dir / dl : vec2(1.0, 0.0);
    push.xz += dir * (g * s * hh * ${f(PUSH_MAX)});
  }
  return push;
}
`;

/**
 * The block that runs after the sway has bent the vertex: it takes the bent vertex's world position,
 * bends in world space (where the push lives) rather than stretches: the tip angle is capped and each
 * vertex keeps its world distance from the base, so the stalk leans over and the base stays planted
 * and thick.
 */
export const FISH_PUSH_APPLY = /* glsl */`
      mat3 fpM = mat3(modelMatrix);
      #ifdef USE_INSTANCING
      fpM = fpM * mat3(instanceMatrix);
      vec4 fpWp = modelMatrix * (instanceMatrix * vec4(transformed, 1.0));
      #else
      vec4 fpWp = modelMatrix * vec4(transformed, 1.0);
      #endif
      vec3 fpPush = fishPushWorld(fpWp.xyz, h);
      {
        vec3 fpS = max(vec3(length(fpM[0].xyz), length(fpM[1].xyz), length(fpM[2].xyz)), vec3(1e-3));
        float fpMag = length(fpPush);
        if (fpMag > 1e-5) {
          float fpCap = fpS.y * ${f(BEND_CHORD)};
          if (fpMag > fpCap) fpPush *= fpCap / fpMag;
          mat3 fpRot = mat3(fpM[0].xyz / fpS.x, fpM[1].xyz / fpS.y, fpM[2].xyz / fpS.z);
          // Bend in world space, keeping each vertex its distance from the plant's base. Renormalising
          // in model space let a blade's width (its instance x is scaled ~30x smaller than its length)
          // and the shader's sideways wave stand in for the blade's length: a push could then carry a
          // tip several blade-lengths into the air instead of leaning it over. The world push is capped
          // at BEND_CHORD of the plant's height, so the tip leans at most MAX_BEND.
          vec3 fpOff = fpM * transformed;   // world offset from the instance's base
          float fpR = length(fpOff);
          vec3 fpBent = fpOff + fpPush;
          float fpRL = length(fpBent);
          if (fpRL > 1e-5) fpOff = fpBent * (fpR / fpRL);
          transformed = (fpOff * fpRot) / fpS;   // back to the model's own space
        }
      }
`;

const reactors: FishPushReactor[] = [];
const tracked = new WeakMap<FishPushFish, { s: number }>();

/** Replaces the plant patches the update reads (called once by the reef builder). */
export function setFishPushReactors(list: readonly FishPushReactor[]): void {
  reactors.length = 0;
  reactors.push(...list);
}

/**
 * Writes the fish nearest the plants into the shared uniform array, with a smoothed per-fish strength
 * (fast in, slow out) so the blades part as a fish arrives and sway back after it leaves. O(fish x
 * patches), no per-instance work.
 */
export function updateFishPush(world: FishPushWorld, camera: FishPushCamera, dt: number): void {
  const pos = fishUniforms.uFishPos.value;
  const vel = fishUniforms.uFishVel.value;
  if (!FISH_PUSH_ON) {
    pos.fill(0);
    vel.fill(0);
    fishUniforms.uFishCount.value = 0;
    return;
  }
  const ranked: { f: FishPushFish; s: number; cam: number }[] = [];
  for (const fsh of world.fish) {
    let st = tracked.get(fsh);
    if (!st) {
      st = { s: 0 };
      tracked.set(fsh, st);
    }
    // How far past the nearest patch's reach the fish is (negative = inside it).
    let nearest = Infinity;
    for (const r of reactors) {
      const reach = r.r + fsh.size * BODY_RADIUS + PUSH_MARGIN;
      const d = Math.hypot(fsh.pos.x - r.x, fsh.pos.z - r.z) - reach;
      if (d < nearest) nearest = d;
    }
    const target = clamp(1 - nearest / REACTOR_FADE, 0, 1);
    const rate = target > st.s ? STRENGTH_ATTACK : STRENGTH_RELEASE;
    st.s += (target - st.s) * Math.min(1, dt * rate);
    if (st.s < STRENGTH_CUTOFF && target <= 0) st.s = 0;
    const cam = (fsh.pos.x - camera.position.x) ** 2 + (fsh.pos.y - camera.position.y) ** 2 + (fsh.pos.z - camera.position.z) ** 2;
    ranked.push({ f: fsh, s: st.s, cam });
  }
  ranked.sort((a, b) => (b.s - a.s) || (a.cam - b.cam));
  let n = 0;
  for (const { f: fsh, s } of ranked) {
    if (s < STRENGTH_CUTOFF || n >= MAX_FISH) break;
    const i = n * 4;
    pos[i] = fsh.pos.x;
    pos[i + 1] = fsh.pos.y;
    pos[i + 2] = fsh.pos.z;
    pos[i + 3] = fsh.size * BODY_RADIUS + PUSH_MARGIN;
    vel[i] = fsh.vel.x;
    vel[i + 1] = fsh.vel.y;
    vel[i + 2] = fsh.vel.z;
    vel[i + 3] = s;
    n++;
  }
  fishUniforms.uFishCount.value = n;
  // Zero the unused slots so a shorter frame's fish don't linger.
  pos.fill(0, n * 4);
  vel.fill(0, n * 4);
}

// --- WebGPU (TSL) counterparts ---

interface FishPushNodes {
  readonly uFishPos: ShaderNodeObject<UniformArrayNode>;
  readonly uFishVel: ShaderNodeObject<UniformArrayNode>;
  readonly uFishCount: ShaderNodeObject<UniformNode<number>>;
}

let fishPushNodesCache: FishPushNodes | null = null;

/** vec4 views over the shared Float32Array uniforms (updateFishPush mutates them in place). */
function vec4UniformArray(entry: { value: Float32Array }): { readonly x: number; readonly y: number; readonly z: number; readonly w: number }[] {
  const count = entry.value.length / 4;
  return Array.from({ length: count }, (_, i) => ({
    get x(): number { return entry.value[i * 4] ?? 0; },
    get y(): number { return entry.value[i * 4 + 1] ?? 0; },
    get z(): number { return entry.value[i * 4 + 2] ?? 0; },
    get w(): number { return entry.value[i * 4 + 3] ?? 0; },
  }));
}

/** The shared fish-push uniform nodes (created once, on the WebGPU path only). */
export function fishPushNodes(): FishPushNodes {
  if (fishPushNodesCache) return fishPushNodesCache;
  const t = tsl();
  const count = t.uniform(fishUniforms.uFishCount.value);
  Object.defineProperty(fishUniforms.uFishCount, 'value', {
    get: (): number => count.value,
    set: (v: number): void => { count.value = v; },
    configurable: true,
    enumerable: true,
  });
  fishPushNodesCache = {
    uFishPos: t.uniformArray(vec4UniformArray(fishUniforms.uFishPos) as unknown as THREE.Vector4[], 'vec4'),
    uFishVel: t.uniformArray(vec4UniformArray(fishUniforms.uFishVel) as unknown as THREE.Vector4[], 'vec4'),
    uFishCount: count,
  };
  return fishPushNodesCache;
}

/**
 * TSL port of FISH_PUSH_APPLY: takes the swayed local position and its height (0 base .. 1 tip),
 * bends it in world space (where the push lives) rather than stretching, then folds it back into the
 * model's own space. inst0..inst3 are the instance matrix's four columns (the WebGL shader reads
 * instanceMatrix); pass identity columns for a non-instanced mesh.
 */
export function fishPushBend(p: ShaderNodeObject<Node>, h: ShaderNodeObject<Node>, inst0: ShaderNodeObject<Node>, inst1: ShaderNodeObject<Node>, inst2: ShaderNodeObject<Node>, inst3: ShaderNodeObject<Node>): Node {
  const t = tsl();
  const { uFishPos, uFishVel, uFishCount } = fishPushNodes();
  return t.Fn(() => {
    const local = p.toVar();
    const hh = h.mul(h);
    const instM = t.mat4(inst0, inst1, inst2, inst3);
    const wp = t.modelWorldMatrix.mul(instM.mul(t.vec4(local, 1))).xyz;

    // fishPushWorld (FISH_PUSH_HEADER): the loop's break/continue are folded into gates so the TSL
    // Loop needs no control flow.
    const push = t.vec3(0).toVar();
    t.Loop({ start: t.int(0), end: t.int(MAX_FISH), type: 'int', condition: '<' }, ({ i }: { i: ShaderNodeObject<Node> }) => {
      const fp = uFishPos.element(i);
      const fv = uFishVel.element(i);
      const s = fv.w;
      const active = t.select(t.float(i).lessThan(uFishCount), t.float(1), t.float(0));
      const sOn = t.select(s.greaterThanEqual(t.float(STRENGTH_CUTOFF)), t.float(1), t.float(0));
      const d = wp.sub(fp.xyz.sub(fv.xyz.mul(t.float(WAKE_LAG))));
      const r = t.length(d);
      const g = t.float(1).sub(t.smoothstep(t.float(0), t.max(fp.w, t.float(1e-4)), r));
      const gOn = t.select(g.greaterThanEqual(t.float(0.001)), t.float(1), t.float(0));
      const dl = t.length(d.xz);
      const dir = t.select(t.greaterThan(dl, t.float(0.001)), d.xz.div(t.max(dl, t.float(0.001))), t.vec2(1, 0));
      push.xz.addAssign(dir.mul(active.mul(sOn).mul(gOn).mul(g).mul(s).mul(hh).mul(t.float(PUSH_MAX))));
    });

    // Bend in world space, keeping each vertex its distance from the plant's base (FISH_PUSH_APPLY):
    // fpM is the full model*instance rotation-scale, so its column scales are the plant's world size and
    // the renormalisation cannot mistake a blade's width for its length.
    const fpM = t.mat3(t.modelWorldMatrix).mul(t.mat3(inst0.xyz, inst1.xyz, inst2.xyz));
    const fpC0 = t.element(fpM, 0), fpC1 = t.element(fpM, 1), fpC2 = t.element(fpM, 2);
    const fs = t.vec3(t.length(fpC0), t.length(fpC1), t.length(fpC2)).max(t.vec3(1e-3));
    const mag = t.length(push);
    const capped = push.mul(t.min(t.float(1), fs.y.mul(t.float(BEND_CHORD)).div(t.max(mag, t.float(1e-5)))));
    const rot = t.mat3(fpC0.div(fs.x), fpC1.div(fs.y), fpC2.div(fs.z));
    const fpOff = fpM.mul(local).toVar();   // world offset from the instance's base
    const r = t.length(fpOff);
    const bent = fpOff.add(capped);
    const rl = t.length(bent);
    const off = t.select(rl.greaterThan(t.float(1e-5)), bent.mul(r.div(t.max(rl, t.float(1e-5)))), fpOff);
    const outLocal = t.transpose(rot).mul(off).div(fs);
    return t.select(mag.greaterThan(t.float(1e-5)), outLocal, local);
  })();
}

/** Adds the instance matrix's four columns as per-instance vec4 attributes (aInst0..aInst3) for the
 *  TSL sway/fish push to read. Call after every setMatrixAt. */
export function addSwayInstanceAttrs(inst: THREE.InstancedMesh): void {
  const g = inst.geometry;
  const n = inst.count;
  const src = inst.instanceMatrix.array as Float32Array;
  const cols = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    for (let c = 0; c < 4; c++) (cols[c] as Float32Array).set(src.subarray(o + c * 4, o + c * 4 + 4), i * 4);
  }
  g.setAttribute('aInst0', new THREE.InstancedBufferAttribute(cols[0] as Float32Array, 4));
  g.setAttribute('aInst1', new THREE.InstancedBufferAttribute(cols[1] as Float32Array, 4));
  g.setAttribute('aInst2', new THREE.InstancedBufferAttribute(cols[2] as Float32Array, 4));
  g.setAttribute('aInst3', new THREE.InstancedBufferAttribute(cols[3] as Float32Array, 4));
}

/** A storage-buffer node over an InstancedMesh's instance matrix (the same buffer InstanceNode reads),
 *  indexed by the built-in instance index. A material used by exactly one mesh can read its instance
 *  matrix this way without spending four vertex-buffer slots on aInst0..aInst3. */
export function instanceMatrixNode(inst: THREE.InstancedMesh): ShaderNodeObject<Node> {
  const t = tsl();
  return t.buffer(inst.instanceMatrix.array as Float32Array, 'mat4', inst.count).element(t.instanceIndex);
}
