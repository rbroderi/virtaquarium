// Turtle-grass blades. No two real blades are alike: they differ in width, length, lean, twist and
// bend, the sides of a strap wander, the tip is worn and ragged, and the colour runs from a pale
// sheath at the base through green to a browned tip, spotted with epiphytes. One shared 22-vertex strap
// serves every blade, so the differences come from a per-blade seed in the shader: the blade's
// instance colour (random per blade, drawn from the reef's stream before this existed) is hashed,
// so nothing new is drawn and the layout stays as it was.
import * as THREE from 'three';
import { clamp } from '../util.js';
import { addSway, stdMat } from './materials.js';
import { fishPushBend } from './fishPush.js';
import { installReefLight } from '../reefLight/webgpu.js';
import { color } from './geometry.js';
import { gpuActive, tsl, type Tsl } from '../webgpu/tsl.js';
import { waterTimeNode } from '../webgpu/timeUniform.js';
import type { Node, ShaderNodeObject } from 'three/webgpu';

const SEGMENTS = 10;

/** The blade: a strap one unit long and wide, standing on y = 0, its vertices coloured by height. */
export function bladeGeometry(): THREE.PlaneGeometry {
  const blade = new THREE.PlaneGeometry(1, 1, 1, SEGMENTS);
  blade.translate(0, 0.5, 0);
  const p = blade.getAttribute('position'), col = new Float32Array(p.count * 3), c = new THREE.Color();
  const base = color('#3b5a2a'), mid = color('#5a7a36'), tip = color('#8a8248');   // olive, as in field photos
  for (let i = 0; i < p.count; i++) {
    const h = p.getY(i);
    c.copy(base).lerp(mid, clamp(h * 2, 0, 1)).lerp(tip, clamp((h - 0.7) / 0.3, 0, 1) * 0.8);
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  blade.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return blade;
}

const TUFTS = 5;

/**
 * Where a shoot at polar (a, r) of a patch ends up: pulled most of the way to the nearest of a few
 * tuft centres (fixed per patch, so every shoot of a tuft gathers), and the patch's rim is lobed.
 * Deterministic from its arguments; draws nothing.
 */
export function tuftedShoot(patch: number, a: number, r: number): [number, number] {
  const lobe = 0.75 + 0.25 * Math.cos(3 * a + patch * 2.1) + 0.12 * Math.sin(5 * a + patch * 4.3);
  let x = Math.cos(a) * r * lobe * 1.4, z = Math.sin(a) * r * lobe * 0.8, best = Infinity, bx = 0, bz = 0;
  for (let k = 0; k < TUFTS; k++) {
    const ta = k * 1.2566 + patch * 0.9 + 0.4 * Math.sin(k * 2.7 + patch), tr = 0.18 + 0.38 * (0.5 + 0.5 * Math.sin(k * 4.1 + patch * 1.7));
    const tx = Math.cos(ta) * tr * 1.4, tz = Math.sin(ta) * tr * 0.8, d = Math.hypot(tx - x, tz - z);
    if (d < best) { best = d; bx = tx; bz = tz; }
  }
  const pull = 0.65 * clamp(1.2 - best, 0, 1);
  x += (bx - x) * pull; z += (bz - z) * pull;
  return [x, z];
}

const VERT_HEAD = /* glsl */`
varying vec4 vGrass;
vec3 grassShape(vec3 p) {
  #ifdef USE_INSTANCING_COLOR
  vec3 ic = instanceColor;
  #else
  vec3 ic = vec3(0.5);
  #endif
  float s1 = fract(sin(dot(ic, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  float s2 = fract(s1 * 91.7 + 0.37), s3 = fract(s1 * 57.3 + 0.71), s4 = fract(s2 * 33.1 + 0.13);
  float h = p.y, side = p.x * 2.0, tipN = smoothstep(0.76, 1.0, h);
  // The strap swells and thins, each side wandering on its own; the end narrows to a rounded, uneven point.
  float swell = 0.92 + 0.16 * sin(h * (5.0 + 4.0 * s2) + 6.0 * s3);
  float edge = 1.0 + 0.11 * sin(h * (11.0 + 8.0 * s3) + s1 * 20.0 + (side > 0.0 ? 0.0 : 2.4));
  float x = p.x * swell * edge * (1.0 - tipN * tipN * (0.5 + 0.45 * s4));
  // A worn tip: one side ends lower than the other.
  float y = h - side * (s2 - 0.5) * 0.14 * tipN - (s4 - 0.3) * 0.05 * tipN;
  // Twist along the blade, a bend out of its plane and a slow sideways wave.
  // (The instance scales x by the blade's width and y, z by its length: the ratio keeps the twist round and the wave a fraction of the length.)
  #ifdef USE_INSTANCING
  float wL = length(instanceMatrix[2].xyz) / max(length(instanceMatrix[0].xyz), 1e-4);
  #else
  float wL = 1.0;
  #endif
  float tw = (s3 - 0.5) * 2.6 * h;
  vec3 q = vec3(x * cos(tw), y, x * sin(tw) / wL);
  q.z += (s1 - 0.5) * 0.4 * h * h;
  q.x += sin(h * (2.5 + 2.0 * s2) + s3 * 6.28) * 0.06 * wL * h * h;
  vGrass = vec4(h, side, s1, s2);
  return q;
}
`;

const FRAG_HEAD = /* glsl */`
varying vec4 vGrass;
float grassHash(vec2 c) { return fract(sin(dot(c, vec2(127.1, 311.7))) * 43758.5453); }
`;

const FRAG_COLOUR = /* glsl */`#include <color_fragment>
{
  float h = vGrass.x, ed = abs(vGrass.y), s1 = vGrass.z, s2 = vGrass.w;
  // Worn, ragged edges towards the tip.
  float eaten = smoothstep(0.6, 1.0, h) * smoothstep(0.35, 0.9, ed) * (0.15 + 0.5 * s2);
  if (grassHash(floor(vec2(vGrass.y * 4.0 + s1 * 9.0, h * 38.0))) < eaten) discard;
  // A pale sheath at the base, a browned and darker tip, and slow patches of lighter and darker green.
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62, 0.68, 0.42), (1.0 - smoothstep(0.0, 0.2, h)) * 0.55);
  float brown = smoothstep(0.5 + 0.3 * s2, 1.0, h) * (0.35 + 0.5 * s1);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.34, 0.24, 0.1), brown * 0.8);
  diffuseColor.rgb *= 0.86 + 0.28 * (0.5 + 0.5 * sin(h * (14.0 + 12.0 * s1) + s2 * 40.0 + vGrass.y * 1.5));
  // Epiphyte specks, denser towards the older tip.
  vec2 cell = vec2(vGrass.y * 2.5 + s1 * 17.0 + h * 0.8, h * 70.0);
  vec2 id = floor(cell), f = fract(cell) - 0.5 + (vec2(grassHash(id + 1.7), grassHash(id + 5.9)) - 0.5) * 0.4;
  float dens = (0.02 + 0.2 * smoothstep(0.3, 1.0, h)) * (0.3 + 1.4 * s2 * s2);
  float on = step(1.0 - dens, grassHash(id));
  float rad = 0.12 + 0.3 * grassHash(id + 7.3) * grassHash(id + 2.2);
  float spot = on * (1.0 - smoothstep(rad * 0.5, rad, length(f * vec2(1.0, 0.6)) * (0.8 + 0.4 * grassHash(floor(cell * 3.0)))));
  diffuseColor.rgb = mix(diffuseColor.rgb, mix(vec3(0.74, 0.76, 0.68), vec3(0.2, 0.2, 0.12), step(0.6, grassHash(id + 3.1))), spot * 0.75);
}`;

/** The grass material: vertex colours, the blade shape and colour above, swaying with the water. */
export function grassMaterial(): THREE.Material {
  if (gpuActive()) return grassNodeMaterial();
  const mat = addSway(stdMat({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide }), 'seagrass-organic', { ax: 0, az: 0.16, hz: 0.7, fishPush: true });
  const swayed = mat.onBeforeCompile.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    swayed(shader, r);
    shader.vertexShader = VERT_HEAD + shader.vertexShader.replace('vec3 transformed = vec3(position);', 'vec3 transformed = grassShape(position);');
    shader.fragmentShader = FRAG_HEAD + shader.fragmentShader.replace('#include <color_fragment>', FRAG_COLOUR);
  };
  return mat;
}

