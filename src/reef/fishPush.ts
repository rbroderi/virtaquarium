// Fish parting for swayed plants: a fixed-size uniform array of the fish nearest the grass and
// anemone patches, written once a frame from world.fish, and a vertex-shader bend that parts each
// blade/tentacle from nearby bodies and wakes behind them. The sway (materials.ts addSway) already
// bends with the water; this adds a horizontal push on top, so the two compose in the vertex shader.
import { clamp } from '../util.js';

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
 * folds the world-space push back into model space, and bends rather than stretches: the tip angle is
 * capped and each vertex keeps its distance from the base, so the stalk leans over and the base stays
 * planted and thick.
 */
export const FISH_PUSH_APPLY = /* glsl */`
      #ifdef USE_INSTANCING
      vec4 fpWp = modelMatrix * (instanceMatrix * vec4(transformed, 1.0));
      mat4 fpM = instanceMatrix;
      #else
      vec4 fpWp = modelMatrix * vec4(transformed, 1.0);
      mat4 fpM = modelMatrix;
      #endif
      vec3 fpPush = fishPushWorld(fpWp.xyz, h);
      {
        mat3 fpM3 = mat3(fpM);
        vec3 fpS = max(vec3(length(fpM3[0].xyz), length(fpM3[1].xyz), length(fpM3[2].xyz)), vec3(1e-3));
        float fpMag = length(fpPush);
        if (fpMag > 1e-5) {
          float fpCap = fpS.y * ${f(BEND_CHORD)};
          if (fpMag > fpCap) fpPush *= fpCap / fpMag;
          mat3 fpRot = mat3(fpM3[0].xyz / fpS.x, fpM3[1].xyz / fpS.y, fpM3[2].xyz / fpS.z);
          vec3 fpLocal = (fpPush * fpRot) / fpS;
          float fpR = length(transformed);
          vec3 fpBent = transformed + fpLocal;
          float fpRL = length(fpBent);
          if (fpRL > 1e-5) transformed = fpBent * (fpR / fpRL);
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
