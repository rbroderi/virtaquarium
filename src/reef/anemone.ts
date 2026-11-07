// Magnificent sea anemone (Heteractis magnifica), the clownfish's host: a pale cream-to-lilac column
// with a dense carpet of slender, soft finger-like tentacles. The real animal (Fautin & Allen 1992;
// Animal Diversity Web) has a 30-50 cm oral disc and 5-8 cm finger-like tentacles, blunt or slightly
// swollen at the tip; at this tank's 1 unit = 12.5 cm those are 0.40-0.64 units long and roughly a
// tenth of a clownfish's length thick, and the tank's reduced crown keeps those proportions against
// its 0.62-unit (7.75 cm) clownfish. Each tentacle is one cheap lathe (128
// triangles, 8 sides) with a nearly even girth and a swollen, rounded bulb; the tip is tinted violet
// over its last tenth by a soft gradient, not a cap. The gradients ride on the vertices. Per-instance
// attributes add a static curl, a tip hue and a mottle phase, while instance colours vary the overall
// cream/pink tint; a vertex aThin ramp feeds the tissue translucency so light glows through the tips.
// The golden-angle packing is broken up by a smooth swirl field, so neighbours lean together in drifts
// rather than all pointing radially outward. The crown is kept close to the old footprint so the
// clownfish stays visible among the tentacles.
import * as THREE from 'three';
import { Noise, TAU, clamp, mulberry32, pick, range, type Rng } from '../util.js';
import { addTranslucency } from '../softSkin.js';
import { addSway, stdMat } from './materials.js';
import { instanceMatrixNode } from './fishPush.js';
import { gpuActive, tsl } from '../webgpu/tsl.js';
import type { Node, ShaderNodeObject } from 'three/webgpu';
import { GOLDEN_ANGLE, UP, color, lathe, scratch } from './geometry.js';

/** Own seeded streams, so the reef's rng draws stay as they were before the anemone was reworked. */
const WRINKLE_SEED = 911;
const GIRTH_SEED = 912;
const JITTER_SEED = 913;
const CURL_SEED = 914;
const TIP_SEED = 915;
/**
 * 640 slender tentacles, one rng draw each: the same 640 draws the old crown made (320 x 2), so the
 * rest of the seeded reef layout is unchanged. Widths follow the real animal: at 1 unit = 12.5 cm,
 * Fautin & Allen's 5-8 cm tentacles are 0.40-0.64 units long and about a tenth of a clownfish's
 * length thick (tentacle width is not published; from the reference photo it is ~0.6-1.3 cm).
 */
const TENTACLES = 640;
/** Tentacles reach out to the disc's rim (about the old crown's footprint). */
const TENTACLE_SPREAD = 0.56;

type Profile = readonly (readonly [number, number])[];

/** Column: pedal lip on the rock (y 0), the column, and the disc flaring out over it, dished to the mouth. */
const COLUMN_PROFILE: Profile = [[0.0, -0.02], [0.46, -0.02], [0.48, 0.02], [0.4, 0.06], [0.36, 0.16], [0.37, 0.25], [0.43, 0.31], [0.48, 0.335], [0.44, 0.35], [0.27, 0.335], [0.09, 0.31], [0.035, 0.29], [0.0, 0.285]];
/** Where the disc's top starts in COLUMN_PROFILE (rim in to the mouth). */
const DISC_TOP_FROM = 8;
/**
 * (r, y): the base buried in the disc, an even stem (the width holds all the way up), a swollen
 * rounded bulb from 0.84, and a blunt rounded top. Length 0.981 / stem diameter ~0.068 = 14x; the
 * bulb is ~1.35x the stem's width. No point: the last tenth rounds over rather than tapering to a spike.
 */
const TENTACLE_PROFILE: Profile = [[0.018, 0.0], [0.034, 0.06], [0.034, 0.55], [0.041, 0.84], [0.046, 0.875], [0.044, 0.915], [0.036, 0.945], [0.021, 0.965], [0.0, 0.981]];
const TENTACLE_HEIGHT = 0.981;
/** The violet tip tint grows in over the last ~10% of the model's length, blending out of the cream. */
const TIP_GRADIENT_FROM = 0.88, TIP_GRADIENT_TO = 0.972;