// --- WebGPU (TSL) grass ---

type NodeObject = ShaderNodeObject<Node>;

/** The blade's per-instance fields: the colour the WebGL shader got from instanceColor, and the
 *  instance matrix columns the sway/fish push read. builder.ts fills them instead of setColorAt. */
export function grassInstanceAttrs(inst: THREE.InstancedMesh, tints: Float32Array): void {
  const g = inst.geometry, n = inst.count;
  const src = inst.instanceMatrix.array as Float32Array;
  const cols = [new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4), new Float32Array(n * 4)];
  for (let i = 0; i < n; i++) {
    const o = i * 16;
    for (let c = 0; c < 4; c++) (cols[c] as Float32Array).set(src.subarray(o + c * 4, o + c * 4 + 4), i * 4);
  }
  g.setAttribute('aTint', new THREE.InstancedBufferAttribute(tints, 3));
  g.setAttribute('aInst0', new THREE.InstancedBufferAttribute(cols[0] as Float32Array, 4));
  g.setAttribute('aInst1', new THREE.InstancedBufferAttribute(cols[1] as Float32Array, 4));
  g.setAttribute('aInst2', new THREE.InstancedBufferAttribute(cols[2] as Float32Array, 4));
  g.setAttribute('aInst3', new THREE.InstancedBufferAttribute(cols[3] as Float32Array, 4));
}

