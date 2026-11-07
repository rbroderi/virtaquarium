// Magnificent sea anemone (Heteractis magnifica), the clownfish's host: a pale cream-to-lilac column
// with a dense carpet of thick, soft finger-like tentacles. Each tentacle is one cheap lathe (128
// triangles, 8 sides) with a nearly even girth, a swollen rounded tip and a small violet dot; the
// gradients ride on the vertices. Per-instance attributes add a static curl (so the tube is never a
// straight needle) and a violet-dot hue, while instance colours vary the overall cream/pink tint. The
// golden-angle packing is broken up by a smooth swirl field, so neighbours lean together in drifts
// rather than all pointing radially outward.
import * as THREE from 'three';
import { Noise, TAU, clamp, mulberry32, pick, range, type Rng } from '../util.js';
import { addTranslucency } from '../softSkin.js';
import { addSway, stdMat } from './materials.js';
import { GOLDEN_ANGLE, UP, color, lathe, scratch } from './geometry.js';

/** Own seeded streams, so the reef's rng draws stay as they were before the anemone was reworked. */
const WRINKLE_SEED = 911;
const GIRTH_SEED = 912;
const JITTER_SEED = 913;
const CURL_SEED = 914;
const TIP_SEED = 915;
/** 640 thick tentacles (the old crown had 320 thin ones); 640 also matches the old tentacle-load's
 *  draw count from the reef rng (320 x 2), so the rest of the seeded reef is unchanged. */
const TENTACLES = 640;
/** Tentacles reach out to the disc's rim. */
const TENTACLE_SPREAD = 0.6;

type Profile = readonly (readonly [number, number])[];

/** Column: pedal lip on the rock (y 0), the column, and the disc flaring out over it, dished to the mouth. */
const COLUMN_PROFILE: Profile = [[0.0, -0.02], [0.46, -0.02], [0.48, 0.02], [0.4, 0.06], [0.36, 0.16], [0.37, 0.25], [0.43, 0.31], [0.48, 0.335], [0.44, 0.35], [0.27, 0.335], [0.09, 0.31], [0.035, 0.29], [0.0, 0.285]];
/** Where the disc's top starts in COLUMN_PROFILE (rim in to the mouth). */
const DISC_TOP_FROM = 8;
/**
 * (r, y): the base buried in the disc, an even stem (the width holds all the way up), the swollen
 * rounded bulb at 0.86-0.93, and a small violet cap. Length 0.981 / stem diameter ~0.104 = 9.4x; the
 * bulb is ~1.2x the stem's width.
 */
const TENTACLE_PROFILE: Profile = [[0.026, 0.0], [0.052, 0.06], [0.051, 0.55], [0.063, 0.86], [0.058, 0.912], [0.043, 0.948], [0.028, 0.966], [0.011, 0.977], [0.0, 0.981]];
const TENTACLE_HEIGHT = 0.981;
/** The small violet dot covers the very top (model y), mixed over a soft edge. */
const TIP_MASK_FROM = 0.97, TIP_MASK_TO = 0.979;

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

/** Pale cream through beige-pink to a yellower bulb; the very tip's colour is replaced per instance. */
function tentacleColors(): (y: number, c: THREE.Color) => void {
  const foot = color('#b59b8b'), stem = color('#d1b7a9'), mid = color('#dfc8bc'), pale = color('#e8d3b4'), bulb = color('#ebd8b5'), dot = color('#7c5c9e');
  return (y, c) => {
    if (y < 0.09) c.copy(foot).lerp(stem, y / 0.09);
    else if (y < 0.42) c.copy(stem).lerp(mid, (y - 0.09) / 0.33);
    else if (y < 0.72) c.copy(mid).lerp(pale, (y - 0.42) / 0.30);
    else if (y < TIP_MASK_FROM) c.copy(pale).lerp(bulb, (y - 0.72) / (TIP_MASK_FROM - 0.72));
    else c.copy(dot);
  };
}

/** Violet dot hues, per tentacle, so the tips are not one flat colour. */
const TIP_COLORS = [color('#7c63a0'), color('#8d6cae'), color('#6c5691'), color('#9a78b2'), color('#82649e'), color('#9274a8')];
/** Overall tentacle tints (peach, lilac, cream, a little yellow), multiplied over the vertex gradient. */
const TINTS = [color('#ffe3cd'), color('#eadcf0'), color('#fff0d2'), color('#f5dfe1'), color('#e6e8f4')];

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
`;
const CURL_PRELUDE = 'attribute vec4 aCurl;\n';

/** Replaces the (cream/violet) tip vertex colour with the instance's own violet hue. */
function addTipTint(mat: THREE.Material): void {
  const prev = mat.onBeforeCompile.bind(mat), prevKey = mat.customProgramCacheKey.bind(mat);
  mat.onBeforeCompile = (shader, r) => {
    prev(shader, r);
    shader.vertexShader = 'attribute vec3 aTip;\n' + shader.vertexShader.replace('#include <color_vertex>', `#include <color_vertex>
      vColor = mix(vColor, aTip, smoothstep(${TIP_MASK_FROM}, ${TIP_MASK_TO}, position.y));`);
  };
  mat.customProgramCacheKey = () => prevKey() + '|tip';
}

const WHITE = new THREE.Color(1, 1, 1);

/** A dense carpet of curled, tinted tentacles, one instanced draw. */
function tentacles(rng: Rng): THREE.InstancedMesh {
  const tg = lathe(TENTACLE_PROFILE, 8, tentacleColors());
  const curl = new THREE.InstancedBufferAttribute(new Float32Array(TENTACLES * 4), 4);
  const tip = new THREE.InstancedBufferAttribute(new Float32Array(TENTACLES * 3), 3);
  tg.setAttribute('aCurl', curl);
  tg.setAttribute('aTip', tip);
  const mat = addSway(
    addTranslucency(stdMat({ vertexColors: true, roughness: 0.82 }), { wrap: 0.55, back: 0.55, tint: [1.0, 0.8, 0.78], thin: 0.6 }),
    'anemone', { ax: 0.05, az: 0.04, hz: 1.15, hTop: TENTACLE_HEIGHT, fishPush: true, prelude: CURL_PRELUDE, deform: CURL_DEFORM, variant: 'curl' },
  );
  addTipTint(mat);
  const tent = new THREE.InstancedMesh(tg, mat, TENTACLES);
  const girth = mulberry32(GIRTH_SEED);    // per-tentacle thickness, off the reef's rng
  const { m, q, s, p } = scratch;
  const jitter = mulberry32(JITTER_SEED);  // placement and posture, off the reef's rng too
  const curls = mulberry32(CURL_SEED);     // the static bend, and which way it bends
  const tips = mulberry32(TIP_SEED);       // tip-dot hue and overall tint
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
    const tilt = skirt ? 1.1 + 0.35 * jitter() : 0.4 + 0.7 * jitter() + 0.35 * edge, st = Math.sin(tilt), ct = Math.cos(tilt);
    q.setFromUnitVectors(UP, p.set(dx * st, ct, dz * st).normalize());
    q.multiply(roll.setFromAxisAngle(UP, jitter() * TAU));   // roll the tube's facets and curl round its axis
    const g = (0.84 + 0.4 * girth()) * (skirt ? 1.1 : 1);
    const len = range(rng, 0.5, 1.05) * (1 + 0.1 * (1 - r / TENTACLE_SPREAD)) * (skirt ? 1.25 : 1);
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
