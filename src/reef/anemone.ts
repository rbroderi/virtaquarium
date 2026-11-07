// Bubble-tip anemone (Entacmaea quadricolor): a column that flares into the oral disc, gripping the
// rock with a pedal lip, and swaying instanced tentacles. Each tentacle is a lathe of the real one's
// profile: a slender stem, a pale constriction ring, the swollen bulb, and a darker pointed tip. A
// lathe puts its rings where the profile curves, so it is fewer triangles than the old capsules (176
// a tentacle against 272).
import * as THREE from 'three';
import { Noise, clamp, mulberry32, range, type Rng } from '../util.js';
import { addTranslucency } from '../softSkin.js';
import { addSway, stdMat } from './materials.js';
import { GOLDEN_ANGLE, UP, color, lathe, scratch } from './geometry.js';

/** Own seeded streams, so the reef's rng draws stay as they were before the anemone was reworked. */
const WRINKLE_SEED = 911;
const GIRTH_SEED = 912;
const JITTER_SEED = 913;
const TENTACLES = 320;
/** Tentacles reach out to the disc's rim (0.55; the old column ended at 0.42). */
const TENTACLE_SPREAD = 0.58;

type Profile = readonly (readonly [number, number])[];

/** Column: pedal lip on the rock (y 0), the column, and the disc flaring out over it, dished to the mouth. */
const COLUMN_PROFILE: Profile = [[0.0, -0.02], [0.53, -0.02], [0.55, 0.02], [0.47, 0.06], [0.42, 0.16], [0.43, 0.25], [0.5, 0.31], [0.55, 0.335], [0.5, 0.35], [0.3, 0.335], [0.1, 0.31], [0.04, 0.29], [0.0, 0.285]];
/** Where the disc's top starts in COLUMN_PROFILE (rim in to the mouth). */
const DISC_TOP_FROM = 8;
/**
 * (r, y): the base buried in the disc, stem, the constriction band at 0.62 of the height, bulb, pointed
 * tip at 0.42 (the old capsule's height, which the sway's hTop goes by).
 */
const TENTACLE_PROFILE: Profile = [[0.02, -0.01], [0.019, 0.08], [0.018, 0.19], [0.0155, 0.235], [0.018, 0.252], [0.023, 0.275], [0.0265, 0.3], [0.026, 0.325], [0.021, 0.35], [0.013, 0.378], [0.005, 0.405], [0.0, 0.42]];
const TENTACLE_HEIGHT = 0.42;

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

/** The column, wrinkled once with its own noise, the mouth flushed pink. */
function column(): THREE.Mesh {
  const noise = new Noise(mulberry32(WRINKLE_SEED)), colBrown = color('#8a6446'), discCol = color('#6f7a44'), mouth = color('#c77d8e');
  const cg = lathe(COLUMN_PROFILE, 32, (y, c) => { c.copy(y < 0.32 ? colBrown : discCol); });
  const p = cg.getAttribute('position'), cl = cg.getAttribute('color'), v = new THREE.Vector3(), c = new THREE.Color();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const r = Math.hypot(v.x, v.z), k = 1 + (noise.noise3(v.x * 7, v.y * 7, v.z * 7) - 0.5) * 0.2 * clamp(r / 0.3, 0, 1);
    p.setXYZ(i, v.x * k, v.y + (r < 0.45 && v.y > 0.25 ? (noise.noise3(v.x * 5 + 9, 0, v.z * 5) - 0.5) * 0.03 : 0), v.z * k);
    if (v.y > 0.28 && r < 0.12) { c.fromBufferAttribute(cl, i).lerp(mouth, clamp((0.12 - r) / 0.08, 0, 1)); cl.setXYZ(i, c.r, c.g, c.b); }
  }
  cg.computeVertexNormals();
  return new THREE.Mesh(cg, addTranslucency(stdMat({ vertexColors: true, roughness: 0.75 }), { wrap: 0.35, back: 0.3, thin: 0.1 }));
}

function tentacleColors(): (y: number, c: THREE.Color) => void {
  const stem = color('#7f8a4a'), ring = color('#e8e2c8'), bulb = color('#e07aa2'), tip = color('#8e2f58');
  return (y, c) => {
    if (y < 0.225) c.copy(stem);
    else if (y < 0.26) c.copy(stem).lerp(ring, clamp(1 - Math.abs(y - 0.243) / 0.014, 0, 1));
    else if (y < 0.35) c.copy(bulb).lerp(ring, clamp((0.285 - y) / 0.03, 0, 0.5));
    else c.copy(bulb).lerp(tip, clamp((y - 0.35) / 0.04, 0, 1));
  };
}

/** Tentacles spread by the golden angle over the disc, each sized from the reef's rng. */
function tentacles(rng: Rng): THREE.InstancedMesh {
  const tg = lathe(TENTACLE_PROFILE, 8, tentacleColors());
  const mat = addSway(
    addTranslucency(stdMat({ vertexColors: true, roughness: 0.5 }), { wrap: 0.5, back: 0.9, tint: [1.0, 0.55, 0.6], thin: 0.7 }),
    'anemone', { ax: 0.09, az: 0.07, hz: 1.2, hTop: TENTACLE_HEIGHT, fishPush: true },
  );
  const tent = new THREE.InstancedMesh(tg, mat, TENTACLES);
  const girth = mulberry32(GIRTH_SEED);   // per-tentacle bulb size, off the reef's rng
  const { m, q, s, p } = scratch;
  const jitter = mulberry32(JITTER_SEED);   // placement and posture, off the reef's rng too
  for (let i = 0; i < TENTACLES; i++) {
    // The golden-angle spiral is too perfect: nudge each tentacle round and out, let the disc's rim wander,
    // and let each lean its own way (some bent over, some upright), a little shorter or longer by region.
    const th = i * GOLDEN_ANGLE + (jitter() - 0.5) * 0.35;
    const rim = 1 + 0.07 * Math.sin(th * 3 + 0.8) + 0.04 * Math.sin(th * 7 + 2.1);
    const r = Math.sqrt(i / TENTACLES) * TENTACLE_SPREAD * rim * (1 + (jitter() - 0.5) * 0.1);
    const out = new THREE.Vector3(Math.cos(th) * r * 1.6 + (jitter() - 0.5) * 0.3, 1, Math.sin(th) * r * 1.6 + (jitter() - 0.5) * 0.3).normalize();
    q.setFromUnitVectors(UP, out);
    const size = range(rng, 0.8, 1.2), g = 0.85 + 0.3 * girth();
    m.compose(p.set(Math.cos(th) * r, discHeight(r) - 0.008, Math.sin(th) * r), q, s.set(size * g, size * range(rng, 0.85, 1.15) * (0.9 + 0.2 * jitter()), size * g * (0.9 + 0.2 * jitter())));
    tent.setMatrixAt(i, m);
  }
  tent.castShadow = true;
  return tent;
}

export function anemone(rng: Rng): THREE.Group {
  const group = new THREE.Group();
  group.add(column());
  group.add(tentacles(rng));
  return group;
}