/** The disc's top at radius r, for seating the tentacles. */
function discHeight(r: number): number {
  const top = COLUMN_PROFILE.slice(DISC_TOP_FROM);
  for (let k = 0; k < top.length - 1; k++) {
    const a = top[k], b = top[k + 1];
    if (!a || !b) break;
    const [r0, y0] = a, [r1, y1] = b;
    if (r <= r0 && r >= r1) return y0 + (y1 - y0) * (r - r0) / (r1 - r0);
  }
  return top[0]?.[1] ?? 0;
}

/** The column, wrinkled once with its own noise, flushed pink at the mouth. */
function column(): THREE.Mesh {
  const noise = new Noise(mulberry32(WRINKLE_SEED)), colCream = color('#96806b'), discCream = color('#6f5c4c'), mouth = color('#cfaeae');
  const cg = lathe(COLUMN_PROFILE, 32, (y, c) => { c.copy(y < 0.32 ? colCream : discCream); });
  const p = cg.getAttribute('position'), cl = cg.getAttribute('color'), v = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = Math.hypot(v.x, v.z), k = 1 + (noise.noise3(v.x * 7, v.y * 7, v.z * 7) - 0.5) * 0.2 * clamp(r / 0.3, 0, 1);
    p.setXYZ(i, v.x * k, v.y + (r < 0.45 && v.y > 0.25 ? (noise.noise3(v.x * 5 + 9, 0, v.z * 5) - 0.5) * 0.03 : 0), v.z * k);
    // Mottle the column so it reads as mottled tissue, not a smooth pot, then flush the mouth pink.
    c.fromBufferAttribute(cl, i).multiplyScalar(0.8 + 0.4 * noise.noise3(v.x * 4 + 3, v.y * 5, v.z * 4));
    if (v.y > 0.28 && r < 0.12) c.lerp(mouth, clamp((0.12 - r) / 0.08, 0, 1));
    cl.setXYZ(i, c.r, c.g, c.b);
  }
  cg.computeVertexNormals();
  return new THREE.Mesh(cg, addTranslucency(stdMat({ vertexColors: true, roughness: 0.9 }), { wrap: 0.25, back: 0.2, tint: [1.0, 0.85, 0.82], thin: 0.1 }));
}

/** Pale cream through beige-pink to a warm translucent bulb; the tip's violet is blended per instance. */
function tentacleColors(): (y: number, c: THREE.Color) => void {
  const foot = color('#ae9384'), stem = color('#cea99f'), mid = color('#ddbfb6'), pale = color('#e9d2b6'), bulb = color('#efdebd');
  return (y, c) => {
    if (y < 0.09) c.copy(foot).lerp(stem, y / 0.09);
    else if (y < 0.42) c.copy(stem).lerp(mid, (y - 0.09) / 0.33);
    else if (y < 0.72) c.copy(mid).lerp(pale, (y - 0.42) / 0.30);
    else c.copy(pale).lerp(bulb, clamp((y - 0.72) / (0.9 - 0.72), 0, 1));
  };
}

/** Lilac tip hues, softened with cream, so adjacent tips differ but never read as stickers. */
const TIP_COLORS = [color('#b49cc4'), color('#c0a9ce'), color('#a48bb8'), color('#c9b2d6'), color('#ab94c6'), color('#b9a3c9')];
/** Overall tentacle tints (peach, lilac, cream, a little yellow and rose), multiplied over the gradient. */
const TINTS = [color('#ffd9c0'), color('#ddc8e8'), color('#fff0c8'), color('#ffd6dc'), color('#dbe4f2'), color('#f0e0c8'), color('#ffd9ea'), color('#e9e6d2')];

/**
 * A smooth swirl field over the disc: a slow turn around the column plus low-frequency wobble, so
 * neighbours lean the same way in drifts instead of all pointing out from the centre. No rng draws.
 */