/** The grassShape VERT_HEAD + the sway/fish push, in one position node. */
function grassPositionNode(): Node {
  const t = tsl();
  const time = waterTimeNode();
  return t.Fn(() => {
    const p = t.positionGeometry.toVar();   // the authored strap (x/y in 0..1): shape before the instance matrix
    const ic = t.attribute('aTint', 'vec3');
    const s1 = t.fract(t.sin(t.dot(ic, t.vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
    const s2 = t.fract(s1.mul(91.7).add(0.37));
    const s3 = t.fract(s1.mul(57.3).add(0.71));
    const s4 = t.fract(s2.mul(33.1).add(0.13));
    const h = p.y;
    const side = p.x.mul(2);
    const tipN = t.smoothstep(0.76, 1, h);

    const swell = t.float(0.92).add(t.float(0.16).mul(t.sin(
      h.mul(t.float(5).add(t.float(4).mul(s2))).add(t.float(6).mul(s3)))));

    const edge = t.float(1).add(t.float(0.11).mul(t.sin(
      h.mul(t.float(11).add(t.float(8).mul(s3))).add(s1.mul(20))
        .add(t.select(t.greaterThan(side, 0), t.float(0), t.float(2.4))))));

    const x = p.x.mul(swell).mul(edge)
      .mul(t.float(1).sub(tipN.mul(tipN).mul(t.float(0.5).add(t.float(0.45).mul(s4)))));
    const y = h
      .sub(side.mul(s2.sub(0.5)).mul(0.14).mul(tipN))
      .sub(s4.sub(0.3).mul(0.05).mul(tipN));

    const aInst0 = t.attribute('aInst0', 'vec4');
    const aInst2 = t.attribute('aInst2', 'vec4');
    const wL = t.length(aInst2.xyz).div(t.max(t.length(aInst0.xyz), t.float(1e-4)));
    const tw = s3.sub(0.5).mul(2.6).mul(h);
    const q = t.vec3(x.mul(t.cos(tw)), y, x.mul(t.sin(tw)).div(wL)).toVar();
    q.z.addAssign(s1.sub(0.5).mul(0.4).mul(h).mul(h));
    q.x.addAssign(t.sin(h.mul(t.float(2.5).add(t.float(2).mul(s2))).add(s3.mul(6.28)))
      .mul(0.06).mul(wL).mul(h).mul(h));
    t.varyingProperty('vec4', 'vGrass').assign(t.vec4(h, side, s1, s2));

    // Sway (ax 0, az 0.16, hz 0.7) with the blade's instance translation for the phase, then fish push.
    const aInst3 = t.attribute('aInst3', 'vec4');
    const ph = aInst3.x.mul(1.7).add(aInst3.z.mul(2.3));
    const zSway = t.cos(time.mul(t.float(0.56)).add(ph.mul(1.3))).mul(t.float(0.16)).mul(h).mul(h);
    const out = q.add(t.vec3(0, 0, zSway)).toVar();
    // fishPushBend returns the bent blade in its own space; the renderer's InstanceNode prepass applies
    // the instance matrix to the position-node result, so it is not applied here.
    return fishPushBend(out, t.clamp(h, t.float(0), t.float(1)), aInst0, t.attribute('aInst1', 'vec4'), aInst2, aInst3);
  })();
}

/** The FRAG_COLOUR patch: worn edges (discard), sheath/brown/green variation and epiphyte specks. */
function grassColorNode(): Node {
  const t = tsl();
  const hash: (c: NodeObject) => NodeObject = t.Fn(([c]: [NodeObject]) =>
    t.fract(t.sin(t.dot(c, t.vec2(127.1, 311.7))).mul(43758.5453))) as unknown as (c: NodeObject) => NodeObject;
  return t.Fn(() => {
    const v = t.varyingProperty('vec4', 'vGrass');
    const col = t.attribute('color', 'vec3').mul(t.attribute('aTint', 'vec3')).toVar();
    const h = v.x;
    const ed = t.abs(v.y);
    const s1 = v.z;
    const s2 = v.w;

    const eaten = t.smoothstep(0.6, 1, h)
      .mul(t.smoothstep(0.35, 0.9, ed))
      .mul(t.float(0.15).add(t.float(0.5).mul(s2)));
    hash(t.floor(t.vec2(v.y.mul(4).add(s1.mul(9)), h.mul(38)))).lessThan(eaten).discard();

    const sheath = t.float(1).sub(t.smoothstep(0, 0.2, h)).mul(0.55);
    col.assign(t.mix(col, t.vec3(0.62, 0.68, 0.42), sheath));

    const brown = t.smoothstep(t.float(0.5).add(t.float(0.3).mul(s2)), 1, h)
      .mul(t.float(0.35).add(t.float(0.5).mul(s1)));
    col.assign(t.mix(col, t.vec3(0.34, 0.24, 0.1), brown.mul(0.8)));

    const green = t.float(0.5).add(t.float(0.5).mul(t.sin(
      h.mul(t.float(14).add(t.float(12).mul(s1))).add(s2.mul(40)).add(v.y.mul(1.5)))));
    col.assign(col.mul(t.float(0.86).add(t.float(0.28).mul(green))));

    const cell = t.vec2(v.y.mul(2.5).add(s1.mul(17)).add(h.mul(0.8)), h.mul(70));
    const id = t.floor(cell);
    const f = t.fract(cell).sub(0.5).add(
      t.vec2(hash(id.add(1.7)), hash(id.add(5.9))).sub(0.5).mul(0.4));

    const dens = t.float(0.02).add(t.float(0.2).mul(t.smoothstep(0.3, 1, h)))
      .mul(t.float(0.3).add(t.float(1.4).mul(s2).mul(s2)));
    const on = t.step(t.float(1).sub(dens), hash(id));

    const rad = t.float(0.12).add(t.float(0.3).mul(hash(id.add(7.3))).mul(hash(id.add(2.2))));
    const spotScale = t.float(0.8).add(t.float(0.4).mul(hash(t.floor(cell.mul(3)))));
    const spot = on.mul(t.float(1).sub(t.smoothstep(rad.mul(0.5), rad, t.length(f.mul(t.vec2(1, 0.6))).mul(spotScale))));

    const epi = t.mix(t.vec3(0.74, 0.76, 0.68), t.vec3(0.2, 0.2, 0.12), t.step(0.6, hash(id.add(3.1))));
    col.assign(t.mix(col, epi, spot.mul(0.75)));
    return col;
  })();
}

/** The grass under WebGPU: the same blade shape + colour, in TSL (WebGPURenderer never runs the GLSL). */
function grassNodeMaterial(): InstanceType<Tsl['MeshStandardNodeMaterial']> {
  const t = tsl();
  const mat = new t.MeshStandardNodeMaterial({ roughness: 0.55, side: THREE.DoubleSide });
  mat.positionNode = grassPositionNode();
  mat.colorNode = grassColorNode();
  return installReefLight(mat) as InstanceType<Tsl['MeshStandardNodeMaterial']>;
}