function driftDir(x: number, z: number): readonly [number, number] {
  const wob = 1.0 * Math.sin(x * 2.4 + 0.7) + 0.8 * Math.cos(z * 2.15 - 1.1) + 0.5 * Math.sin((x + z) * 3.3 + 0.4);
  const dx = -z * 0.9 + Math.cos(wob), dz = x * 0.9 + Math.sin(wob), d = Math.hypot(dx, dz) || 1;
  return [dx / d, dz / d];
}

/** GLSL for the static per-tentacle curl: a lean that grows towards the tip plus a small sideways wave. */
const CURL_DEFORM = /* glsl */`
        float curlH = h * h * (0.7 + 0.3 * h);
        float wig = sin(h * 5.3 + aCurl.w) * 0.22 * h * h;
        transformed.x += (aCurl.x * curlH - aCurl.y * wig) * aCurl.z;
        transformed.z += (aCurl.y * curlH + aCurl.x * wig) * aCurl.z;
        // Not a perfect pipe: the girth swells and thins a little along the tube, out of phase per
        // tentacle, so the surface undulates instead of reading as an extruded cylinder.
        transformed.x *= 1.0 + 0.045 * sin(h * 21.0 + aCurl.w * 2.3);
        transformed.z *= 1.0 + 0.04 * sin(h * 17.0 - aCurl.w * 1.7);
`;
const CURL_PRELUDE = 'attribute vec4 aCurl;\n';

/** TSL counterpart of CURL_DEFORM (WebGPU): the static per-tentacle curl, applied after the sway. */
function curlDeformNode(p: ShaderNodeObject<Node>, h: ShaderNodeObject<Node>): ShaderNodeObject<Node> {
  const t = tsl();
  const aCurl = t.attribute('aCurl', 'vec4');
  const curlH = h.mul(h).mul(t.float(0.7).add(t.float(0.3).mul(h)));
  const wig = t.sin(h.mul(t.float(5.3)).add(aCurl.w)).mul(t.float(0.22)).mul(h).mul(h);
  const q = p.toVar();
  q.x.addAssign(aCurl.x.mul(curlH).sub(aCurl.y.mul(wig)).mul(aCurl.z));
  q.z.addAssign(aCurl.y.mul(curlH).add(aCurl.x.mul(wig)).mul(aCurl.z));
  // Not a perfect pipe: the girth swells and thins a little along the tube, out of phase per tentacle.
  q.x.assign(q.x.mul(t.float(1).add(t.float(0.045).mul(t.sin(h.mul(t.float(21)).add(aCurl.w.mul(t.float(2.3))))))));
  q.z.assign(q.z.mul(t.float(1).add(t.float(0.04).mul(t.sin(h.mul(t.float(17)).sub(aCurl.w.mul(t.float(1.7))))))));
  return q;
}

/**
 * Tints the last tenth of each tentacle with the instance's violet hue, as a gradient out of the cream
 * (not a cap), and adds a faint tissue mottling along the tube, out of phase per tentacle.
 */
function addTipTint(mat: THREE.Material): void {
  if (gpuActive()) {
    // The GLSL patch below is dead under WebGPURenderer; the same tint runs as a colorNode. The standard
    // node material multiplies this node by the vertex and instance colours, so those are divided out to
    // reproduce the GLSL mix(vertex*instance, tip, tipK) exactly (every tentacle colour is > 0).
    const t = tsl();
    (mat as unknown as { colorNode: Node | null }).colorNode = t.Fn(() => {
      const vc = t.attribute('color', 'vec3');
      const ic = t.varyingProperty('vec3', 'vInstanceColor');
      const aTip = t.attribute('aTip', 'vec3');
      const aCurl = t.attribute('aCurl', 'vec4');
      const y = t.positionGeometry.y;
      const tipK = t.smoothstep(t.float(TIP_GRADIENT_FROM), t.float(TIP_GRADIENT_TO), y);
      const tipDeep = t.smoothstep(t.float(TIP_GRADIENT_TO), t.float(TENTACLE_HEIGHT), y);
      const tip = aTip.mul(t.float(0.9).add(t.float(0.1).mul(tipDeep)));
      const base = t.mix(t.vec3(1), tip.div(vc.mul(ic)), tipK);
      const mott = t.sin(y.mul(31).add(aCurl.w.mul(4.3))).mul(0.55)
        .add(t.sin(y.mul(11).sub(aCurl.w.mul(7.1))).mul(0.45));
      const sR = t.sin(y.mul(9).add(aCurl.w));
      return base.mul(t.vec3(
        t.float(1).add(t.float(0.03).mul(sR)),
        t.float(1),
        t.float(1).sub(t.float(0.024).mul(sR)),
      ).mul(t.float(1).add(mott.mul(t.float(0.075)))));
    })();
    return;
  }
  const prev = mat.onBeforeCompile.bind(mat), prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    prev(shader, r);
    shader.vertexShader = 'attribute vec3 aTip;\n' + shader.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
      float tipK = smoothstep(${TIP_GRADIENT_FROM}, ${TIP_GRADIENT_TO}, position.y);
      float tipDeep = smoothstep(${TIP_GRADIENT_TO}, ${TENTACLE_HEIGHT}, position.y);
      vColor = mix(vColor, aTip * (0.9 + 0.1 * tipDeep), tipK);
      // Faint tissue mottling (pink/cream striation) along the tube, out of phase per tentacle.
      float mott = sin(position.y * 31.0 + aCurl.w * 4.3) * 0.55 + sin(position.y * 11.0 - aCurl.w * 7.1) * 0.45;
      vColor *= 1.0 + mott * 0.075;
      vColor.r *= 1.0 + 0.03 * sin(position.y * 9.0 + aCurl.w);
      vColor.b *= 1.0 - 0.024 * sin(position.y * 9.0 + aCurl.w);`);
  };
  mat.customProgramCacheKey = () => prevKey() + '|tip';
}

const WHITE = new THREE.Color(1, 1, 1);

/** A dense carpet of curled, tinted tentacles, one instanced draw. */
function tentacles(rng: Rng): THREE.InstancedMesh {
  const tg = lathe(TENTACLE_PROFILE, 8, tentacleColors());
  // Tissue thinness up the tube (base solid, tip translucent), for the SSS transmission lobe. The
  // geometry is shared by every instance, so this costs one attribute and no rng.
  const pos = tg.getAttribute('position');
  const thin = new THREE.BufferAttribute(new Float32Array(pos.count), 1);
  for (let i = 0; i < pos.count; i++) {
    const h = clamp(pos.getY(i) / TENTACLE_HEIGHT, 0, 1);
    thin.setX(i, 0.28 + 0.72 * h * h * (0.6 + 0.4 * h));   // stout at the foot, translucent at the tip
  }
  tg.setAttribute('aThin', thin);
  const curl = new THREE.InstancedBufferAttribute(new Float32Array(TENTACLES * 4), 4);
  const tip = new THREE.InstancedBufferAttribute(new Float32Array(TENTACLES * 3), 3);
  tg.setAttribute('aCurl', curl);
  tg.setAttribute('aTip', tip);
  // The material needs the mesh's instance matrix on WebGPU (as a storage buffer, not four vertex
  // buffers), so the mesh comes first with a placeholder material that is swapped for the real one.
  const tent = new THREE.InstancedMesh<THREE.BufferGeometry, THREE.Material>(tg, new THREE.MeshBasicMaterial(), TENTACLES);
  const girth = mulberry32(GIRTH_SEED);    // per-tentacle thickness, off the reef's rng
  const { m, q, s, p } = scratch;
  const jitter = mulberry32(JITTER_SEED);  // placement and posture, off the reef's rng too
  const curls = mulberry32(CURL_SEED);     // the static bend, and which way it bends
  const tips = mulberry32(TIP_SEED);       // tip hue and overall tint
  const roll = new THREE.Quaternion(), tint = new THREE.Color(), tipCol = new THREE.Color();
  for (let i = 0; i < TENTACLES; i++) {
    // Break the golden-angle spiral: nudge each tentacle round and out, and let the rim wander. Every
    // third one hangs from the very rim, a skirt that drapes over the oral disc and hides the column.
    const skirt = i % 3 === 0;
    const th = i * GOLDEN_ANGLE + (jitter() - 0.5) * 0.55;
    const rim = 1 + 0.075 * Math.sin(th * 3 + 0.8) + 0.05 * Math.sin(th * 7 + 2.1);
    const r = skirt ? TENTACLE_SPREAD * (0.94 + 0.06 * jitter())
      : Math.sqrt((i + 0.5) / TENTACLES) * TENTACLE_SPREAD * 0.82 * rim * (1 + (jitter() - 0.5) * 0.08);
    const x = Math.cos(th) * r, z = Math.sin(th) * r;
    // Lean along the swirl field; the skirt turns outward and the rim blends towards radial.
    const edge = clamp((r / TENTACLE_SPREAD - 0.5) / 0.5, 0, 1), [fx, fz] = driftDir(x, z);
    const radialMix = skirt ? 1 : 0.55 * edge;
    let dx = fx * (1 - radialMix) + Math.cos(th) * radialMix;
    let dz = fz * (1 - radialMix) + Math.sin(th) * radialMix;
    const dl = Math.hypot(dx, dz) || 1;
    dx /= dl; dz /= dl;
    // Tilt from upright: strong variation, and much more towards the rim, so the edge drapes over the
    // column and the interior tentacles lie across each other rather than standing to attention.
    const tilt = skirt ? 1.12 + 0.38 * jitter() : 0.55 + 0.85 * jitter() + 0.35 * edge, st = Math.sin(tilt), ct = Math.cos(tilt);
    q.setFromUnitVectors(UP, p.set(dx * st, ct, dz * st).normalize());
    q.multiply(roll.setFromAxisAngle(UP, jitter() * TAU));   // roll the tube's facets and curl round its axis
    const g = (0.74 + 0.34 * girth()) * (skirt ? 1.06 : 1);
    // Real 5-8 cm tentacles (0.40-0.64 units) scaled by the profile's 0.981 height; the skirt a touch
    // longer. It keeps the crown near the old anemone's footprint, so the clownfish stays visible.
    const len = range(rng, 0.30, 0.66) * (1 + 0.1 * (1 - r / TENTACLE_SPREAD)) * (skirt ? 1.12 : 1);
    // Bases sink just below the disc (and the skirt just below the rim), so no gap shows under them.
    m.compose(p.set(x, discHeight(Math.min(r, 0.52)) - 0.02 - (skirt ? 0.008 : 0) + (jitter() - 0.5) * 0.018, z), q, s.set(g, len, g));
    tent.setMatrixAt(i, m);
    // Static curl: direction, strength (world-ish model units) and a phase for the sideways wave.
    const ca = curls() * TAU;
    curl.setXYZW(i, Math.cos(ca), Math.sin(ca), 0.14 + 0.24 * curls(), curls() * TAU);
    // Per-tentacle violet dot (two hues mixed) and an overall cream/peach/lilac tint.
    tipCol.copy(pick(tips, TIP_COLORS)).lerp(pick(tips, TIP_COLORS), tips()).multiplyScalar(0.85 + 0.3 * tips());
    tip.setXYZ(i, tipCol.r, tipCol.g, tipCol.b);
    tent.setColorAt(i, tint.copy(pick(tips, TINTS)).lerp(WHITE, tips() * 0.5));
  }
  if (tent.instanceColor) tent.instanceColor.needsUpdate = true;
  const mat = addSway(
    addTranslucency(stdMat({ vertexColors: true, roughness: 0.46 }), { wrap: 0.85, back: 1.25, tint: [1.0, 0.68, 0.66], thin: 'attr' }),
    'anemone', { ax: 0.05, az: 0.04, hz: 1.15, hTop: TENTACLE_HEIGHT, fishPush: true, instanced: true, instanceMatrixNode: gpuActive() ? instanceMatrixNode(tent) : undefined, prelude: CURL_PRELUDE, deform: CURL_DEFORM, deformNode: curlDeformNode, variant: 'curl' },
  );
  addTipTint(mat);
  tent.material = mat;
  tent.castShadow = true;
  return tent;
}

export function anemone(rng: Rng): THREE.Group {
  const group = new THREE.Group();
  group.name = 'anemone';
  group.add(column());
  group.add(tentacles(rng));
  return group;
}
